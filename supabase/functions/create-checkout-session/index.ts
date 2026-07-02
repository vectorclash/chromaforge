// Creates a Stripe Checkout Session for a real Printful purchase. This is the one place a
// "pending" order gets written -- using the service role, since RLS deliberately has no
// insert policy for the `authenticated` role (see 0005_orders_schema.sql's header comment).
// The transition to 'paid'/'submitted'/'failed' only ever happens in stripe-webhook, once a
// real Stripe payment is confirmed; a stray 'pending' row with no completed payment is
// harmless and never surfaces in order history.
//
// v1 checkout ships with whatever the client already rendered+uploaded as printFileUrls
// (the same capped-resolution browser render the mockup-preview pipeline uses, just for
// every placement instead of only the visible ones -- see src/lib/printful.js's
// generatePrintFileUrls). True print-resolution rendering is a later, separate phase that
// only needs to change how printFileUrls is produced client-side, not anything here.
//
// Deploy with: npx supabase functions deploy create-checkout-session
// Needs these secrets set: STRIPE_SECRET_KEY, PRINTFUL_API_KEY (already set for the other
// two Printful functions; same key, already order-capable -- see printful-catalog's header
// comment). SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY are auto-provided by the platform, no
// need to set them.

import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";
import { applyMarkup } from "../_shared/pricing.ts";
import { isStoreEnabled } from "../_shared/storeStatus.ts";
import { buildShippingOptions, estimateShippingCents } from "../_shared/shipping.ts";
import { toCompactDesign } from "../_shared/compactDesign.ts";

const PRINTFUL_API_BASE = "https://api.printful.com";

