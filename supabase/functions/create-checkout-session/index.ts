// Creates a Stripe Checkout Session for a real Printful purchase. This is the one place a
// "pending" order gets written -- using the service role, since RLS deliberately has no
// insert policy for the `authenticated` role (see 0005_orders_schema.sql's header comment).
// The transition to 'paid'/'submitted'/'failed' only ever happens in stripe-webhook, once a
// real Stripe payment is confirmed; a stray 'pending' row with no completed payment is
// harmless and never surfaces in order history.
//
// Print files are rendered AFTER payment (2026-10-19). The browser sends `printJobs` -- one render
// request per placement, the body it used to send render-print-file itself -- which are checked
// against Printful's printfile specs (_shared/printJobs.ts) and stored on the order item;
// process-order renders them once Stripe confirms the money. `printFileUrls` still carries the
// small label marks, which the browser renders and uploads itself (they take milliseconds, and
// their ink is chosen from the same sample the approved mockup used). A tab loaded before this
// change sends finished URLs for every placement and no jobs; that still works, process-order
// just has nothing to render.
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
import { buildShippingOptions, estimateShippingCents, isSellableProduct } from "../_shared/shipping.ts";
import { toCompactDesign } from "../_shared/compactDesign.ts";
import { checkRateLimit } from "../_shared/rateLimit.ts";
import { fetchPrintfileSpecs, validatePrintJobs } from "../_shared/printJobs.ts";

// Checkout-session creation hits Printful's live product-price endpoint and writes a
// pending order row per call -- a signed-in account scripting this repeatedly is real cost
// (Printful API quota) and DB noise, even though nothing is charged until Stripe redirects
// back through the webhook. Looser than the render/mockup limits since a real shopper
// might legitimately retry a session a few times (browser back button, changed quantity).
const RATE_LIMIT = 10;
const RATE_LIMIT_WINDOW_SECONDS = 60;

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

// The live site's generator version, from the /version.json every build publishes (vite.config.mjs).
// It is the version render-service runs whenever the store is open: a generator bump deploys
// render-service and the site together inside a paused-store window. Read from the site rather
// than from render-service so a Buy Now never waits on a cold Fly machine. Fails OPEN -- an
// unreachable or malformed file means no check, and process-order's version hold is still there.
const STALE_PAGE_MESSAGE =
  "Chromaforge has been updated since this page loaded. Reload the page, check your preview, then buy again.";
