// Creates and polls Printful mockup-generation tasks. This is the one function in the
// pair that *writes* to Printful (printful-catalog is read-only) -- it asks Printful to
// render our artwork onto a product. Mockup generation does not create a real order or
// charge anything; it's a free preview render. Still gated behind verify_jwt so only
// signed-in app users can spend Printful's (rate-limited) mockup quota.
//
// Uses the v2 Mockup Generator API (/v2/mockup-tasks), not v1
// (/mockup-generator/create-task). v1 returned a task_key and accepted the task but every
// actual render came back "Internal Server Error" for our all-over-print products -- v1's
// mockup generator predates AOP/cut-and-sew construction. v2 models a placement as
// { placement, technique, layers: [{ type: 'file', url }] } instead of v1's flat
// { placement, image_url, position }, and requires the X-PF-Store-Id header v1 doesn't use.
//
// Deploy with: npx supabase functions deploy printful-mockup

import { checkRateLimitVerbose } from "../_shared/rateLimit.ts";

const PRINTFUL_API_BASE = "https://api.printful.com/v2";

// Not a secret -- store IDs are just account identifiers, same sensitivity as a username.
const STORE_ID = "18363066";
// Only gates task creation (POST) -- that's the action that actually spends Printful's
// mockup quota; polling an already-created task (GET) doesn't.
const RATE_LIMIT = 20;
const RATE_LIMIT_WINDOW_SECONDS = 60;

