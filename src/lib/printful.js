import { supabase, isSupabaseConfigured } from './supabase';
import { cachedFetch } from './catalogCache';
import { isSameDesign } from '../render/designSettings';
import {
  resolvePlacementEntries,
  mockupPlacementEntries,
  buildMockupFiles,
  hideUnsubmittedViews
} from './printfulPlacements';

// These four live in printfulPlacements.js and
// are re-exported here so every existing import site is unchanged. They moved for the same reason
// PRODUCT_MOCKUP_CONFIG did: this module imports the Supabase client, so nothing in it can run
// from a plain-Node script -- and scripts/check-printful-mockups.mjs has to exercise the REAL
// helpers, not a copy that drifts from the code it exists to protect.
export { resolvePlacementEntries, mockupPlacementEntries, buildMockupFiles, hideUnsubmittedViews };
import { generateLabelMark } from '../render/generateLabelMark';
import { sampleLabelBackdrop, wantsLightInk } from '../render/labelBackdrop';
import { labelBackdropChoice, frontPlacementKey } from './printfulPlacements';
import { drawHatWrap, hatWrapSourceSize, hatWrapDiscSourceSize } from '../render/hatWrap';
import { drawLegWrap, legWrapSourceSize } from '../render/legWrap';
import renderLabelMark from '../render/renderLabelMark';
import { PRODUCT_MOCKUP_CONFIG } from './printfulMockupConfig';

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
  261, // All-Over Print Women's Crew Neck T-Shirt
  320, // All-Over Print Recycled Unisex Sweatshirt
  388, // All-Over Print Recycled Unisex Hoodie
  717, // All-Over Print Recycled Unisex Zip Hoodie
  801, // All-Over Print Recycled Unisex Track Jacket
  615, // All-Over Print Men's Windbreaker
  390, // All-Over Print Unisex Bomber Jacket
  693, // All-Over Print Recycled Unisex Mesh Shorts
  784, // All-Over Print Unisex Wide-Leg Joggers
  604, // All-Over Print Unisex Wide-Leg Pants
  654, // All-Over Print Reversible Bucket Hat
  458, // All-Over Print Beanie
  630, // All-Over Print Bandana
  420, // All-Over Print Neck Gaiter
  274, // All-Over Print Large Tote Bag w/ Pocket
  744, // All-Over Print Utility Crossbody Bag
  83, // All-Over Print Basic Pillow
];

// All three catalog fetchers below cache through lib/catalogCache.js (localStorage + TTL +
// in-flight dedupe) -- the catalog is near-static and re-fetching it on every page mount
// was the dominant source of Supabase egress (see that file's header).

export async function listCatalogProducts({ categoryId = null } = {}) {
  if (!isSupabaseConfigured) throw new Error('Supabase is not configured.');
  const path = categoryId ? `printful-catalog?category_id=${categoryId}` : 'printful-catalog';
  return cachedFetch(path, async () => {
    const { data, error } = await supabase.functions.invoke(path, { method: 'GET' });
    if (error) throw error;
    return data.result;
  });
}

// Cached with a shorter TTL than the other catalog calls: this response also carries the
// storeEnabled kill switch, and a cache hit delays the Buy Now button reacting to a flag
// flip by up to the TTL. Acceptable -- create-checkout-session independently rejects with
// a 503 when the store is off (defense in depth, see CLAUDE.md), so a stale button can't
// actually start a checkout.
const PRODUCT_TTL_MS = 10 * 60 * 1000;

export async function getCatalogProduct(productId) {
  if (!isSupabaseConfigured) throw new Error('Supabase is not configured.');
  const data = await cachedFetch(
    `printful-catalog?id=${productId}`,
    async () => {
      const { data, error } = await supabase.functions.invoke(
        `printful-catalog?id=${productId}`,
        { method: 'GET' }
      );
      if (error) throw error;
      return data;
    },
    PRODUCT_TTL_MS
  );
  return {
    ...data.result,
    variants: sortVariantsBySize(data.result.variants, productId),
    // Store-wide purchasing kill switch (see supabase/functions/_shared/storeStatus.ts) --
    // defaults to enabled if the field is ever missing, matching the Edge Function's own
    // fail-open default.
    storeEnabled: data.storeEnabled !== false
  };
}

// Printful's GET /products/:id doesn't guarantee variant order -- it's whatever order the
// product was set up in upstream, which isn't necessarily small-to-large and can apparently
// change. Re-sort client-side so the size picker is always small to large, grouped by color
// (in the order colors first appear) so each color's sizes run together instead of
// interleaving across colors.
const SIZE_ORDER = ['2XS', 'XS', 'S', 'M', 'L', 'XL', '2XL', '3XL', '4XL', '5XL', '6XL', '7XL'];


function sizeRank(size) {
  const name = String(size).toUpperCase().trim();
  const idx = SIZE_ORDER.indexOf(name);
  if (idx !== -1) return idx;
  // Ranged sizes -- the bucket hat (654) stocks 'XS', 'S/M' and 'L/XL'. Both halves are
  // ordinary named sizes, so rank the range by the midpoint of its two ends: S/M lands at
  // 2.5 and L/XL at 4.5, which slots them between the plain sizes rather than after every
  // one of them. Without this both fall through to Infinity and keep Printful's own
  // arbitrary order (which really does list L/XL before S/M).
  const parts = name.split('/').map(p => SIZE_ORDER.indexOf(p.trim()));
  if (parts.length > 1 && parts.every(i => i !== -1)) {
    return parts.reduce((sum, i) => sum + i, 0) / parts.length;
  }
  // Non-letter sizes (e.g. pillow dimensions like '18"×18"', waist measurements) -- sort by
  // their leading number, after all named sizes.
  const num = parseFloat(size);
  return Number.isNaN(num) ? Infinity : SIZE_ORDER.length + num;
}

function sortVariantsBySize(variants, productId) {
  // Colours otherwise run in the order Printful happens to list them, and the first one ends
  // up as the page's initial variant (ProductPage takes variants[0]). `defaultColor` lets a
  // product name the one that should lead -- see the windbreaker (615), the only entry that
  // sets it.
  const defaultColor = PRODUCT_MOCKUP_CONFIG[productId]?.defaultColor;
  const colorOrder = new Map();
  if (defaultColor && variants.some(v => v.color === defaultColor)) {
    colorOrder.set(defaultColor, 0);
  }
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
  const path = `printful-catalog?id=${productId}&printfiles=1`;
  return cachedFetch(path, async () => {
    const { data, error } = await supabase.functions.invoke(path, { method: 'GET' });
    if (error) throw error;
    return data.result;
  });
}

