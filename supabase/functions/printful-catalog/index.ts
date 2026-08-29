// Proxies Printful's public catalog (GET /products, GET /products/:id) so the browser
// never needs the Printful private API token -- that token can create real orders and
// manage files, so it must stay server-side. This function only ever reads catalog data;
// it has no write path to Printful, which keeps its blast radius small even if something
// upstream of it were ever compromised.
//
// Deploy with: npx supabase functions deploy printful-catalog
// Set the secret once with: npx supabase secrets set PRINTFUL_API_KEY=<key>

import { applyMarkup } from "../_shared/pricing.ts";
import { isStoreEnabled } from "../_shared/storeStatus.ts";

const PRINTFUL_API_BASE = "https://api.printful.com";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async req => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  if (req.method !== "GET") {
    return Response.json({ error: "Method not allowed" }, { status: 405, headers: corsHeaders });
  }

  const apiKey = Deno.env.get("PRINTFUL_API_KEY");
  if (!apiKey) {
    return Response.json(
      { error: "PRINTFUL_API_KEY is not configured on this function" },
      { status: 500, headers: corsHeaders }
    );
  }

  const url = new URL(req.url);
  // /printful-catalog                       -> GET /products (list)
  // /printful-catalog?id=123                -> GET /products/123 (one product + variants)
  // /printful-catalog?id=123&printfiles=1    -> GET /mockup-generator/printfiles/123
  //   (per-placement print area specs: width/height px, dpi, fill_mode -- this is what
  //   differs between e.g. a shirt's front/back vs its sleeves, and what we need before
  //   ever generating a real print file for an order)
  // /printful-catalog?id=123&templates=1     -> GET /mockup-generator/templates/123
  //   (per-placement print-area POSITIONS within each mockup template photo -- multiple
  //   placements share one photo on cut-sew products, so this is the geometry that relates
  //   one panel's physical location to another's, e.g. where the hoodie pocket sits
  //   relative to the front panel for lib/printful.js's pocketCrop continuity math)
  // /printful-catalog?id=123&sizes=1         -> GET /products/123/sizes
  // /printful-catalog?id=123&styles=1        -> GET /v2/catalog-products/123/mockup-styles,
  //     reduced to the distinct style GROUP names. The client turns those into the
  //     option_groups a mockup task asks for (src/lib/printfulViewPolicy.js) -- deciding it
  //     client-side keeps ONE implementation of that policy, shared with the checker, instead
  //     of a Deno copy that would drift the way the placements list did.
  //   (the published size guide: body measurements per size, flat garment measurements,
  //   and Printful's own measuring diagrams -- see components/ui/SizeGuideModal.jsx)
  const productId = url.searchParams.get("id");
  const categoryId = url.searchParams.get("category_id");
  const wantsPrintfiles = url.searchParams.get("printfiles") === "1";
  const wantsTemplates = url.searchParams.get("templates") === "1";
  const wantsSizes = url.searchParams.get("sizes") === "1";
  const wantsStyles = url.searchParams.get("styles") === "1";

  let printfulUrl;
  if (productId && wantsPrintfiles) {
    printfulUrl = new URL(`${PRINTFUL_API_BASE}/mockup-generator/printfiles/${productId}`);
  } else if (productId && wantsTemplates) {
    printfulUrl = new URL(`${PRINTFUL_API_BASE}/mockup-generator/templates/${productId}`);
  } else if (productId && wantsStyles) {
    printfulUrl = new URL(`${PRINTFUL_API_BASE}/v2/catalog-products/${productId}/mockup-styles`);
  } else if (productId && wantsSizes) {
    // unit is fixed to inches; the modal converts to cm client-side rather than spending a
    // second upstream request (and a second cache entry) on the same numbers.
    printfulUrl = new URL(`${PRINTFUL_API_BASE}/products/${productId}/sizes`);
    printfulUrl.searchParams.set("unit", "inches");
  } else {
    printfulUrl = new URL(`${PRINTFUL_API_BASE}/products${productId ? `/${productId}` : ""}`);
    if (categoryId) printfulUrl.searchParams.set("category_id", categoryId);
  }

  const printfulRes = await fetch(printfulUrl, {
    headers: { Authorization: `Bearer ${apiKey}` }
  });

  const data = await printfulRes.json();

  // Reduce the mockup-styles payload to the distinct group names before it leaves here. The raw
  // response is hundreds of style entries repeated per variant group (358 on the hoodie), and the
  // only thing the policy needs is the set of names.
  if (wantsStyles) {
    const names = new Set<string>();
    for (const entry of (data?.data ?? [])) {
      for (const style of (entry?.mockup_styles ?? [])) {
        if (style?.category_name) names.add(style.category_name);
      }
    }
    return Response.json({ result: [...names] }, { status: printfulRes.status, headers: corsHeaders });
  }

  // Single-product responses carry each variant's cost price -- mark it up here so the
  // price the customer sees on the product page matches what create-checkout-session
  // actually charges (same applyMarkup, same PRICE_MARKUP_PERCENT secret).
  if (productId && !wantsPrintfiles && !wantsSizes) {
    if (Array.isArray(data.result?.variants)) {
      for (const variant of data.result.variants) {
        if (typeof variant.price === "string") {
          variant.price = (applyMarkup(Math.round(parseFloat(variant.price) * 100)) / 100).toFixed(2);
        }
      }
    }
    // Store-wide purchasing kill switch (see _shared/storeStatus.ts) -- attached here since
    // this is the one response ProductPage.jsx's Buy Now gating actually reads.
    data.storeEnabled = isStoreEnabled();
  }

  return Response.json(data, { status: printfulRes.status, headers: corsHeaders });
});
