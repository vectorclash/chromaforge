# Chromaforge — project context for Claude

This file is the portable handoff doc for this project. It's checked into git specifically
so that any Claude Code session — on any machine — has the architecture decisions and
current state without needing the original chat history. Keep it updated as work lands;
treat the bullet points below as living facts, not a changelog (prune/update rather than
appending forever).

## What this is

A generative art web app (live at **chromaforge.app**). Vite + React, static build,
deployed via GitHub Actions → FTP on every push to `master` (see
`.github/workflows/deploy.yml`). UI language is "the artwork is the interface": the
generated piece fills the screen; controls live in a small frosted-glass panel that
floats on top. Designs are JSON, re-renderable via Canvas2D from that JSON alone.

**The goal in progress:** turn a saved design into printed merch (shirts/hoodies) via
Printful, with user accounts and a gallery. Stack: Supabase (Postgres + Auth + Storage),
Stripe (payment), Printful (fulfillment), Vite/React frontend (unchanged).

## Architecture decisions (the load-bearing ones)

### Renderer: seed-based, not pixel-based
The renderer is a pure deterministic function of `(seed, colors, settings, width,
height)` — NOT stored pixel/normalized coordinates. A tiny JSON `{ generatorVersion,
seed, colors, settings }` reconstructs the full artwork at any size/ratio. This was a
deliberate choice over "store the resolved composition": it enables **method-4
recompose-per-ratio** — screen and print are sibling compositions generated fresh from
the same seed, not the same layout reflowed. The print mockup the customer approves is
the actual print, generated the same deterministic way.

- `src/render/prng.js` — seeded PRNG (xmur3 + mulberry32: `makeRng`, `randomSeed`,
  `randomColorHex`). Every `Generate*` class in `src/components/Canvas/` takes an `rng`
  param and uses it instead of `Math.random()`/`tinycolor.random()`.
- `src/render/generateArtwork.js` / `src/render/renderArtwork.js` — pure, React-free
  generation/compositing, so the same code can eventually run server-side (Node/headless)
  for print resolution. `GENERATOR_VERSION` bumps when the algorithm changes in a way that
  alters output for a given seed.
- **Print rendering must be server-side**, not client-side: iOS Safari caps canvas area
  around 16.7 Mpx, and 150 DPI print (4200×5400 = 22.7 Mpx) exceeds that. Desktop Chrome
  handles it fine (proven up to 300 DPI), but mobile can't — this is why a render service
  is still needed before the print pipeline is real.
- **Studio generation settings (geometry sliders), 2026-07-02**: the design JSON's
  `settings` field is now real — `{ settings: { geometry: { chance, pointsMin, pointsMax,
  coherence, size } } }` (`size` added 2026-07-04, see below), edited via a new "Geometry"
  tab in the studio settings panel (chance slider, dual min/max points slider, coherence
  slider, size slider; moving one live-regenerates the *current seed* with the new
  settings after a 350ms debounce). `src/render/designSettings.js`
  owns the defaults/normalization (it's a separate module because the `Generate*` classes
  need it and generateArtwork imports those — circular otherwise). Key invariants:
  **defaults are byte-identical to the pre-settings generator** (chance 0.4 ≡ the old
  `rng() >= 0.6`; points 3–12 ≡ the old `3 + round(rng()*9)`; coherence 0 skips every new
  code path — verified against a bundle of the pre-change committed code, 900 config
  comparisons), which is why `GENERATOR_VERSION` stayed at 3 and old designs are untouched;
  `settings` is only persisted when non-default (`compactSettings`); settings are part of a
  design's *identity* like seed/colors (`isSameDesign` compares them — a slider tweak on a
  saved design correctly reads as unsaved); and settings-dependent rng() consumption is
  size-independent, so the cross-size determinism guarantee below still holds (verified at
  5 sizes incl. print). Coherence semantics: 0 = today's chaos (unbounded size, arbitrary
  triangles), 1 = a "vector equilibrium" chord web (`latticeCells()`, reworked 2026-07-04
  — see below; deliberately NOT sliced by `getCountScale` — a thumbnail must show the same
  complete polygon as the print) sized to fit with 12.5% clearance off the short dimension;
  between, size lerps and chaotic triangles trade off against filled cells. The chance draw always
  consumes exactly one rng() regardless of the setting so downstream layers stay aligned.
  Settings ride through every regeneration path: compactDesign (both the JS and the Deno
  `_shared/compactDesign.ts` mirror), StudioContext's renderDesignBlob (mockups/thumbnails),
  share links, gallery loads, `render-print-file` → render-service. Deployed everywhere:
  both Edge Functions and the Fly.io render-service (`flyctl deploy` run from the repo
  root — **not** `render-service/`, since the Dockerfile's build context is the repo root;
  see its own header comment).
  **Real bug found and fixed same day, via user report**: full coherence rendered with an
  obvious, unwanted pinwheel/spiral rather than the clean faceted look the feature
  describes. Took real debugging to pin down, not a one-line fix — two genuinely separate,
  pre-existing bugs (both predating this feature, in the original chaotic-mode code) were
  found and fixed along the way but turned out NOT to be the primary cause: (1) `buildShape`'s
  3+-color branch did `shape.colors = this.colors` — a bare reference, not a copy — so
  every shape in a design silently shared, and retroactively mutated, the exact same color
  array (confirmed live: dumped colors from 66 lattice cells, all byte-identical, all the
  same object); (2) `shuffleColors` mutated that shared array in place on every call, so
  colors drifted cumulatively across a design's shapes rather than each being an
  independent perturbation of the true original palette — invisible noise for randomly
  positioned chaotic shapes, but for the first time visible once shapes had a spatial
  order (the lattice) to correlate with. Both real, both fixed (`.slice()` copy;
  `shuffleColors` now pure, spinning fresh from the untouched palette every call) — but the
  spiral persisted after fixing both, proving neither was the actual cause. The root cause
  was a diagonal-choice bias in the then-current disjoint ring-band tessellation (any
  single consistent 2-triangle quad split rotates in lockstep with the ring's own angular
  step — a real geometric windmill), fixed at the time by fanning each quad from its own
  centroid. **That whole disjoint tessellation has since been replaced (2026-07-04, user
  request)**: it fully tiled the polygon but read as a faceted gemstone; the user wanted
  the classic vector-equilibrium look (nested rings with every vertex chord-connected
  across the whole figure). `latticeCells()` now emits overlapping long-chord cells —
  per-ring star triangles (k, k+skip, k+2*skip) for every skip up to floor((V-1)/2) (the
  bound excludes even-V's degenerate zero-area V/2 cells), plus symmetric splay triangles
  (outer k, inner k±j) between every ring PAIR — blended by GeometricShape's `hard-light`
  compositing (overlap is the look, not a bug; the windmill can't recur since no cell is a
  split quad). Draw order is deterministic (user-approved final form): outer-ring-reaching
  cells first (behind), center-connecting cells last (on top) — the shuffle only picks
  WHICH cells survive a partial fill; sort keys are quantized to integer ring indices, not
  raw radii, because pointsArray's pixel rounding varies with canvas size and raw-radius
  ties could order same-ring cells differently across sizes, desyncing per-cell colors
  between mockup and print (verified: per-cell colors byte-identical across 5 sizes). Full coherence also raises min ring depth 2→3 (depth 2 has only one ring
  pair to splay and rendered washed-out; still one rng() draw). Structure was matched to
  the user's reference image via a wireframe scratch harness (several candidate cell
  families compared) and verified on real full-pipeline renders at 6/8/12 vertices, full
  and half coherence; coherence-0 output re-verified byte-identical (PNG hashes) against a
  build of the pre-change committed code, and full-coherence structure re-verified
  identical across 5 sizes incl. print. As with the earlier tessellation change, **any
  existing design with a non-zero coherence setting renders its geometry layer differently
  now** — same nothing-live-yet-so-accepted tradeoff as the ratio-aware (`v3`) change
  below; coherence-0 designs (all of them, until the sliders ship) are untouched.
  **`size` setting added (2026-07-04, user request)**: a new `geometry.size` slider (0–1,
  default 0.5) controls the coherent polygon's radius — 0.15×`getSizeScale` (fairly small)
  to 0.6×`getSizeScale` (bleeds ~20% of the short dimension's half past the canvas edge,
  deliberately allowed — the old behaviour was a hard "always fits with 12.5% margin"
  containment rule the user explicitly wanted relaxed at the high end). The clever bit
  requiring no extra interpolation logic: `shapeSize` was already
  `chaoticSize + (coherentSize - chaoticSize) * coherence`, so swapping the old fixed
  `0.375` factor inside `coherentSize` for `0.15 + size * 0.45` means the *existing*
  coherence lerp automatically gates `size`'s influence — at coherence 0 the size term's
  coefficient is exactly 0 regardless of `size`'s value (verified: identical shape points
  across size 0/0.5/1 at coherence 0), and influence grows smoothly as coherence rises,
  which is exactly the "the higher the coherence, the more accurate/controllable" behavior
  asked for, with zero new branching. Default 0.5 reproduces the prior fixed-0.375 factor
  exactly, so absent-`size` designs (everything saved before this) are byte-identical
  (re-verified: same 3-seed PNG hashes as the lattice-rework verification above).
