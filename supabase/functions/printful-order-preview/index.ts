// Returns Printful's own generated mockup for the signed-in user's in-flight orders --
// the composite photo of the finished garment that Printful renders from the REAL print
// files at order-creation time, labels included.
//
// Why this exists rather than reusing the mockup the customer approved at checkout: the
// stored `mockup_image_url` is OUR preview (a printful-mockup task over a capped client
// render, restricted to the placements a Flat photo can show). Printful's order preview is
// a different, later artifact -- rendered from the actual files that go to production, and
// covering placements no mockup style exposes. On the mesh shorts (693), for instance,
// there is no "Flat Back" style at all and no style carrying a label, so this is the only
// view of the ordered garment that shows either.
//
// Deliberately scoped to ACTIVE orders (paid/submitted). A resolved order's preview is of
// no further use to the customer, and fetching it would put an unbounded, growing history
// behind per-view Printful calls.
//
// The caller sends NO order ids -- this function derives the user's own active orders
// itself via the service role. There is nothing to enumerate and no ownership check to get
// wrong.
//
// verify_jwt = true, but note that is NOT "signed-in users only" on its own: the public
// anon key is itself a valid JWT and passes that gate (see printful-mockup's own comment).
// The GoTrue /auth/v1/user check below is what actually identifies a real user, and it is
// load-bearing here -- without it, anyone with the shipped anon key could read order data.
//
// Deploy with: npx supabase functions deploy printful-order-preview
// Uses the same PRINTFUL_API_KEY secret as printful-catalog/printful-mockup.

const PRINTFUL_API_BASE = 'https://api.printful.com';
const STORE_ID = '18363066'; // same store as stripe-webhook -- not a secret, just an account id

// A customer's in-flight order count is naturally tiny (see listMyActiveOrders, which is
// deliberately unpaginated for that reason). This cap only exists so one account cannot
// turn a single page view into an unbounded fan-out of Printful requests.
const MAX_ORDERS = 10;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type'
};

Deno.serve(async req => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }
  if (req.method !== 'GET') {
    return Response.json({ error: 'Method not allowed' }, { status: 405, headers: corsHeaders });
  }

  const apiKey = Deno.env.get('PRINTFUL_API_KEY');
  if (!apiKey) {
    return Response.json(
      { error: 'PRINTFUL_API_KEY is not configured on this function' },
      { status: 500, headers: corsHeaders }
    );
  }

  const authHeader = req.headers.get('Authorization') ?? '';
  const jwt = authHeader.replace(/^Bearer\s+/i, '');
  if (!jwt) {
    return Response.json({ error: 'Sign in required' }, { status: 401, headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

  // Plain fetch against GoTrue/PostgREST rather than @supabase/supabase-js, same as
  // render-print-file: this function makes two REST calls, and the SDK's bundle cost has
  // caused deploy-time bundling timeouts on this project before.
  const userRes = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: { Authorization: `Bearer ${jwt}`, apikey: serviceRoleKey }
  });
  if (!userRes.ok) {
    return Response.json({ error: 'Sign in required' }, { status: 401, headers: corsHeaders });
  }
  const { id: userId } = await userRes.json();

  // Only this user's active orders that actually reached Printful. A 'paid' order whose
  // Printful submission hasn't landed yet has no printful_order_id, and therefore no
  // preview to fetch -- it is simply absent from the response, which the UI reads as
  // "not available yet" rather than an error.
  //
  // This status set MUST match listMyActiveOrders() in src/lib/checkout.js -- that query
  // decides which orders the account page renders, this one decides which get a thumbnail,
  // and a status in one but not the other silently leaves a visible row with a permanently
  // empty image slot. 'on_hold' is here for exactly that reason: a held order still shows in
  // Active, so it still needs its preview.
  const ordersRes = await fetch(
    `${supabaseUrl}/rest/v1/orders?select=id,printful_order_id` +
      `&user_id=eq.${userId}&status=in.(paid,submitted,on_hold)&printful_order_id=not.is.null` +
      `&order=created_at.desc&limit=${MAX_ORDERS}`,
    { headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` } }
  );
  if (!ordersRes.ok) {
    console.error(`printful-order-preview: orders query failed: ${await ordersRes.text()}`);
    return Response.json(
      { error: 'Could not load your orders' },
      { status: 500, headers: corsHeaders }
    );
  }
  const orders: { id: string; printful_order_id: string }[] = await ordersRes.json();

  // One Printful call per order, in parallel. A single failure must not take out the whole
  // response -- the preview is a nice-to-have next to an order row that renders fine
  // without it, so a failed lookup degrades to "no preview" rather than an error state.
  const previews = await Promise.all(
    orders.map(async order => {
      try {
        const res = await fetch(`${PRINTFUL_API_BASE}/orders/${order.printful_order_id}`, {
          headers: { Authorization: `Bearer ${apiKey}`, 'X-PF-Store-Id': STORE_ID }
        });
        if (!res.ok) {
          console.error(
            `printful-order-preview: order ${order.printful_order_id} -> ${res.status}`
          );
          return null;
        }
        const body = await res.json();
        // Printful returns the placement files the order was submitted with PLUS one extra
        // entry of type 'preview' -- the composed garment photo. Verified against real
        // orders, including an unconfirmed/canceled one, so this is generated at creation
        // time and does not depend on the order being confirmed or fulfilled.
        for (const item of body.result?.items ?? []) {
          const preview = (item.files ?? []).find(
            (f: { type: string; preview_url?: string }) => f.type === 'preview' && f.preview_url
          );
          if (preview) return { orderId: order.id, previewUrl: preview.preview_url as string };
        }
        return null;
      } catch (err) {
        console.error(`printful-order-preview: order ${order.printful_order_id} failed: ${err}`);
        return null;
      }
    })
  );

  return Response.json(
    { previews: previews.filter(Boolean) },
    { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
  );
});
