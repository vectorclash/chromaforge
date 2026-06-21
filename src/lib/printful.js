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
// getPrintfileSpecs). Start with one AOP t-shirt and one AOP hoodie, both spec-verified;
// add more once a new product's printfile specs have been checked.
export const STARTER_PRODUCT_IDS = [
  257, // All-Over Print Men's Crew Neck T-Shirt
  388 // All-Over Print Recycled Unisex Hoodie
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
  return data.result;
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

// Confirmed live: both starter products are constructed as all-over cut-and-sew garments
// (printed fabric panels sewn together), not DTG-on-a-flat-placement, so both use the
// same Printful "technique" value. The hoodie also requires a stitch_color product
// option -- Printful rejects the task without it (GET /products/{id} -> result.product
// .options lists which products need this; there's no generic way to detect "required"
// from that response, so this is a small hand-verified map rather than something derived).
// `placements` further restricts which of getPrintfileSpecs' available_placements we
// actually submit -- confirmed live that submitting all of the hoodie's 8 placements at
// once (front/back/sleeves/pocket/hood/label_panel/inside_label) left the task stuck in
// "pending" indefinitely (10+ minutes, never failed, never completed), while 2 placements
// finished in ~80s and these 5 finished in ~40s. Root cause unconfirmed, but back/
// label_panel/inside_label don't show in a front-view mockup photo anyway, so this is
// also just the set worth rendering for a preview -- a real print order still needs every
// placement filled in, that's a separate concern from generating a mockup.
const PRODUCT_MOCKUP_CONFIG = {
  257: { technique: 'cut-sew', placements: ['default', 'sleeve_left', 'sleeve_right'] }, // t-shirt
  388: {
    technique: 'cut-sew',
    productOptions: [{ name: 'stitch_color', value: 'white' }],
    placements: ['front', 'sleeve_left', 'sleeve_right', 'hood', 'pocket']
  } // hoodie
};

export function getMockupConfigForProduct(productId) {
  return PRODUCT_MOCKUP_CONFIG[productId] || { technique: 'cut-sew' };
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

// Creates a Printful v2 mockup-generation task. `placements` is
// [{ placement, technique, layers: [{ type: 'file', url }] }, ...] -- one entry per
// placement the chosen variant needs (see getPrintfileSpecs' variant_printfiles).
export async function createMockupTask({ productId, variantIds, placements, productOptions }) {
  if (!isSupabaseConfigured) throw new Error('Supabase is not configured.');
  const { data, error } = await supabase.functions.invoke('printful-mockup', {
    method: 'POST',
    body: { productId, variantIds, placements, productOptions, format: 'jpg' }
  });
  if (error) throw error;
  if (data.error) throw new Error(data.error.message || 'Mockup task creation failed');
  return data.data[0]; // { id, status, ... }
}

export async function getMockupTask(taskId) {
  if (!isSupabaseConfigured) throw new Error('Supabase is not configured.');
  const { data, error } = await supabase.functions.invoke(`printful-mockup?id=${taskId}`, {
    method: 'GET'
  });
  if (error) throw error;
  if (data.error) throw new Error(data.error.message || 'Mockup task lookup failed');
  return data.data[0]; // { id, status, catalog_variant_mockups, failure_reasons }
}
