import { supabase, isSupabaseConfigured } from './supabase';

// Catalog browsing only -- goes through the printful-catalog Edge Function so the
// Printful private API key (which can create real orders) never reaches the browser.
// See supabase/functions/printful-catalog/index.ts.

// We're only ever printing on all-over-print (AOP) goods -- the artwork covers the
// entire garment rather than sitting in a single placement, which fits this app's
// full-bleed generative pieces much better than a small front/back logo print would.
// Printful's full catalog is thousands of products with wildly different print specs
// even within AOP (the t-shirt needs 4 separate placements at 2 aspect ratios; the
// hoodie instead uses one big cut-and-sew printfile for the whole garment -- see
// getPrintfileSpecs). Every entry here is spec-verified (a real mockup task created and
// confirmed completed) before being added -- see PRODUCT_MOCKUP_CONFIG below for the
// per-product placement/option quirks that verification turned up.
// Order here is the display order in the shop (clothing first, then accessories/home
// goods) -- see ShopPage.jsx/ShopCarousel.jsx, which build their product list by mapping
// over this array rather than the catalog response's order.
export const STARTER_PRODUCT_IDS = [
  257, // All-Over Print Men's Crew Neck T-Shirt
  388, // All-Over Print Recycled Unisex Hoodie
  320, // All-Over Print Recycled Unisex Sweatshirt
  261, // All-Over Print Women's Crew Neck T-Shirt
  693, // All-Over Print Recycled Unisex Mesh Shorts
  717, // All-Over Print Recycled Unisex Zip Hoodie
  784, // All-Over Print Unisex Wide-Leg Joggers
  801, // All-Over Print Recycled Unisex Track Jacket
  274, // All-Over Print Large Tote Bag w/ Pocket
  744, // All-Over Print Utility Crossbody Bag
  83, // All-Over Print Basic Pillow
];

export async function listCatalogProducts({ categoryId = null } = {}) {
  if (!isSupabaseConfigured) throw new Error('Supabase is not configured.');
  const path = categoryId ? `printful-catalog?category_id=${categoryId}` : 'printful-catalog';
  const { data, error } = await supabase.functions.invoke(path, { method: 'GET' });
  if (error) throw error;
  return data.result;
}

export async function getCatalogProduct(productId) {
  if (!isSupabaseConfigured) throw new Error('Supabase is not configured.');
  const { data, error } = await supabase.functions.invoke(`printful-catalog?id=${productId}`, {
    method: 'GET'
  });
  if (error) throw error;
  return { ...data.result, variants: sortVariantsBySize(data.result.variants) };
}

// Printful's GET /products/:id doesn't guarantee variant order -- it's whatever order the
// product was set up in upstream, which isn't necessarily small-to-large and can apparently
// change. Re-sort client-side so the size picker is always small to large, grouped by color
// (in the order colors first appear) so each color's sizes run together instead of
// interleaving across colors.
const SIZE_ORDER = ['2XS', 'XS', 'S', 'M', 'L', 'XL', '2XL', '3XL', '4XL', '5XL', '6XL', '7XL'];

function sizeRank(size) {
  const idx = SIZE_ORDER.indexOf(String(size).toUpperCase().trim());
  if (idx !== -1) return idx;
  // Non-letter sizes (e.g. pillow dimensions like '18"×18"', waist measurements) -- sort by
  // their leading number, after all named sizes.
  const num = parseFloat(size);
  return Number.isNaN(num) ? Infinity : SIZE_ORDER.length + num;
}

function sortVariantsBySize(variants) {
  const colorOrder = new Map();
  variants.forEach(v => {
    if (!colorOrder.has(v.color)) colorOrder.set(v.color, colorOrder.size);
  });
  return [...variants].sort((a, b) => {
    const colorDiff = colorOrder.get(a.color) - colorOrder.get(b.color);
    return colorDiff !== 0 ? colorDiff : sizeRank(a.size) - sizeRank(b.size);
  });
}

