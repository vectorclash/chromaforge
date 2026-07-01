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

const MOCKUP_BUCKET = "design-mockups";

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

  const body = await req.json();
  const { design, width, height, label } = body;
  if (!design?.seed || !design?.generatorVersion || !width || !height) {
    return Response.json(
      { error: { message: "Missing required fields: design.seed, design.generatorVersion, width, height" } },
      { status: 400, headers: corsHeaders }
    );
  }
  // Legitimate dimensions only ever come from Printful's printfile specs, which top out
  // around 6000x6000 -- the size the render-service's 1GB Fly machine is provisioned for
  // (a ~6000x6000 RGBA buffer is already ~144MB before Skia/PNG overhead; see CLAUDE.md's
  // OOM note). Anything bigger is either a bug or someone probing for an OOM, so reject it
  // here rather than letting it crash a render machine mid-request.
  const MAX_DIMENSION = 6500;
  if (
    !Number.isInteger(width) || !Number.isInteger(height) ||
    width < 1 || height < 1 || width > MAX_DIMENSION || height > MAX_DIMENSION
  ) {
    return Response.json(
      { error: { message: `width/height must be integers between 1 and ${MAX_DIMENSION}` } },
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
        width,
        height,
        generatorVersion: design.generatorVersion
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

  const path = `${userId}/print-${Date.now()}-${label ?? "file"}.png`;
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
