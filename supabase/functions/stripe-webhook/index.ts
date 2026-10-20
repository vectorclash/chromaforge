// Confirms a Stripe payment and moves the order from 'pending' to 'paid'. This is the only place
// orders transition past 'pending' -- see 0005_orders_schema.sql's header comment on why
// client-side writes are blocked by RLS.
//
// Rendering the print files and submitting the Printful order happen in process-order, which this
// kicks once the order is paid (2026-10-19, when print files moved after payment). Until then
// this function submitted to Printful itself; that code now lives in _shared/printfulOrder.ts.
//
// verify_jwt is explicitly false for this function (set in supabase/config.toml) -- Stripe's
// webhook caller carries no Supabase JWT at all, only a Stripe-Signature header. Auth here
// is entirely the signature check below, not Supabase's JWT gate.
//
// Deploy with: npx supabase functions deploy stripe-webhook --no-verify-jwt
// Needs: STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, CLEANUP_STORAGE_KEY (to call process-order).
// SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY are auto-provided.
//
// Register the endpoint in Stripe's dashboard pointing at this function's URL, subscribed
// to checkout.session.completed, checkout.session.async_payment_succeeded and
// checkout.session.async_payment_failed (see the payment_status note in the handler).

import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";

async function kickProcessOrder(orderId: string) {
  try {
    const res = await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/process-order`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Cleanup-Key": Deno.env.get("CLEANUP_STORAGE_KEY") ?? "" },
      body: JSON.stringify({ orderId }),
      signal: AbortSignal.timeout(8000)
    });
    if (!res.ok) console.error(`stripe-webhook: process-order answered ${res.status} for ${orderId}`);
  } catch (err) {
    console.error(`stripe-webhook: could not reach process-order for ${orderId}`, err);
  }
}

Deno.serve(async req => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const stripeKey = Deno.env.get("STRIPE_SECRET_KEY");
  const webhookSecret = Deno.env.get("STRIPE_WEBHOOK_SECRET");
  if (!stripeKey || !webhookSecret) {
    console.error("stripe-webhook: missing STRIPE_SECRET_KEY/STRIPE_WEBHOOK_SECRET");
    return new Response("Server misconfigured", { status: 500 });
  }

  const stripe = new Stripe(stripeKey, { apiVersion: "2026-06-24.dahlia" });

  // Raw bytes, not parsed JSON -- signature verification needs the exact request body.
  const rawBody = await req.text();
  const signature = req.headers.get("Stripe-Signature");
  if (!signature) {
    return new Response("Missing signature", { status: 400 });
  }

  let event: Stripe.Event;
  try {
    // Deno's runtime has no Node crypto module, so signature verification needs the
    // SubtleCrypto-backed async variant (Stripe's documented pattern for edge runtimes --
    // see https://supabase.com/docs/guides/functions/examples/stripe-webhooks).
    const cryptoProvider = Stripe.createSubtleCryptoProvider();
    event = await stripe.webhooks.constructEventAsync(
      rawBody,
      signature,
      webhookSecret,
      undefined,
      cryptoProvider
    );
  } catch (err) {
    console.error("stripe-webhook: signature verification failed", err);
    return new Response("Invalid signature", { status: 400 });
  }

  // `completed` means the customer finished the Checkout page, NOT that money arrived. For a
  // delayed-settlement method (bank debits and the like) it fires with payment_status "unpaid",
  // and the money either lands later (async_payment_succeeded) or never does
  // (async_payment_failed). Only card and wallet methods are enabled today, where `completed`
  // always arrives "paid" -- but that is a dashboard setting, and fulfilling on `completed`
  // alone would start real production for an unpaid order the day someone switches one on.
  // The endpoint must be subscribed to all three events in Stripe's dashboard.
  const HANDLED_EVENTS = new Set([
    "checkout.session.completed",
    "checkout.session.async_payment_succeeded",
    "checkout.session.async_payment_failed"
  ]);
  if (!HANDLED_EVENTS.has(event.type)) {
    return new Response("ok", { status: 200 });
  }

  const session = event.data.object as Stripe.Checkout.Session;
  const orderId = session.metadata?.order_id;
  if (!orderId) {
    console.error(`stripe-webhook: session ${session.id} has no metadata.order_id`);
    return new Response("ok", { status: 200 }); // not a condition retrying will fix
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  if (event.type === "checkout.session.async_payment_failed") {
    // The money never arrived. Nothing was submitted to Printful (that waits for "paid"), so
    // closing the pending row is all there is to do.
    // stripe_payment_intent_id is cleared because order history reads "has a payment intent" as
    // "was paid" (listMyOrderHistory), and this one never was.
    await supabase
      .from("orders")
      .update({ status: "canceled", failure_reason: "Payment did not complete", stripe_payment_intent_id: null })
      .eq("id", orderId)
      .eq("status", "pending");
    return new Response("ok", { status: 200 });
  }
  if (session.payment_status !== "paid" && session.payment_status !== "no_payment_required") {
    // Recording the payment intent now marks the order as "checkout finished, money in
    // flight", which the hourly stale-pending cron (migration 0018) leaves alone -- a bank
    // debit can take days to settle, and cancelling at 24h would strand a real payment.
    await supabase
      .from("orders")
      .update({
        stripe_payment_intent_id:
          typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id ?? null
      })
      .eq("id", orderId)
      .eq("status", "pending");
    console.warn(
      `stripe-webhook: session ${session.id} completed with payment_status ` +
        `${session.payment_status} -- waiting for async_payment_succeeded`
    );
    return new Response("ok", { status: 200 });
  }

  const { data: order, error: fetchError } = await supabase
    .from("orders")
    .select("id, status")
    .eq("id", orderId)
    .maybeSingle();
  if (fetchError) {
    console.error("stripe-webhook: failed to look up order", fetchError);
    return new Response("Lookup failed", { status: 500 }); // transient -- let Stripe retry
  }
  if (!order) {
    console.error(`stripe-webhook: no order found for id ${orderId} (session ${session.id})`);
    return new Response("ok", { status: 200 });
  }
  if (order.status !== "pending") {
    // Already processed by an earlier delivery of this same event -- idempotent no-op.
    return new Response("ok", { status: 200 });
  }

  // Stripe API versions from 2025-03-31 onward moved shipping details under
  // collected_information (pre-2025-03-31 had a top-level session.shipping_details instead)
  // -- confirmed live against this account's webhook destination, pinned to 2026-06-24.dahlia.
  const shippingDetails = session.collected_information?.shipping_details;

  // .select() so we can see how many rows the guarded update actually claimed -- zero rows
  // is NOT an error to PostgREST. Without this check, two near-simultaneous deliveries of
  // the same event could both pass the status read above (both see 'pending'), both "update
  // successfully" (one matching a row, one matching none), and both submit a Printful order
  // -- double-producing a purchase the customer paid for once. Whichever delivery claims the
  // pending->paid transition proceeds; the other no-ops here.
  const { data: paidRows, error: paidError } = await supabase
    .from("orders")
    .update({
      status: "paid",
      // What order-watchdog measures a stuck order from (created_at is when checkout STARTED,
      // which can be most of a day earlier).
      paid_at: new Date().toISOString(),
      stripe_payment_intent_id:
        typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id,
      shipping_name: shippingDetails?.name ?? null,
      shipping_address: shippingDetails?.address ?? null,
      // The pending row's totals were estimates (tax isn't known until Stripe collects the
      // address at checkout) -- adopt Stripe's authoritative computed amounts, which include
      // shipping and tax. amount_subtotal is the pre-shipping/pre-tax items total.
      ...(typeof session.amount_subtotal === "number" ? { subtotal_cents: session.amount_subtotal } : {}),
      ...(typeof session.amount_total === "number" ? { total_cents: session.amount_total } : {})
    })
    .eq("id", orderId)
    .eq("status", "pending")
    .select("id");
  if (paidError) {
    console.error("stripe-webhook: failed to mark order paid", paidError);
    return new Response("Update failed", { status: 500 });
  }
  if (!paidRows || paidRows.length === 0) {
    // A concurrent delivery of this event won the pending->paid race -- idempotent no-op.
    return new Response("ok", { status: 200 });
  }

  // Payment is settled and the order claimed: rendering the print files and submitting to
  // Printful is process-order's job (2026-10-19). It answers at once and works in the background,
  // so Stripe gets its 200 without waiting on a render. If this kick fails or that run dies,
  // order-watchdog resumes the order within minutes -- the order is safely 'paid' either way.
  await kickProcessOrder(orderId);

  return new Response("ok", { status: 200 });
});