// Per-placement print area specs (width/height px, dpi, fill_mode) plus which printfile
// each variant uses for each placement. This is what differs between e.g. a shirt's
// front/back and its sleeves -- needed before generating any real print file.
export async function getPrintfileSpecs(productId) {
  if (!isSupabaseConfigured) throw new Error('Supabase is not configured.');
  const { data, error } = await supabase.functions.invoke(
    `printful-catalog?id=${productId}&printfiles=1`,
    { method: 'GET' }
  );
  if (error) throw error;
  return data.result;
}

const MOCKUP_BUCKET = 'design-mockups';

// Confirmed live: every product below is constructed as an all-over cut-and-sew garment
// or panel (printed fabric pieces sewn together), not DTG-on-a-flat-placement, so they all
// use the same Printful "technique" value, and all require a stitch_color product option --
// Printful rejects the task without it even though it's not obviously implied by anything
// in getPrintfileSpecs (GET /products/{id} -> result.product.options lists which products
// need this and which values are valid -- e.g. the tote bag/crossbody bag only accept
// black/clear, not white; there's no generic way to detect "required" from that response,
// so this is a small hand-verified map rather than something derived).
//
// `mockupStyleIds` picks which photographed camera angles come back (GET
// /v2/catalog-products/{id}/mockup-styles lists the options -- each product has dozens:
// Flat Front/Back, Men's/Women's on-model, Lifestyle, Ghost, etc.). Every entry below
// requests the catalog's "Flat Front" + "Flat Back" style pair, confirmed live to return
// two distinct images. Omitting mockup_style_ids entirely makes Printful silently default
// to one single style no matter how many placements are submitted.
//
// `placements` is a DIFFERENT axis: it's which panels of the garment have artwork on them
// *within* a single photo, not how many photos come back. A "Front" style photo of a hoodie
// shows the front torso, hood, both sleeves, and the pocket all at once -- each is its own
// placement, and any placement left out renders as blank/undecorated fabric in that panel
// (confirmed live -- a front+back-only submission left the hood/sleeves/pocket plain white
// in an otherwise-correct front photo). So `placements` here is every placement visible
// from the Front/Back styles requested, not a trimmed-down subset -- the one exception is
// the track jacket (801), where submitting `details` together with the sleeve placements
// confirmed live to fail the whole task outright with an opaque "Internal Server Error"
// (isolated by testing subsets: front+back+sleeves+pocket succeeds, front+back+details
// alone succeeds, but adding sleeves and details together fails every time). Its placement
// list below omits `details` for that reason -- front+back+sleeves+pocket already renders
// every visible panel. Label/inside-label/inside-pocket placements are never included since
// they're not visible in any Front/Back photo. A real print order still needs every
// placement filled in regardless of what's visible in a preview photo -- that's a separate,
// not-yet-built concern (no checkout exists yet) from generating a mockup.
const PRODUCT_MOCKUP_CONFIG = {
  257: {
    technique: 'cut-sew',
    productOptions: [{ name: 'stitch_color', value: 'white' }],
    placements: ['default', 'back', 'sleeve_left', 'sleeve_right'],
    mockupStyleIds: [15714, 15715]
  }, // men's t-shirt
  388: {
    technique: 'cut-sew',
    productOptions: [{ name: 'stitch_color', value: 'white' }],
    placements: ['front', 'back', 'sleeve_left', 'sleeve_right', 'hood', 'pocket'],
    mockupStyleIds: [20169, 20170]
  }, // hoodie
  320: {
    technique: 'cut-sew',
    productOptions: [{ name: 'stitch_color', value: 'white' }],
    placements: ['front', 'back', 'sleeve_left', 'sleeve_right'],
    mockupStyleIds: [18428, 18429]
  }, // sweatshirt
  261: {
    technique: 'cut-sew',
    productOptions: [{ name: 'stitch_color', value: 'white' }],
    placements: ['default', 'back', 'sleeve_left', 'sleeve_right'],
    mockupStyleIds: [15777, 15778]
  }, // women's t-shirt
  274: {
    technique: 'cut-sew',
    productOptions: [{ name: 'stitch_color', value: 'black' }],
    // No separate 'back' placement exists for this product (only 'default' + 'pocket') --
    // the single default printfile wraps the whole bag, so it renders correctly on both
    // the Front and Back styles without needing a second placement. 'pocket' is an inside
    // pocket, not visible in either style, but harmless to include for completeness.
    placements: ['default', 'pocket'],
    mockupStyleIds: [16394, 16395]
  }, // tote bag
  83: {
    technique: 'cut-sew',
    productOptions: [{ name: 'stitch_color', value: 'white' }],
    placements: ['front', 'back'],
    mockupStyleIds: [12675, 12676]
  }, // pillow
  693: {
    technique: 'cut-sew',
    productOptions: [{ name: 'stitch_color', value: 'white' }],
    // No "Flat Back" style exists in this product's mockup-styles catalog (just Front,
    // on-model, and lifestyle angles) -- front is the only flat preview available.
    placements: ['front'],
    mockupStyleIds: [8603]
  }, // mesh shorts
  717: {
    technique: 'cut-sew',
    productOptions: [{ name: 'stitch_color', value: 'white' }],
    placements: ['front', 'back', 'sleeve_left', 'sleeve_right', 'hood', 'pocket'],
    mockupStyleIds: [257, 265]
  }, // zip hoodie
  784: {
    technique: 'cut-sew',
    productOptions: [{ name: 'stitch_color', value: 'white' }],
    placements: ['front', 'back'],
    mockupStyleIds: [22595, 22596]
  }, // wide-leg joggers
  801: {
    technique: 'cut-sew',
    productOptions: [{ name: 'stitch_color', value: 'white' }],
    // 'details' omitted -- confirmed live to fail the task when combined with the sleeve
    // placements (see comment above). This set already covers every visible panel.
    placements: ['front', 'back', 'sleeve_left', 'sleeve_right', 'pocket'],
    mockupStyleIds: [23286, 23287]
  }, // track jacket
  744: {
    technique: 'cut-sew',
    productOptions: [{ name: 'stitch_color', value: 'black' }],
    placements: ['front', 'back', 'pocket', 'details'],
    mockupStyleIds: [21376, 21377]
  } // crossbody bag
};

