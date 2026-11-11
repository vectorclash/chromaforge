// Keeps PAID orders moving, and alerts a human about any that are stuck.
//
// Since 2026-10-19 a paid order's print files are rendered after payment, by process-order, which
// stripe-webhook kicks the moment an order is paid. This watchdog is the durable half of that:
//
// 1. RESUME. Any order still 'paid' a couple of minutes after payment, with no run in progress (its
//    lease expired or never taken), is handed to process-order again. That covers a kick that never
//    arrived, a run killed mid-render by a platform timeout or deploy, a render that failed and is
//    worth another try, and an order HELD because render-service is on a different generator
//    version from the design the customer saw (it renders once the versions match). process-order
//    skips placements already rendered and confirms a Printful draft that already exists, so a
//    resume never duplicates work or orders, and it gives up and alerts on its own after its last
//    attempt.
// 2. ALERT. Any order still 'paid' 30 minutes after payment is emailed about ONCE
//    (watchdog_alerted_at), with its hold reason and attempt count. A hold that will not clear on
//    its own (render-service deployed AHEAD of the design's version) only ever surfaces here.
// 3. DELIVERIES (2026-10-24). A shipped order ('fulfilled') stays in the customer's Active list
//    until it arrives; this moves it to 'delivered' once Printful's v1 order shows every package
//    delivered (see _shared/printfulShipments.ts). Polled because printful-webhook never hears
//    about delivery: Printful's shipment events exist only on the v2 beta, and subscribing to
//    them would mean re-registering the webhook. One Printful read per in-transit order per run,
//    which is a handful. A package Printful never marks delivered stays in Active, which is
//    true: from the customer's side it has not arrived.
//
// 4. SHUT-OFF (2026-11-11). If paid orders are failing or piling up -- TROUBLE_LIMIT or more of
//    them since the store was last opened, within TROUBLE_WINDOW_MINUTES -- this closes checkout
//    (public.store_state, see _shared/storeStatus.ts) and emails once. One order in trouble is
//    that order's problem (a bad address, a stale variant) and only gets its own alert; two is
//    the pipeline. Closing stops NEW checkouts only: orders already paid keep being retried
//    above, and browsing, mockups and the studio are untouched. It never reopens by itself.
//    STORE_BREAKER=false (a function secret) turns this step and the next off.
// 5. STORAGE TEST (2026-11-11). Uploads a one-pixel PNG to the print-file bucket and reads it back
//    through its public URL, every run (_shared/storageProbe.ts; create-checkout-session runs the
//    same test on every Buy Now, which is what stops a purchase in the minutes before this closes
//    the store). On 2026-11-04 every Storage upload saved its file and then
//    never answered: mockups failed, and a paid order's print files could not have been made. Two
//    failed tests running (5-10 minutes) close checkout; two passes running reopen it, but only a
//    close this step made. That one reopens by itself because nothing was harmed and nothing needs
//    a person's judgement -- unlike step 4, which closes on real orders.
//    Not tested: the database and Edge Functions (if either is down checkout cannot start, so no
//    money is taken) and render-service (testing it would wake a Fly machine every five minutes;
//    a render outage shows up as stuck orders and closes the store through step 4).
//
// Invoked every 5 minutes by pg_cron (migration 0020; it was every 30 when this only alerted).
//
// verify_jwt = false (config.toml): the cron caller has no user JWT. Auth is the same
// X-Cleanup-Key shared secret cleanup-storage uses (CLEANUP_STORAGE_KEY) -- all cron-only
// maintenance endpoints, one secret to rotate. Plain fetch(), no supabase-js, for the same
// bundle-timeout reason as render-print-file.
//
// Deploy with: npx supabase functions deploy order-watchdog --no-verify-jwt

import { sendAlertEmail, sendOrderFailureAlert } from "../_shared/orderAlert.ts";
import { probeStorage } from "../_shared/storageProbe.ts";
import { fetchShipments } from "../_shared/printfulShipments.ts";
import { closeStore, readStoreState, recordProbe, reopenStore, type StoreState } from "../_shared/storeStatus.ts";

