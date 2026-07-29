// Renders a design at true print resolution via the Fly.io render-service (see
// render-service/ and CLAUDE.md's "Server-side print rendering" section) and uploads the
// result to the existing design-mockups bucket, returning a directly-fetchable URL --
// same contract as uploadMockupSourceImage's capped client-side path
// (src/lib/printful.js), just backed by a different renderer.
//
// verify_jwt = true: this triggers real (billed, if scale-to-zero doesn't apply) Fly.io
// compute, so only signed-in app users can invoke it, same rationale as
// create-checkout-session.
//
// Deploy with: npx supabase functions deploy render-print-file
// Needs these secrets set: RENDER_SERVICE_URL (the Fly.io app's URL, e.g.
// https://chromaforge-render.fly.dev), RENDER_SERVICE_KEY (the same shared secret set via
// `flyctl secrets set RENDER_SERVICE_KEY=... --app chromaforge-render`).
// SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY are auto-provided by the platform.
//
// Uses plain fetch() against Supabase's Auth/Storage REST endpoints instead of the
// @supabase/supabase-js SDK the other functions use -- this function only needs two calls
// (verify a user JWT, upload a file), and pulling in the full SDK (which drags in
// realtime-js's Node polyfills) made this function's bundle step repeatedly time out on
// deploy. No functional difference for the caller.

import { checkRateLimit } from "../_shared/rateLimit.ts";

