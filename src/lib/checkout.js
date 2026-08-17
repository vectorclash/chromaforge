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
  // Optional second design printed on a physically separate face of the same garment (the
  // reversible bucket hat's inside -- see lib/printful.js's getSecondaryDesignConfig).
  // Recorded in the order's audit copy; it never affects pricing.
  secondaryDesign,
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
      secondaryDesign,
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
//
// 'fulfilled' is excluded too, and this is the whole point of that status existing: until it
// was added (2026-08-17) the enum only described how an order could END BADLY, so `submitted`
// was terminal in practice and a produced-and-shipped order sat here forever reading
// "In production". Two real completed orders were doing exactly that.
export async function listMyActiveOrders() {
  const { data, error } = await client()
    .from('orders')
    .select('*, order_items(*)')
    .in('status', ['paid', 'submitted'])
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data;
}

// Printful's own generated mockup of each in-flight order, keyed by our order id:
// { [orderId]: previewUrl }. This is the composite Printful renders from the REAL print
// files at order-creation time -- not the preview the customer approved at checkout, which
// is our own capped render and only covers the placements a Flat mockup photo can show.
// On some products (the mesh shorts, whose catalog has no Flat Back style and no style
// carrying a label) it is the only view of the finished garment that exists.
//
// Active orders only, by design -- see the Edge Function's header. Never throws: an order
// row renders perfectly well without a picture, so a Printful hiccup here must not take
// down the orders list with it.
export async function getActiveOrderPreviews() {
  try {
    const { data, error } = await client().functions.invoke('printful-order-preview', {
      method: 'GET'
    });
    if (error || !data?.previews) return {};
    return Object.fromEntries(data.previews.map(p => [p.orderId, p.previewUrl]));
  } catch {
    return {};
  }
}

// Resolved orders -- fulfilled, failed or canceled, whether by our own
// checkout/Printful-submission flow or via a later printful-webhook reconciliation (see that
// function's header comment) -- kept out of the active list so a finished order doesn't sit
// on the main account view forever. Cursor-paginated on created_at, same keyset pattern as
// designs.js's
// listPublicDesigns(), since this is exactly the "what if you have a lot of them" case that
// motivated splitting this out in the first place.
export async function listMyOrderHistory({ limit = 20, before = null } = {}) {
  let query = client()
    .from('orders')
    .select('*, order_items(*)')
    .in('status', ['fulfilled', 'failed', 'canceled'])
    // Only orders that were actually PAID for. 'canceled' covers two very different things:
    // a real order Printful later canceled (printful-webhook's order_canceled), which the
    // customer paid for and absolutely belongs here -- and a checkout that was started and
    // abandoned, which create-checkout-session/the stale-pending cron mark canceled and
    // which never charged anyone. Listing the second kind as "order history" is simply
    // wrong: nothing was ordered. It also dominates the list, because abandoning a checkout
    // is easy and common (every closed Stripe tab leaves one). The payment intent is the
    // clean discriminator -- stripe-webhook sets it only once payment completes, and an
    // order whose webhook never ran stays 'pending' and is excluded by the status filter
    // above anyway.
    .not('stripe_payment_intent_id', 'is', null)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (before) query = query.lt('created_at', before);

  const { data, error } = await query;
  if (error) throw error;
  return data;
}