// stripe-webhook kicks process-order straight away, so give that run time to start before a
// resume would only find it already leased.
const RESUME_AFTER_MINUTES = 2;
// A normal order is submitted within a minute of payment; a hold during a deploy window clears in
// minutes. Thirty is well past both.
const ALERT_AFTER_MINUTES = 30;
// The shut-off. An order is "in trouble" if it was paid in the window and has either been marked
// failed or is still not at Printful STUCK_AFTER_MINUTES after payment (a normal one takes about
// a minute; a queue of renders or a version hold is what makes it longer).
const TROUBLE_WINDOW_MINUTES = 120;
const STUCK_AFTER_MINUTES = 15;
const TROUBLE_LIMIT = 2;
// The Storage test. A healthy upload answers in well under a second; the 2026-11-04 hang took 60.
const PROBE_TIMEOUT_MS = 15000;
const PROBE_FAILURES_TO_CLOSE = 2;
const PROBE_SUCCESSES_TO_REOPEN = 2;

type PaidOrder = {
  id: string;
  paid_at: string;
  print_lease_until: string | null;
  print_hold: string | null;
  print_attempts: number;
  watchdog_alerted_at: string | null;
};

Deno.serve(async req => {
  if (req.method !== "POST") {
    return Response.json({ error: { message: "Method not allowed" } }, { status: 405 });
  }

  const cronKey = Deno.env.get("CLEANUP_STORAGE_KEY");
  if (!cronKey || req.headers.get("X-Cleanup-Key") !== cronKey) {
    return Response.json({ error: { message: "Unauthorized" } }, { status: 401 });
  }

  // Test the alert channel: every safeguard here ends in an email, so it is worth knowing the mail
  // still goes out. A call with {"testAlert": true} sends one email and does nothing else; the
  // cron job's own body is {} and never reaches this. Send it from the SQL editor, which reads the
  // key from Vault without it ever being shown:
  //   select net.http_post(
  //     url := 'https://fgrhbzqzadpjpbzuszpm.supabase.co/functions/v1/order-watchdog',
  //     headers := jsonb_build_object('Content-Type', 'application/json', 'X-Cleanup-Key',
  //       (select decrypted_secret from vault.decrypted_secrets where name = 'cron_internal_key')),
  //     body := '{"testAlert": true}'::jsonb);
  const body = await req.json().catch(() => ({}));
  if (body?.testAlert === true) {
    const sent = await sendAlertEmail(
      "Chromaforge: test alert",
      "This is a test of the order alert email, sent on request. If you are reading it, the alerts " +
        "for failed orders and an automatically closed store will reach you too. Nothing needs doing."
    );
    console.log(`order-watchdog: test alert ${sent ? "sent" : "NOT sent"}`);
    return Response.json({ testAlert: sent ? "sent" : "failed" }, { status: sent ? 200 : 500 });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const headers = { Authorization: `Bearer ${serviceRoleKey}`, apikey: serviceRoleKey };

  const resumeCutoff = new Date(Date.now() - RESUME_AFTER_MINUTES * 60 * 1000).toISOString();
  const res = await fetch(
    `${supabaseUrl}/rest/v1/orders?select=id,paid_at,print_lease_until,print_hold,print_attempts,watchdog_alerted_at` +
      `&status=eq.paid&paid_at=lt.${encodeURIComponent(resumeCutoff)}`,
    { headers }
  );
  if (!res.ok) {
    return Response.json({ error: { message: `orders query failed (${res.status})` } }, { status: 500 });
  }
  const paid: PaidOrder[] = await res.json();
  const now = Date.now();

  // 1. Resume anything without a live run. process-order claims the order itself, so a run that
  // started between this query and the call is left alone.
  const resumable = paid.filter(o => !o.print_lease_until || Date.parse(o.print_lease_until) <= now);
  const resumed = await Promise.allSettled(
    resumable.map(order =>
      fetch(`${supabaseUrl}/functions/v1/process-order`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Cleanup-Key": cronKey },
        body: JSON.stringify({ orderId: order.id }),
        signal: AbortSignal.timeout(15000)
      }).then(r => r.json())
    )
  );

  // 2. Alert once on anything that has been paid for too long without reaching Printful.
  const alertCutoff = now - ALERT_AFTER_MINUTES * 60 * 1000;
  const stuck = paid.filter(o => !o.watchdog_alerted_at && Date.parse(o.paid_at) < alertCutoff);
  for (const order of stuck) {
    const why = order.print_hold
      ? `It is HELD: ${order.print_hold}. render-service must be on the design's generator version ` +
        `before its print files can be made.`
      : `process-order has run ${order.print_attempts} time(s) without finishing; it keeps retrying ` +
        `and will mark the order failed after its last attempt.`;
    await sendOrderFailureAlert(
      order.id,
      `This order was paid at ${order.paid_at} but has not been submitted to Printful. ${why}`,
      "Check process-order's and render-print-file's logs for this order. If it cannot finish on " +
        "its own, submit it to Printful by hand (or refund it via the Stripe dashboard) and set its " +
        "status accordingly."
    );
    await fetch(`${supabaseUrl}/rest/v1/orders?id=eq.${order.id}`, {
      method: "PATCH",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ watchdog_alerted_at: new Date().toISOString() })
    });
  }

  // 3. Last, so a slow Printful can never hold up a resume or an alert. Never fails the run: an
  // order missed now is simply checked again in five minutes.
  const delivered = await recordDeliveries(supabaseUrl, headers);

  // 4 and 5. After everything else, and never able to fail the run.
  let storeClosed = false;
  let storage = "skipped";
  if (Deno.env.get("STORE_BREAKER") !== "false") {
    try {
      storage = await testStorage();
    } catch (err) {
      console.error("order-watchdog: storage test failed to run", err);
    }
    try {
      storeClosed = await closeStoreIfInTrouble(supabaseUrl, headers, paid, now);
    } catch (err) {
      console.error("order-watchdog: shut-off check failed", err);
    }
  }

  const summary = {
    storeClosed,
    storage,
    resumed: resumed.filter(r => r.status === "fulfilled" && r.value?.started).length,
    resumable: resumable.length,
    alerted: stuck.length,
    delivered
  };
  console.log("order-watchdog", JSON.stringify(summary));
  return Response.json(summary);
});

