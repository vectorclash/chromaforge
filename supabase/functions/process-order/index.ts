// Renders a PAID order's print files and submits it to Printful (2026-10-19).
//
// Before this, the browser rendered every placement at true print resolution before Stripe was
// opened, so the customer sat through it (7s for a t-shirt, 15s+ for the shorts, and more once
// the nebula lands). Now Buy Now goes straight to Stripe, the order carries one render request
// per placement (order_items.print_jobs, checked by create-checkout-session against Printful's
// printfile specs), and this function does the rendering once the money has settled.
//
// Who calls it: stripe-webhook, right after it marks an order paid, and order-watchdog every five
// minutes for any paid order whose run stalled or failed. Both send the X-Cleanup-Key shared
// secret; the function answers 202 at once and does the work in the background
// (EdgeRuntime.waitUntil), because Stripe will not wait for a render.
//
// One run at a time per order: a run claims the order with a short lease (print_lease_until) by a
// conditional update on its attempt count, so a webhook kick and a watchdog pass that cross can
// never render or submit the same order twice. Printful's draft id is recorded the moment it
// exists, so a run that dies between create and confirm is resumed by confirming that draft rather
// than creating another.
//
// Each print file is rendered by render-print-file (its internal mode), one invocation per file --
// the same fan-out the browser used to do, which keeps each file's CPU and memory in its own
// isolate rather than holding several multi-megabyte PNGs in this one. Files are named by
// content, so re-rendering after a partial run is idempotent, and every finished URL is written to
// print_file_urls so a resumed run renders only what is missing.
//
// Outcomes:
// - every file rendered -> submit to Printful -> 'submitted', or 'failed' + alert (as before).
// - render-service is on a different generator version than the design the customer saw -> the
//   order is HELD (print_hold), never printed with a different picture. The attempt does not
//   count; the watchdog retries until the versions match and alerts a human after 30 minutes.
// - any other render failure -> retried within the run with backoff, then by the watchdog, and
//   only after MAX_ATTEMPTS runs is the order marked 'failed' and a human alerted.
//
// verify_jwt = false (config.toml): callers are other functions, not users. Plain fetch() against
// the REST endpoints, no supabase-js, for render-print-file's bundle-timeout reason.
//
// Deploy with: npx supabase functions deploy process-order --no-verify-jwt
// Needs: CLEANUP_STORAGE_KEY, STRIPE_SECRET_KEY, PRINTFUL_API_KEY (all already set for other
// functions). SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY are auto-provided.

import { sendOrderFailureAlert } from "../_shared/orderAlert.ts";
import { submitPrintfulOrder, type OrderItemRow, type StripeSession } from "../_shared/printfulOrder.ts";

declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void };

// Runs per order before giving up and alerting. A run that dies mid-way (a platform timeout)
// counts too, so a pathological order cannot loop forever.
const MAX_ATTEMPTS = 4;
// Longer than any real run (the slowest product renders in well under a minute, and a run is
// killed by the platform at 150s) so a live run is never taken over, short enough that a dead one
// is resumed by the next watchdog pass.
const LEASE_SECONDS = 6 * 60;
// Per-file retries within one run.
const RENDER_RETRY_DELAYS_MS = [3000, 10000];
const RENDER_TIMEOUT_MS = 140_000;

class HoldError extends Error {}
class PermanentError extends Error {}

type OrderRow = {
  id: string;
  user_id: string;
  status: string;
  print_attempts: number;
  print_lease_until: string | null;
  printful_order_id: string | null;
  stripe_session_id: string;
};

type ItemRow = OrderItemRow & {
  id: string;
  print_jobs: Record<string, Record<string, unknown>> | null;
};

const supabaseUrl = () => Deno.env.get("SUPABASE_URL")!;
const serviceHeaders = () => {
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  return { Authorization: `Bearer ${key}`, apikey: key, "Content-Type": "application/json" };
};

async function rest(path: string, init: RequestInit = {}) {
  const res = await fetch(`${supabaseUrl()}/rest/v1/${path}`, {
    ...init,
    headers: { ...serviceHeaders(), ...(init.headers ?? {}) }
  });
  if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path.split("?")[0]} failed (${res.status}): ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