async function fetchLiveGeneratorVersion(): Promise<number | null> {
  try {
    const res = await fetch(`https://chromaforge.app/version.json?t=${Date.now()}`, {
      signal: AbortSignal.timeout(2500)
    });
    if (!res.ok) return null;
    const { generatorVersion } = await res.json();
    return Number.isInteger(generatorVersion) ? generatorVersion : null;
  } catch {
    return null;
  }
}

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

  const withinLimit = await checkRateLimit(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    userId,
    "create-checkout-session",
    RATE_LIMIT,
    RATE_LIMIT_WINDOW_SECONDS
  );
  if (!withinLimit) {
    return Response.json(
      { error: "Too many checkout attempts. Please wait a moment and try again." },
      { status: 429, headers: corsHeaders }
    );
  }

  const body = await req.json();
  const {
    productId,
    productTitle,
    variantId,
    variantLabel,
    quantity,
    design,
    secondaryDesign,
    printFileUrls,
    printJobs,
    productOptions,
    mockupImageUrl,
    guessedRegion
  } = body;
  if (!productId || !variantId || !quantity || !design || (!printFileUrls && !printJobs)) {
    return Response.json({ error: "Missing required fields" }, { status: 400, headers: corsHeaders });
  }
  // Only products this store sells, by numeric id. productId is also interpolated into the
  // Printful URL below, which is sent with the store's private key.
  if (!Number.isInteger(productId) || !isSellableProduct(productId) || !Number.isInteger(variantId)) {
    return Response.json({ error: "Unknown product" }, { status: 400, headers: corsHeaders });
  }

  // printFileUrls goes to Printful verbatim as the files to PRINT, so it must be artwork this
  // app rendered for this customer: every URL a file in the caller's own folder of our own
  // bucket (render-print-file and uploadMockupSourceImage both write there, and Storage RLS
  // stops anyone writing into someone else's). Without this, a direct call could pay to have
  // any image on the internet printed under the Chromaforge name. Keys are Printful placement
  // names; Printful itself rejects one that does not exist on the product.
  const ownFilePrefix = `${Deno.env.get("SUPABASE_URL")}/storage/v1/object/public/design-mockups/${userId}/`;
  const fileEntries =
    printFileUrls && typeof printFileUrls === "object" && !Array.isArray(printFileUrls)
      ? Object.entries(printFileUrls as Record<string, unknown>)
      : [];
  // With print jobs, the files are only the label marks, and a product may have none.
  const filesValid =
    (printJobs ? true : fileEntries.length > 0) &&
    fileEntries.length <= 20 &&
    fileEntries.every(
      ([key, url]) =>
        /^[a-z0-9_]{1,40}$/.test(key) &&
        typeof url === "string" &&
        url.startsWith(ownFilePrefix) &&
        /^[A-Za-z0-9_.-]{1,200}$/.test(url.slice(ownFilePrefix.length)) &&
        !url.includes("..")
    );
  if (!filesValid) {
    return Response.json({ error: "Invalid print files" }, { status: 400, headers: corsHeaders });
  }

  // The UI caps quantity at 1-10 (ProductPage's stepper), but nothing stops a direct call
  // from sending -1, 2.5, "999999", etc. -- and this value multiplies straight into the
  // Stripe charge and the Printful production run. Enforce the same bounds server-side.
  const qty = Number(quantity);
  if (!Number.isInteger(qty) || qty < 1 || qty > 10) {
    return Response.json({ error: "Quantity must be between 1 and 10" }, { status: 400, headers: corsHeaders });
  }

  // Re-price server-side -- never trust a client-supplied price for the actual Stripe
  // charge amount. Same v1 product endpoint printful-catalog already proxies. The printfile
  // specs (only needed to check print jobs) are fetched alongside it.
  const [productRes, printfileSpecs] = await Promise.all([
    fetch(`${PRINTFUL_API_BASE}/products/${productId}`, {
      headers: { Authorization: `Bearer ${printfulKey}` }
    }),
    printJobs ? fetchPrintfileSpecs(productId, printfulKey) : Promise.resolve(null)
  ]);
  if (!productRes.ok) {
    return Response.json({ error: "Could not verify product price" }, { status: 502, headers: corsHeaders });
  }
  const productData = await productRes.json();
  const variant = productData.result?.variants?.find((v: { id: number }) => v.id === variantId);
  if (!variant) {
    return Response.json({ error: "Unknown variant" }, { status: 400, headers: corsHeaders });
  }
  // Every print job must be a render of the ordered design onto Printful's own printfile for
  // that placement -- see _shared/printJobs.ts. A placement is either a job or a finished file,
  // never both.
  let validatedJobs: Record<string, unknown> | null = null;
  if (printJobs) {
    if (!printfileSpecs) {
      return Response.json({ error: "Could not verify print files" }, { status: 502, headers: corsHeaders });
    }
    const result = validatePrintJobs(printJobs, {
      specs: printfileSpecs,
      variantId,
      designs: secondaryDesign ? [design, secondaryDesign] : [design]
    });
    if ("error" in result) {
      return Response.json({ error: result.error }, { status: 400, headers: corsHeaders });
    }
    if (Object.keys(result.jobs).length === 0 || fileEntries.some(([key]) => key in result.jobs)) {
      return Response.json({ error: "Invalid print jobs" }, { status: 400, headers: corsHeaders });
    }
    validatedJobs = result.jobs;
    // A tab loaded before a generator bump describes its designs with code render-service no
    // longer runs. Taking its money would only end in a held order (process-order never prints a
    // picture the customer did not see), so refuse here, before Stripe, and ask for a reload.
    const liveVersion = await fetchLiveGeneratorVersion();
    if (liveVersion !== null && Object.values(result.jobs).some(job => job.design.generatorVersion !== liveVersion)) {
      return Response.json({ error: STALE_PAGE_MESSAGE }, { status: 409, headers: corsHeaders });
    }
  }

  const unitPriceCents = applyMarkup(Math.round(parseFloat(variant.price) * 100));
  // A marked-up price that is not a positive whole number of cents means PRICE_MARKUP_PERCENT
  // is malformed (Number("abc") is NaN) -- refuse rather than hand Stripe a NaN charge.
  if (!Number.isInteger(unitPriceCents) || unitPriceCents <= 0) {
    console.error(`create-checkout-session: bad unit price ${unitPriceCents} -- check PRICE_MARKUP_PERCENT`);
    return Response.json({ error: "Could not verify product price" }, { status: 500, headers: corsHeaders });
  }
  // The title on the Stripe page and the order record comes from Printful, not the request.
  // The variant label is ours to compose client-side ("L / Black stitching") but is bounded.
  const lineTitle: string = productData.result?.product?.title ?? String(productTitle ?? "Chromaforge print");
  const lineVariant: string | null =
    typeof variantLabel === "string" && variantLabel.length > 0 ? variantLabel.slice(0, 80) : null;
  const totalCents = unitPriceCents * qty;

  // Weight-class + region shipping (see _shared/shipping.ts for the real Printful rates
  // this is derived from, and why hosted Checkout can't calculate this live off the address
  // the customer types). Multiple region-labeled options are offered in the same session;
  // the customer picks whichever matches their own address. SHIPPING_FLAT_CENTS still works
  // as an emergency override back to a single flat rate (or 0 to disable shipping
  // entirely), no redeploy needed -- same escape hatch as before.
  // totalCents rides along because UK/EU shipping carries a share of the item price -- see
  // REGION_ITEM_SHARE in _shared/shipping.ts.
  const shippingOptions = buildShippingOptions(productId, guessedRegion, totalCents);
  const estimatedShippingCents = estimateShippingCents(productId);

  // Stripe Tax (automatic_tax) -- requires one-time activation in the Stripe dashboard
  // (Settings -> Tax: origin address + a registration). If a session errors with a tax
  // configuration message before that's done, set STRIPE_AUTOMATIC_TAX=false to unblock
  // checkout while sorting the dashboard side out. Same fail-open literal-"false" pattern
  // as STORE_ENABLED.
  const automaticTax = Deno.env.get("STRIPE_AUTOMATIC_TAX") !== "false";

  // Stripe requires product images to be publicly reachable https URLs -- mockupImageUrl is
  // client-supplied, so validate the scheme rather than trusting it blindly (worst case of a
  // bad value here is just a broken line-item image, but no reason to forward garbage to
  // Stripe's API).
  const mockupImages =
    typeof mockupImageUrl === "string" && mockupImageUrl.startsWith("https://") ? [mockupImageUrl] : [];

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
    product_title: lineTitle,
    variant_label: lineVariant,
    quantity: qty,
    unit_price_cents: unitPriceCents,
    // Audit copy of what was actually printed. On a reversible product the customer can
    // choose a second design for the inside face (see lib/printful.js's
    // getSecondaryDesignConfig), and the primary alone wouldn't describe half the garment --
    // so it rides in the same write-only jsonb rather than a new column. Absent (the normal
    // case, and every other product) leaves the shape byte-identical to before.
    design_data: {
      ...toCompactDesign(design),
      ...(secondaryDesign ? { secondaryDesign: toCompactDesign(secondaryDesign) } : {})
    },
    // Finished files (the label marks, or every placement from an older tab); process-order adds
    // each rendered print file here as it lands.
    print_file_urls: printFileUrls ?? {},
    print_jobs: validatedJobs,
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
            product_data: {
              name: `${lineTitle}${lineVariant ? ` (${lineVariant})` : ""}`,
              ...(mockupImages.length > 0 ? { images: mockupImages } : {})
            },
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
      metadata: { order_id: order.id },
      // Statement descriptor suffix: shows on the customer's card statement appended to the
      // account's registered short name, so a Chromaforge charge is recognizable instead of
      // a generic default. Custom text: small branded touches on Stripe's hosted page --
      // deliberately no shipping/production-time claim here since none is verified/committed
      // to elsewhere in the app.
      payment_intent_data: { statement_descriptor_suffix: "CHROMAFORGE" },
      custom_text: {
        submit: {
          message: "Your Chromaforge design is printed to order by our print partner."
        },
        after_submit: {
          message: "Thanks for your order! You'll receive tracking details by email once it ships."
        }
      }
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