// The distinct mockup STYLE GROUP names this product has ("Flat", "Men's", "Ghost", ...). Feeds
// chooseOptionGroups (src/lib/printfulViewPolicy.js), which turns them into the option_groups a
// mockup task asks for. Cached like every other catalog read, so this costs one small request per
// product per session against a 30-90s mockup round trip.
//
// Fetched rather than configured ON PURPOSE. A per-product list in PRODUCT_MOCKUP_CONFIG would be
// the same structure as the old `placements` list, which silently drifted out of date at the v1
// migration and cost customers the mesh shorts' whole back panel. A rule reading the live
// catalogue cannot drift.
export async function getMockupStyleGroups(productId) {
  if (!isSupabaseConfigured) throw new Error('Supabase is not configured.');
  const path = `printful-catalog?id=${productId}&styles=1`;
  return cachedFetch(path, async () => {
    const { data, error } = await supabase.functions.invoke(path, { method: 'GET' });
    if (error) throw error;
    return data.result || [];
  });
}

// Printful's published size guide for a product: body measurements per size
// ('measure_yourself'), flat garment measurements ('product_measure'), and the diagrams that
// give those measurements meaning. Fetched LAZILY -- only when the customer opens the size
// guide -- rather than alongside the product, since most visits never open it; cachedFetch
// then makes reopening it free. Always requested in inches (the Edge Function fixes the
// unit); SizeGuideModal converts to cm client-side rather than spending a second upstream
// request and a second cache entry on the same numbers.
export async function getSizeGuide(productId) {
  if (!isSupabaseConfigured) throw new Error('Supabase is not configured.');
  const path = `printful-catalog?id=${productId}&sizes=1`;
  return cachedFetch(path, async () => {
    const { data, error } = await supabase.functions.invoke(path, { method: 'GET' });
    if (error) throw error;
    // Shape-check before returning, for a specific and very reachable failure: a
    // printful-catalog deploy that predates the `sizes=1` param ignores it and falls through
    // to the ordinary product response, which has variants but no size_tables. Without this
    // the modal would confidently report "no size guide is published" for a product that has
    // one -- and, worse, cachedFetch would store that wrong payload for its full 30-minute
    // TTL, so the mistake would outlive the fix. Throwing here means nothing is cached
    // (cachedFetch only writes on success) and the modal shows an honest failure instead.
    if (!Array.isArray(data?.result?.size_tables)) {
      console.warn(
        `[Chromaforge] printful-catalog returned no size_tables for product ${productId}. ` +
          'The deployed function probably predates the `sizes=1` parameter -- redeploy it ' +
          'with: npx supabase functions deploy printful-catalog'
      );
      throw new Error('The size guide could not be loaded right now.');
    }
    return data.result;
  });
}

const MOCKUP_BUCKET = 'design-mockups';

export function getMockupConfigForProduct(productId) {
  return PRODUCT_MOCKUP_CONFIG[productId] || { technique: 'cut-sew' };
}

// Printful's real per-product valid values for the stitch_color option (GET /products/:id
// -> result.product.options, already reaching the browser unfiltered via getCatalogProduct's
// `...data.result` spread -- see printful-catalog/index.ts's pass-through). Confirmed live for
// every current starter product: 14 of the 15 expose a stitch_color radio here (white/black for
// most, black/clear for the tote/crossbody bags, white/black/clear for the bucket hat and
// bandana), so where it's present this is a real choice, not just PRODUCT_MOCKUP_CONFIG's
// single hand-picked default. Returns null when the product has none, which is NOT purely
// defensive: v1 omits the
// option entirely for the windbreaker (615) even though Printful requires it -- that product
// just gets no picker and keeps its configured default. See 615's config entry.
export function getStitchColorOption(product) {
  const opt = product?.options?.find(o => o.id === 'stitch_color');
  if (!opt || !opt.values || Object.keys(opt.values).length < 2) return null;
  return { title: opt.title, values: opt.values };
}

// Which placements a customer can toggle geometry on/off for, for a given product's
// mockup config -- used by ProductPage.jsx to build its checkboxes and to default them
// all to "on" (matching the generator's own everywhere-by-default behavior). Deliberately
// excludes 'pocket' (it has no independent choice -- see includesGeometry above, it
// always mirrors the front placement) and any label/inside/details placement (never
// visible in a mockup or on the finished garment, so a checkbox for one would control
// something the customer can never see). 'front'/'default' are unified under one 'front'
// key here since only one of them is ever present per product and the customer shouldn't
// need to know which internal name their product uses.
const GEOMETRY_PLACEMENT_LABELS = [
  { key: 'front', label: 'Front' },
  { key: 'back', label: 'Back' },
  { key: 'sleeve_left', label: 'Left sleeve' },
  { key: 'sleeve_right', label: 'Right sleeve' },
  { key: 'hood', label: 'Hood' },
  // Reversible bucket hat (654) only -- both faces are worn, so all four are real choices.
  { key: 'outside_front', label: 'Outside front' },
  { key: 'outside_back', label: 'Outside back' },
  { key: 'inside_front', label: 'Inside front' },
  { key: 'inside_back', label: 'Inside back' }
];

// Derived from cfg.geometryPlacementKeys, falling back to cfg.placements.
//
// **cfg.placements no longer has anything to do with what a mockup submits** (2026-08-29 --
// mockups now resolve placements unfiltered, exactly as checkout does; see
// printfulPlacements.js). This is its one remaining consumer, so read it as "which panels offer
// the customer a geometry checkbox", and the fallback as a convenience for the products whose
// two lists happened to coincide. That coincidence is precisely what went wrong twice: a
// placement with no checkbox is never in ProductPage's selection Set, which includesGeometry
// reads as "geometry off", silently and unfixably -- it printed geometry-less backs on the mesh
// shorts, and would have on the bucket hat's inside panels, which are really printed and really
// worn. cfg.geometryPlacementKeys is the explicit override, and is the safer thing to write.
// Note the whitelist above is what keeps trim surfaces (details, label_*, facing, hood_inner,
// inside_pocket) out of this list no matter what the fallback contains -- geometry-off is the
// intended rule for those, and it now survives the placements list widening.
export function getGeometryPlacementOptions(cfg) {
  const placements = cfg?.geometryPlacementKeys || cfg?.placements || [];
  return GEOMETRY_PLACEMENT_LABELS.filter(
    ({ key }) => placements.includes(key) || (key === 'front' && placements.includes('default'))
  );
}

// Placements whose render is horizontally mirrored so a garment's back half continues its
// front's pattern across the visible side seams rather than restarting at each -- today only
// the reversible bucket hat (654), see its config entry for the geometry and why mirroring
// closes both seams. Returns null for every other product, which is what keeps the toggle
// (and the flip) invisible everywhere else.
export function getMirrorPlacements(cfg) {
  return cfg?.mirrorPlacements || null;
}

// This product's cut-piece geometry, if its artwork should be wrapped onto real pieces rather
// than laid flat across the printfile -- today only the reversible bucket hat (654), see its
// config entry and src/render/hatWrap.js. Null for everything else, which renders exactly as it
// did before this existed.
export function getHatWrap(cfg) {
  return cfg?.hatWrap || null;
}