const patchOrder = (orderId: string, fields: Record<string, unknown>) =>
  rest(`orders?id=eq.${orderId}`, { method: "PATCH", body: JSON.stringify(fields), headers: { Prefer: "return=minimal" } });

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Claims the order for one run. Returns the claimed row, or null if it is not ours to process
// (not paid, already being processed, or a concurrent claim won).
async function claim(orderId: string): Promise<OrderRow | null> {
  const rows: OrderRow[] = await rest(
    `orders?id=eq.${orderId}&select=id,user_id,status,print_attempts,print_lease_until,printful_order_id,stripe_session_id`
  );
  const order = rows[0];
  if (!order || order.status !== "paid") return null;
  if (order.print_lease_until && Date.parse(order.print_lease_until) > Date.now()) return null;
  const leaseUntil = new Date(Date.now() + LEASE_SECONDS * 1000).toISOString();
  // Conditional on the attempt count we read: of two callers that both saw the lease free, only
  // one update matches.
  const claimed: OrderRow[] = await rest(
    `orders?id=eq.${orderId}&status=eq.paid&print_attempts=eq.${order.print_attempts}`,
    {
      method: "PATCH",
      body: JSON.stringify({ print_lease_until: leaseUntil, print_attempts: order.print_attempts + 1 }),
      headers: { Prefer: "return=representation" }
    }
  );
  return claimed.length ? { ...order, print_attempts: order.print_attempts + 1 } : null;
}

async function renderOnce(job: Record<string, unknown>, userId: string): Promise<string> {
  let res: Response;
  try {
    res = await fetch(`${supabaseUrl()}/functions/v1/render-print-file`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Internal-Key": Deno.env.get("CLEANUP_STORAGE_KEY")! },
      body: JSON.stringify({ ...job, userId }),
      signal: AbortSignal.timeout(RENDER_TIMEOUT_MS)
    });
  } catch (err) {
    throw new Error(`render-print-file unreachable: ${err instanceof Error ? err.message : err}`);
  }
  const data = await res.json().catch(() => ({}));
  if (res.ok && typeof data.url === "string") return data.url;
  const message: string = data?.error?.message || `render-print-file returned ${res.status}`;
  // render-service refuses a design made under a different generator version (render-print-file
  // passes its message through). Printing it anyway would print a different picture.
  if (message.includes("generatorVersion mismatch")) throw new HoldError(message);
  // A malformed job will be malformed on every retry.
  if (res.status === 400) throw new PermanentError(message);
  throw new Error(message);
}

async function renderWithRetry(job: Record<string, unknown>, userId: string): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await renderOnce(job, userId);
    } catch (err) {
      if (err instanceof HoldError || err instanceof PermanentError) throw err;
      if (attempt >= RENDER_RETRY_DELAYS_MS.length) throw err;
      console.warn(`process-order: render failed, retrying: ${err instanceof Error ? err.message : err}`);
      await sleep(RENDER_RETRY_DELAYS_MS[attempt]);
    }
  }
}

