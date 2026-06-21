import { supabase, isSupabaseConfigured } from './supabase';

// Catalog browsing only -- goes through the printful-catalog Edge Function so the
// Printful private API key (which can create real orders) never reaches the browser.
// See supabase/functions/printful-catalog/index.ts.

// Printful's full catalog is thousands of products with wildly different print specs
// (an all-over t-shirt alone needs 4 placements at 2 different aspect ratios -- see
// getPrintfileSpecs). Rather than support all of it day one, start with a short,
// hand-picked list we've actually verified specs for. Add to this once a product's
// printfile specs have been checked, not before.
export const STARTER_PRODUCT_IDS = [
  71, // Unisex Staple T-Shirt | Bella + Canvas 3001
  146, // Unisex Heavy Blend Hoodie | Gildan 18500
  300, // Black Glossy Mug
  1 // Enhanced Matte Paper Poster (in)
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