- **Generators are now ratio-aware** (`GENERATOR_VERSION = 3`, `src/render/scale.js`):
  sizes scale off `min(width, height)` instead of `width` alone (a tall/narrow print was
  sizing stars off its narrow axis only), and element counts scale off canvas area relative
  to the studio's actual default resolution (3840×2160) instead of fixed constants (a
  320×320 thumbnail was getting literally the same star counts as a 4200×5400 print).
  Count scaling is `sqrt(area ratio)`, not the raw ratio — tested against real renders and
  plain linear area scaling collapsed thumbnail-size renders to nearly nothing, since
  320×320 is ~1.2% of the reference area but the old fixed counts already looked
  reasonable there.
  - **Real bug caught and fixed mid-implementation**: the first version scaled each
    generation loop's *trip count* directly by the size factor. That desyncs `rng()`
    consumption across sizes — every layer generated after a size-scaled loop (radial
    field → star field → geometry → overlay, in that order) draws from a different
    position in the sequence depending on how many stars/gradients happened to be
    generated at that specific width/height. Confirmed live: **the same seed would gain or
    lose an entire geometry-shape layer purely depending on what size it was rendered
    at** — directly breaking the "mockup and its print are the same underlying piece"
    guarantee `renderArtwork`'s method-4 recompose-per-ratio design depends on. Fixed by
    always generating the *original fixed* count (exactly matching pre-fix `rng()`
    consumption, so every downstream draw lands in the same position regardless of size)
    and only **slicing** the result down to a size-scaled subset afterward — sizes at or
    above the reference resolution keep everything generated (unchanged density from
    before `v3`); only smaller canvases keep a reduced slice. Verified live with a script
    that inspects `generateArtwork`'s output directly (not just pixels): confirmed
    `radialFieldConfig`/`geometryConfig`/`overlayConfig` presence is now identical for the
    same seed across thumbnail/moderate/studio-default/tall-print/print sizes, both for a
    seed with geometry on and one with it off.
  - Also verified visually across the same five sizes, isolating the star layer alone
    (radial field/geometry/overlay temporarily forced off in a local test, then reverted)
    to judge density without other randomized layers reshuffling alongside count changes.
  **Consequence, accepted deliberately:** this still changes output for every existing
  seed (the fixed-then-slice approach preserves rng() *position* consistency across sizes
  for `v3`, but `v3`'s formulas still differ from `v2`'s) — old `v2` saved designs render
  differently now and fail render-service's version check for printing until re-saved.
  Same treatment as pre-seed (`v1`) designs already got — best-effort only, not a
  blocker, and nothing is live to real customers yet so the timing cost is low.

### Server-side print rendering: `render-service/` — built, deployed, wired into checkout, live-verified
`render-service/` (new top-level dir, separate from the Vite app) runs the actual,
unmodified `generateArtwork.js`/`renderArtwork.js`/`Generate*.js` files in plain Node —
**no headless browser** (Puppeteer/Chromium were both considered and rejected: a managed
screenshot API is a recurring per-render vendor bill the project owner explicitly doesn't
want; a real browser needs a ~1GB+ RAM host for something this can now do in ~1GB, see
memory note below). Verified this session, with real test code against real output (not
assumed): every `globalCompositeOperation` this app uses, gradient rendering, and the one
non-Canvas2D dependency (`GeometricShape.js`'s use of createjs/EaselJS) all render
correctly under `@napi-rs/canvas` (Skia-backed, same engine real Chrome uses) plus
`render-service/shim.js`'s `document`/`window`/createjs polyfill.

- **A real bug was caught and fixed via this work**, independent of the render-service
  project itself: `GenerateLargeRadialField.js:18` sets `radGrad.alpha =
  rng().toFixed(2)` — a **string**. Browsers silently coerce that to a number when
  assigned to `ctx.globalAlpha`; `@napi-rs/canvas` doesn't (leaves `globalAlpha` at its
  default of `1`). Fixed in `LargeRadialField.js` with `Number(...)`, matching the
  coercion `renderArtwork.js` already does for `overlayAlpha` — verified via pixel diff
  against a real Puppeteer-captured browser screenshot (0-1000ppm scratch harness, not
  committed) that this closes the gap from a 250/765 average pixel difference down to
  ~1/765 (PNG rounding noise). This bug was latent in the browser-only renderer the whole
  time, just never surfaced because browsers tolerate it.
- `render-service/build.js` bundles `generateArtwork.js`+`renderArtwork.js` (via esbuild)
  into `render-service/generated/render-lib.js` before each run/deploy — **not a code
  port**, just resolving Vite-style extensionless imports that Node's native ESM loader
  can't handle; the executed logic is byte-for-byte the same as what ships to the
  browser. Re-run `npm run build` in `render-service/` after any change to `src/render`.