// Products where a second design can be printed on a physically separate face of the same
// garment -- today only the reversible bucket hat (654), see its config entry. Returns null
// for everything else, which is what keeps this feature invisible on every other product.
export function getSecondaryDesignConfig(cfg) {
  return cfg?.secondaryDesign || null;
}

// Whether this product's front/back printfile is one flat canvas physically cut into two
// garment legs when sewn -- see the 693/784 config comments above and GeometricShape.js.
// Drives whether ProductPage.jsx shows the "Geometry layout" single/mirrored toggle at all.
export function hasTwoLegCanvas(cfg) {
  return !!cfg?.twoLegCanvas;
}

// The fractions of this product's printfile taken up by ONE separately-visible panel, or
// null if the sheet is seen whole (every product but the two leg ones). Drives whether
// ProductPage shows the "Artwork scale" choice, and is what gets passed as renderContext's
// sizeFrame when the customer picks the panel option. See render/scale.js.
export function getLegPanel(cfg) {
  return cfg?.legPanel || null;
}

// The geometry for laying one composition across this product's ASSEMBLED FRONT rather than
// flat across the sheet, so the artwork continues over the centre-front seam -- the three
// two-leg products, see their config entries and src/render/legWrap.js. Null for everything
// else. Unlike getHatWrap this is not automatically in play wherever it exists: it is the
// default mode on those products but the customer can still pick the flat scales, so
// ProductPage resolves it and passes it down rather than every call site reading it here.
export function getLegWrap(cfg) {
  return cfg?.legWrap || null;
}

// Where this product's outside label lands on its front sheet, as fractions of it -- the five
// products with a visible label_outside, measured from real calibration mockups (see
// PRODUCT_MOCKUP_CONFIG's labelOutsideRegion). Null everywhere else, which keeps the mark's
// existing dark ink.
export function getLabelOutsideRegion(cfg) {
  return cfg?.labelOutsideRegion || null;
}

// Where a VISIBLE inside label lands on the inside face. Set on the reversible bucket hat alone;
// null everywhere else, which keeps `label_inside` as the opaque dark tag it is on a garment whose
// inside nobody sees.
export function getLabelInsideRegion(cfg) {
  return cfg?.labelInsideRegion || null;
}


// Mockups are previews, not the final print file -- cap render size well below Printful's
// real printfile dims (some 6000x6000) to stay fast and under iOS Safari's ~16.7 Mpx canvas
// limit. Real checkout renders at true print resolution instead (renderPrintFileStrategy,
// below), uncapped.
//
// Bumped from 1200 after a live comparison showed the preview reading as noticeably sparser
// than the actual print: at 1200, a 4200x5400 shirt front panel renders at a capped 933x1200,
// which (see render/scale.js's getCountScale) keeps only ~37% of the generator's
// reference-tuned element count -- while the real, uncapped 4200x5400 print keeps all of it
// (its own count-scale factor already exceeds 1). That's a ~4.5x density gap between what a
// customer previews and what they'd actually receive, on top of (and independent from) the
// aspect-ratio-driven size differences getElementSizeScale addresses. 2000 narrows that gap
// substantially (~61% of reference count for the same panel) while staying well under the
// iOS canvas limit even for the largest catalog printfiles (6000x6000 capped at 2000 is still
// only 4 Mpx, versus the ~16.7 Mpx ceiling).
const RENDER_CAP = 2000;