export function getMockupConfigForProduct(productId) {
  return PRODUCT_MOCKUP_CONFIG[productId] || { technique: 'cut-sew' };
}

// Placement -> printfile id for a given variant, optionally restricted to a subset of
// placements. Mockup previews (useMockup.js) restrict this to cfg.placements -- only what's
// visible in the requested Front/Back camera-angle photos (see PRODUCT_MOCKUP_CONFIG above).
// A real Printful order needs every placement regardless of visibility (placements left out
// of a real order render as blank/undecorated fabric on the actual garment, unlike a preview
// photo that simply doesn't show them) -- checkout flows call this with no filter.
export function resolvePlacementEntries(printfileSpecs, variant, placementFilter) {
  const variantPrintfiles = printfileSpecs.variant_printfiles.find(v => v.variant_id === variant.id);
  if (!variantPrintfiles) return null;
  return Object.entries(variantPrintfiles.placements).filter(
    ([key]) => !placementFilter || placementFilter.includes(key)
  );
}

// Mockups are previews, not the final print file -- cap render size well below Printful's
// real printfile dims (some 6000x6000) to stay fast and under iOS Safari's ~16.7 Mpx canvas
// limit. v1 checkout reuses this same cap (true print-resolution rendering is a later,
// separate phase -- see CLAUDE.md).
const RENDER_CAP = 1200;