- **Deployed to Fly.io** (`chromaforge-render.fly.dev`, `iad` region, scale-to-zero) and
  **live-verified end to end** (2026-07-01): a real `onBuyNowClick` through the actual app
  produced a `print_file_urls` entry at **3150×5550px** (true print resolution — the old
  capped client-side path tops out at `RENDER_CAP = 1200`), confirmed by downloading the
  real uploaded file and checking its pixel dimensions, not just that the request
  succeeded. The Dockerfile's build stage needed `COPY src/components/Canvas` added (it
  only copied `src/render`, but `generateArtwork.js`/`renderArtwork.js` import from
  `../components/Canvas/*` — missed until a real Docker build surfaced it, since the local
  `npm run build` sanity check runs inside the full repo checkout and never hit the gap).
  `fly.toml`'s `[build] dockerfile` path resolves relative to `fly.toml`'s own directory
  (`render-service/`), not the repo root, despite `flyctl deploy`'s own `--dockerfile` flag
  docs implying otherwise — confirmed via flyctl v0.4.63; the file's header comment
  reflects the working invocation.
- **Real capacity bug, not just a deploy-config one**: the initial 512MB Fly machine size
  got OOM-killed mid-render on a real product's printfile spec (confirmed in Fly's logs —
  `anon-rss:412116kB` at kill time). Some printfiles run up to ~6000×6000px; the raw RGBA
  buffer alone is ~144MB before Skia/Node overhead and PNG encoding headroom. Bumped to
  1024MB in `fly.toml` and reverified live — no further OOM kills. If future products push
  printfile sizes higher, watch for this failure mode again (Fly logs show
  `Out of memory: Killed process ... (node)` distinctly from any application-level error).
  **This recurred and got fixed for real, 2026-07-05**: `render-print-file`'s dimension
  check (`MAX_DIMENSION = 6500`, per-axis only) turned out to be a real bug in itself —
  it rejected several real starter-product printfiles that are legitimately elongated but
  not actually huge in total pixels (mesh shorts 11250×4350, joggers 9750×8100, sweatshirt
  5037×6600, track jacket 6600×6900), and even for cases it did allow, it measured the
  wrong thing (the sweatshirt's 33.2Mpx got rejected on its height axis while the hoodie's
  36.0Mpx — more total pixels, just squarer — passed fine). Replaced with a total-pixel-area
  cap (`MAX_PIXELS`, what actually bounds memory) plus a much looser per-axis sanity ceiling
  (`MAX_AXIS`). Raising that limit then genuinely OOM-killed a live mesh-shorts checkout at
  1024mb (`anon-rss:1905132kB`, right at a since-abandoned 2048mb ceiling too —
  `shared-cpu-1x` caps out at 2048mb regardless of configured value, confirmed live via a
  rejected `flyctl deploy`; needed `performance-2x` for real headroom). Now at 4096mb, with
  an explicit `global.gc()` forced after every response (`--expose-gc` on the Dockerfile's
  CMD) — working theory is `@napi-rs/canvas`'s native (non-heap) buffers outrunning V8's own
  lazy GC between two large sequential renders on one warm machine, not any single render
  alone needing this much. Checkout renders were also switched from sequential to
  concurrent per placement (`renderAndUploadPrintFiles`, dedup-safe via caching the
  in-flight promise, not just the resolved URL) to fix a genuinely slow "preparing
  checkout" — only safe alongside `fly.toml`'s `[http_service.concurrency]` hard-capped at
  1 request/machine, so concurrent large renders spread across the 2 machines already
  provisioned instead of stacking on one (which would reintroduce the same OOM, worse).
  **None of this was actually the root cause of the checkout failures that prompted it,
  though** — see the next bullet, and `TODO.md`'s "Blocking launch" section for the live
  details/evidence.
- **Printful's own catalog and production pipeline disagree on print-area size, for several
  starter products — found live, 2026-07-05/06, not fixable from this codebase.** A real
  Printful order (Stripe charge succeeds, `stripe-webhook` creates the order fine) can still
  end up `failed` ~10-40s later via Printful's own async file-processing, with the
  order-item's `placements` silently emptied and no error detail beyond "Failed to process
  design." Confirmed via a synthetic order submitted with trivial solid-color placeholder
  files at the exact same dimensions (no rendering/geometry/content involved) failing
  identically — this rules out anything in this app's renderer. Pattern tracks physical
  print size, not pixel count or file size (both comfortably within Printful's own
  documented 100MB/20000px limits): confirmed working at 28×36in (t-shirt), confirmed
  failing at 35×40in (zip hoodie) and 75×29in (mesh shorts). Hoodie/sweatshirt/track
  jacket/joggers are all larger than the known-failing zip hoodie and untested but suspect.
  See `TODO.md`'s "Blocking launch" section for the full product-by-product breakdown and
  order IDs — needs a Printful support ticket, not more debugging here.
- `supabase/functions/render-print-file/index.ts` deliberately uses plain `fetch()` against
  Supabase's Auth (`/auth/v1/user`) and Storage (`/storage/v1/object/...`) REST endpoints
  instead of the `@supabase/supabase-js` SDK every other function uses — pulling in the
  full SDK (which drags in `realtime-js`'s Node polyfills) made this function's bundle step
  repeatedly time out on deploy (`Bundle generation timed out` / a `deno.land` fetch
  timeout inside `realtime-js`), confirmed reproducible across multiple attempts. No
  `deno.json`/import map needed as a result. If this function ever needs more than
  "verify a JWT" + "upload a file," reconsider whether the SDK's bundle-time cost is worth
  it, but don't reach for it by default here.
- `RENDER_SERVICE_KEY` (shared secret, `X-Render-Key` header) is set both as a Fly.io
  secret (`flyctl secrets set RENDER_SERVICE_KEY=... --app chromaforge-render`) and as the
  `render-print-file` Edge Function's `RENDER_SERVICE_KEY` secret — same value, two places,
  no code ties them together automatically if one is rotated. `RENDER_SERVICE_URL` is the
  Edge Function's only other secret (`https://chromaforge-render.fly.dev`).
- `src/lib/printful.js`'s `renderAndUploadPrintFiles` takes an injected `renderOne(design,
  spec, printfileId)` strategy instead of being hardcoded to one render path:
  `capRenderStrategy(renderDesignBlob)` (mockups, `useMockup.js` — cheap, capped, client-side,
  unchanged behavior) vs. `renderPrintFileStrategy` (checkout, `ProductPage.jsx` — true print
  resolution via the Edge Function above). Mockup previews are untouched by design — no
  reason to add render-service cost to something already free and good enough for picking
  artwork/variant.
### MP4 export: client-side (WebCodecs), not server-side
Animation export is fully client-side: WebCodecs (`VideoEncoder`/`VideoFrame`,
`AudioEncoder`/`AudioData`) muxed with `mp4-muxer`. All in
`src/components/DisplayCanvas.jsx` (`exportAnimationVideo`, `encodeAudioTrack`). **There
is no `server/` directory, no `/api/export`, no Vite proxy** — an earlier server-side
FFmpeg design was fully removed; don't reintroduce it from old assumptions. Prefers H.264
Constrained Baseline (`avc1.42E034`) specifically to avoid B-frame reordering, which
silently halved framerate on Windows hardware encoders. This is a *different* concern
from print rendering above (video vs. still images) — don't conflate the two.

### Backend: Supabase, seed-first schema
- `supabase/migrations/0001_initial_schema.sql` — `profiles` (1:1 auth.users, trigger
  auto-created on signup), `designs` (`data` jsonb = `{ generatorVersion, seed, colors,
  ... }`, public-readable by default, write-owner-only via RLS), `likes` (junction,
  triggers keep `likes_count` in sync).
- `src/lib/supabase.js` / `designs.js` / `auth.js` — client + data access + email/password
  auth. The client is guarded: exports `null` and warns if env vars are missing, so the
  app doesn't crash without Supabase configured.
- **Gotcha:** the public-gallery query disambiguates the `profiles` embed with
  `profiles!designs_user_id_fkey(...)` — the `likes` junction creates a second
  designs↔profiles join path that confuses PostgREST otherwise.
- **Email/password plus Google OAuth.** Google sign-in needed a Google Cloud Console
  OAuth client (Web application type, authorized redirect URI =
  `https://fgrhbzqzadpjpbzuszpm.supabase.co/auth/v1/callback`) and the resulting Client
  ID/Secret entered in the Supabase dashboard's Authentication → Providers → Google
  config — that's all dashboard-side, no migration. `signInWithGoogle()` in `auth.js`
  reuses the same redirect-handling code already built for email confirmation links.