// Constrain to countries Printful can actually fulfill to. This list is a conservative
// starting set (English-speaking + EU markets), not a verified enumeration of Printful's
// full shipping coverage -- expand it deliberately, checked against Printful's supported
// countries, rather than just allow-listing everything Stripe supports (a customer paying
// for shipping to a country Printful then rejects is a worse failure than a country being
// briefly unavailable at checkout).
const ALLOWED_SHIPPING_COUNTRIES = [
  "US", "CA", "GB", "AU", "NZ", "IE",
  "DE", "FR", "ES", "IT", "NL", "BE", "AT", "SE", "DK", "FI", "PT", "PL"
];

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async req => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405, headers: corsHeaders });
  }

  // Defense in depth: ProductPage.jsx already hides/disables Buy Now when the store is
  // flagged off, but a tab left open from before the flag was flipped could still hit this
  // endpoint directly -- reject here too rather than trusting the client-side check alone.
  if (!isStoreEnabled()) {
    return Response.json(
      { error: "Store purchasing is temporarily offline. Please check back soon." },
      { status: 503, headers: corsHeaders }
    );
  }

  const stripeKey = Deno.env.get("STRIPE_SECRET_KEY");
  const printfulKey = Deno.env.get("PRINTFUL_API_KEY");
  if (!stripeKey || !printfulKey) {
    return Response.json(
      { error: "STRIPE_SECRET_KEY/PRINTFUL_API_KEY is not configured on this function" },
      { status: 500, headers: corsHeaders }
    );
  }

  const authHeader = req.headers.get("Authorization") ?? "";
  const jwt = authHeader.replace(/^Bearer\s+/i, "");
  if (!jwt) {
    return Response.json({ error: "Sign in required" }, { status: 401, headers: corsHeaders });
  }

  // Service role for both identifying the caller (auth.getUser accepts any user JWT
  // regardless of which key the client was constructed with) and for the pending-order
  // insert below, which RLS would otherwise block.
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  const { data: userData, error: userError } = await supabase.auth.getUser(jwt);
  if (userError || !userData.user) {
    return Response.json({ error: "Sign in required" }, { status: 401, headers: corsHeaders });
  }
  const userId = userData.user.id;

  const body = await req.json();
  const {
    productId,
    productTitle,
    variantId,
    variantLabel,
    quantity,
    design,
    printFileUrls,
    productOptions
  } = body;
  if (!productId || !variantId || !quantity || !design || !printFileUrls) {
    return Response.json({ error: "Missing required fields" }, { status: 400, headers: corsHeaders });
  }
  // The UI caps quantity at 1-10 (ProductPage's stepper), but nothing stops a direct call
  // from sending -1, 2.5, "999999", etc. -- and this value multiplies straight into the
  // Stripe charge and the Printful production run. Enforce the same bounds server-side.
  const qty = Number(quantity);
  if (!Number.isInteger(qty) || qty < 1 || qty > 10) {
    return Response.json({ error: "Quantity must be between 1 and 10" }, { status: 400, headers: corsHeaders });
  }

  // Re-price server-side -- never trust a client-supplied price for the actual Stripe
  // charge amount. Same v1 product endpoint printful-catalog already proxies.
  const productRes = await fetch(`${PRINTFUL_API_BASE}/products/${productId}`, {
    headers: { Authorization: `Bearer ${printfulKey}` }
  });
  if (!productRes.ok) {
    return Response.json({ error: "Could not verify product price" }, { status: 502, headers: corsHeaders });
  }
  const productData = await productRes.json();
  const variant = productData.result?.variants?.find((v: { id: number }) => v.id === variantId);
  if (!variant) {
    return Response.json({ error: "Unknown variant" }, { status: 400, headers: corsHeaders });
  }
  const unitPriceCents = applyMarkup(Math.round(parseFloat(variant.price) * 100));
  const totalCents = unitPriceCents * qty;

  // Weight-class + region shipping (see _shared/shipping.ts for the real Printful rates
  // this is derived from, and why hosted Checkout can't calculate this live off the address
  // the customer types). Multiple region-labeled options are offered in the same session;
  // the customer picks whichever matches their own address. SHIPPING_FLAT_CENTS still works
  // as an emergency override back to a single flat rate (or 0 to disable shipping
  // entirely), no redeploy needed -- same escape hatch as before.
  const shippingOptions = buildShippingOptions(productId);
  const estimatedShippingCents = estimateShippingCents(productId);

  // Stripe Tax (automatic_tax) -- requires one-time activation in the Stripe dashboard
  // (Settings -> Tax: origin address + a registration). If a session errors with a tax
  // configuration message before that's done, set STRIPE_AUTOMATIC_TAX=false to unblock
  // checkout while sorting the dashboard side out. Same fail-open literal-"false" pattern
  // as STORE_ENABLED.
  const automaticTax = Deno.env.get("STRIPE_AUTOMATIC_TAX") !== "false";

  const stripe = new Stripe(stripeKey, { apiVersion: "2026-06-24.dahlia" });

  // Insert the pending order + its single item first, so the Checkout Session's metadata
  // can carry just the order id (Stripe metadata values cap at 500 chars -- nowhere near
  // enough for a full design jsonb -- so the design/printFileUrls live in our own DB row,
  // not in Stripe).
  const { data: order, error: orderError } = await supabase
    .from("orders")
    .insert({
      user_id: userId,
      status: "pending",
      stripe_session_id: crypto.randomUUID(), // placeholder, overwritten below once the real session exists
      currency: "usd",
      // Estimates: shipping is a US-rate estimate here (the customer hasn't picked their
      // region yet -- see _shared/shipping.ts) and tax isn't known at all (Stripe computes
      // it at checkout, after the address is collected). stripe-webhook overwrites both
      // with Stripe's authoritative amount_subtotal/amount_total once payment completes.
      subtotal_cents: totalCents,
      total_cents: totalCents + estimatedShippingCents
    })
    .select()
    .single();
  if (orderError || !order) {
    return Response.json({ error: "Could not start order" }, { status: 500, headers: corsHeaders });
  }

  const { error: itemError } = await supabase.from("order_items").insert({
    order_id: order.id,
    product_id: productId,
    variant_id: variantId,
    product_title: productTitle,
    variant_label: variantLabel,
    quantity: qty,
    unit_price_cents: unitPriceCents,
    design_data: toCompactDesign(design),
    print_file_urls: printFileUrls,
    product_options: productOptions ?? null
  });
  if (itemError) {
    await supabase.from("orders").update({ status: "canceled" }).eq("id", order.id);
    return Response.json({ error: "Could not start order" }, { status: 500, headers: corsHeaders });
  }

  const origin = req.headers.get("origin") ?? new URL(req.url).origin;
  let session;
  try {
    session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: { name: `${productTitle}${variantLabel ? ` (${variantLabel})` : ""}` },
            unit_amount: unitPriceCents,
            // Prices are set pre-tax; Stripe Tax adds tax on top rather than carving it
            // out of the listed price.
            tax_behavior: "exclusive"
          },
          quantity: qty
        }
      ],
      automatic_tax: { enabled: automaticTax },
      ...(shippingOptions.length > 0 ? { shipping_options: shippingOptions } : {}),
      shipping_address_collection: { allowed_countries: ALLOWED_SHIPPING_COUNTRIES },
      success_url: `${origin}/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/shop/${productId}?checkout=canceled`,
      metadata: { order_id: order.id }
    });
  } catch (err) {
    await supabase.from("orders").update({ status: "canceled" }).eq("id", order.id);
    return Response.json(
      { error: err instanceof Error ? err.message : "Could not create checkout session" },
      { status: 500, headers: corsHeaders }
    );
  }

  await supabase.from("orders").update({ stripe_session_id: session.id }).eq("id", order.id);

  return Response.json({ url: session.url, orderId: order.id }, { headers: corsHeaders });
});
