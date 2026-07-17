import { supabase, isSupabaseConfigured } from './supabase';
import { unwrapFunctionsError } from './printful';

// Real-money checkout: Stripe Checkout Session creation + order history reads. Orders are
// only ever written by the create-checkout-session/stripe-webhook Edge Functions (service
// role) -- see 0005_orders_schema.sql. Everything here is read-only from the client's
// perspective except kicking off the Stripe session itself.

function client() {
  if (!isSupabaseConfigured) {
    throw new Error('Supabase is not configured. Add credentials to .env.local.');
  }
  return supabase;
}

// Starts a real purchase: re-prices and creates a 'pending' order server-side, returns a
// Stripe-hosted Checkout Session URL to redirect to. `printFileUrls`/`design`/`productOptions`
// must already be resolved client-side (see lib/printful.js's renderAndUploadPrintFiles and
// getMockupConfigForProduct) -- this function does no rendering itself.
export async function createCheckoutSession({
  productId,
  productTitle,
  variantId,
  variantLabel,
  quantity,
  design,
  printFileUrls,
  productOptions,
  mockupImageUrl,
  guessedRegion
}) {
  const { data, error } = await client().functions.invoke('create-checkout-session', {
    method: 'POST',
    body: {
      productId,
      productTitle,
      variantId,
      variantLabel,
      quantity,
      design,
      printFileUrls,
      productOptions,
      mockupImageUrl,
      guessedRegion
    }
  });
  if (error) throw await unwrapFunctionsError(error);
  if (data.error) throw new Error(data.error);
  return data; // { url, orderId }
}

export async function getOrder(orderId) {
  const { data, error } = await client()
    .from('orders')
    .select('*, order_items(*)')
    .eq('id', orderId)
    .single();
  if (error) throw error;
  return data;
}

// Orders still in flight for the signed-in user, newest first. RLS scopes this to their own
// orders automatically. Deliberately unpaginated -- like listMyDesigns() in designs.js, a
// user's own in-flight orders are always few, unlike the growing history below.
// 'pending' orders (payment not yet confirmed, or abandoned at Stripe) are excluded --
// they're an implementation detail of create-checkout-session, not something a customer
// should see as a phantom order.
export async function listMyActiveOrders() {
  const { data, error } = await client()
    .from('orders')
    .select('*, order_items(*)')
    .in('status', ['paid', 'submitted'])
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data;
}

// Resolved orders (failed or canceled, whether by our own checkout/Printful-submission flow
// or via a later printful-webhook reconciliation -- see that function's header comment) --
// kept out of the active list so a canceled/failed order doesn't sit on the main account
// view forever. Cursor-paginated on created_at, same keyset pattern as designs.js's
// listPublicDesigns(), since this is exactly the "what if you have a lot of them" case that
// motivated splitting this out in the first place.
export async function listMyOrderHistory({ limit = 20, before = null } = {}) {
  let query = client()
    .from('orders')
    .select('*, order_items(*)')
    .in('status', ['failed', 'canceled'])
    .order('created_at', { ascending: false })
    .limit(limit);
  if (before) query = query.lt('created_at', before);

  const { data, error } = await query;
  if (error) throw error;
  return data;
}