- Backend is live and verified against the real Supabase project (connection, RLS, the
  embed query, auth endpoint all checked). **Now wired into the UI**, all in
  `DisplayCanvas.jsx`: a Sign In/Account panel (email/password + "Continue with Google",
  with a banner handling Supabase's auth redirect — it lands back on the app with a
  token in the URL hash, which needs explicit UI feedback since `supabase-js` consumes
  it silently),
  Save now also persists to the `designs` table for signed-in users (alongside the
  existing share-link, which still works for everyone), and a Gallery panel
  (Public / My Designs tabs) that lists saved designs and reloads one onto the canvas on
  click.
- **Gallery now has thumbnails, delete, and pagination.** Saving a design regenerates it
  from its own seed/colors at 320x320 (recompose-per-ratio, same approach as the main
  renderer — not a downscaled screenshot of the full canvas) and uploads it to the
  `design-thumbnails` Supabase Storage bucket (`supabase/migrations/
  0002_design_thumbnails_storage.sql`), keyed by `${user_id}/${design_id}.jpg` so RLS can
  check ownership from the path alone — no DB column tracks "has a thumbnail"; a missing
  object just 404s client-side (`<img onError>` hides it), which is what happens for
  designs saved before this existed. My Designs has a per-row Delete (wired to the
  existing `deleteDesign`); the Public tab pages 20 at a time via `listPublicDesigns`'s
  `before` cursor with a "Load More" button.