// Printful's REAL constraint on POST /v2/mockup-tasks, read live off their own
// x-ratelimit-* headers (undocumented): shared across every user of the app, not
// per-user -- our own RATE_LIMIT above is far looser and was never the binding one
// (see TODO.md). GLOBAL_USER_ID is a fixed sentinel (not a real user) so this reuses
// the existing per-(user_id, action) rate_limits table/RPC as a store-wide counter
// without a schema change -- rate_limits.user_id has no FK to auth.users.
// The number tracks whatever they currently advertise: it was 2/60s when this gate was
// built (2026-07-17) and is 10/60s as of 2026-08-19 (x-ratelimit-limit: 10). Keep it at
// or below their header value -- the passthrough-429 path below is the safety net if
// they lower it again, not a substitute for this gate.
const GLOBAL_USER_ID = "00000000-0000-0000-0000-000000000000";
const GLOBAL_RATE_LIMIT = 10;
const GLOBAL_RATE_LIMIT_WINDOW_SECONDS = 60;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Confirms the caller is a real signed-in user, not just anyone holding the public anon
// key. verify_jwt alone is NOT enough here: the anon key shipped in the app's JS bundle is
// itself a valid JWT and passes that gate, which would let anonymous scripts burn Printful's
// rate-limited mockup quota (and submit arbitrary layer URLs). Same plain-fetch GoTrue check
// render-print-file uses -- this function has no imports, and pulling in supabase-js is what
// made that function's bundle step time out on deploy, so don't reach for the SDK here.
// Returns the user id on success (needed for rate limiting) or null if unauthenticated.
async function getSignedInUserId(req: Request): Promise<string | null> {
  const authHeader = req.headers.get("Authorization") ?? "";
  const jwt = authHeader.replace(/^Bearer\s+/i, "");
  if (!jwt) return null;
  const userRes = await fetch(`${Deno.env.get("SUPABASE_URL")}/auth/v1/user`, {
    headers: { Authorization: `Bearer ${jwt}`, apikey: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")! }
  });
  if (!userRes.ok) return null;
  const userData = await userRes.json();
  return userData.id;
}

Deno.serve(async req => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const userId = await getSignedInUserId(req);
  if (!userId) {
    return Response.json({ error: "Sign in required" }, { status: 401, headers: corsHeaders });
  }

  if (req.method === "POST") {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const perUser = await checkRateLimitVerbose(
      supabaseUrl, serviceRoleKey, userId, "printful-mockup", RATE_LIMIT, RATE_LIMIT_WINDOW_SECONDS
    );
    if (!perUser.allowed) {
      return Response.json(
        {
          error: "Too many mockup requests. Please wait a moment and try again.",
          retryAfterSeconds: perUser.retryAfterSeconds
        },
        { status: 429, headers: corsHeaders }
      );
    }

    // Checked separately from (and after) the per-user gate above: this is the one that
    // actually binds in practice, since it's shared across every signed-in user hitting
    // this endpoint, not just this one.
    const global = await checkRateLimitVerbose(
      supabaseUrl, serviceRoleKey, GLOBAL_USER_ID, "printful-mockup-global",
      GLOBAL_RATE_LIMIT, GLOBAL_RATE_LIMIT_WINDOW_SECONDS
    );
    if (!global.allowed) {
      return Response.json(
        {
          error: "Printful's preview service is at capacity right now.",
          retryAfterSeconds: global.retryAfterSeconds
        },
        { status: 429, headers: corsHeaders }
      );
    }
  }

  const apiKey = Deno.env.get("PRINTFUL_API_KEY");
  if (!apiKey) {
    return Response.json(
      { error: "PRINTFUL_API_KEY is not configured on this function" },
      { status: 500, headers: corsHeaders }
    );
  }

  const printfulHeaders = {
    Authorization: `Bearer ${apiKey}`,
    "X-PF-Store-Id": STORE_ID,
    "Content-Type": "application/json"
  };

  const url = new URL(req.url);

  if (req.method === "POST") {
    // Create a mockup task.
    // Body: { productId, variantIds, placements: [{ placement, technique, layers: [{ type, url }] }],
    //         format, productOptions?, mockupStyleIds? } -- productOptions covers per-product
    //         config some catalog items require (e.g. this hoodie's stitch_color), surfaced by
    //         GET /products/{id} -> result.product.options. mockupStyleIds picks which
    //         photographed camera angles to render (Flat Front, Flat Back, etc.) -- surfaced by
    //         GET /v2/catalog-products/{id}/mockup-styles. Without it Printful silently defaults
    //         to a single style no matter how many `placements` are submitted; placements alone
    //         only supply the artwork, they don't control how many preview photos come back.
    const body = await req.json();
    const { productId, variantIds, placements, format = "jpg", productOptions, mockupStyleIds } = body;

    const printfulRes = await fetch(`${PRINTFUL_API_BASE}/mockup-tasks`, {
      method: "POST",
      headers: printfulHeaders,
      body: JSON.stringify({
        format,
        products: [
          {
            source: "catalog",
            catalog_product_id: productId,
            catalog_variant_ids: variantIds,
            placements,
            ...(productOptions ? { product_options: productOptions } : {}),
            ...(mockupStyleIds ? { mockup_style_ids: mockupStyleIds } : {})
          }
        ]
      })
    });
    const data = await printfulRes.json();
    if (!printfulRes.ok) {
      // Without this, get_logs only shows "POST | 400" with no indication of WHY
      // Printful rejected the task -- log the body so failures are diagnosable.
      console.error(
        `printful mockup-task create failed (${printfulRes.status}) product=${productId}:`,
        JSON.stringify(data).slice(0, 1000)
      );
    }
    if (printfulRes.status === 429) {
      // The proactive GLOBAL_RATE_LIMIT gate above should catch this before it ever
      // reaches Printful, but is deliberately not perfectly in sync with Printful's own
      // counter (e.g. right after a deploy, or if Printful's window boundary lands
      // slightly differently than ours) -- fall back to whatever Printful itself reports.
      // Retry-After isn't confirmed present on this endpoint (undocumented, see TODO.md),
      // so this is best-effort with a conservative default.
      const retryAfterHeader = printfulRes.headers.get("Retry-After");
      const retryAfterSeconds = retryAfterHeader
        ? parseInt(retryAfterHeader, 10) || GLOBAL_RATE_LIMIT_WINDOW_SECONDS
        : GLOBAL_RATE_LIMIT_WINDOW_SECONDS;
      return Response.json(
        { error: "Printful's preview service is at capacity right now.", retryAfterSeconds },
        { status: 429, headers: corsHeaders }
      );
    }
    return Response.json(data, { status: printfulRes.status, headers: corsHeaders });
  }

  if (req.method === "GET") {
    // Poll a task: /printful-mockup?id=xxx
    const taskId = url.searchParams.get("id");
    if (!taskId) {
      return Response.json({ error: "id is required" }, { status: 400, headers: corsHeaders });
    }

    const printfulRes = await fetch(
      `${PRINTFUL_API_BASE}/mockup-tasks?id=${encodeURIComponent(taskId)}`,
      { headers: printfulHeaders }
    );
    const data = await printfulRes.json();
    return Response.json(data, { status: printfulRes.status, headers: corsHeaders });
  }

  return Response.json({ error: "Method not allowed" }, { status: 405, headers: corsHeaders });
});