async function fetchStripeSession(sessionId: string): Promise<StripeSession> {
  const res = await fetch(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}`, {
    headers: {
      Authorization: `Bearer ${Deno.env.get("STRIPE_SECRET_KEY")}`,
      "Stripe-Version": "2026-06-24.dahlia"
    }
  });
  if (!res.ok) throw new Error(`Stripe session lookup failed (${res.status})`);
  return res.json();
}

async function failOrder(order: OrderRow, reason: string, extra: Record<string, unknown> = {}) {
  await patchOrder(order.id, { status: "failed", failure_reason: reason, print_lease_until: null, ...extra });
  await sendOrderFailureAlert(order.id, reason);
}

// A failure worth another run, unless this was the last one.
async function retryLaterOrFail(order: OrderRow, reason: string) {
  if (order.print_attempts >= MAX_ATTEMPTS) {
    await failOrder(order, `${reason} (gave up after ${order.print_attempts} attempts)`);
    return;
  }
  console.warn(`process-order: order ${order.id} attempt ${order.print_attempts} failed, will retry: ${reason}`);
  await patchOrder(order.id, { print_lease_until: null, print_hold: null });
}

async function run(order: OrderRow) {
  const items: ItemRow[] = await rest(
    `order_items?order_id=eq.${order.id}` +
      `&select=id,quantity,variant_id,unit_price_cents,product_options,print_file_urls,print_jobs`
  );
  if (items.length === 0) {
    await failOrder(order, "No order items found");
    return;
  }

  // Render what is missing. Identical jobs (a t-shirt's front and back) render once.
  let holdMessage: string | null = null;
  let failure: Error | null = null;
  for (const item of items) {
    const urls: Record<string, string> = { ...(item.print_file_urls ?? {}) };
    const pending = Object.entries(item.print_jobs ?? {}).filter(([placement]) => !urls[placement]);
    const byJob = new Map<string, string[]>();
    for (const [placement, job] of pending) {
      const key = JSON.stringify(job);
      byJob.set(key, [...(byJob.get(key) ?? []), placement]);
    }
    const results = await Promise.allSettled(
      [...byJob.entries()].map(async ([key, placements]) => {
        const url = await renderWithRetry(JSON.parse(key), order.user_id);
        for (const placement of placements) urls[placement] = url;
      })
    );
    for (const r of results) {
      if (r.status === "fulfilled") continue;
      if (r.reason instanceof HoldError) holdMessage = r.reason.message;
      else failure = failure ?? (r.reason instanceof Error ? r.reason : new Error(String(r.reason)));
    }
    // Keep whatever did render, so a resumed run renders only the rest.
    if (results.some(r => r.status === "fulfilled")) {
      await rest(`order_items?id=eq.${item.id}`, {
        method: "PATCH",
        body: JSON.stringify({ print_file_urls: urls }),
        headers: { Prefer: "return=minimal" }
      });
    }
    item.print_file_urls = urls;
  }

  if (holdMessage) {
    // Not the order's fault and not a failure: give the attempt back and wait for the versions to
    // match (order-watchdog retries, and alerts a human if it goes on).
    console.warn(`process-order: order ${order.id} held: ${holdMessage}`);
    await patchOrder(order.id, {
      print_hold: holdMessage,
      print_lease_until: null,
      print_attempts: order.print_attempts - 1
    });
    return;
  }
  if (failure) {
    if (failure instanceof PermanentError) {
      await failOrder(order, `Print file render refused: ${failure.message}`);
    } else {
      await retryLaterOrFail(order, `Print file render failed: ${failure.message}`);
    }
    return;
  }
  if (items.some(item => Object.keys(item.print_file_urls).length === 0)) {
    await failOrder(order, "Order has no print files");
    return;
  }

  let session: StripeSession;
  try {
    session = await fetchStripeSession(order.stripe_session_id);
  } catch (err) {
    await retryLaterOrFail(order, err instanceof Error ? err.message : "Stripe session lookup failed");
    return;
  }

  const { printfulOrderId, error } = await submitPrintfulOrder({
    printfulKey: Deno.env.get("PRINTFUL_API_KEY")!,
    orderId: order.id,
    session,
    items,
    existingPrintfulOrderId: order.printful_order_id,
    onCreated: id => patchOrder(order.id, { printful_order_id: id })
  });

  if (!error) {
    await patchOrder(order.id, {
      status: "submitted",
      printful_order_id: printfulOrderId,
      print_lease_until: null,
      print_hold: null
    });
    return;
  }
  // The customer has already paid -- a flagged manual-ops gap, not an auto-refund (see
  // sendOrderFailureAlert). Printful's id is kept when the draft exists: it is what a human needs
  // to confirm by hand, and printful-webhook matches later events by it.
  console.error(`process-order: Printful submission failed for order ${order.id}: ${error.message}`);
  await failOrder(
    order,
    printfulOrderId
      ? `${error.message} (Printful draft order ${printfulOrderId} exists and was not confirmed)`
      : error.message,
    printfulOrderId ? { printful_order_id: printfulOrderId } : {}
  );
}

Deno.serve(async req => {
  if (req.method !== "POST") {
    return Response.json({ error: { message: "Method not allowed" } }, { status: 405 });
  }
  const key = Deno.env.get("CLEANUP_STORAGE_KEY");
  if (!key || req.headers.get("X-Cleanup-Key") !== key) {
    return Response.json({ error: { message: "Unauthorized" } }, { status: 401 });
  }
  const { orderId } = await req.json().catch(() => ({}));
  if (typeof orderId !== "string" || !/^[0-9a-f-]{36}$/.test(orderId)) {
    return Response.json({ error: { message: "orderId required" } }, { status: 400 });
  }

  let order: OrderRow | null;
  try {
    order = await claim(orderId);
  } catch (err) {
    console.error("process-order: claim failed", err);
    return Response.json({ error: { message: "claim failed" } }, { status: 500 });
  }
  if (!order) return Response.json({ started: false }, { status: 200 });

  const claimed = order;
  EdgeRuntime.waitUntil(
    run(claimed).catch(async err => {
      // An unexpected error (a database write failing, say). Leave the lease to expire so the
      // watchdog picks it up again; MAX_ATTEMPTS still bounds it.
      console.error(`process-order: run for ${claimed.id} threw`, err);
    })
  );
  return Response.json({ started: true }, { status: 202 });
});
