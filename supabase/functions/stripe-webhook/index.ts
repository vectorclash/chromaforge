// Confirms a Stripe payment and submits the real Printful order. This is the only place
// orders transition past 'pending' -- see 0005_orders_schema.sql's header comment on why
// client-side writes are blocked by RLS.
//
// verify_jwt is explicitly false for this function (set in supabase/config.toml) -- Stripe's
// webhook caller carries no Supabase JWT at all, only a Stripe-Signature header. Auth here
// is entirely the signature check below, not Supabase's JWT gate.
//
// Printful order API: this function deliberately uses the STABLE v1 orders API, not the
// v2 beta. (The mockup pipeline followed it onto v1 on 2026-08-21, so nothing customer-facing
// depends on the beta any more.) Ported from v2 on 2026-07-15 after live-proving that
// v2's order pipeline fails any order containing the label_inside placement (~10-40s
// after creation, via async file processing, placements silently emptied) while v1
// processes the exact same product/placements/files cleanly -- verified with real draft
// orders 166979280 and 166981022 (all 8 zip-hoodie placements incl. label_inside, files
// all 'ok', stable). POST /orders creates a DRAFT, uncharged order by default; a separate
// POST /orders/{id}/confirm actually confirms/fulfills it. Since the customer has already
// paid via Stripe by the time this runs, we create + immediately confirm in one go --
// there's no reason to leave a paid order sitting as an unconfirmed draft.
//
// Deploy with: npx supabase functions deploy stripe-webhook --no-verify-jwt
// Needs: STRIPE_WEBHOOK_SECRET, PRINTFUL_API_KEY (same order-capable key the other two
// Printful functions use). SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY are auto-provided.
//
// Register the endpoint in Stripe's dashboard pointing at this function's URL, subscribed
// to checkout.session.completed, checkout.session.async_payment_succeeded and
// checkout.session.async_payment_failed (see the payment_status note in the handler).
//
// PRINTFUL_API_KEY is real and store-scoped -- Printful has no sandbox/test mode, so this
// always acts against your actual store. Set PRINTFUL_SKIP_CONFIRM=true while verifying the
// end-to-end flow (see below) so test purchases create an unconfirmed Printful draft instead
// of a real, billed, produced order; unset it once you're ready for real customers.

import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";
import { sendOrderFailureAlert } from "../_shared/orderAlert.ts";

