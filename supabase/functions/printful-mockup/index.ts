// Creates and polls Printful mockup-generation tasks. This is the one function in the
// pair that *writes* to Printful (printful-catalog is read-only) -- it asks Printful to
// render our artwork onto a product. Mockup generation does not create a real order or
// charge anything; it's a free preview render. Still gated behind verify_jwt so only
// signed-in app users can spend Printful's (rate-limited) mockup quota.
//
// Uses the STABLE v1 Mockup Generator API (/mockup-generator/create-task), migrated off v2
// on 2026-08-21. The header here used to say v1 "returned a task_key and accepted the task but
// every actual render came back Internal Server Error for our all-over-print products".
// **That is no longer true** -- re-tested against every configured product (all 15 at the time,
// and the three added on 2026-08-28 verified the same way), every one renders, and v1 covers
// every placement we use plus two v2 cannot express at all (the mesh shorts' `back`
// panel and the track jacket's `details` strip). Reasons for moving:
//   - v2 is an unsupported beta with no published end date; v1 is stable, and orders already
//     run on v1 (ported 2026-07-15 when v2's order pipeline failed on `label_inside`).
//   - Speed. Measured, three repeats each, create -> completed: t-shirt 6.6s vs 17.0s,
//     zip hoodie 8.9s vs 32.9s, mesh shorts 4.6s vs 17.6s. v1 barely scales with placement
//     count (4 -> 6 placements costs it 2.3s and cost v2 16s) and its variance is +/-0.09s
//     where v2 swung 28.6-35.1s on the same request.
//   - No more mockup style ids. v2 needed a hand-maintained style id per product, and per
//     VARIANT on the pillow and bandana -- the mechanism that silently broke every pillow
//     size except 18"x18" when Printful restricted those styles. v1 has no such concept.
// Shape differences that matter:
//   - A placement is flat { placement, image_url, position } instead of v2's
//     { placement, technique, layers: [...] }. `position` is REQUIRED (400 "Position field
//     is missing" without it); the client builds it from printfile specs it already holds.
//   - `product_options` must be a JSON OBJECT ({ stitch_color: "white" }), not v2's array of
//     { name, value }. Sending the array 400s. (`options` is a different thing entirely -- a
//     filter over mockup variants -- and sending stitch_color there fails with "No variants
//     to generate".)
//   - No X-PF-Store-Id header.
//   - Polling is by `task_key`, and the result is normalized here (see GET) so the client
//     never sees v1's mockups/extra split.
// `option_groups` IS sent as of 2026-08-29, and the values come from the client (see the POST
// handler). It used to be omitted on the grounds that v1's default is four on-model angles at no
// extra time cost -- true of the t-shirt it was measured on, and false as a generalisation. Across
// the catalogue that default ranged from 2 views (zip hoodie, track jacket, pants, pillow) to 10
// (beanie), with no pattern, because nobody was choosing: the zip hoodie has TEN style groups and
// was returning two flats. Asking for a consistent set costs nothing measurable -- the zip hoodie
// returned 10 photos in 8.6s against 8.9s for its two.
//
// Deploy with: npx supabase functions deploy printful-mockup

import { checkRateLimitVerbose } from "../_shared/rateLimit.ts";

const PRINTFUL_API_BASE = "https://api.printful.com";

// Only gates task creation (POST) -- that's the action that actually spends Printful's
// mockup quota; polling an already-created task (GET) doesn't.
const RATE_LIMIT = 20;
const RATE_LIMIT_WINDOW_SECONDS = 60;

// Printful's REAL constraint on create-task, read live off their own
// x-ratelimit-* headers (undocumented): shared across every user of the app, not
// per-user -- our own RATE_LIMIT above is far looser and was never the binding one
// (see TODO.md). GLOBAL_USER_ID is a fixed sentinel (not a real user) so this reuses
// the existing per-(user_id, action) rate_limits table/RPC as a store-wide counter
// without a schema change -- rate_limits.user_id has no FK to auth.users.
// The number tracks whatever they currently advertise: it was 2/60s when this gate was
// built (2026-07-17) and is 10/60s as of 2026-08-19 (x-ratelimit-limit: 10). Keep it at
// or below their header value -- the passthrough-429 path below is the safety net if
// they lower it again, not a substitute for this gate.
// Human labels for the filmstrip's tooltips. v1 names a photo after the PLACEMENT that
// produced it, which is an implementation detail and occasionally a lie about what you are
// looking at -- the photo for `sleeve_left` on a t-shirt is a three-quarter shot of the whole
// garment, not a sleeve close-up. Anything unmapped falls through to Printful's own string.
const PLACEMENT_LABELS: Record<string, string> = {
  default: "Front", front: "Front", back: "Back",
  sleeve_left: "Left", sleeve_right: "Right",
  hood: "Hood", pocket: "Pocket", details: "Details",
  outside_front: "Front", outside_back: "Back",
  inside_front: "Inside front", inside_back: "Inside back",
  // Added 2026-08-29, when mockups started submitting every placement an order does. Without
  // these the fallback below put the raw Printful key -- "label_inside" -- on a customer-facing
  // filmstrip tab.
  label_inside: "Inside label", label_outside: "Outside label", label_panel: "Lining"
};

