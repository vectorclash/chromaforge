// Alerts a human about orders that were PAID but never reached Printful.
//
// stripe-webhook moves an order pending -> paid, then submits it to Printful and moves it on to
// submitted or failed, all inside one invocation. If that invocation dies in between (a platform
// timeout, a crash, a deploy mid-request), the order is left at `paid`: the customer has been
// charged, nothing is being produced, and no alert was sent, because the code that sends it
// never ran. Stripe will not retry either -- its delivery already claimed the pending -> paid
// transition, so a retry no-ops by design. Nothing else in the system ever looks at `paid`
// again, so without this such an order would sit unnoticed until the customer asked.
//
// Invoked every 30 minutes by pg_cron (migration 0018). Each stuck order is alerted ONCE
// (watchdog_alerted_at); the fix is a human's, so repeating the email would only be noise.
//
// verify_jwt = false (config.toml): the cron caller has no user JWT. Auth is the same
// X-Cleanup-Key shared secret cleanup-storage uses (CLEANUP_STORAGE_KEY) -- both are cron-only
// maintenance endpoints, and one secret means one thing to rotate. Plain fetch(), no
// supabase-js, for the same bundle-timeout reason as render-print-file.
//
// Deploy with: npx supabase functions deploy order-watchdog --no-verify-jwt

import { sendOrderFailureAlert } from "../_shared/orderAlert.ts";

// stripe-webhook normally finishes within seconds of stamping paid_at; even with its one retry
// and Printful being slow it is well under a minute. Fifteen is comfortably past any real run.
const STUCK_AFTER_MINUTES = 15;

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

  const cutoff = new Date(Date.now() - STUCK_AFTER_MINUTES * 60 * 1000).toISOString();
  const res = await fetch(
    `${supabaseUrl}/rest/v1/orders?select=id,paid_at,created_at` +
      `&status=eq.paid&watchdog_alerted_at=is.null&paid_at=lt.${encodeURIComponent(cutoff)}`,
    { headers }
  );
  if (!res.ok) {
    return Response.json({ error: { message: `orders query failed (${res.status})` } }, { status: 500 });
  }
  const stuck: { id: string; paid_at: string }[] = await res.json();

  for (const order of stuck) {
    await sendOrderFailureAlert(
      order.id,
      `This order was paid at ${order.paid_at} but was never submitted to Printful -- ` +
        `stripe-webhook did not finish processing it.`,
      "Check stripe-webhook's logs for this order, then submit it to Printful by hand (or " +
        "refund it via the Stripe dashboard) and set its status accordingly."
    );
    await fetch(`${supabaseUrl}/rest/v1/orders?id=eq.${order.id}`, {
      method: "PATCH",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ watchdog_alerted_at: new Date().toISOString() })
    });
  }

  const summary = { alerted: stuck.length };
  console.log("order-watchdog", JSON.stringify(summary));
  return Response.json(summary);
});