const PRINTFUL_API_BASE = "https://api.printful.com";
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
    await sendOrderFailureAlert(orderId, "No order items found");
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
  // Branded packing slip -- the paper insert Printful puts in the box. Without this,
  // Printful falls back to its own default slip (no Chromaforge branding at all).
  // custom_order_id round-trips our own order uuid onto the slip/Printful dashboard, useful
  // for correlating a support inquiry back to this order without asking the customer for
  // their Printful order number. logo_url must be a publicly reachable image (not the SVG
  // wordmark -- Printful's slip renderer wants a raster image); apple-touch-icon.png is
  // already a square PNG mark built for exactly this kind of small-icon use.
  //
  // Real bug caught live (2026-07-17): a full order uuid (36 chars, dashes included) blew
  // past Printful's 20-char cap on custom_order_id and made POST /orders 400 outright --
  // Stripe had already charged the customer by this point, so this failed every single
  // order, not an edge case (every order id is a uuid). Fixed by stripping dashes and
  // truncating to 20 hex chars -- still enough of the real id for a support lookup
  // (`orders.id::text like '<prefix>%'`) against the full uuid stored in our own DB.
  const packingSlip = {
    email: "support@chromaforge.app",
    store_name: "Chromaforge",
    logo_url: "https://chromaforge.app/apple-touch-icon.png",
    message: "Thanks for supporting Chromaforge! chromaforge.app",
    custom_order_id: orderId.replace(/-/g, "").slice(0, 20)
  };

  const printfulOrderBody = {
    recipient: {
      name: shippingDetails?.name ?? session.customer_details?.name ?? "",
      // Without an email, Printful has no way to send the customer shipping/tracking
      // notifications -- they'd get nothing between the success page and the package.
      email: session.customer_details?.email ?? undefined,
      address1: shippingDetails?.address?.line1 ?? "",
      address2: shippingDetails?.address?.line2 ?? undefined,
      city: shippingDetails?.address?.city ?? "",
      country_code: shippingDetails?.address?.country ?? "",
      state_code: shippingDetails?.address?.state ?? "",
      zip: shippingDetails?.address?.postal_code ?? ""
    },
    packing_slip: packingSlip,
    items: items.map(item => ({
      quantity: item.quantity,
      variant_id: item.variant_id,
      // order_items.product_options is stored in the v2/mockup shape ({ name, value },
      // from PRODUCT_MOCKUP_CONFIG's productOptions); v1 item options use { id, value }.
      // Unlike v2, v1 HARD-REJECTS some products without their required option (confirmed
      // live: the zip hoodie 400s without an explicit stitch_color), so this mapping is
      // load-bearing, not cosmetic.
      ...(item.product_options
        ? {
            options: (item.product_options as Array<{ name: string; value: string }>).map(
              ({ name, value }) => ({ id: name, value })
            )
          }
        : {}),
      // v1 file types match our placement keys except 'front', which v1 calls 'default'.
      files: Object.entries(item.print_file_urls as Record<string, string>).map(
        ([placement, url]) => ({
          type: placement === "front" ? "default" : placement,
          url
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

  // One automatic retry before giving up, same pattern as useMockup.js's retry for
  // Printful's occasional transient "Internal Server Error". printfulOrderId is tracked
  // across attempts (not re-created each time) so a confirm-only failure retries just the
  // confirm call, not a second POST /orders -- otherwise a transient confirm failure would
  // leave an extra orphaned draft order sitting in the Printful dashboard.
  let printfulOrderId: string | number | null = null;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      if (!printfulOrderId) {
        const createRes = await fetch(`${PRINTFUL_API_BASE}/orders`, {
          method: "POST",
          headers: printfulHeaders,
          body: JSON.stringify(printfulOrderBody)
        });
        const createData = await createRes.json();
        if (!createRes.ok) {
          throw new Error(createData?.error?.message || `Printful order creation failed (${createRes.status})`);
        }
        printfulOrderId = createData.result?.id ?? createData.data?.id;
      }

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

      lastError = null;
      break;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error("Printful order submission failed");
      if (attempt === 0) {
        console.warn(`stripe-webhook: Printful submission attempt failed, retrying once: ${lastError.message}`);
        await new Promise(resolve => setTimeout(resolve, 1500));
      }
    }
  }

  if (!lastError) {
    await supabase
      .from("orders")
      .update({ status: "submitted", printful_order_id: String(printfulOrderId) })
      .eq("id", orderId);
  } else {
    // The customer has already paid at this point -- this is a flagged manual-ops gap, not
    // an auto-refund (see sendOrderFailureAlert's comment for why). The order-history UI
    // must show 'failed' distinctly so it doesn't look like a normal completed order.
    console.error(`stripe-webhook: Printful submission failed for order ${orderId}: ${lastError.message}`);
    // Keep Printful's id when the order WAS created and only confirmation failed: it is the
    // draft a human needs to find and confirm by hand, and printful-webhook matches later
    // events by it -- without it every update about that order is silently dropped.
    await supabase
      .from("orders")
      .update({
        status: "failed",
        failure_reason: lastError.message,
        ...(printfulOrderId ? { printful_order_id: String(printfulOrderId) } : {})
      })
      .eq("id", orderId);
    await sendOrderFailureAlert(
      orderId,
      printfulOrderId
        ? `${lastError.message} (Printful draft order ${printfulOrderId} exists and was not confirmed)`
        : lastError.message
    );
  }

  return new Response("ok", { status: 200 });
});