// Placements that are a brand mark rather than a panel. Their mockup entries are pushed LAST, so
// when several placements resolve to the same photo (the common case -- see the de-dup below) the
// name comes from the panel the photo actually shows. Found the same day and it was not cosmetic:
// on the track jacket a photo of the JACKET came back named "label_outside", because naming is
// first-wins by URL and that placement happened to be ordered first.
const LABEL_PLACEMENTS = new Set(["label_inside", "label_outside", "label_panel"]);

// Placements that never correspond to a photograph a customer can be shown: brand marks, and
// interior surfaces (the track jacket's pocket is its inside lining, the windbreaker's
// hood_inner and facing likewise). Printful still associates SOME camera angle with each of
// them, so letting them name a view produces a photo of the jacket labelled "Pocket" -- which
// is exactly what happened once mockups started asking for more style groups and leftover
// photos began outnumbering the placements that could claim them. Their `extra` entries still
// count; those carry Printful's own view titles, which are real.
const NON_VIEW_PLACEMENTS = new Set([
  ...LABEL_PLACEMENTS, "pocket", "details", "inside_pocket", "hood_inner", "facing"
]);

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
    "Content-Type": "application/json"
  };

  const url = new URL(req.url);

  if (req.method === "POST") {
    // Create a mockup task.
    // Body: { productId, variantIds, files: [{ placement, image_url, position }], format,
    //         productOptions? } -- `files` arrives already in v1 shape because the client is
    //         the side that holds the printfile specs `position` is computed from (it fetches
    //         them to render the artwork in the first place), so building it here would mean a
    //         second round trip to Printful for numbers we already have.
    // productOptions is our own [{ name, value }] config shape (e.g. the zip hoodie's required
    // stitch_color); v1 wants a JSON object, so it is converted here rather than in the client
    // -- the array shape is what PRODUCT_MOCKUP_CONFIG carries and what the v1 ORDER path also
    // consumes, so it stays the one representation everything else speaks.
    const body = await req.json();
    const { productId, variantIds, files, format = "jpg", productOptions, optionGroups } = body;

    // Which camera-angle groups to ask for. Decided CLIENT-side (src/lib/printfulViewPolicy.js)
    // from the product's own style list, so the policy has one implementation shared with
    // scripts/check-printful-mockups.mjs rather than a Deno copy that would drift. Validated
    // rather than trusted: it reaches Printful verbatim, and an empty array would ask for no
    // styles at all and return a filmstrip with no photos -- so an empty or malformed value falls
    // through to v1's own default, which is what shipped before this existed.
    const groups = Array.isArray(optionGroups)
      ? optionGroups.filter((g: unknown) => typeof g === "string" && g.length > 0 && g.length < 64).slice(0, 8)
      : [];

    if (!files?.length) {
      return Response.json(
        { error: "files is required" },
        { status: 400, headers: corsHeaders }
      );
    }

    const productOptionsObject = Array.isArray(productOptions)
      ? Object.fromEntries(productOptions.map((o: { name: string; value: unknown }) => [o.name, o.value]))
      : productOptions;

    const printfulRes = await fetch(
      `${PRINTFUL_API_BASE}/mockup-generator/create-task/${encodeURIComponent(productId)}`,
      {
        method: "POST",
        headers: printfulHeaders,
        body: JSON.stringify({
          variant_ids: variantIds,
          format,
          files,
          ...(productOptionsObject && Object.keys(productOptionsObject).length
            ? { product_options: productOptionsObject }
            : {}),
          ...(groups.length ? { option_groups: groups } : {})
        })
      }
    );
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
    // Normalized to { id, status } so the client never learns v1 calls this a task_key.
    return Response.json(
      printfulRes.ok ? { id: data.result?.task_key, status: data.result?.status } : data,
      { status: printfulRes.status, headers: corsHeaders }
    );
  }

  if (req.method === "GET") {
    // Poll a task: /printful-mockup?id=xxx  (the id is v1's task_key)
    const taskId = url.searchParams.get("id");
    if (!taskId) {
      return Response.json({ error: "id is required" }, { status: 400, headers: corsHeaders });
    }

    const printfulRes = await fetch(
      `${PRINTFUL_API_BASE}/mockup-generator/task?task_key=${encodeURIComponent(taskId)}`,
      { headers: printfulHeaders }
    );
    const data = await printfulRes.json();
    if (!printfulRes.ok) {
      return Response.json(data, { status: printfulRes.status, headers: corsHeaders });
    }

    // Flatten v1's two-level result into one ordered, de-duplicated list of preview photos.
    // Two things make that necessary. v1 splits a render across `mockups[]` (one entry per
    // submitted placement) and each entry's `extra[]` (the other camera angles of that same
    // garment) -- the client only ever wants "the photos", not which placement produced them.
    // And several placements routinely resolve to the SAME photo (on the zip hoodie all six
    // collapse onto just two), so the list must be de-duped by URL or the filmstrip fills with
    // identical thumbnails. Insertion order is preserved, which puts the front view first
    // because the front placement is submitted first.
    const result = data.result ?? {};
    const byUrl = new Map<string, { mockup_url: string; display_name: string }>();
    // Labels are made unique for the filmstrip's tooltips, because they legitimately repeat
    // across DIFFERENT photos -- the mesh shorts return two distinct images both called "Front".
    // De-duplicating by NAME instead would throw a real photo away.
    //
    // Collected first, named second, and that order is the fix rather than a style choice.
    // Naming as we go produced "Front 2 2" on the windbreaker: it returns a `front` placement
    // plus extras titled "Front" AND "Front 2", so the second "Front" took the suffix 2, and
    // Printful's real "Front 2" was then pushed to "2 2". Reserving every name Printful actually
    // uses before handing out any suffix means a generated label can never land on a real one.
    // That list gives Front / Front 3 / Front 2. Found by scripts/check-printful-mockups.mjs
    // across all 14 windbreaker variants -- the sort of thing hand-testing reads as fine,
    // because it is only a tooltip.
    const raw: Array<{ url: string; name: string }> = [];
    const seenUrls = new Set<string>();
    const push = (url: string | undefined, name: string) => {
      if (!url || seenUrls.has(url)) return;
      seenUrls.add(url);
      raw.push({ url, name });
    };
    const ordered = [...(result.mockups ?? [])].sort(
      (a, b) => Number(LABEL_PLACEMENTS.has(a.placement)) - Number(LABEL_PLACEMENTS.has(b.placement))
    );
    for (const m of ordered) {
      // A label placement's own mockup_url is never a photograph OF the label -- a sewn-in tag has
      // no camera angle on any product, and the one label that IS visible (the mesh shorts'
      // label_outside, a 3in patch on the leg) shows up inside the FRONT photo, which `front`
      // already names. What that url actually points at is some garment angle Printful chose to
      // associate with the placement, so naming a view from it produces a photo of the jacket
      // labelled "Outside label". Measured: asking for more camera angles made this routine, since
      // leftover photos outnumber the placements that can claim them. Its extras still count --
      // those carry Printful's own view titles.
      if (!NON_VIEW_PLACEMENTS.has(m.placement)) push(m.mockup_url, PLACEMENT_LABELS[m.placement] ?? m.placement);
      for (const e of m.extra ?? []) push(e.url, e.title);
    }
    const reserved = new Set(raw.map(r => r.name));
    const taken = new Set<string>();
    for (const { url, name } of raw) {
      let final = name;
      if (taken.has(final)) {
        for (let n = 2; taken.has(final) || (final !== name && reserved.has(final)); n++) final = `${name} ${n}`;
      }
      taken.add(final);
      byUrl.set(url, { mockup_url: url, display_name: final });
    }
    return Response.json(
      {
        id: taskId,
        status: result.status,
        error: result.error ?? null,
        mockups: [...byUrl.values()]
      },
      { status: 200, headers: corsHeaders }
    );
  }

  return Response.json({ error: "Method not allowed" }, { status: 405, headers: corsHeaders });
});