// Same cap-and-scale math capRenderStrategy uses below, factored out so any other caller
// that needs "what size would the mockup preview render this printfile at" (e.g.
// TshirtPreview.jsx's hero shirt, which needs to match the real mockup's element DENSITY,
// not just its aspect ratio -- getCountScale in render/scale.js scales element counts off
// absolute rendered area relative to the studio's reference resolution, so rendering
// smaller than this produces a visibly sparser composition even at the correct aspect)
// can get the exact same numbers instead of drifting from a re-derived approximation.
export function capMockupRenderSize(width, height, cap = RENDER_CAP) {
  const scale = cap / Math.max(width, height);
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

// Pre-warm the Fly.io render-service the moment purchase intent appears (first mockup
// render on a product page), so its scale-to-zero cold start is already paid by the time
// Buy Now actually needs a print-resolution render. Fly wakes a stopped machine on ANY
// incoming request; the service's GET /warmup does zero work and needs no auth (see
// render-service/server.js). Fire-and-forget with mode:'no-cors' -- we don't need to read
// the response, just cause the request. Throttled: repeat pings inside the window are
// dropped so browsing many products doesn't spam wake-ups, while a ping every couple of
// minutes keeps the machine warm through an active shopping session (Fly's idle
// auto-stop kicks in after a few quiet minutes). The URL is not a secret -- only
// RENDER_SERVICE_KEY is, and /warmup never touches it.
const RENDER_SERVICE_WARMUP_URL = 'https://chromaforge-render.fly.dev/warmup';
const WARMUP_INTERVAL_MS = 2 * 60 * 1000;
let lastWarmupAt = 0;
export function warmRenderService() {
  const now = Date.now();
  if (now - lastWarmupAt < WARMUP_INTERVAL_MS) return;
  lastWarmupAt = now;
  try {
    fetch(RENDER_SERVICE_WARMUP_URL, { method: 'GET', mode: 'no-cors' }).catch(() => {});
  } catch {
    /* never let a warmup hiccup surface anywhere */
  }
}


// Whether a placement should include the geometry layer. `geometryPlacements` (a Set of
// placement keys, or null) is the customer's choice from ProductPage.jsx's per-placement
// checkboxes -- null (no selection made, e.g. any caller that predates that UI) means
// "everywhere," matching the generator's own default. 'pocket' has no checkbox of its own:
// on every clothing product that has one (hoodie, zip hoodie, track jacket), it's a
// kangaroo/welt pocket physically continuous with the front torso panel (see the
// pocketCrop configs above) -- it always mirrors whatever the front placement resolves to,
// never an independent choice, so `frontKey` (not the literal 'pocket' key) is what gets
// looked up for it. Placement keys are normalized to 'front' before the Set lookup
// because the SET uses the UI-facing 'front' key uniformly (see
// getGeometryPlacementOptions) while the actual placement key for t-shirts is 'default'.
function includesGeometry(placementKey, frontKey, geometryPlacements) {
  // label_panel is the hood/neckline interior lining (see CLAUDE.md's merch-pipeline
  // notes) -- it's meant to hold a small brand mark on a plain background, not a copy of
  // the front's full geometry-laden composition, so this is always off regardless of the
  // customer's per-placement selection. Today this already happens to be true as a side
  // effect of label_panel never being one of getGeometryPlacementOptions' checkbox keys --
  // this makes it an explicit, guaranteed rule instead of relying on that omission.
  if (placementKey === 'label_panel') return false;
  if (!geometryPlacements) return true;
  const key = placementKey === 'pocket' && frontKey ? frontKey : placementKey;
  return geometryPlacements.has(key === 'default' ? 'front' : key);
}

// Renders the design for each printfile and uploads it (one render per unique printfile id
// -- placements often share one, e.g. a hoodie's body placements all use the same
// printfile), returning { [placement]: url }. Shared by mockup previews (useMockup.js) and
// real checkout (ProductPage.jsx); `entries` comes from resolvePlacementEntries above, with
// whatever placement filter the caller needs. `renderOne(design, spec, printfileId,
// includeGeometry, regionsConfig)` is the actual render+upload strategy -- mockups use
// capRenderStrategy (cheap, capped, client-side); checkout uses renderPrintFileStrategy
// (true print resolution, via render-service). The render cache is keyed by printfileId
// *and* includeGeometry (not just printfileId) so a placement with geometry included can
// never be served another placement's cached (geometry-suppressed) render or vice versa,
// even if they happened to share a printfile id.
// `pocketCrop` (optional, from the product's PRODUCT_MOCKUP_CONFIG entry): when set, the
// 'pocket' placement is rendered as one or more regions cropped from the FRONT placement's
// own composition instead of an independent render -- see the hoodie (388) and zip hoodie
// (717) config comments for why. This needs the front placement's own printfile spec (as
// the SOURCE resolution the region coordinates were measured against, and the aspect the
// composition must be generated at -- see renderOne implementations for why that matters
// when the pocket's own printfile has a different aspect ratio than the front's), so it's
// looked up here from `entries` rather than passed in separately. The regions render gets
// its own cache key (without this, pocket and front sharing a printfile id on these
// products would dedupe to the same uploaded file, which is exactly the
// mini-echo-of-the-front behavior being replaced).
// `geometryPlacements` (optional Set of placement keys): the customer's per-placement
// geometry choice from ProductPage.jsx -- see includesGeometry above.
// `geometryLayout` (optional 'single' | 'mirror'): the customer's choice for products
// whose front/back printfile is one flat canvas cut into two garment legs (see
// PRODUCT_MOCKUP_CONFIG's twoLegCanvas and GeometricShape.js) -- applied uniformly to
// every placement of this design, not per-placement like geometryPlacements, since it's a
// property of the whole print job on this specific product, not any one panel.
// label_inside/label_outside are Printful's dedicated small brand-mark placements (see
// CLAUDE.md's merch-pipeline notes) -- a fixed 375x150 or ~450x450 canvas, tiny next to
// every other placement's multi-thousand-pixel printfile. They never go through the
// generic full-composition render: generateLabelMark/renderLabelMark draw a small,
// self-contained mark instead, synchronously and client-side (no render-service round
// trip needed at these sizes, at checkout or in a preview), then upload straight to the
// same design-mockups bucket every other print/mockup file already lives in.
const LABEL_MARK_PLACEMENTS = new Set(['label_inside', 'label_outside']);

async function renderLabelMarkBlob(design, spec, { transparent = false, lightInk = false } = {}) {
  const config = generateLabelMark(design, spec.width, spec.height, { transparent, lightInk });
  const canvas = renderLabelMark(config);
  // The transparent variant must ship as PNG -- JPEG has no alpha channel, and the whole
  // point is that unfilled pixels stay unprinted. The paneled variant keeps JPEG (smaller,
  // no alpha needed).
  const [type, quality] = transparent ? ['image/png', undefined] : ['image/jpeg', 0.95];
  return new Promise((resolve, reject) =>
    canvas.toBlob(b => (b ? resolve(b) : reject(new Error('Label mark render failed'))), type, quality)
  );
}

export async function renderAndUploadPrintFiles(
  entries,
  {
    printfileSpecs,
    design,
    renderOne,
    pocketCrop = null,
    geometryPlacements = null,
    geometryLayout = null,
    // Which frame element sizes are measured against, as fractions of the canvas: null (the
    // default, every product) means the whole sheet. Products whose sheet is cut into
    // separately-visible panels can pass their legPanel instead -- see render/scale.js and
    // ProductPage's Artwork scale control. Fractions, never pixels, so the capped mockup
    // render and the true-resolution print file compose identically.
    sizeFrame = null,
    // Reflects each render's left half onto its right so the two leg panels mirror and the
    // pattern meets itself at the centre-front seam -- see renderArtwork.js. Opt-in.
    legSymmetry = false,
    // A second design printed on a physically separate face of the same garment (the
    // reversible bucket hat's inside -- see getSecondaryDesignConfig). Null, or equal to
    // `design`, means every placement renders from `design` exactly as before.
    // `secondaryPlacements` comes from the product's own config, never from the caller's
    // imagination, so an unknown placement key can't silently divert a render.
    secondaryDesign = null,
    secondaryPlacements = null,
    // Placements whose render is horizontally mirrored so the pattern continues across a
    // garment's visible side seams instead of restarting at each -- see mirrorPlacements in
    // PRODUCT_MOCKUP_CONFIG, and renderArtwork.js for where the flip actually happens. Null
    // (every product that doesn't declare it, or the customer opting out) mirrors nothing.
    mirrorPlacements = null,
    // Wraps each face's composition onto the product's real cut pieces instead of laying it
    // flat across the sheet -- the reversible bucket hat only, see PRODUCT_MOCKUP_CONFIG's
    // hatWrap and src/render/hatWrap.js. Null for every other product, which renders exactly
    // as it did before this existed.
    hatWrap = null,
    // Lays one composition across the ASSEMBLED FRONT of a two-leg garment instead of flat
    // across the sheet, so the artwork continues over the centre-front seam -- the shorts,
    // joggers and wide-leg pants, see PRODUCT_MOCKUP_CONFIG's legWrap and src/render/legWrap.js.
    // Unlike hatWrap this is a customer choice (ProductPage's Artwork row), so it arrives as a
    // parameter and belongs in the cache key below. Null on every other product and in the two
    // flat modes, which render exactly as they did before this existed.
    legWrap = null,
    // Where this product's outside label lands on the front sheet, so the mark can sample the
    // artwork underneath and pick its ink -- see PRODUCT_MOCKUP_CONFIG's labelOutsideRegion.
    labelOutsideRegion = null,
    // Set only where `label_inside` is a visible printed patch rather than a sewn tag (the
    // reversible bucket hat). When set, that label renders transparent over the artwork and picks
    // its ink the same way label_outside does -- but sampled against the INSIDE face, which carries
    // the secondary design whenever the customer has chosen a different one.
    labelInsideRegion = null,
    // Optional (checkout UI feedback): called with (done, total) as each UNIQUE render
    // finishes -- total counts deduped files, not placements, so "3 of 5" matches the
    // real work (a t-shirt's front+back share one render). Never called on failure paths;
    // the caller's own error handling owns those.
    onProgress = null
  }
) {
  // rendered[cacheKey] holds the in-flight PROMISE, not the resolved URL -- what makes this
  // dedup-safe under concurrency. Every entry below is assigned its promise in one
  // synchronous pass (nothing here awaits until the final Promise.all), so two placements
  // sharing a printfile id (e.g. a t-shirt's front+back, both printfile 94) can't race: the
  // second one always finds the first's promise already sitting in `rendered`, since
  // nothing yielded control between the first's check-and-assign and the second's check.
  // Concurrent rendering (real checkout renders were sequential before this -- each is a
  // full server round trip: wake the Fly machine if cold, render at true print resolution,
  // upload -- and a 4+ placement order was adding up to a genuinely long "preparing
  // checkout" wait, confirmed live 2026-07-05) is only actually safe because
  // render-service's fly.toml now caps concurrency at 1 request per machine -- see its own
  // comment. Without that, two large concurrent renders (e.g. shorts' ~49Mpx front+back)
  // could land on the SAME warm machine and hold both sets of buffers in memory at once,
  // which is worse than the sequential OOM this app already hit once today, not better.
  const rendered = {};
  // A secondary design that's actually the SAME design is treated as no secondary at all --
  // both faces then share one render (and one uploaded file) instead of paying twice for
  // identical output. isSameDesign, not ===: ProductPage builds these objects separately
  // (withCurrentGeneratorVersion returns a fresh object), so reference equality would miss.
  const hasSecondary = !!secondaryDesign && !isSameDesign(design, secondaryDesign);
  const frontKey = frontPlacementKey(entries);
  const frontSpec =
    frontKey && printfileSpecs.printfiles.find(f => f.printfile_id === entries.find(([k]) => k === frontKey)[1]);
  // The face a visible inside label is printed on -- the first placement the product's secondary
  // design covers (the hat's `inside_front`). Only used to sample that label's backdrop.
  const insideFaceEntry = secondaryPlacements?.length
    ? entries.find(([k]) => secondaryPlacements.includes(k))
    : null;
  const insideFaceKey = insideFaceEntry?.[0] || null;
  const insideFaceSpec = insideFaceEntry
    ? printfileSpecs.printfiles.find(f => f.printfile_id === insideFaceEntry[1])
    : null;

  const tasks = entries.map(([placementKey, printfileId]) => {
    if (LABEL_MARK_PLACEMENTS.has(placementKey)) {
      const cacheKey = `label:${placementKey}`;
      if (!rendered[cacheKey]) {
        const spec = printfileSpecs.printfiles.find(f => f.printfile_id === printfileId);
        const choice = labelBackdropChoice(placementKey, {
          design,
          secondaryDesign,
          hasSecondary,
          frontKey,
          frontSpec,
          insideFaceKey,
          insideFaceSpec,
          labelOutsideRegion,
          labelInsideRegion
        });
        rendered[cacheKey] = spec
          ? renderLabelMarkBlob(choice.backdropDesign, spec, {
              transparent: choice.transparent,
              // Null region (every product without a visible label of this kind) or a failed sample
              // keeps the dark ink that shipped before this existed.
              lightInk:
                choice.transparent &&
                wantsLightInk(
                  sampleLabelBackdrop(choice.backdropDesign, choice.backdropSpec, choice.region, {
                    includeGeometry: includesGeometry(choice.backdropKey, frontKey, geometryPlacements),
                    geometryLayout,
                    sizeFrame,
                    legSymmetry,
                    legWrap: legWrap?.placements?.includes(choice.backdropKey) ? legWrap : null,
                    hatWrap: hatWrap?.placements?.includes(choice.backdropKey) ? hatWrap : null
                  })
                )
            }).then(blob =>
              uploadMockupSourceImage(blob, `${printfileId}-label`)
            )
          : Promise.resolve(null);
      }
      return [placementKey, rendered[cacheKey]];
    }

    const includeGeometry = includesGeometry(placementKey, frontKey, geometryPlacements);
    const regionsConfig =
      placementKey === 'pocket' && pocketCrop && frontSpec
        ? { regions: pocketCrop.regions, sourceSpec: frontSpec }
        : null;
    const useSecondary = hasSecondary && !!secondaryPlacements?.includes(placementKey);
    const mirrorX = !!mirrorPlacements?.includes(placementKey);
    // Only the faces the product names, so a label placement on the same product can never be
    // wrapped -- the geometry describes crown and brim pieces it has nothing to do with.
    const wrap = hatWrap?.placements?.includes(placementKey) ? hatWrap : null;
    // Same discipline as `wrap`: only the faces the product itself names, so a label placement
    // on the same product can never be wrapped onto a geometry that describes leg panels.
    const legs = legWrap?.placements?.includes(placementKey) ? legWrap : null;
    // The design is part of the cache key, not just the printfile/geometry/layout: on the
    // bucket hat all four face placements share ONE printfile id, so without this the inside
    // would collide with the outside's entry and silently be served the outside's render --
    // the exact bug this feature is here to avoid. ':b' only ever appears when a genuinely
    // different second design is in play, so every other product's keys are unchanged.
    // mirrorX belongs in the key for the same reason the design discriminator does: a
    // mirrored back panel shares its front's printfile id, so without it the back would be
    // served the front's unmirrored render and the seam fix would silently do nothing.
    const cacheKey =
      `${printfileId}:${includeGeometry}:${geometryLayout || 'center'}` +
      `${regionsConfig ? ':pocket-regions' : ''}${useSecondary ? ':b' : ''}${mirrorX ? ':mirror' : ''}` +
      // Same reasoning as mirrorX: front and back share one printfile id on these products,
      // so without this the panel-scaled render would be served the sheet-scaled one and the
      // customer's choice would silently do nothing. Only ever appended when a frame is
      // actually in play, so every other product's keys are byte-identical.
      `${sizeFrame ? `:panel${sizeFrame.width}x${sizeFrame.height}` : ''}` +
      `${legSymmetry ? ':legsym' : ''}` +
      // A wrapped face and an unwrapped one would otherwise collide on printfile id alone.
      // Only ever appended for a product that declares hatWrap, so every other product's keys
      // stay byte-identical.
      `${wrap ? ':hatwrap' : ''}` +
      // A wrapped face and a flat one would otherwise collide on printfile id alone, and on
      // these products front and back share one -- so without this the flat mode would be
      // served the wrapped render (or the reverse) and the Artwork choice would silently do
      // nothing. Only ever appended when the customer is actually in the wrapped mode.
      `${legs ? ':legwrap' : ''}`;
    if (!rendered[cacheKey]) {
      const spec = printfileSpecs.printfiles.find(f => f.printfile_id === printfileId);
      rendered[cacheKey] = spec
        ? renderOne(
            useSecondary ? secondaryDesign : design,
            spec,
            printfileId,
            includeGeometry,
            regionsConfig,
            geometryLayout,
            mirrorX,
            sizeFrame,
            legSymmetry,
            wrap,
            legs
          )
        : Promise.resolve(null);
    }
    return [placementKey, rendered[cacheKey]];
  });

  // Progress observers ride alongside the real awaits (side .then on each unique
  // promise, rejections deliberately swallowed HERE ONLY -- Promise.all below still
  // surfaces them to the caller).
  if (onProgress) {
    const unique = Object.values(rendered);
    const total = unique.length;
    let done = 0;
    onProgress(0, total);
    for (const p of unique) {
      p.then(
        () => onProgress(++done, total),
        () => {}
      );
    }
  }

  const urls = {};
  await Promise.all(
    tasks.map(async ([placementKey, promise]) => {
      const url = await promise;
      if (url != null) urls[placementKey] = url;
    })
  );
  return urls;
}

// Composites `regions` (each { src, dest }, fractions of the source/output respectively)
// from a rendered source blob onto a new outW x outH canvas. Used by the pocket-continuity
// path (see renderAndUploadPrintFiles) on the client mockup strategy; the print-resolution
// strategy composites server-side instead (render-service), same math (drawRegion is
// mirrored there -- keep the two in sync).
async function compositeRegionsBlob(sourceBlob, outW, outH, regions) {
  const bitmap = await createImageBitmap(sourceBlob);
  const canvas = document.createElement('canvas');
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext('2d');
  drawRegionsComposite(ctx, bitmap, bitmap.width, bitmap.height, outW, outH, regions);
  bitmap.close();
  return new Promise((resolve, reject) =>
    canvas.toBlob(b => (b ? resolve(b) : reject(new Error('Composite failed'))), 'image/jpeg', 0.92)
  );
}

// Client-side half of the leg wrap: decode the one rendered source and hand it to the SHARED
// drawLegWrap (src/render/legWrap.js). Like drawHatWrap and unlike drawRegion, that module goes
// through the same esbuild bundle as generateArtwork, so the browser and render-service run one
// implementation and cannot drift.
async function compositeLegWrapBlob(sourceBlob, geom, outW, outH, mirror) {
  const source = await createImageBitmap(sourceBlob);
  const canvas = document.createElement('canvas');
  canvas.width = outW;
  canvas.height = outH;
  drawLegWrap(canvas.getContext('2d'), source, geom, outW, outH, { mirror });
  source.close();
  return new Promise((resolve, reject) =>
    canvas.toBlob(b => (b ? resolve(b) : reject(new Error('Leg wrap composite failed'))), 'image/jpeg', 0.92)
  );
}

// Client-side half of the hat wrap: decode both rendered sources and hand them to the SHARED
// drawHatWrap (src/render/hatWrap.js). Unlike drawRegion, this math is not mirrored by hand into
// render-service -- that module goes through the same esbuild bundle as generateArtwork, so both
// sides run one implementation and cannot drift.
async function compositeHatWrapBlob(unrolledBlob, discBlob, geom, outW, outH, mirror) {
  const [unrolled, disc] = await Promise.all([
    createImageBitmap(unrolledBlob),
    createImageBitmap(discBlob)
  ]);
  const canvas = document.createElement('canvas');
  canvas.width = outW;
  canvas.height = outH;
  drawHatWrap(canvas.getContext('2d'), unrolled, disc, geom, outW, outH, { mirror });
  unrolled.close();
  disc.close();
  return new Promise((resolve, reject) =>
    canvas.toBlob(b => (b ? resolve(b) : reject(new Error('Hat wrap composite failed'))), 'image/jpeg', 0.92)
  );
}

// Base layer (a cover-fit of the whole source) plus each region drawn on top. The base
// layer only matters for compound placements whose regions don't tile the whole canvas --
// e.g. the zip hoodie's two welt-pocket regions leave a gap between them (under the
// zipper) that sits between two separate physical cut pieces and is genuinely never
// visible on the real garment, but must still be SOME valid pixel data, not left blank.
function drawRegionsComposite(ctx, source, srcW, srcH, outW, outH, regions) {
  const coverScale = Math.max(outW / srcW, outH / srcH);
  const cw = srcW * coverScale;
  const ch = srcH * coverScale;
  ctx.drawImage(source, (outW - cw) / 2, (outH - ch) / 2, cw, ch);
  for (const { src, dest } of regions) {
    drawRegion(ctx, source, srcW, srcH, src, {
      x: dest.x * outW,
      y: dest.y * outH,
      w: dest.w * outW,
      h: dest.h * outH
    });
  }
}

// Draws the `src` window (fractions of the source, MAY extend past [0,1] -- see the
// hoodie's pocketCrop comment) into the `dest` rect (absolute pixels on ctx's canvas),
// scaling to fit and edge-clamping any part of the window that falls outside the source.
// Out-of-bounds src regions are real for the hoodie pocket (the solved window extends
// slightly past the front file): they only ever land in the pocket piece's cut-away
// bleed, but sewing tolerance can drag up to ~an inch of bleed into view, so they must
// continue the edge colors rather than print white. For in-bounds regions (e.g. the zip
// hoodie's welt pockets) the clamp strips are all zero-size and never draw.
function drawRegion(ctx, source, srcW, srcH, src, dest) {
  const winX = src.x * srcW;
  const winY = src.y * srcH;
  const winW = src.w * srcW;
  const winH = src.h * srcH;
  const scaleX = dest.w / winW;
  const scaleY = dest.h / winH;
  // in-bounds part of the window, in source pixels
  const cx0 = Math.max(0, Math.round(winX));
  const cy0 = Math.max(0, Math.round(winY));
  const cx1 = Math.min(srcW, Math.round(winX + winW));
  const cy1 = Math.min(srcH, Math.round(winY + winH));
  const cw = cx1 - cx0;
  const ch = cy1 - cy0;
  // where that part lands within dest, scaled
  const offX = (cx0 - winX) * scaleX;
  const offY = (cy0 - winY) * scaleY;
  const ddx = dest.x + offX;
  const ddy = dest.y + offY;
  const cdw = cw * scaleX;
  const cdh = ch * scaleY;
  // 9-patch: centre is the real (scaled) crop; strips/corners stretch the source's 1px
  // border outward to fill whatever the window overhangs, within dest's own bounds.
  const px = (sx, sy, sw, sh, ddx0, ddy0, dw, dh) => {
    if (dw > 0.01 && dh > 0.01 && sw > 0 && sh > 0) ctx.drawImage(source, sx, sy, sw, sh, ddx0, ddy0, dw, dh);
  };
  px(cx0, cy0, cw, ch, ddx, ddy, cdw, cdh); // centre
  px(cx0, cy0, cw, 1, ddx, dest.y, cdw, offY); // top strip
  px(cx0, cy1 - 1, cw, 1, ddx, ddy + cdh, cdw, dest.h - offY - cdh); // bottom strip
  px(cx0, cy0, 1, ch, dest.x, ddy, offX, cdh); // left strip
  px(cx1 - 1, cy0, 1, ch, ddx + cdw, ddy, dest.w - offX - cdw, cdh); // right strip
  px(cx0, cy0, 1, 1, dest.x, dest.y, offX, offY); // corners
  px(cx1 - 1, cy0, 1, 1, ddx + cdw, dest.y, dest.w - offX - cdw, offY);
  px(cx0, cy1 - 1, 1, 1, dest.x, ddy + cdh, offX, dest.h - offY - cdh);
  px(cx1 - 1, cy1 - 1, 1, 1, ddx + cdw, ddy + cdh, dest.w - offX - cdw, dest.h - offY - cdh);
}

// TEMPORARY calibration mode -- when true, any placement using pocketCrop uploads a
// labeled measurement grid instead of artwork, so a single mockup round reveals exactly
// which part of the uploaded file Printful displays at the pocket's edges (the CAD
// templates demonstrably don't describe the mockup renderer's real mapping, and three
// rounds of solving from hand-measured artwork screenshots oscillated instead of
// converging -- each solve amplified ~5% feature-measurement error). Read the corner
// cell labels off the resulting mockup, compute the src rect directly, set it in the
// product's pocketCrop, then FLIP THIS BACK TO FALSE. Never ship true: this replaces
// real pocket artwork with a test pattern.
const POCKET_CALIBRATION_GRID = false;

// 10x8 labeled grid (columns A-J left to right, rows 1-8 top to bottom, cell label like
// "C5" at every cell center) with a heavy magenta border at the file's exact edge and a
// blue crosshair at its exact center. High-contrast + big type so labels survive
// Printful's mockup compositing at pocket-photo scale.
async function makeCalibrationGridBlob(width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  const cols = 10;
  const rows = 8;
  const cw = width / cols;
  const ch = height / rows;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      ctx.fillStyle = (r + c) % 2 ? '#ffffff' : '#d8f0d8';
      ctx.fillRect(c * cw, r * ch, cw, ch);
      ctx.fillStyle = '#111111';
      ctx.font = `bold ${Math.round(ch * 0.42)}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(`${String.fromCharCode(65 + c)}${r + 1}`, (c + 0.5) * cw, (r + 0.5) * ch);
    }
  }
  ctx.strokeStyle = '#222222';
  ctx.lineWidth = 2;
  for (let c = 1; c < cols; c++) { ctx.beginPath(); ctx.moveTo(c * cw, 0); ctx.lineTo(c * cw, height); ctx.stroke(); }
  for (let r = 1; r < rows; r++) { ctx.beginPath(); ctx.moveTo(0, r * ch); ctx.lineTo(width, r * ch); ctx.stroke(); }
  ctx.strokeStyle = '#ff00cc';
  ctx.lineWidth = Math.max(6, width * 0.008);
  ctx.strokeRect(ctx.lineWidth / 2, ctx.lineWidth / 2, width - ctx.lineWidth, height - ctx.lineWidth);
  ctx.strokeStyle = '#0044ff';
  ctx.lineWidth = Math.max(4, width * 0.004);
  ctx.beginPath(); ctx.moveTo(width / 2, 0); ctx.lineTo(width / 2, height); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(0, height / 2); ctx.lineTo(width, height / 2); ctx.stroke();
  return new Promise((resolve, reject) =>
    canvas.toBlob(b => (b ? resolve(b) : reject(new Error('Grid render failed'))), 'image/jpeg', 0.92)
  );
}

// Mockups: cheap, capped, client-side, free -- well below Printful's real printfile dims,
// same cap iOS Safari's canvas-area limit already forced (see RENDER_CAP above).
export function capRenderStrategy(renderDesignBlob) {
  return async (
    design,
    spec,
    printfileId,
    includeGeometry,
    regionsConfig = null,
    geometryLayout = null,
    mirrorX = false,
    sizeFrame = null,
    legSymmetry = false,
    hatWrap = null,
    legWrap = null
  ) => {
    const { width, height } = capMockupRenderSize(spec.width, spec.height);
    // Lays one composition across the assembled front (see src/render/legWrap.js). Same two
    // properties that make the hat wrap below safe: the source is sized from the geometry, so
    // its ASPECT is identical here and at true print resolution and this capped mockup shows
    // the composition the print file will rather than a second recompose of the same seed; and
    // mirrorX is NOT passed to the source render, because what has to be reflected is the
    // finished SHEET so a mirrored back meets the front across the side seams. drawLegWrap
    // does that; doing both would mirror twice and land back where it started.
    //
    // sizeFrame is deliberately not passed either: the composition IS one leg-pair front here,
    // so element sizes are already measured against what the customer sees. ProductPage never
    // sends both, but the render path should not depend on that.
    if (legWrap) {
      const src = legWrapSourceSize(legWrap, width, height);
      const sourceBlob = await renderDesignBlob(design, src.width, src.height, {
        includeGeometry,
        geometryLayout,
        legSymmetry
      });
      const blob = await compositeLegWrapBlob(sourceBlob, legWrap, width, height, mirrorX);
      return uploadMockupSourceImage(blob, `${printfileId}-legwrap${mirrorX ? '-mirror' : ''}`);
    }
    // Wraps the composition onto the product's real cut pieces (see src/render/hatWrap.js).
    // The two sources are sized from the geometry rather than from the printfile, so their
    // ASPECT is identical here and at true print resolution -- which is what keeps this capped
    // mockup showing the same composition the print file will, rather than a second
    // ratio-aware recompose of the same seed.
    //
    // mirrorX is deliberately not passed to either source render: for every other placement it
    // reflects the composition inside renderArtwork, but here what has to be reflected is the
    // finished SHEET, so the face's cut pieces meet their partner's across the side seams.
    // drawHatWrap does that; doing both would mirror twice.
    if (hatWrap) {
      const src = hatWrapSourceSize(hatWrap, width);
      const disc = hatWrapDiscSourceSize(hatWrap, width);
      const opts = { includeGeometry, geometryLayout, sizeFrame, legSymmetry };
      const [unrolledBlob, discBlob] = await Promise.all([
        renderDesignBlob(design, src.width, src.height, opts),
        renderDesignBlob(design, disc.width, disc.height, opts)
      ]);
      const blob = await compositeHatWrapBlob(unrolledBlob, discBlob, hatWrap, width, height, mirrorX);
      return uploadMockupSourceImage(blob, `${printfileId}-hatwrap${mirrorX ? '-mirror' : ''}`);
    }
    if (!regionsConfig) {
      const blob = await renderDesignBlob(design, width, height, {
        includeGeometry,
        geometryLayout,
        mirrorX,
        sizeFrame,
        legSymmetry
      });
      return uploadMockupSourceImage(blob, printfileId);
    }
    if (POCKET_CALIBRATION_GRID) {
      const blob = await makeCalibrationGridBlob(width, height);
      return uploadMockupSourceImage(blob, `${printfileId}-calibration-grid`);
    }
    // Generate the SOURCE composition at the FRONT's own aspect/resolution -- not the
    // target placement's -- so it's the literal same composition the front placement
    // uploads (this generator is ratio-aware; rendering at the wrong aspect would produce
    // a structurally different, unrelated layout, defeating the whole point of this path).
    // `includeGeometry` here is already resolved against the FRONT placement's own choice
    // (see includesGeometry/renderAndUploadPrintFiles above) -- using it for the source
    // keeps the pocket's content a true continuation of whatever the front actually shows,
    // geometry included or not, rather than assuming the front always has geometry on.
    const { regions, sourceSpec } = regionsConfig;
    const { width: srcW, height: srcH } = capMockupRenderSize(sourceSpec.width, sourceSpec.height);
    // mirrorX rides along here too, so a mirrored placement's pocket crop would be taken
    // from the same mirrored composition its own panel shows. No current product combines
    // the two (the one product with mirrorPlacements has no pocket), so this is consistency
    // for a future one, not behavior anything exercises today.
    const sourceBlob = await renderDesignBlob(design, srcW, srcH, {
      includeGeometry,
      geometryLayout,
      mirrorX,
      sizeFrame,
      legSymmetry
    });
    const blob = await compositeRegionsBlob(sourceBlob, width, height, regions);
    return uploadMockupSourceImage(blob, `${printfileId}-pocket`);
  };
}

// Real checkout: true print resolution (spec.width/height ARE the print resolution already
// -- no RENDER_CAP scaling), rendered server-side by the Fly.io render-service via the
// render-print-file Edge Function (see supabase/functions/render-print-file/index.ts and
// CLAUDE.md's "Server-side print rendering" section) so mobile Safari's ~16.7 Mpx canvas
// limit never comes into play and the print file matches the approved mockup exactly
// (GENERATOR_VERSION-checked server-side).
export async function renderPrintFileStrategy(
  design,
  spec,
  printfileId,
  includeGeometry,
  regionsConfig = null,
  geometryLayout = null,
  mirrorX = false,
  sizeFrame = null,
  legSymmetry = false,
  hatWrap = null,
  legWrap = null
) {
  if (!isSupabaseConfigured) throw new Error('Supabase is not configured.');
  const body = {
    design,
    // width/height are the OUTPUT canvas dims -- spec's own (the target placement's
    // printfile), same as any other placement. When regionsConfig is set, the render
    // pipeline generates the SOURCE composition at sourceWidth/sourceHeight instead (the
    // front's own dims/aspect -- see printful.js's capRenderStrategy for why that
    // distinction matters) and composites `regions` from it into this output size, using
    // this same includeGeometry value (already resolved against the front's own choice).
    width: spec.width,
    height: spec.height,
    label: hatWrap
      ? `${printfileId}-hatwrap${mirrorX ? '-mirror' : ''}`
      : legWrap
        ? `${printfileId}-legwrap${mirrorX ? '-mirror' : ''}`
        : regionsConfig
          ? `${printfileId}-pocket`
          : printfileId,
    includeGeometry,
    geometryLayout,
    mirrorX,
    sizeFrame,
    legSymmetry
  };
  if (hatWrap) {
    // render-service derives both source sizes from this geometry, so there is nothing else to
    // send -- and no sourceWidth/sourceHeight, which belong to the regions path only.
    body.hatWrap = hatWrap;
  } else if (legWrap) {
    // render-service derives the source size from this geometry, same as hatWrap above.
    body.legWrap = legWrap;
  } else if (regionsConfig) {
    body.regions = regionsConfig.regions;
    body.sourceWidth = regionsConfig.sourceSpec.width;
    body.sourceHeight = regionsConfig.sourceSpec.height;
  }
  const { data, error } = await supabase.functions.invoke('render-print-file', {
    method: 'POST',
    body
  });
  if (error) throw await unwrapFunctionsError(error);
  if (data.error) throw new Error(data.error.message || 'Print file render failed');
  return data.url;
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

  // Content-hashed path (was `mockup-${Date.now()}-...`) so re-rendering the same design at
  // the same size upserts over the existing object instead of accumulating a new file per
  // run -- the renderer is deterministic, so identical inputs produce identical bytes. The
  // bucket's owner UPDATE policy (migration 0003) is what lets the upsert path work.
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  const hash = [...new Uint8Array(digest).slice(0, 8)]
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
  // Extension follows the blob's real type -- transparent label marks are PNG (alpha),
  // everything else stays JPEG.
  const ext = blob.type === 'image/png' ? 'png' : 'jpg';
  const path = `${user.id}/mockup-${hash}-${label}.${ext}`;
  const { error } = await supabase.storage
    .from(MOCKUP_BUCKET)
    .upload(path, blob, { contentType: blob.type || 'image/jpeg', upsert: true });
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
    const status = error?.context?.status;
    const body = await error.context.json();
    const message = body?.error?.message || body?.error || body?.message || error.message;
    const wrapped = new Error(message);
    // Surfaced so callers can react to rate limiting specifically -- e.g. printful-mockup's
    // POST gate (per-user AND Printful's own store-wide cap, see that function's header
    // comment) returns { error, retryAfterSeconds, status: 429 } and useMockup auto-retries
    // using it instead of treating a busy Printful as a hard failure.
    if (status) wrapped.status = status;
    if (typeof body?.retryAfterSeconds === 'number') wrapped.retryAfterSeconds = body.retryAfterSeconds;
    return wrapped;
  } catch {
    return error;
  }
}


// Creates a Printful v1 mockup-generation task (see printful-mockup/index.ts's header for why
// v1 rather than the v2 beta). `files` comes from buildMockupFiles above. There is no style
// parameter: v1 chooses the camera angles itself and returns four on-model views at no extra
// time cost, which is exactly why the per-product (and per-variant) style-id tables v2 needed
// are gone.
export async function createMockupTask({ productId, variantIds, files, productOptions, optionGroups }) {
  if (!isSupabaseConfigured) throw new Error('Supabase is not configured.');
  const { data, error } = await supabase.functions.invoke('printful-mockup', {
    method: 'POST',
    body: { productId, variantIds, files, productOptions, optionGroups, format: 'jpg' }
  });
  if (error) throw await unwrapFunctionsError(error);
  if (data.error) throw new Error(data.error.message || 'Mockup task creation failed');
  return data; // { id, status }
}

export async function getMockupTask(taskId) {
  if (!isSupabaseConfigured) throw new Error('Supabase is not configured.');
  const { data, error } = await supabase.functions.invoke(`printful-mockup?id=${taskId}`, {
    method: 'GET'
  });
  if (error) throw await unwrapFunctionsError(error);
  if (data.error) throw new Error(data.error.message || 'Mockup task lookup failed');
  return data; // { id, status, error, mockups: [{ mockup_url, display_name }] } -- flattened
               // and de-duplicated by the Edge Function, front view first.
}
