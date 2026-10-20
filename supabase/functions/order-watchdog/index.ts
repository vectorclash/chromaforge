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
//
// Invoked every 5 minutes by pg_cron (migration 0020; it was every 30 when this only alerted).
//
// verify_jwt = false (config.toml): the cron caller has no user JWT. Auth is the same
// X-Cleanup-Key shared secret cleanup-storage uses (CLEANUP_STORAGE_KEY) -- all cron-only
// maintenance endpoints, one secret to rotate. Plain fetch(), no supabase-js, for the same
// bundle-timeout reason as render-print-file.
//
// Deploy with: npx supabase functions deploy order-watchdog --no-verify-jwt

import { sendOrderFailureAlert } from "../_shared/orderAlert.ts";

// stripe-webhook kicks process-order straight away, so give that run time to start before a
// resume would only find it already leased.
const RESUME_AFTER_MINUTES = 2;
// A normal order is submitted within a minute of payment; a hold during a deploy window clears in
// minutes. Thirty is well past both.
const ALERT_AFTER_MINUTES = 30;

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

  const summary = {
    resumed: resumed.filter(r => r.status === "fulfilled" && r.value?.started).length,
    resumable: resumable.length,
    alerted: stuck.length
  };
  console.log("order-watchdog", JSON.stringify(summary));
  return Response.json(summary);
});
