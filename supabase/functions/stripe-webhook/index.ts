// Confirms a Stripe payment and submits the real Printful order. This is the only place
// orders transition past 'pending' -- see 0005_orders_schema.sql's header comment on why
// client-side writes are blocked by RLS.
//
// verify_jwt is explicitly false for this function (set in supabase/config.toml) -- Stripe's
// webhook caller carries no Supabase JWT at all, only a Stripe-Signature header. Auth here
// is entirely the signature check below, not Supabase's JWT gate.
//
// Printful order API (verified against https://developers.printful.com/docs/v2-beta/, not
// guessed): POST /v2/orders always creates a DRAFT, uncharged order; a separate
// POST /v2/orders/{id}/confirm actually confirms/fulfills it. Since the customer has
// already paid via Stripe by the time this runs, we create + immediately confirm in one go
// -- there's no reason to leave a paid order sitting as an unconfirmed draft.
//
// Deploy with: npx supabase functions deploy stripe-webhook --no-verify-jwt
// Needs: STRIPE_WEBHOOK_SECRET, PRINTFUL_API_KEY (same order-capable key the other two
// Printful functions use). SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY are auto-provided.
//
// Register the endpoint in Stripe's dashboard pointing at this function's URL, subscribed
// to checkout.session.completed only.
//
// PRINTFUL_API_KEY is real and store-scoped -- Printful has no sandbox/test mode, so this
// always acts against your actual store. Set PRINTFUL_SKIP_CONFIRM=true while verifying the
// end-to-end flow (see below) so test purchases create an unconfirmed Printful draft instead
// of a real, billed, produced order; unset it once you're ready for real customers.

import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";

const PRINTFUL_API_BASE = "https://api.printful.com/v2";
const STORE_ID = "18363066"; // same store as printful-mockup.js -- not a secret, just an account id

Deno.serve(async req => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const stripeKey = Deno.env.get("STRIPE_SECRET_KEY");
  const webhookSecret = Deno.env.get("STRIPE_WEBHOOK_SECRET");
  const printfulKey = Deno.env.get("PRINTFUL_API_KEY");
  if (!stripeKey || !webhookSecret || !printfulKey) {
    console.error("stripe-webhook: missing STRIPE_SECRET_KEY/STRIPE_WEBHOOK_SECRET/PRINTFUL_API_KEY");
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

  if (event.type !== "checkout.session.completed") {
    // Only subscribed to this event type in Stripe's dashboard, but acknowledge anything
    // else cleanly rather than erroring.
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

  const { error: paidError } = await supabase
    .from("orders")
    .update({
      status: "paid",
      stripe_payment_intent_id:
        typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id,
      shipping_name: shippingDetails?.name ?? null,
      shipping_address: shippingDetails?.address ?? null
    })
    .eq("id", orderId)
    .eq("status", "pending");
  if (paidError) {
    console.error("stripe-webhook: failed to mark order paid", paidError);
    return new Response("Update failed", { status: 500 });
  }

  const { data: items, error: itemsError } = await supabase
    .from("order_items")
    .select("*")
    .eq("order_id", orderId);
  if (itemsError || !items || items.length === 0) {
    console.error("stripe-webhook: no order_items found", itemsError);
    await supabase
      .from("orders")
      .update({ status: "failed", failure_reason: "No order items found" })
      .eq("id", orderId);
    return new Response("ok", { status: 200 });
  }

  const printfulHeaders = {
    Authorization: `Bearer ${printfulKey}`,
    "X-PF-Store-Id": STORE_ID,
    "Content-Type": "application/json"
  };

  // All current catalog products are all-over-print cut-and-sew garments/panels (see the
  // header comment in src/lib/printful.js) -- this is a stated, deliberate catalog-wide
  // policy of this app, not a per-order guess.
  const printfulOrderBody = {
    recipient: {
      name: shippingDetails?.name ?? session.customer_details?.name ?? "",
      address1: shippingDetails?.address?.line1 ?? "",
      address2: shippingDetails?.address?.line2 ?? undefined,
      city: shippingDetails?.address?.city ?? "",
      country_code: shippingDetails?.address?.country ?? "",
      state_code: shippingDetails?.address?.state ?? "",
      zip: shippingDetails?.address?.postal_code ?? ""
    },
    items: items.map(item => ({
      quantity: item.quantity,
      catalog_variant_id: item.variant_id,
      source: "catalog",
      ...(item.product_options ? { product_options: item.product_options } : {}),
      placements: Object.entries(item.print_file_urls as Record<string, string>).map(
        ([placement, url]) => ({
          placement,
          technique: "cut-sew",
          layers: [{ type: "file", url }]
        })
      )
    }))
  };

  // Printful has no sandbox -- this account/store is real regardless of which store id we
  // use, and confirming an order for real bills Printful's stored payment method and
  // triggers real production/shipping, completely independent of Stripe being in test mode.
  // PRINTFUL_SKIP_CONFIRM is a deliberate off-switch for end-to-end verification: with it
  // set, we still create the order (so we can confirm Printful accepts our request shape,
  // visible in the dashboard as an unconfirmed draft) but never call /confirm, so nothing is
  // ever actually charged or produced. Unset this secret before real customers can check out.
  const skipConfirm = Deno.env.get("PRINTFUL_SKIP_CONFIRM") === "true";

  try {
    const createRes = await fetch(`${PRINTFUL_API_BASE}/orders`, {
      method: "POST",
      headers: printfulHeaders,
      body: JSON.stringify(printfulOrderBody)
    });
    const createData = await createRes.json();
    if (!createRes.ok) {
      throw new Error(createData?.error?.message || `Printful order creation failed (${createRes.status})`);
    }
    const printfulOrderId = createData.result?.id ?? createData.data?.id;

    if (!skipConfirm) {
      const confirmRes = await fetch(`${PRINTFUL_API_BASE}/orders/${printfulOrderId}/confirm`, {
        method: "POST",
        headers: printfulHeaders
      });
      const confirmData = await confirmRes.json();
      if (!confirmRes.ok) {
        throw new Error(confirmData?.error?.message || `Printful order confirmation failed (${confirmRes.status})`);
      }
    } else {
      console.warn(
        `stripe-webhook: PRINTFUL_SKIP_CONFIRM is set -- order ${printfulOrderId} left as an ` +
          `unconfirmed draft, not charged or produced. Unset this secret before going live.`
      );
    }

    await supabase
      .from("orders")
      .update({ status: "submitted", printful_order_id: String(printfulOrderId) })
      .eq("id", orderId);
  } catch (err) {
    // The customer has already paid at this point -- this is a flagged manual-ops gap, not
    // an auto-refund. The order-history UI must show 'failed' distinctly so it doesn't look
    // like a normal completed order.
    const message = err instanceof Error ? err.message : "Printful order submission failed";
    console.error(`stripe-webhook: Printful submission failed for order ${orderId}: ${message}`);
    await supabase.from("orders").update({ status: "failed", failure_reason: message }).eq("id", orderId);
  }

  return new Response("ok", { status: 200 });
});