// Renders the design at each printfile's capped resolution and uploads it (one render per
// unique printfile id -- placements often share one, e.g. a hoodie's body placements all
// use the same printfile), returning { [placement]: url }. Shared by mockup previews
// (useMockup.js) and real checkout (lib/checkout.js); `entries` comes from
// resolvePlacementEntries above, with whatever placement filter the caller needs.
export async function renderAndUploadPrintFiles(entries, { printfileSpecs, design, renderDesignBlob }) {
  const printfileIdToUrl = {};
  const urls = {};
  for (const [placementKey, printfileId] of entries) {
    if (!printfileIdToUrl[printfileId]) {
      const spec = printfileSpecs.printfiles.find(f => f.printfile_id === printfileId);
      if (!spec) continue;
      const scale = RENDER_CAP / Math.max(spec.width, spec.height);
      const width = Math.round(spec.width * scale);
      const height = Math.round(spec.height * scale);
      const blob = await renderDesignBlob(design, width, height);
      printfileIdToUrl[printfileId] = await uploadMockupSourceImage(blob, printfileId);
    }
    urls[placementKey] = printfileIdToUrl[printfileId];
  }
  return urls;
}

// Uploads a rendered design image so Printful's mockup-generator can fetch it. Must be a
// stable, directly-fetchable URL -- confirmed live that redirect-based image hosts (e.g.
// picsum.photos) leave the render task stuck in "pending" forever with no error surfaced,
// because Printful's render worker can't follow the redirect to the actual image bytes.
// Supabase Storage public URLs are direct, so this is safe.
export async function uploadMockupSourceImage(blob, label) {
  if (!isSupabaseConfigured) throw new Error('Supabase is not configured.');
  const {
    data: { user }
  } = await supabase.auth.getUser();
  if (!user) throw new Error('You must be signed in to generate a mockup.');

  const path = `${user.id}/mockup-${Date.now()}-${label}.jpg`;
  const { error } = await supabase.storage
    .from(MOCKUP_BUCKET)
    .upload(path, blob, { contentType: 'image/jpeg', upsert: true });
  if (error) throw error;

  return supabase.storage.from(MOCKUP_BUCKET).getPublicUrl(path).data.publicUrl;
}

// supabase-js collapses any non-2xx Edge Function response into a generic
// FunctionsHttpError ("Edge Function returned a non-2xx status code") -- the actual body
// (here, printful-mockup's pass-through of Printful's own error) only lives on
// error.context, the raw Response object, not error.message. Confirmed live: without this,
// a real Printful rejection (e.g. a bad request on a specific product/variant) surfaced as
// that generic string with no way to tell what actually went wrong. Exported so other edge
// function callers (lib/checkout.js) hit the same fix instead of re-discovering it.
export async function unwrapFunctionsError(error) {
  try {
    const body = await error.context.json();
    return new Error(body?.error?.message || body?.message || error.message);
  } catch {
    return error;
  }
}

// Creates a Printful v2 mockup-generation task. `placements` is
// [{ placement, technique, layers: [{ type: 'file', url }] }, ...] -- one entry per
// placement the chosen variant needs (see getPrintfileSpecs' variant_printfiles).
// `mockupStyleIds` picks which photographed camera angles to render those placements
// into (see PRODUCT_MOCKUP_CONFIG above) -- without it Printful defaults to a single style.
export async function createMockupTask({
  productId,
  variantIds,
  placements,
  productOptions,
  mockupStyleIds
}) {
  if (!isSupabaseConfigured) throw new Error('Supabase is not configured.');
  const { data, error } = await supabase.functions.invoke('printful-mockup', {
    method: 'POST',
    body: { productId, variantIds, placements, productOptions, mockupStyleIds, format: 'jpg' }
  });
  if (error) throw await unwrapFunctionsError(error);
  if (data.error) throw new Error(data.error.message || 'Mockup task creation failed');
  return data.data[0]; // { id, status, ... }
}

export async function getMockupTask(taskId) {
  if (!isSupabaseConfigured) throw new Error('Supabase is not configured.');
  const { data, error } = await supabase.functions.invoke(`printful-mockup?id=${taskId}`, {
    method: 'GET'
  });
  if (error) throw await unwrapFunctionsError(error);
  if (data.error) throw new Error(data.error.message || 'Mockup task lookup failed');
  return data.data[0]; // { id, status, catalog_variant_mockups, failure_reasons }
}