// Moves every shipped order whose packages have all arrived to 'delivered', refreshing its stored
// shipments on the way so each carries its delivered_at. Returns how many it moved.
async function recordDeliveries(supabaseUrl: string, headers: Record<string, string>): Promise<number> {
  const res = await fetch(
    `${supabaseUrl}/rest/v1/orders?select=id,printful_order_id&status=eq.fulfilled&printful_order_id=not.is.null`,
    { headers }
  );
  if (!res.ok) {
    console.error(`order-watchdog: shipped orders query failed (${res.status})`);
    return 0;
  }
  const shipped: { id: string; printful_order_id: string }[] = await res.json();

  const results = await Promise.allSettled(
    shipped.map(async order => {
      const { shipments, deliveredAt } = await fetchShipments(
        order.printful_order_id,
        AbortSignal.timeout(10000)
      );
      if (!deliveredAt) return false;
      // status=eq.fulfilled on the write too: a refund that landed since the query wins.
      const up = await fetch(`${supabaseUrl}/rest/v1/orders?id=eq.${order.id}&status=eq.fulfilled`, {
        method: "PATCH",
        headers: { ...headers, "Content-Type": "application/json", Prefer: "return=representation" },
        body: JSON.stringify({ status: "delivered", delivered_at: deliveredAt, shipments })
      });
      if (!up.ok) throw new Error(`PATCH order ${order.id} -> ${up.status} ${await up.text()}`);
      return (await up.json()).length > 0;
    })
  );
  for (const r of results) {
    if (r.status === "rejected") console.error("order-watchdog: delivery check failed", r.reason);
  }
  return results.filter(r => r.status === "fulfilled" && r.value).length;
}