- **Real bug found and fixed (2026-07-02), traced from a Supabase egress spike**: PostgREST
  egress was 93.6% of daily egress, and `designs` rows were up to 2.3MB each — a
  `starFieldConfig` alone can be 5MB+ (the fully resolved per-star list), and every
  `listPublicDesigns`/`listMyDesigns`/`listTopLikedDesigns` call does `select('*')`. Root
  cause: `MiniGenerator.jsx`'s Save button called `saveCurrentDesign('image', currentDesign)`
  with the **raw, uncompacted** `generateArtwork()` output — unlike DisplayCanvas's own Save
  button, which already compacted via a (now-removed) private `toCompactConfig` method
  first. Fixed by centralizing compaction inside `StudioContext.saveCurrentDesign` itself
  (new shared `src/render/compactDesign.js`, used by both `StudioContext` and
  `DisplayCanvas`) so it's applied regardless of what shape any caller passes —
  `toCompactDesign` is idempotent, so already-compact callers are unaffected. **Existing
  bloated rows were backfilled directly in the database** (all `kind = 'image'` rows
  recompacted to `{ generatorVersion, seed, colors }` — same seed/colors regenerates the
  identical artwork, so nothing changed visually): total `designs` table size went from
  ~7MB+ to ~5.2KB across 46 image rows + 1 animation row (animations were never affected --
  they only ever save through DisplayCanvas's already-correct path). Verified live: the
  gallery renders identically post-backfill, and opening a backfilled design into the
  studio regenerates the same artwork from just its seed/colors.
  **A follow-up full audit (same session) found the identical bug pattern a second time:**
  `order_items.design_data` (checkout's audit-trail copy of what was ordered) had one row at
  191KB, because checking out with "Current studio design" selected sends
  `StudioContext.currentDesign` — always the raw, uncompacted `generateArtwork()` output —
  straight through to `create-checkout-session`, which inserted it as-is.  `design_data` is
  write-only (grepped the whole frontend and every other Edge Function -- nothing ever reads
  it back), so compacting it loses nothing. Fixed with a small mirrored
  `supabase/functions/_shared/compactDesign.ts` (Edge Functions are a separate Deno runtime
  from the Vite frontend, so this couldn't literally share `src/render/compactDesign.js` --
  same fix, applied on both sides) applied right before the `order_items` insert. Backfilled
  the one bloated row the same way (191KB → 77 bytes). The audit also checked Storage
  (`design-mockups`/`design-thumbnails`/`avatars` sizes all look like legitimate real images,
  not bloat) and Supabase's own performance advisor, which flagged RLS policies
  re-evaluating `auth.<function>()` per-row on `profiles`/`designs`/`likes`/`orders`/
  `order_items`, and an unindexed FK on `likes.design_id` — real, but standard scale-related
  suggestions, nowhere near the severity of the two design-data findings above. Both fixed
  same session: `supabase/migrations/0007_rls_performance_fixes.sql` wraps every
  `auth.uid()` call in `(select auth.uid())` (lets Postgres's planner evaluate it once via
  an InitPlan instead of once per row — Supabase's own documented fix, no behavior change)
  and adds `likes_design_id_idx`. Re-ran the advisor after applying: zero performance
  warnings left. Verified live: the public gallery (which exercises the rewritten
  `designs`/`profiles` policies) still renders all 22 cards correctly with zero console
  errors.
- **Real duplicate-save bug found by manual testing (2026-07-02, unrelated to the egress
  bugs above but touching the same save path)**: save a design from the homepage hero's
  studio panel, then visit a route with the `MiniGenerator` widget (e.g. the gallery) --
  it still showed "Save" as available instead of "Saved," and clicking it inserted a
  duplicate row. Root cause: `StudioContext`'s `isCurrentDesignSaved` was **reference**
  equality (`savedDesign === currentDesign`). That only ever held for `MiniGenerator`'s own
  save (it passes `currentDesign` straight through, same object) -- `DisplayCanvas`'s Save
  button always builds a fresh object via `toCompactDesign(this.mainConfig)`, never `===`
  to `currentDesign` even though it's the exact same design. Fixed by comparing the actual
  identity of a design (seed + colors) instead of object identity, via a new `isSameDesign`
  helper. Verified against real generated data (not a synthetic mock, via a temporary debug
  hook since driving a full authenticated save wasn't possible in-session): a compacted
  snapshot of the current design correctly matches itself (`true`), and a stale snapshot
  from *before* clicking Generate correctly stops matching once a genuinely new design is
  generated (`false`).
- **Gotcha:** Supabase's confirmation email links hit Supabase's own verify endpoint
  first (not the app directly), which consumes the one-time token and *then* redirects to
  the app's redirect URL with the session in the hash. If that redirect URL is unreachable
  (e.g. dev server not running yet), the token is still consumed — a retry click will
  show "invalid or expired" even though the account was already confirmed. Fixed by
  passing `emailRedirectTo: window.location.origin` in `signUpWithEmail` (`auth.js`) so
  the link targets whichever environment the user actually signed up from; both
  `localhost:5173` and `chromaforge.app` need to be in Supabase Auth → URL Configuration's
  redirect allow-list for this to work (already added).
- **Email confirmation is live and required** (`enable_confirmations = true`, matching the
  live project — `config.toml` previously had this wrong as `false`, don't trust it without
  checking the Dashboard). Confirmation/recovery/etc. emails go out via **custom SMTP
  through a dedicated Hostinger mailbox** (`no-reply@chromaforge.app`, `smtp.hostinger.com`
  port 465, auth via a Hostinger **App Password** not the mailbox login password) — needed
  because Supabase's built-in mailer caps at 2 emails/hour and only delivers to project-team
  addresses; custom SMTP raises that to a configurable 30+/hour and lifts the
  team-address-only restriction. Configured in the Dashboard's Auth → Emails → SMTP
  Settings (hosted projects only — the CLI/`config.toml`'s `[auth.email.smtp]` block is
  local-dev-only parity, same caveat as the template below). Deliberately a *separate*
  mailbox from `support@chromaforge.app` (which stays human-monitored, linked on the legal
  pages) — keeps automated/bot-prone signup traffic from risking the reputation of the
  address people expect real replies from.
- **Branded "Confirm signup" email template**, `supabase/templates/confirmation.html` —
  table-based/inline-styled HTML (with an Outlook VML button fallback) matching the site's
  actual design tokens (Exo/Quicksand, the studio-green wordmark treatment, the spectrum
  gradient bar, the exact `.cf-btn-primary` purple→magenta CTA gradient) rather than a
  generic template. `config.toml`'s `[auth.email.template.confirmation]` points at it for
  local dev; the **hosted project needs this HTML pasted directly into the Dashboard's Auth
  → Email Templates → "Confirm signup"** — the CLI does not push email templates to hosted
  projects. Live-verified 2026-07-01: real signup → real Hostinger-delivered email,
  correctly branded, working confirmation link.
- **Gotcha, fixed:** GoTrue's anti-enumeration behavior means `signUp()` returns the same
  shape (`session: null`) whether it's a genuine new signup or the email already has a
  confirmed account — without handling this, a returning user hitting "Create account" was
  told to check an inbox that would never receive anything. `signUpWithEmail` (`auth.js`)
  now detects this via `user.identities.length === 0` (confirmed live: this is `[]` for an
  existing account, populated for a real new signup) and returns `alreadyRegistered: true`;
  `AccountPage.jsx` switches to sign-in mode and shows "An account with this email already
  exists. Sign in instead." instead of the misleading confirmation message.

### Merch pipeline: Printful catalog → mockup preview → Stripe checkout → real order
- `src/lib/printful.js` — catalog browsing (`listCatalogProducts`/`getCatalogProduct`/
  `getPrintfileSpecs`) via the `printful-catalog` edge function (read-only, Printful's v1
  API), plus `PRODUCT_MOCKUP_CONFIG` — a hand-verified, per-product map of
  placements/technique/required options for all 11 starter products (every entry confirmed
  against a real mockup task; see the file's header comments for product-specific quirks
  like the track jacket's `details`+sleeves combo failing outright). `resolvePlacementEntries`
  + `renderAndUploadPrintFiles` are shared between mockup previews and real checkout: mockup
  previews filter to only the placements visible in the requested camera-angle photo
  (`cfg.placements`); a real **order** needs every placement regardless of visibility
  (left-out placements render as blank fabric on the actual garment) — checkout calls
  `resolvePlacementEntries` with no filter.
  - **Pocket continuity, 2026-07-04**: on cut-sew products with a visible front pocket
    (hoodie 388, zip hoodie 717), the `pocket` placement no longer gets its own
    independently-generated composition — by default that produced a small, oddly-scaled
    "echo" of the whole front design crammed onto the pocket (confirmed bad via real
    mockups), since the generator is ratio-aware and a pocket's own printfile is a
    different aspect ratio than the front's. Fixed via a `pocketCrop` config per product
    (in `PRODUCT_MOCKUP_CONFIG`): `renderAndUploadPrintFiles` generates the FRONT
    composition once, then composites one or more `{ src, dest }` fraction-rects
    (`drawRegionsComposite`/`drawRegion`, mirrored byte-for-byte between
    `lib/printful.js` for mockups and `render-service/render.js` for real print files) so
    the pocket becomes a literal crop of the front instead of an unrelated render.
    **Hard-won lesson, confirmed across ~8 real-mockup iterations**: a `dest` smaller than
    the full output canvas is fragile — any area outside it falls back to a differently-
    scaled cover-fit of the whole front, and the boundary between the two reads as a
    visible seam/doubled content the moment the real garment's visible-crop assumption is
    even slightly off (it was, twice — a hand-measured "safe area" from Printful's CAD
    sewing templates, and separately a scale inferred from a labeled calibration-grid
    upload, both produced this exact defect). The only structure that's been defect-free
    is `dest` filling **100%** of the canvas (`{x:0,y:0,w:1,h:1}`) — whatever the garment's
    own real crop discards is simply invisible, same as for any upload; only the `src`
    window (with zero overhang, so no edge-clamp-stretch artifacts either — see below)
    needs tuning, and only visually, from real mockups. The hoodie (388) needed one
    `src` rect (solved from CAD template geometry, since its pocket panel and front share
    one printfile at the same aspect). The zip hoodie (717) is structurally different —
    two zip panels forming the front, a compound two-piece welt pocket on its own
    differently-aspect-ratio printfile — and needed its `src` window's vertical offset
    bisected empirically against real mockup feedback (`y=0.36`, see the 717 config
    comment for the full trail); exact per-pocket registration was attempted and abandoned
    for the same seam-defect reason above. The track jacket (801) has NO pocket-crop
    config: its `pocket` placement is the inside pocket lining, never visible in any
    mockup or on the worn garment, so there's nothing to fix. `drawRegion`'s 9-patch
    edge-clamp (stretches the source's edge pixel outward) only matters for a `src` window
    that overhangs the canvas by a few percent (388's does, by design, to reach a real
    part of the design at its exact print scale) — overhang beyond roughly 20% produces
    its own defect (visibly flat stretched color bars), so it's used sparingly.
  - **Per-placement geometry picker, 2026-07-04**: `settings.geometry.frontOnly` (a
    saved-design toggle for suppressing the geometry layer on non-front placements) was
    removed — baking that choice into the design meant it was permanent for every product
    the design was ever printed on, which didn't make sense once printing on multiple
    products became real. Replaced with a per-order choice: `ProductPage.jsx` shows a
    "Geometry placement" section (checkboxes for Front/Back/Left sleeve/Right
    sleeve/Hood, filtered per-product via `getGeometryPlacementOptions`, defaulting to
    all checked) whose selection — a plain `Set` of placement keys, never persisted —
    flows through `renderAndUploadPrintFiles`'s `geometryPlacements` param into
    `generateArtwork`'s `renderContext.includeGeometry` (renamed from the old
    `isFrontPlacement`, which is now genuinely about "does this specific render include
    geometry," not "is this the front"). `pocket` has no checkbox of its own — it always
    mirrors whatever `front` resolves to, since its content is literally cropped from the
    front's render (see pocket continuity above); this also fixed a latent bug where the
    pocket crop's source generation had `includeGeometry` hardcoded true, which would
    have silently mismatched a front rendered with geometry off. The selection is part of
    the mockup cache key (`useMockup.js`) so toggling a checkbox correctly misses a stale
    cached preview instead of silently reusing one rendered under a different selection.
  - **Label placements, 2026-07-04**: Printful's catalog was audited product-by-product
    (`getPrintfileSpecs`/`getPrintfileSpecs?templates=1`, live) and turned out to expose
    *three* distinct label-type placements, not one, previously never even considered:
    `label_inside` (universal, every hooded/crewneck product, fixed 375×150px/2.5"×1",
    `fit`), `label_outside` (joggers/track jacket only, 450×450px/3"×3", `cover`), and
    `label_panel` (hoodie/zip hoodie/sweatshirt only — confirmed via Printful's own
    mockup-generator template reference images to be the hood/neckline **interior lining**
    panel, sharing a full-size printfile with front/pocket, not a small tag despite the
    name). Real checkout already submits every placement Printful returns
    (`resolvePlacementEntries` with no filter — see above), so all three were already being
    *sent*; `label_inside`/`label_outside` just got the same shrunk full composition every
    other placement does, which for a 2.5"×1" tag reads as noise, not a mark. Fixed with a
    dedicated generator, `src/render/generateLabelMark.js` +
    `renderLabelMark.js`: reuses `Logo.jsx`'s 37-chord vectorclash line geometry and its
    exact per-line color logic from `animateLogo()` (each chord independently has a 60%
    chance to show at all; of those, ~80% render a random light greyscale value and ~20% a
    small hue-spin variant of one accent picked from the design's own palette — never one
    flat color for the whole mark) and its fixed white outer ring (never randomized, per
    `Logo.scss`), against a fixed dark background (`#181520`, the app's own
    `--color-ink-900` token — chosen because the ring is white and would vanish on
    anything light). Seeded off `${design.seed}-label`, a separate rng stream from the main
    artwork's so geometry-slider tweaks can't shift which chords survive on the label.
    **Real bug caught before shipping**: the first version centered against Logo.jsx's own
    declared SVG viewBox (`0 0 313.4 303.4`), which doesn't actually bound the geometry —
    the ring alone spans out to x=325, past the viewBox's own width — producing a visibly
    off-center mark; fixed by computing the true bounding box (ring ∪ lines) directly from
    the coordinates instead of trusting the source SVG's viewBox. Both placements are tiny
    enough (well under iOS Safari's canvas cap) to render synchronously client-side and
    upload straight to the `design-mockups` bucket, for *both* the mockup preview and real
    checkout — deliberately bypassing `render-service`/`render-print-file` entirely for
    these two placements, since the only reason that pipeline exists (mobile's canvas-area
    ceiling) doesn't apply at this size. `label_panel` is untouched by this — it keeps
    getting the real front composition (confirmed via Printful's own template reference
    images that a fully-patterned lining is legitimate, not a bug) — except its geometry
    layer is now *always* forced off (`includesGeometry` in `printful.js`), matching every
    other placement's intent-to-hold-a-simple-mark-or-plain-pattern rather than a copy of
    the front's full geometry-laden composition; previously this was already true in
    practice as an accident of `label_panel` never being one of
    `getGeometryPlacementOptions`' checkbox keys, now it's an explicit, guaranteed rule.
  - **Geometry layout toggle for two-leg-canvas products, 2026-07-05**: mesh shorts
    (693) and joggers (784) print from one flat front/back canvas that gets physically cut
    into two garment legs when sewn (see their `PRODUCT_MOCKUP_CONFIG` entries'
    `twoLegCanvas: true`). The geometry shape's default centering (dead on `width/2`) landed
    it exactly on that cut line every time — found via a real generated mockup, confirmed
    the worst possible spot (hidden in the inseam). Fixed with a per-order "Geometry layout"
    toggle on `ProductPage.jsx` (Single leg / Mirrored, default Single leg), threaded as
    render context (`geometryLayout`, same non-persisted treatment as `includeGeometry`)
    through `generateArtwork.js` → `GenerateGeometricShape.js` → `GeometricShape.js`, which
    anchors the shape at `width/4` (single) or draws it twice, mirrored, at `width/4` and
    `3*width/4` (mirrored) instead of `width/2`. Verified byte-identical to pre-change output
    when unset (SHA-256 match) — every other product is unaffected.
    **Real regression caught the same day**: the `geometryLayout` React state defaulted to
    `'single'` for *every* product, not just the two flagged ones, and was sent
    unconditionally — since any truthy value is "not centered" to the renderer, every other
    product's geometry silently started rendering off-center-left. Fixed by gating on
    `hasTwoLegCanvas` once (`effectiveGeometryLayout`) and using that everywhere instead of
    the raw state.
- `src/hooks/useMockup.js` — drives the *preview* pipeline (render → upload → Printful v2
  `mockup-tasks` via the `printful-mockup` edge function → poll → dedupe by camera angle →
  cache). Free, no money involved. One automatic retry on Printful's occasional transient
  "Internal Server Error" for AOP products. Exposes `elapsedSeconds` + `BUSY_STATUSES` for
  UI feedback during the 30–90s+ round trip.
- **Real checkout** (`supabase/functions/create-checkout-session`,
  `supabase/functions/stripe-webhook`, `src/lib/checkout.js`, wired into
  `ProductPage.jsx`'s "Buy now" and a new `CheckoutSuccessPage` + `AccountPage` order
  history section): Stripe Checkout (hosted page, collects shipping address natively) →
  webhook confirms payment → submits the real Printful order. Schema:
  `supabase/migrations/0005_orders_schema.sql` + `0006_order_items_product_options.sql`
  (`orders`/`order_items`, owner-read-only RLS, **no client insert/update policy at all** —
  only the service role, used exclusively by these two functions, writes orders).
  - **Store-wide purchasing kill switch**: `supabase/functions/_shared/storeStatus.ts`'s
    `isStoreEnabled()`, gated on the `STORE_ENABLED` secret (same instant-toggle pattern as
    `PRICE_MARKUP_PERCENT` in `pricing.ts` — `npx supabase secrets set STORE_ENABLED=false`,
    takes effect on the next request, no redeploy). Only pauses checkout: `printful-catalog`
    attaches `storeEnabled` to its single-product response (the one `ProductPage.jsx`
    already fetches, so no extra request), which disables Buy Now and shows "Store
    purchasing is temporarily offline" — browsing, mockups, the gallery, and the studio all
    stay fully operational. `create-checkout-session` independently rejects with a 503 if
    the flag is off too (defense in depth against a tab left open from before the flag
    flipped, not just trusting the client-side check). Unset/anything other than the
    literal string `"false"` means enabled, so a fresh project isn't accidentally locked
    out. No effect on the signed-out flow, which already shows "Sign in to buy" regardless.
  - `create-checkout-session` (`verify_jwt = true`): re-prices server-side against
    Printful's catalog (never trusts the client's price), validates quantity server-side
    (integer 1–10 — the UI's stepper cap, enforced again here since the value multiplies
    into the charge and the production run), inserts a `pending` order + item *before*
    creating the Stripe session, and stashes just the order id in the session's `metadata`
    (Stripe metadata caps at 500 chars — nowhere near enough for a design jsonb, so the
    design/print-file URLs live in our own DB row instead).
  - **Shipping + tax are charged at checkout** (2026-07-01, shipping calc reworked
    2026-07-02): `supabase/functions/_shared/shipping.ts` replaces the original single
    `SHIPPING_FLAT_CENTS` flat rate with a **weight-class × region rate table**, verified
    against Printful's real AOP shipping-rate tables — the flat $5.99 was checked against
    those tables and found to be losing money on almost every order (up to $6 on an AOP
    hoodie to Australia/NZ, every Canada order, every hoodie/sweatshirt/jacket order).
    Product weight class (`"light"` t-shirts/shorts vs. `"heavy"` hoodies/sweatshirts/
    jackets/joggers) is known automatically server-side since the product being bought is
    already known at session-creation time — no guessing there. Destination region isn't
    known that early though: true per-address dynamic shipping requires switching hosted
    Checkout to Stripe's embedded (Elements) Checkout, which also disables Apple Pay/Google
    Pay entirely (confirmed via Stripe's docs) — decided against that trade. Instead, Stripe's
    `shipping_options` offers one correctly-priced choice per region (US/Canada/UK/Europe/
    Australia-NZ) in the same session, and the customer picks whichever matches their own
    address — Stripe doesn't cross-check the selected option against the address they
    actually type, so an honest customer picking the wrong region is a known, accepted gap,
    not a bug. The 3 non-clothing starter products (tote bag, crossbody bag, pillow) aren't
    covered by Printful's clothing rate tables and are approximated as `"light"` pending a
    real look-up. `SHIPPING_FLAT_CENTS` still works as an emergency override to a single
    flat rate (or 0 to disable shipping entirely), same instant-toggle pattern as the
    markup, no redeploy needed — leave it unset to use the new table. Stripe Tax via
    `automatic_tax` (kill switch:
    `STRIPE_AUTOMATIC_TAX=false`), `tax_behavior: "exclusive"` on both the item and the
    shipping rate. **Requires one-time Stripe dashboard activation (Settings → Tax) or
    session creation errors** — see TODO.md. The pending order row's totals are estimates;
    `stripe-webhook` overwrites `subtotal_cents`/`total_cents` with Stripe's authoritative
    `amount_subtotal`/`amount_total` (which include shipping + tax) once payment completes.
  - `stripe-webhook` (`verify_jwt = false` — Stripe's caller carries no Supabase JWT, only
    a `Stripe-Signature` header, so auth here is the signature check alone, via
    `Stripe.createSubtleCryptoProvider()` + `constructEventAsync`, Deno's documented
    pattern since it has no Node crypto module). Idempotent on `status='pending'` guard,
    and the guarded update `.select()`s and checks the affected-row count — zero rows is
    not a PostgREST error, so without that check two *concurrent* deliveries of the same
    event could both pass the earlier status read and both submit to Printful; whichever
    claims the pending→paid transition proceeds, the other no-ops. The Printful recipient
    includes `session.customer_details.email` so Printful can send shipping/tracking
    notifications (Stripe receipt emails are a separate dashboard toggle — see TODO.md).
    Printful's v2 Orders API (`POST /v2/orders`) **always creates an unconfirmed draft** —
    a separate `POST /v2/orders/{id}/confirm` actually charges/fulfills it; the webhook
    does both back-to-back since the customer already paid via Stripe.
  - **Edge-function auth gotcha, fixed 2026-07-01**: `verify_jwt = true` is NOT "signed-in
    users only" — the public anon key shipped in the JS bundle is itself a valid JWT and
    passes that gate (confirmed live: it reached `printful-mockup`'s logic before the fix).
    Any function whose work costs money/quota must ALSO verify a real user: `printful-mockup`
    now does the same plain-fetch GoTrue `/auth/v1/user` check `render-print-file` uses
    (not the SDK — see that function's bundle-timeout note). `render-print-file` also
    clamps width/height to ≤6500px so oversized requests can't OOM the 1GB Fly machine.
  - **`PRINTFUL_SKIP_CONFIRM` secret**: Printful has no sandbox/test mode at all — orders
    are real and billed regardless of which store id is used, completely independent of
    Stripe being in test mode. Rather than standing up a second "test store" (which
    wouldn't actually be safer — still real, still billed), this secret makes the webhook
    create the Printful order but skip the `/confirm` call, so end-to-end testing produces
    a real, inspectable draft that's never charged or produced. **Set while testing; unset
    before real customers can check out** — that single secret is the only thing standing
    between this and live order fulfillment.
  - **Live-verified** (2026-06-30): a full real run — Stripe test-mode payment (card
    `4242...`) → webhook signature verified → order persisted → Printful order created and
    visible as a Draft in the dashboard (`PRINTFUL_SKIP_CONFIRM` was set) — confirmed
    working end to end, not just builds-clean. API version pinned to `2026-06-24.dahlia`
    in both edge functions, matching the actual Stripe account/webhook destination (not
    guessed). Stripe's "Managed Payments" (merchant-of-record tax/fraud handling) was
    explored but is **ineligible for physical goods** — it's a digital-goods-only program;
    this account uses standard Stripe Checkout instead.
  - **Printful-failure-after-Stripe-success handling**: still not auto-refunded — a
    failure could be a fixable data issue (bad address, stale variant) that's
    resubmittable, not necessarily a "give the money back" situation, so this is a
    deliberate human-judgment-call gap, not an oversight. What *is* now built:
    `stripe-webhook` retries the Printful create/confirm calls once before giving up (same
    pattern as `useMockup.js`'s retry for Printful's occasional transient "Internal Server
    Error" — the created draft order id is tracked across attempts so a confirm-only
    failure retries just the confirm, not a second `POST /orders`, which would otherwise
    leave an orphaned duplicate draft), and sends an email alert
    (`sendOrderFailureAlert`, `npm:nodemailer` over raw SMTP against the same Hostinger
    mailbox used for Auth emails — needs its own `ORDER_ALERT_SMTP_*`/`ORDER_ALERT_EMAIL_TO`
    secrets since Edge Functions can't reach Supabase Auth's own SMTP config) so a human
    finds out promptly instead of stumbling onto a `'failed'` order days later.
    **Raw SMTP confirmed working from Supabase Edge Functions** (2026-07-02, live-tested
    via a throwaway `test-order-alert` function, since deleted) — Supabase's own docs
    recommend an HTTP email API (Resend) over raw SMTP specifically because serverless
    runtimes commonly block outbound SMTP ports, so this was a real open question, not a
    formality; settled by an actual received test email, not just a clean API response.
    Note for future debugging: `sendOrderFailureAlert` still fails silently by design (a
    broken alert channel must never block order processing) and only logs the error, so a
    regression here wouldn't be obvious without checking `stripe-webhook`'s logs directly.
  - Print files now ship at true print resolution via the Fly.io render-service (see
    "Server-side print rendering" below) — the earlier capped-browser-render gap here is
    closed, live-verified end to end (2026-07-01).

### Styling: Tailwind v4, fully migrated (not partial)
The whole app was migrated from SCSS to Tailwind v4 + a small custom-CSS layer — this was
the user's explicit call, made *against* an earlier instinct to leave the working UI
alone, because "do it now while the app is small." It's done and merged to `master`.

- `src/tailwind.css` — `@import 'tailwindcss'` (Preflight is **enabled**), the
  `--font-quicksand` token, the relocated Quicksand/Exo Google Fonts `@import url()`
  (must stay the first statement in the file), and the few app-globals Preflight doesn't
  cover (bg color, full-viewport sizing, the font stack/smoothing).
- `src/styles/components.css` — scoped custom CSS for everything utilities can't express:
  glassmorphism `backdrop-filter`, gradient borders/fills, `@keyframes`, GSAP-morphed SVG
  internals, complex hover states, and the themed `jscolor` color-picker popup (see
  below). Everything here is scoped under `.display-canvas` or the relevant hook class.
- **Every GSAP/JS selector hook (class or id) was preserved** through the conversion —
  utilities were added alongside hook classes, never replacing them. If you touch
  `DisplayCanvas.jsx` or `ColorField.jsx`, grep for `gsap.` selectors and
  `querySelector`/`getAttribute('data-color-id')` before renaming any class.
- `src/components/Logo.jsx` + `Logo.scss` are the **one intentionally unconverted**
  leftover — it's the vectorclash logo mark, currently unused, earmarked for a future
  About page. Don't migrate it speculatively before it's actually mounted somewhere (you
  can't verify a conversion against a render that doesn't exist).
- The `jscolor` third-party color-picker popup (opened by tapping a color swatch) is
  themed via `jscolor.presets.default` in `index.html` (background/border/radius/shadow —
  most of it) plus targeted `!important` overrides in `components.css` for the bits the
  library sets via inline style (close-button font/hover) or doesn't expose as a preset
  option at all (inner palette/slider corner rounding, via structural `:has(> canvas)`
  selectors since those elements are unclassed). If you resize the picker
  (`width`/`height`/`sliderSize`/`padding` in the preset), the slider-rounding selector
  (`[style*='width: 20px']`) and the close-button's `right` value are both keyed to the
  current preset numbers — keep them in sync.

## Current state / what's deployed

`master` is deployed (push triggers GitHub Actions → FTP → chromaforge.app). As of the
last push, live includes: the seed-based renderer (Phases 1–2 of the print pipeline), the
full Tailwind migration, a batch of ColorField drag-and-drop fixes (dead-zone hit-testing,
swap-instead-of-insert reorder logic, a perf throttle, a listener-leak fix) plus the
jscolor picker theming, the Supabase auth/save/gallery UI, and the Printful catalog/mockup
preview pipeline (Shop/ProductPage, `useMockup`) — confirm what's actually been committed
and pushed before assuming any specific recent change is live, this file tracks what's
*built*, not what's deployed.

The Stripe checkout → real Printful order pipeline (see "Merch pipeline" above) is
**deployed to Supabase Edge Functions and live-verified** — a real Stripe test-mode
purchase has gone through both functions end to end and produced a correct Printful draft
order. `PRINTFUL_SKIP_CONFIRM` is still set (intentionally, for continued testing), so no
order can be confirmed/billed/produced yet — check whether it's still set before assuming
real customers can complete a purchase.

Server-side print-resolution rendering is **built, deployed (Fly.io + a new
render-print-file Edge Function), wired into checkout, and live-verified** (see
"Server-side print rendering" above) — the print-resolution gap called out in the Merch
pipeline section above is closed. Ratio-aware generation tuning is also done (see
"Renderer: seed-based, not pixel-based" above).

**`feature/account-gallery-ui` merged to `master` and pushed 2026-07-05** — everything
that was gated on that merge (gallery/accounts, the print pipeline, ratio-aware
generation, site-wide entrance animations, the wordmark hover effect, the two-leg-canvas
geometry layout toggle, the mobile shop-carousel fix) is live on chromaforge.app now,
not just deployed-but-unmerged. Several more commits landed directly on `master` the same
day fixing real bugs found during live testing that followed the merge (a leaked
credential, checkout dimension validation, render-service memory/concurrency, an
off-center-geometry regression) — see this file's other sections and `git log` for
specifics rather than assuming this paragraph stays current for long.

**Real, live-tested checkout currently works end to end for at least the t-shirt**
(confirmed 2026-07-05: Stripe charge → Printful order → stays in valid `draft`, never
fails). **Several other products (mesh shorts, zip hoodie confirmed; hoodie, sweatshirt,
track jacket, joggers suspected) currently cannot actually be fulfilled** — Printful's own
catalog and production pipeline disagree on print-area size, unrelated to anything in this
codebase (see "Server-side print rendering" above and `TODO.md`'s "Blocking launch"
section for the full evidence and product list). `PRINTFUL_SKIP_CONFIRM` is still set
(intentionally, for continued testing), so no order can be confirmed/billed/produced yet
regardless — check whether it's still set before assuming real customers can complete a
purchase.

A full pre-launch review + hardening pass landed 2026-07-01 (checkout shipping/tax, the
webhook race fix, the mockup-function auth gate, OG/meta tags with a pipeline-rendered
`public/og-image.jpg`, per-route titles, scroll-to-top, an error boundary,
`prefers-reduced-motion`, skeleton loaders, a route-enter transition). **The remaining
path to launch — ops steps, go-live sequence, and deferred code items — lives in
`TODO.md` at the repo root**; treat it the same way as this file (living facts, prune as
things land).

## Local setup (new machine / clone)

1. `npm install`
2. Create `.env.local` (gitignored, not in git) with:
   ```
   VITE_SUPABASE_URL=<see Supabase dashboard>
   VITE_SUPABASE_ANON_KEY=<the "publishable" key, sb_publishable_... works fine with supabase-js v2>
   ```
   Ask the developer for these — they're real project credentials, not regenerable from
   the repo.
3. `npm start` → Vite dev server on **port 5173** (not 3000 — `.claude/launch.json` is
   already corrected for this, but if it drifts again, 5173 is Vite's actual default).
4. Build/verify with `npm run build` before considering any change done.

## Working conventions established this project

- **Verify every styling/behavior change against a live baseline** — computed-style
  diffs, screenshots, and actual interaction tests (drag, click, toggle), not just "it
  builds." This caught several real bugs (clipped pointer indicators, dead-zone hit
  testing, a reorder-logic bug) that a build-only check would have missed.
- Prefer fixing root causes over hardcoded magic numbers — e.g. the close-button width
  fix uses `left`/`right` anchoring so it self-adjusts if the picker is resized, instead
  of a fixed pixel width that would drift out of sync.
- Don't migrate/touch code that isn't actually exercised yet (see Logo.jsx above) — you
  can't verify a change against a render that doesn't exist.