const MOCKUP_BUCKET = "design-mockups";
// True print-resolution renders are real Fly.io compute (see fly.toml) -- a real checkout
// legitimately fires several of these concurrently (one per placement), so this needs
// headroom above "one render," just a bound on a signed-in account scripting a flood.
const RATE_LIMIT = 20;
const RATE_LIMIT_WINDOW_SECONDS = 60;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async req => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return Response.json({ error: { message: "Method not allowed" } }, { status: 405, headers: corsHeaders });
  }

  const renderServiceUrl = Deno.env.get("RENDER_SERVICE_URL");
  const renderServiceKey = Deno.env.get("RENDER_SERVICE_KEY");
  if (!renderServiceUrl || !renderServiceKey) {
    return Response.json(
      { error: { message: "RENDER_SERVICE_URL/RENDER_SERVICE_KEY is not configured on this function" } },
      { status: 500, headers: corsHeaders }
    );
  }

  const authHeader = req.headers.get("Authorization") ?? "";
  const jwt = authHeader.replace(/^Bearer\s+/i, "");
  if (!jwt) {
    return Response.json({ error: { message: "Sign in required" } }, { status: 401, headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  // Identify the caller by asking GoTrue directly (equivalent to supabase.auth.getUser(jwt)
  // -- validates the user's own JWT, apikey here is just the project-level key GoTrue
  // requires on every request, not what's being checked).
  const userRes = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: { Authorization: `Bearer ${jwt}`, apikey: serviceRoleKey }
  });
  if (!userRes.ok) {
    return Response.json({ error: { message: "Sign in required" } }, { status: 401, headers: corsHeaders });
  }
  const userData = await userRes.json();
  const userId = userData.id;

  const withinLimit = await checkRateLimit(
    supabaseUrl, serviceRoleKey, userId, "render-print-file", RATE_LIMIT, RATE_LIMIT_WINDOW_SECONDS
  );
  if (!withinLimit) {
    return Response.json(
      { error: { message: "Too many render requests. Please wait a moment and try again." } },
      { status: 429, headers: corsHeaders }
    );
  }

  const body = await req.json();
  const { design, width, height, label, includeGeometry, geometryLayout, mirrorX, sizeFrame, regions, sourceWidth, sourceHeight } =
    body;
  if (!design?.seed || !design?.generatorVersion || !width || !height) {
    return Response.json(
      { error: { message: "Missing required fields: design.seed, design.generatorVersion, width, height" } },
      { status: 400, headers: corsHeaders }
    );
  }
  // Legitimate dimensions only ever come from Printful's printfile specs. A per-axis-only
  // cap here was a real bug, found live (2026-07-05): it rejected a genuine checkout on
  // mesh shorts (printfile 11250x4350 -- one axis, not total size, is what's huge for that
  // product) with "width/height must be integers between 1 and 6500", and would have done
  // the same for the sweatshirt/joggers/track jacket too (5037x6600, 9750x8100, 6600x6900
  // respectively -- all real Printful printfiles for products already in the starter
  // catalog, not hypothetical). Worse, it was measuring the wrong thing even for the cases
  // it did correctly allow: the sweatshirt's 33.2Mpx got rejected on its height axis while
  // the hoodie's 36.0Mpx (MORE total pixels, just squarer) passed fine. What actually
  // determines memory risk is total pixel count (the RGBA buffer size), not either axis in
  // isolation, so that's what's checked now. MAX_PIXELS is calibrated with headroom above
  // the real largest current printfile (joggers, 784, 79.0Mpx) -- see fly.toml, whose
  // memory was bumped alongside this fix since 79Mpx is over 2x the 36Mpx case the
  // previous 1024mb allocation was actually validated against. MAX_AXIS is a much looser
  // sanity ceiling (comfortably above the largest real single axis, mesh shorts' 11250) --
  // defense against a pathological aspect ratio (e.g. a huge width with height=1) that a
  // pure area check wouldn't catch on its own.
  const MAX_AXIS = 15000;
  const MAX_PIXELS = 90_000_000;
  if (
    !Number.isInteger(width) || !Number.isInteger(height) ||
    width < 1 || height < 1 || width > MAX_AXIS || height > MAX_AXIS || width * height > MAX_PIXELS
  ) {
    return Response.json(
      {
        error: {
          message: `width/height must be integers between 1 and ${MAX_AXIS}, and their product must not exceed ${MAX_PIXELS.toLocaleString()} total pixels`
        }
      },
      { status: 400, headers: corsHeaders }
    );
  }

  let renderRes: Response;
  try {
    renderRes = await fetch(`${renderServiceUrl}/render`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Render-Key": renderServiceKey },
      body: JSON.stringify({
        seed: design.seed,
        colors: design.colors ?? [],
        // Generation settings (geometry sliders etc.) are part of the design's identity --
        // omitting them here would print a different composition than the mockup showed.
        settings: design.settings ?? null,
        width,
        height,
        generatorVersion: design.generatorVersion,
        // Render context, not design identity -- whether the geometry layer appears on
        // this specific placement (see generateArtwork.js's renderContext param), driven
        // by ProductPage.jsx's per-placement checkboxes. Defaults to included so callers
        // that don't know about placements get today's behavior unchanged.
        includeGeometry: includeGeometry !== false,
        // 'single' | 'mirror', optional -- the customer's choice for products whose
        // front/back printfile is one flat canvas cut into two garment legs when sewn (see
        // PRODUCT_MOCKUP_CONFIG's twoLegCanvas and GeometricShape.js). Absent/null for
        // every other product, which renders identically to before this existed.
        geometryLayout: geometryLayout ?? null,
        mirrorX: mirrorX === true,
        // Fractions of the canvas, not pixels -- see lib/printful.js. Passed straight
        // through; render-service is the only thing that resolves it against real dims.
        sizeFrame: sizeFrame ?? null,
        // Optional region composite for placements that continue a larger panel's artwork
        // (hoodie/zip-hoodie pocket) -- validated by render-service itself, just
        // forwarded here. When set, sourceWidth/sourceHeight are the FRONT placement's own
        // dims (what to generate at) and width/height above are the output/target
        // placement's dims (what to composite into). Absent for every other placement.
        regions: regions ?? null,
        sourceWidth: sourceWidth ?? null,
        sourceHeight: sourceHeight ?? null
      })
    });
  } catch {
    return Response.json({ error: { message: "render-service is unreachable" } }, { status: 502, headers: corsHeaders });
  }

  if (!renderRes.ok) {
    const errBody = await renderRes.json().catch(() => ({}));
    return Response.json(
      { error: { message: errBody.error || `render-service returned ${renderRes.status}` } },
      { status: 502, headers: corsHeaders }
    );
  }

  const pngBuffer = await renderRes.arrayBuffer();

  // Content-hashed path, same idea as uploadMockupSourceImage's mockup sources: repeat
  // Buy Nows on the same design/product re-derive the same bytes, so a timestamped name
  // (the original scheme) just accumulated multi-MB duplicates forever -- found 2026-07-19
  // as the main driver of Storage usage. Same content = same URL also plays correctly with
  // Printful's fetch-by-URL caching (different content always gets a different URL). The
  // upload below is skipped when the object already exists.
  const digest = await crypto.subtle.digest("SHA-256", pngBuffer);
  const hash = Array.from(new Uint8Array(digest).slice(0, 12))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
  const path = `${userId}/print-${hash}-${label ?? "file"}.png`;

  const headRes = await fetch(`${supabaseUrl}/storage/v1/object/public/${MOCKUP_BUCKET}/${path}`, { method: "HEAD" });
  if (headRes.ok) {
    return Response.json(
      { url: `${supabaseUrl}/storage/v1/object/public/${MOCKUP_BUCKET}/${path}` },
      { headers: corsHeaders }
    );
  }

  const uploadRes = await fetch(
    `${supabaseUrl}/storage/v1/object/${MOCKUP_BUCKET}/${path}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${serviceRoleKey}`,
        apikey: serviceRoleKey,
        "Content-Type": "image/png",
        "x-upsert": "true"
      },
      body: pngBuffer
    }
  );
  if (!uploadRes.ok) {
    const errBody = await uploadRes.json().catch(() => ({}));
    return Response.json(
      { error: { message: errBody.message || `Storage upload failed (${uploadRes.status})` } },
      { status: 500, headers: corsHeaders }
    );
  }

  const url = `${supabaseUrl}/storage/v1/object/public/${MOCKUP_BUCKET}/${path}`;
  return Response.json({ url }, { headers: corsHeaders });
});