// Closes checkout when TROUBLE_LIMIT or more paid orders are in trouble. Returns whether THIS run
// closed it.
async function closeStoreIfInTrouble(
  supabaseUrl: string,
  headers: Record<string, string>,
  paid: PaidOrder[],
  now: number
): Promise<boolean> {
  const state = await readStoreState();
  // Unreadable (or the table is not there yet): do nothing rather than guess. Already closed:
  // nothing to do, and the email went out when it closed.
  if (!state || !state.enabled) return false;

  // Only trouble since the store was last opened counts, or the orders that closed it would
  // close it again the moment a human reopened it.
  const windowStart = Math.max(
    now - TROUBLE_WINDOW_MINUTES * 60 * 1000,
    state.changedAt ? Date.parse(state.changedAt) : 0
  );
  const since = new Date(windowStart).toISOString();

  const stuck = paid.filter(
    o => Date.parse(o.paid_at) >= windowStart && Date.parse(o.paid_at) < now - STUCK_AFTER_MINUTES * 60 * 1000
  );
  // Failed by our own pipeline soon after payment. An order Printful fails days later has an old
  // paid_at and is not counted: that is one order's story, not checkout being broken now.
  const res = await fetch(
    `${supabaseUrl}/rest/v1/orders?select=id,failure_reason&status=eq.failed&paid_at=gte.${encodeURIComponent(since)}`,
    { headers }
  );
  if (!res.ok) throw new Error(`failed orders query failed (${res.status})`);
  const failed: { id: string; failure_reason: string | null }[] = await res.json();

  if (stuck.length + failed.length < TROUBLE_LIMIT) return false;

  const lines = [
    ...failed.map(o => `- ${o.id} FAILED: ${o.failure_reason ?? "no reason recorded"}`),
    ...stuck.map(
      o =>
        `- ${o.id} paid at ${o.paid_at}, still not at Printful` +
        (o.print_hold ? ` (held: ${o.print_hold})` : ` (${o.print_attempts} attempt(s))`)
    )
  ];
  const reason =
    `${failed.length} failed and ${stuck.length} stuck paid order(s) since ${since}`;
  if (!(await closeStore(reason, "orders"))) return false; // another run closed it first

  await sendAlertEmail(
    "Chromaforge: checkout was closed automatically",
    `Checkout has been closed because paid orders are not getting through: ${reason}.\n\n` +
      `${lines.join("\n")}\n\n` +
      "New purchases are paused; the rest of the site works as usual. The orders above are still " +
      "being retried and each failed one has its own email.\n\n" +
      "Once the cause is fixed, reopen checkout in the Supabase SQL editor:\n" +
      "  update public.store_state set enabled = true, reason = null, closed_by = null, changed_at = now();"
  );
  console.error(`order-watchdog: checkout closed automatically -- ${reason}`);
  return true;
}

// Runs the test, keeps its running counts, and closes or reopens checkout on them. Returns a word
// for the run's summary line.
async function testStorage(): Promise<string> {
  const state: StoreState | null = await readStoreState();
  if (!state) return "skipped"; // table unreadable or not there yet

  const problem = await probeStorage("watchdog", PROBE_TIMEOUT_MS);
  if (problem) {
    const failures = state.probeFailures + 1;
    await recordProbe(failures, 0);
    console.error(`order-watchdog: storage test failed (${failures} running): ${problem}`);
    if (failures < PROBE_FAILURES_TO_CLOSE || !state.enabled) return "failing";
    if (!(await closeStore(`Supabase Storage is not answering: ${problem}`, "storage"))) return "failing";
    await sendAlertEmail(
      "Chromaforge: checkout closed, Supabase Storage is not answering",
      `The watchdog's Storage test has failed ${failures} times running: ${problem}.\n\n` +
        "Print files and mockups cannot be uploaded while this lasts, so new purchases are paused. " +
        "The rest of the site is untouched, and orders already paid keep being retried.\n\n" +
        "Checkout reopens by itself once the test passes twice running (about ten minutes after " +
        "Storage recovers), and you will get an email when it does. Supabase's status page and the " +
        "storage logs ([Queue Sender] timeouts were the sign on 2026-11-04) are the places to look."
    );
    return "closed";
  }

  const successes = Math.min(state.probeSuccesses + 1, PROBE_SUCCESSES_TO_REOPEN);
  if (state.probeFailures !== 0 || state.probeSuccesses !== successes) await recordProbe(0, successes);
  if (state.enabled || state.closedBy !== "storage" || successes < PROBE_SUCCESSES_TO_REOPEN) return "ok";
  if (!(await reopenStore("storage"))) return "ok";
  await sendAlertEmail(
    "Chromaforge: checkout reopened, Supabase Storage is answering again",
    "The watchdog's Storage test has passed twice running, so checkout is open again. It was closed " +
      `since ${state.changedAt}. Any order paid just before it closed is retried automatically; ` +
      "one that could not be finished has its own email."
  );
  console.log("order-watchdog: checkout reopened after storage recovered");
  return "reopened";
}
