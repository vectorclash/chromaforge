# Chromaforge — project context for Claude

This file is the portable handoff doc for this project. It's checked into git specifically
so that any Claude Code session — on any machine — has the architecture decisions and
current state without needing the original chat history. Keep it updated as work lands;
treat the bullet points below as living facts, not a changelog (prune/update rather than
appending forever).

## What this is

A generative art web app (live at **chromaforge.app**). Vite + React, static build,
deployed via GitHub Actions → rsync over SSH on every push to `master` (switched from
FTP 2026-07-10 after repeated multi-minute Hostinger FTP outages; key auth via the
`DEPLOY_SSH_KEY` repo secret, host key pinned in the workflow, public key managed in
hPanel's SSH Access page) (see
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
- **Printful order failures: root cause was the `label_inside` placement on the v2-beta
  ORDERS API, RESOLVED 2026-07-15 by porting `stripe-webhook` to the stable v1 orders
  API** (the original "production can't handle these print-area sizes" theory, and the
  later "not fixable from this codebase" conclusion, were both disproven). History: real
  orders on v2 would go `failed` ~10-40s after creation via Printful's async
  file-processing (placements silently emptied, "Failed to process design") whenever the
  order included `label_inside`; the exact same product/placements/files process cleanly
  on v1 — proven via controlled v1 draft orders (166981022: all 8 zip-hoodie placements
  incl. the real label mark, all `ok`) and a full live e2e checkout through the ported
  webhook (166989163). Labels are submitted normally again; no placement filtering.
  Mockups deliberately stay on v2 (`printful-mockup`/`useMockup` — works fine there).
  v1 gotcha handled in the port: v1 hard-rejects some products without their required
  item option (zip hoodie needs explicit `stitch_color`) where v2 silently defaulted it —
  the webhook maps `order_items.product_options` `{name,value}` → v1 `options`
  `{id,value}`. Also: v1's `DELETE /orders/{id}` marks a draft `canceled` but leaves it
  visible in the dashboard, and failed orders have their files list emptied server-side.
  See `TODO.md`'s (now-resolved) "Blocking launch" item for the full evidence trail.
- `supabase/functions/render-print-file/index.ts` deliberately uses plain `fetch()` against
  Supabase's Auth (`/auth/v1/user`) and Storage (`/storage/v1/object/...`) REST endpoints
  instead of the `@supabase/supabase-js` SDK every other function uses — pulling in the
  full SDK (which drags in `realtime-js`'s Node polyfills) made this function's bundle step
  repeatedly time out on deploy (`Bundle generation timed out` / a `deno.land` fetch
  timeout inside `realtime-js`), confirmed reproducible across multiple attempts. No
  `deno.json`/import map needed as a result. If this function ever needs more than
  "verify a JWT" + "upload a file," reconsider whether the SDK's bundle-time cost is worth
  it, but don't reach for it by default here.
- **Pre-warm (2026-07-16)**: `GET /warmup` on the render-service is a no-op, no-auth
  endpoint whose only job is making Fly wake the scaled-to-zero machine;
  `warmRenderService()` (`lib/printful.js`) fires a no-cors, 2-min-throttled ping at it on
  every mockup request (`useMockup.generate`, before the cache check on purpose) so the
  ~6s cold start (measured live) is already paid before a Buy Now needs `/render`. Idle
  scale-to-zero behavior is unchanged; the URL isn't a secret (only RENDER_SERVICE_KEY
  is, and /warmup never touches it).
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
**Export/animation loose ends closed 2026-07-18** (Aaron's purpose for exports: advertising
videos for the app — quality bar is commercial): a "Speed Ramp" Video-tab toggle warps
playback time with a per-cycle sine ease-in-out (`src/utils/speedRamp.js` — the single
source of the warp; the 2D preview drives its GSAP timeline through it via a gsap.ticker,
the 3D preview/exporter pass warped time + a 0..1 `rush` factor into `setTime`, so preview
and export stay motion-identical and loops stay seamless — velocity is symmetrically zero
at the seam). iOS music export was silently broken: WebKit's AudioEncoder omits the AAC
`decoderConfig.description`, so mp4-muxer wrote an unplayable audio track with no error —
`encodeAudioTrack` now synthesizes the AudioSpecificConfig bytes when missing
(phone-verified fix), and a requested-but-skipped music track alerts instead of failing
silently. Fast-motion blockiness fixed: `latencyMode: 'quality'` on Constrained Baseline
(structurally can't B-frame; only the High Profile fallback keeps 'realtime'), mobile
bitrate 15→25Mbps, keyframes every 2s. Previews (both modes) freeze during export so a
live scene never competes with the encoder.

### 3D animation mode (three.js star tunnel), 2026-07-11
**Flight speed is duration-independent as of 2026-07-18** (Aaron's original intent — the
old one-fixed-tunnel-per-cycle rule made longer durations just slower): the scene builds
`FLIGHT_SPEED (240 u/s) × duration` of unique content, capped at `MAX_CONTENT_LENGTH`
(2400), past which the camera does an exact integer number of laps per cycle (seam-safe;
laps read color-shifted since all color evolves over the full cycle). Content counts scale
linearly with length (sqrt for draw-call-bound sprites), spatial frequencies by the rounded
factor (still integers → still loop-safe). The speed-ramp `rush` factor (see MP4 export
section) widens FOV (+14° peak) and pulls the warp-onset uniform closer (−55) mid-cycle.
A "3D" toggle in the studio's Video settings tab switches animation mode from the 2D
frame-crossfade flow to a real-time three.js scene: a camera flying through a long tunnel
of noise-clustered stars (value-noise rejection sampling adapted from
`temp/sound-generator`'s star placement, seeded via `makeRng(seed + '-3d')` — a separate
rng stream so 2D determinism is untouched) with 3D lattice structures (the same
ring/chord cell families as `GenerateGeometricShape.latticeCells`, rings z-offset/twisted
into 3D, panels filled with the same ±10° palette-spin logic), a camera-locked
mesh-gradient shader background cycling the design's palette, and palette-lerped FogExp2.
Key facts:
- `src/animation3d/tunnelScene.js` — pure deterministic scene factory; `setTime(seconds)`
  drives ALL motion/color (no internal clock), so the GSAP-timeline preview
  (`src/components/Animation3DPreview.jsx`) and the MP4 exporter step identical frames.
  Everything is periodic in the cycle duration (camera z wraps modulo TUNNEL_LENGTH,
  content tripled at ±TUNNEL_LENGTH, all time terms sin/cos of 2π·progress·integer) so
  exports loop seamlessly — verified on a real 3840×2160 export (first-vs-last-frame
  pixel diff ≈ one frame of motion).
- three.js is dynamically imported (its own lazy chunk, ~185KB gzip) — never loads unless
  3D mode is used. Star sprites are the sound-generator example's INVERTED variants
  (`star-sprite-*-3d.png`, Aaron's explicit call), not the 2D pipeline's — those are
  authored for canvas compositing and read wrong as additive points.
- In 3D mode only Duration + Include Music remain in the Video tab (Frames/Star Frames
  are 2D-only, hidden); Duration and the geometry sliders apply LIVE (scene rebuilds are
  instant) rather than via the 2D "regenerate to apply" notice. Generate is instant (new
  seed, no frame build); the 2D frames stay in state so toggling 3D off restores them
  without a rebuild (or kicks off a build if none were ever made).
- Save is deliberately disabled in 3D mode (v1, Aaron-approved deferral): `threeDDesign`
  is already the compact `{ seed, colors, settings }` shape, but the gallery/share load
  paths can't replay a 3D animation yet.
- `exportAnimationVideo` branches on 3D: renders the scene per frame into a WebGL canvas
  at export resolution (VideoFrame constructed same-task, so no preserveDrawingBuffer)
  and shares the entire encoder/muxer/audio path with 2D unchanged.
- WebGL context creation can genuinely fail (GPU blocklists, headless) — found live via a
  flag-less headless run: Animation3DPreview catches init errors and DisplayCanvas falls
  back to 2D with an alert instead of a black screen + unhandled rejection.
- Additive-blending tuning was real, from headless screenshots: additive panels blew out
  to white sheets at any useful opacity, and lattice stations get a minimum radial offset
  (0.18×TUNNEL_RADIUS) so the camera never flies through a structure's converged center
  (a full-frame whiteout otherwise).
- **Reworked same day on Aaron's feedback ("looks like 2D full coherence; not colorful
  enough — look at real 2D renders"):** geometry structures are now chaotic-first, like
  the 2D default — random triangles over the lattice point set with rng²-skewed size
  variance (some structures span the whole frame), per-CORNER palette-spun vertex colors
  (the 3D analogue of the 2D 3-stop gradient fill), normal blending at 0.5 opacity (not
  additive — washed to white over a colorful background), with the ordered chord web only
  blending in as coherence rises (same keepCount/cellKeep trade as 2D). Color: the
  background shader is a NORMALIZED weighted mix of palette colors (full-coverage
  saturated mesh gradient, never dark-space-plus-tints), palette-colored nebula glow
  sprites were added, fog is saturated palette color, and — the fix that actually killed
  the monochrome-scene problem (threshold-based accent injection wasn't enough) — a
  seeded complement-side accent palette (mirroring GenerateStarField's baseHue complement
  bias in 2D) unconditionally rides alongside the design palette in the dome, geometry,
  and nebulae, so every scene holds several distinct hue families at once.
- **Geometry layer: a continuous geometric TUNNEL (2026-07-11, third iteration —
  Aaron's direction after two rejected approaches).** Floating lattice monuments, then
  noise-driven floating shards with a distance "bloom", both failed the same way: isolated
  shapes popping in at the fog line never read as intentional, and the shapes themselves
  weren't interesting. Replaced wholesale by `buildGeometricTunnel`: one continuous
  lattice bore the camera flies through — polygon rings (sides from the design's points
  sliders) every ~12 units, per-ring twist (total twist = integer multiple of the
  polygon's symmetry step, for the loop seam), rings connected by longitudinal rails +
  diagonal chords + occasional long in-ring star-chords, a sparse fraction of cells
  filled as gradient panels (fill rate rises with coherence; jitter falls with it —
  coherence 0 is a ragged hand-bent scaffold, 1 a clean bore). Per-frame `update()`
  recomputes every ring vertex: a radial ripple traveling down the tunnel plus a palette
  color WAVE flowing along z and through time (edge + panel vertex colors update every
  frame). No pop-in by construction — the tunnel recedes into fog ahead/behind. Camera
  still flies dead-ahead with slight positional sway. Star shells (near 5000 / far 7000
  at radius 46→140), nebulae, and the background dome are unchanged from the earlier
  iterations; fog 0.009; camera far 450.
- **Space-warp distance compression (Aaron's idea, same day):** far-distance pop-in
  (worst for the unfogged stars) is gone — a vertex-shader patch (`applyWarpShader`,
  onBeforeCompile on the star Points / tunnel LineSegments / panel Mesh materials) scales
  view-space lateral position to zero between WARP_START(170)→WARP_END(380), so distant
  content is born compressed at the vanishing point and expands outward as it approaches
  (visible in exports as the tunnel funneling to a point). Sprites (large stars, nebulae)
  mirror the same curve as a JS scale factor (`warpFactor`) since SpriteMaterial isn't
  chunk-based. Same-day look tuning from Aaron's feedback: panels have their own
  per-vertex color pass at full chroma + MID lightness (s=1/l≈0.5 — pushing lightness
  high read pastel, not vivid), opacity 0.85, panel fill rate 0.28 base, wide per-vertex
  palette-phase jitter (±0.3) for strong multi-color gradients; wireframe density rolls
  per ring section (some sections bare, some fully caged) so the scaffold isn't uniform.

### Homepage hero: 3D t-shirt preview (2026-07-16)
The hero's compact studio panel (DisplayCanvas's `compact` branch) lost its glass backing
(`.controls-compact` overrides in `components.css` kill the backdrop-filter/gradient
border/padding; Save gets its own dark translucent fill since its base style is
transparent-with-border) and gained `src/components/TshirtPreview.jsx`: a three.js
t-shirt (lazy `import('three')`, same treatment as Animation3DPreview) textured live with
the current design. No idle spin (Aaron's call, replacing a first rotating version) — the
shirt faces forward and eases toward the mouse's horizontal position — or, on touch
devices (`pointer: coarse`), with the phone's side-to-side tilt (deviceorientation gamma,
±25° tilt = full range; baseline is the first reading and drifts slowly toward the live
angle so a changed grip re-centers) — capped at ±15° yaw either way, static under
prefers-reduced-motion. Tilt runs ONLY where no permission prompt is needed (Android);
iOS 13+'s `requestPermission()`-on-first-tap flow was tried and user-rejected live (the
natural first tap is the shirt itself, so the prompt fired after navigating to the shop) —
iOS deliberately gets a static shirt, don't reintroduce the prompt.
**Touch devices can also drag the shirt to spin it freely** (2026-07-18, Aaron's ask):
pointer-drag on the mount adds an unclamped `dragYaw` under the ±15° ambient target
(tilt/mouse rides on top), with a decaying release flick (skipped under
prefers-reduced-motion; the drag itself is allowed — direct manipulation, not ambient).
The shop link survives via tap-vs-drag disambiguation: a press only becomes a drag past
8px of horizontally-dominant movement (vertical swipes scroll the page — `touch-action:
pan-y` on the button), and a real drag sets `dragSuppressClickRef` so the release click
doesn't navigate; a clean tap still goes to /shop. Verified via headless touch-emulation
(drag → ~90° spin, URL stays; tap → /shop). Below 480px the shirt+buttons row stacks
vertically (`.hero-compact-row` media query — side-by-side overflows a phone viewport). The model (Sketchfab "Tshirt" by khalilchahi99, CC-BY-4.0 —
attribution in its license.txt) lives in `public/models/tshirt/` (GLTFLoader fetches
scene.bin/textures by URL; Vite can't resolve those from src/assets — the src/assets copy
is the original). Its baseColor atlas is a square sheet of flat cut-pattern UV islands
(front/back body panels, two sleeves, hem strips). **Per-island composition, not full-bleed**
(user caught the first full-bleed version putting an off-center crop on each panel): each
island family gets its own recompose-per-ratio render (body ≈0.69 portrait, sleeve ≈1.9
landscape, via StudioContext.renderDesignBlob, gated on queueReady) composited into
flood-fill-measured island rects (constants in TshirtPreview.jsx, measured off the model's
own material_baseColor.jpeg). **Every island in this atlas is UV-mapped vertically flipped
on the garment** (2026-07-17, user-caught as "the shirt's design is upside down vs the
background"; proven with a headless Playwright harness rendering orientation-marked test
textures on the real model — top-of-rect markers land at the hem, labels read as vertical
mirrors not 180° rotations), so every body/sleeve draw counter-flips via drawCover's
flipY. The 8 thin trim strips (identities also confirmed via that harness: 2 hem, 2 cuff,
rest collar/interior facings — see STRIP_ISLANDS) each get a thin edge-band slice of the
adjacent panel's composition (hem = body bottom, cuff = sleeve bottom, collar = body top)
so trims read as the print continuing over the seam; before that they sampled arbitrary
rows of the unrelated full-bleed base layer (user-caught as "the little strips look off").
Cuff bands wind the same horizontal direction as their sleeve's UVs, so the cuff strip
belonging to the sleeve drawn flipX (for worn left/right symmetry) must be drawn flipX
too (STRIP_ISLANDS' `flip`) — settled by live user feedback after a first attempt flipped
the wrong cuff's band; note the user's "left cuff" meant the WEARER's left, i.e.
viewer-right.
The base layer still underlies everything as a fallback for unmeasured atlas pixels. Texture
updates key off `currentDesign`; a pending-bitmap handoff covers whichever of
scene-init/first-render finishes last. The scene fades in wearing the model's own white baseColor sheet the moment it loads
(seeded onto the texture canvas from a stable copy — blending a canvas onto itself would
compound per frame), so there's never a shirtless gap on first load; the first design
crossfades in from white. A generate-transition ShaderPass (EffectComposer) combines chromatic aberration — a
uniform LATERAL RGB split, NOT radial-from-center (radial was tried and user-rejected:
nothing visible at the centered shirt's chest, anaglyph mush at the edges) — with an
animated heat-haze distortion (crossed scrolling sine waves, uTime from the rAF clock),
both scaled by one normalized `uAmount` tweened up on generate start and to 0 with the
crossfade; alpha takes the max of the three taps so the fringe isn't clipped at the
silhouette. The pass stays in the chain at 0 (identity) rather than branching render
paths. Note the aberration is content-dependent — near-monochrome designs (e.g. all-blue)
show it faintly since the shifted channels carry little signal. The shirt NEVER leaves during a generate: it keeps
the old design while the background renders, then TEXTURE-level crossfades to the new
sheet (the material's single persistent canvas is re-blended old/new per tween frame —
deliberately not a second shirt mesh, which would z-fight its coplanar twin) the moment
DisplayCanvas's `isLoading` flips false via the `waiting` prop — the same signal that
fades `.image-container` in. Two earlier versions were user-rejected: watching
`currentDesign` (misaligned — the shirt's small renders finish in ~200ms while the 4K
background is still going) and a dip-out/return (hid the shirt mid-generate, visibly
unbalancing the centered shirt/buttons/loader arrangement). Also `setImage`'s inline
backdrop-filter tween on `#controls-main` is skipped when compact (it painted a ghost
rectangle of the removed glass over every image fade-in). WebGL init failure hides the preview (returns null) instead of a dead canvas.
The shirt is a shop link (button wrapping the WebGL mount, `onShopClick` → `/shop`; the
design carries via StudioContext — no params needed) with a frosted "Shop →" pill hover/focus
hint at the shirt's top-right (an under-the-shirt "Shop this design" caption was
user-rejected on wording + placement); the hover scale lives on the button, not the mount,
since GSAP owns the mount's inline transform. The hero artwork parallaxes on scroll (compact only, DisplayCanvas.componentDidMount):
`.image-container` renders at scale 1.12 and drifts down at 0.15× scroll speed, clamped
to the 6% the overscale can cover — the listener attaches to SiteLayout's `.overflow-y-auto`
scroll viewport, NOT window (the document never scrolls; `window.scrollY` stays 0 —
confirmed live when the first window-scroll version never moved). Transform only, so the
alpha-only GSAP tweens on `.image-container` don't conflict; skipped under
prefers-reduced-motion. An ambient `.hero-dot-grid` layer (masked dot pattern, `components.css`) sits behind the
compact UI, extending ~110px past it and dissipating with distance via intersecting X/Y
gradient masks (`mask-composite: intersect` — rectangular falloff, not radial).
**The hero's loading indicator is a color ripple through that dot grid** (2026-07-18,
Aaron's idea after the mobile stacked shirt+buttons panel covered the centered
HexagonLoader): `HeroDotRipple.jsx` mounts two `.hero-dot-ripple` layers while
`isLoading` — each is an expanding ring gradient (GSAP drives `--ripple-r`; random
tinycolor hue spins each cycle, same trick as HexagonLoader) masked by the same dot
pattern + edge fades as the grid, half a cycle apart so waves read continuous. The dot
look vars were hoisted from `.hero-dot-grid` to `.controls-compact` so grid and ripple
share one source of truth. The hexagon loader is now non-compact-only (full studio);
verified via headless mobile-viewport screenshots mid-generate.
Compact buttons are smaller than the studio's (56/50px vs 80/60) and sit in a tight stack
with the "Go to studio" link directly beneath them (`.controls-compact .go-to-studio-btn`
un-absolutes the full studio's below-panel positioning); the shirt (190px) is deliberately
larger than the button column — it's the panel's visual anchor.

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
  **Storage SELECT policies are owner-scoped as of 2026-07-17** (migration `0013`,
  advisor-driven): anonymous/other-user clients can no longer LIST files in
  `avatars`/`design-mockups`/`design-thumbnails` — public-URL serving (`getPublicUrl`
  `<img>` loads) is unaffected (public buckets bypass RLS for `/object/public/`), and
  owners still SELECT their own `${user_id}/...` paths (which the `upsert: true` upload
  paths require). Gotcha for future features: a client-side `.list()` on these buckets
  now silently returns `[]` for anything outside the signed-in user's own folder. Same
  session: migration `0012` revoked anon/authenticated EXECUTE on all RPC-exposed
  SECURITY DEFINER functions (the rate-limit pair was a real anon-key DoS vector on the
  store-wide mockup budget; only Edge Functions call them, via service role).
- **Real bug found and fixed, 2026-07-16: thumbnails/modal previews rendered sparse.**
  Direct small renders (320×320 thumbnails, the 1400×1400 gallery modal preview) hit
  `getCountScale`'s own area-based falloff — a 320×320 canvas is ~1.2% of the studio's
  reference area, so it genuinely generates a sparser composition, not just a smaller
  picture of the same one (same root cause TshirtPreview's island renders hit earlier).
  Fixed the same shape as that fix: `render/scale.js`'s new `densityFloorSize` scales a
  requested size UP to a 2000px-long-edge floor (`DISPLAY_RENDER_CAP`) before generating,
  and `StudioContext.renderDesignBlob` takes an opt-in `highDensity` flag that generates at
  the floor size and downscales into the requested canvas — a true downsample of a dense
  composition. Opt-in (not default) so the hot paths that re-render on every design change
  (mini-generator/footer/mobile-nav previews) don't pay the extra render cost; only
  thumbnail save (`StudioContext`) and `GalleryModal` opted in. `lib/printful.js`'s
  `capMockupRenderSize` (factored out of `capRenderStrategy`) does the same cap-and-scale
  math for TshirtPreview's mockup-matched island renders, which need to match a real
  Printful mockup's density exactly (not just the 2000px floor) — see that component's
  header comment. Existing Storage thumbnails (saved before this fix, sparse) were
  backfilled in place via `render-service/backfill-thumbnails.mjs` (one-off, re-runnable,
  read-only on the `designs` table — only overwrites the derived thumbnail JPEG at its
  existing Storage path); kept in the repo as a reference/re-run tool, not deleted after use.
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
- **CAPTCHA on the auth forms (Cloudflare Turnstile), 2026-07-10** — protects the
  Hostinger mailbox's sending reputation/quota from bot signups. Two halves that must stay
  in sync: the frontend widget (`src/components/ui/Turnstile.jsx`, mounted on
  AccountPage's sign-in/sign-up/forgot-password forms, token threaded through `auth.js` as
  `captchaToken`; renders nothing when `VITE_TURNSTILE_SITE_KEY` is unset — the key lives
  in `.env.local` and a GitHub Actions secret, baked in at build time via `deploy.yml`)
  and the enforcement toggle (Supabase Dashboard → Auth → Attack Protection, Turnstile
  provider + the Turnstile *secret* key — dashboard-only, nothing in this repo turns it
  on). Enforcement applies to ALL password-based auth calls (sign-in and recovery too, not
  just signup); Google OAuth is unaffected. Never enable the dashboard toggle unless the
  deployed build has the sitekey, or every email/password auth attempt fails; the toggle
  is also the instant rollback. Turnstile widget config (Cloudflare dashboard): hostnames
  `chromaforge.app` + `localhost` (bare hostname — the field rejects ports), Managed mode,
  pre-clearance off (site isn't proxied through Cloudflare).
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
    **Split-panel layout for wide labels (2026-07-10, user's idea, user-approved from a
    rendered QA page)**: `label_inside`'s 2.5:1 canvas no longer holds the mark alone
    centered in a long dark field — wide placements (aspect ≥ 1.6,
    `LABEL_MARK_GENERATOR_VERSION = 3`; now 4, see below) split into a square dark panel with the mark plus
    a flat fill of the design's chosen accent (the same `mainColorHex` the colored chords
    spin from, so the panels share a root color; zero new rng draws). Panel rects live in
    the generator's config (`panels.mark`/`panels.accent`) so `renderLabelMark` stays
    layout-agnostic; square `label_outside` keeps the single centered panel
    (`panels.accent = null`).
    **Transparent label_outside + heavier mark (2026-07-15, `LABEL_MARK_GENERATOR_VERSION
    = 4`, Aaron-approved from real track-jacket draft mockups — orders 166996698/166999659):**
    Printful composites label placements OVER the garment's own print (confirmed on a real
    mockup — not bare fabric), so `label_outside` now renders with NO panel fills at all
    (`transparent: true` through `generateLabelMark`/`renderLabelMark`/`renderLabelMarkBlob`,
    PNG not JPEG since alpha is the point; `uploadMockupSourceImage` extension/contentType
    follow the blob type) with inverted inks (ring = the dark `#181520` itself, light greys
    flipped to dark complements, accent spins unchanged; same rng draws, so transparency
    never shifts which chords survive). Both placements' mark also shrank 15%
    (`margin` 0.82→0.697) with heavier strokes (3→5.5 lines, 4.5→8 ring) — the thin
    full-size mark read spindly printed over a busy composition. `label_inside` keeps the
    dark split-panel look (it's a sewn tag; the panel is the look). Test-order gotcha worth
    remembering: **Printful dedupes fetched files by URL** — re-serving different bytes at
    a previously-used URL silently reuses their cached copy (bit us live: order 166998144
    got the old mark; the real checkout is immune since uploads are content-hashed).
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
- **Storage growth in `design-mockups`: found and fixed 2026-07-19** (the bucket had
  reached ~357MB — a third of the free-tier quota — 254MB of it print-resolution renders
  from Aaron's own test checkouts, uploaded under timestamped names by `render-print-file`
  on every Buy Now and never deleted; the other ~103MB is content-hashed mockup sources,
  deduped but never expired). Two-part fix: (1) `render-print-file` now names print files
  by a SHA-256 content hash (`print-<hash>-<printfileId>.png`) and skips the upload when
  the object already exists — repeat checkouts of the same design stop duplicating, and
  same-content-same-URL is the *correct* interaction with Printful's fetch-by-URL caching
  (the 2026-07-15 dedup gotcha only bites when different bytes reuse a URL). (2) A new
  `cleanup-storage` Edge Function (verify_jwt = false + `X-Cleanup-Key` shared secret,
  `CLEANUP_STORAGE_KEY` — same pattern/caveats as `RENDER_SERVICE_KEY`) sweeps the bucket:
  deletes print files older than 24h and mockup sources older than 14 days, ALWAYS keeping
  anything referenced by a non-canceled order's `print_file_urls` (which includes label
  marks — those go through the content-hashed mockup path but end up in real orders).
  This deliberately supersedes migration 0010's "Storage is left untouched" stance — that
  reasoning holds for shared content-hashed files, but per-checkout print renders were
  never shared. Scheduled daily 4:41am via pg_cron + pg_net (migration
  `0014_cleanup_storage_cron.sql`; the shared secret is embedded in the cron command —
  rotate it in both places). Storage deletion must go through the Storage API (deleting
  `storage.objects` rows directly orphans the underlying S3 objects), hence the
  HTTP-call-an-Edge-Function shape instead of pure SQL like 0010.
- `src/hooks/useMockup.js` — drives the *preview* pipeline (render → upload → Printful v2
  `mockup-tasks` via the `printful-mockup` edge function → poll → dedupe by camera angle →
  cache). Free, no money involved. One automatic retry on Printful's occasional transient
  "Internal Server Error" for AOP products. Exposes `elapsedSeconds` + `BUSY_STATUSES` for
  UI feedback during the 30–90s+ round trip.
  - **Global mockup-task rate limiting + graceful 429 handling, 2026-07-17.** Printful's
    real constraint on `POST /v2/mockup-tasks` is store-wide (2 requests/60s across every
    user, measured live off their `x-ratelimit-*` headers, undocumented) — the existing
    per-user Edge Function limiter (20/min) was never the binding one. `printful-mockup`
    now enforces a second gate matching that limit, keyed on a fixed sentinel user id so it
    reuses the existing `rate_limits` table as a store-wide counter with no schema change
    beyond one new RPC, `check_rate_limit_verbose` (`0011_global_rate_limit_retry.sql`),
    which also reports retry-after seconds — the plain `check_rate_limit` boolean isn't
    enough to tell a client how long to wait. A real passthrough 429 from Printful itself
    (if the proactive gate and Printful's own window ever drift) is normalized the same
    way, best-effort parsing `Retry-After` since Printful doesn't document this endpoint's
    429 shape. `useMockup.js` auto-retries on either case via a new `queued` status (added
    to `BUSY_STATUSES`) that counts down the reported wait and resumes automatically,
    bounded to 3 minutes total so a genuinely down Printful can't hang a customer forever.
    `ProductPage.jsx` narrates the wait instead of showing a bare error, and adds a "Buy
    without a preview" escape hatch (behind `ConfirmDialog`) reachable while queued, on a
    hard mockup failure, or from the disabled-Buy-Now hint — it calls the exact same
    `onBuyNowClick` the real button uses, unmodified: the print-file render already runs
    independently of mockup success, so only the Stripe line-item image differs (falls back
    to the product's stock photo, same as `heroImage` already did whenever `!hasMockup`).
    Verified: `check_rate_limit_verbose` exercised directly against the live DB
    (allow→allow→deny with correctly shrinking retry-after), edge function deployed clean,
    full app build passes. **Not yet live-verified against a real Printful 429** — that
    needs two rapid real mockup-task submissions through a signed-in session (~30-90s each,
    spends real quota) and no browser/session was available to drive one this session.
- **Real checkout** (`supabase/functions/create-checkout-session`,
  `supabase/functions/stripe-webhook`, `src/lib/checkout.js`, wired into
  `ProductPage.jsx`'s "Buy now" and a new `CheckoutSuccessPage` + `AccountPage` order
  history section): Stripe Checkout (hosted page, collects shipping address natively) →
  webhook confirms payment → submits the real Printful order. Schema:
  `supabase/migrations/0005_orders_schema.sql` + `0006_order_items_product_options.sql`
  (`orders`/`order_items`, owner-read-only RLS, **no client insert/update policy at all** —
  only the service role, used exclusively by these two functions, writes orders).
  - **Stale pending-order cleanup, 2026-07-17** (`supabase/migrations/
    0010_cancel_stale_pending_orders_cron.sql`): `create-checkout-session` always writes a
    `pending` orders row (and a real Stripe Checkout Session) before the browser ever
    reaches Stripe; if the customer never completes payment there was no expiry at all —
    these accumulated forever. A `pg_cron` job (`cancel-stale-pending-orders`, hourly)
    now cancels anything still `pending` 24h after creation, matching Stripe's own default
    Checkout Session expiry (no `expires_at` override is set, so past 24h the session
    can't be completed regardless — guaranteed abandoned, not just probably). Deliberately
    DB-only: the print/mockup files an abandoned order references are content-hashed in
    the `design-mockups` bucket and can be shared with other orders/live mockup previews
    (see `lib/printful.js`'s `uploadMockupSourceImage`), so there's no safe way to know a
    file is only referenced by one abandoned order — Storage is left untouched.
    **Applied directly via the Supabase MCP tooling, not `npx supabase db push`** — this
    project's remote migration history (`supabase_migrations.schema_migrations`, visible
    via `list_migrations`) is tracked under generated timestamp versions from that same
    path, not the sequential `0001`–`0010` local filenames (`npx supabase migration list`
    shows all local versions as unmatched against remote); local files exist for
    readability/history but `db push` would try to (re-)apply all of them and conflict
    with schema that's already live. Keep using `apply_migration`/`execute_sql` for schema
    changes on this project rather than `db push`, unless that drift is deliberately
    reconciled first.
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
    not a bug.
    **Client-side region pre-selection, 2026-07-17** (`src/lib/regionGuess.js`): found live
    during pre-launch testing — the region list rendered with no relationship to the zip
    code the customer had just typed, which reads as broken even though it's the documented
    accepted gap above. Doesn't close that gap (still no cross-check), just makes the
    common case less confusing: guesses one of the 5 regions from
    `Intl.DateTimeFormat().resolvedOptions().timeZone` (no network call, no third-party IP
    geolocation — keeps the Privacy page's "no trackers" promise intact) and sends it to
    `create-checkout-session` as `guessedRegion`, which reorders `buildShippingOptions`'
    array so that region is listed/pre-selected first (Stripe pre-selects whichever
    shipping option appears first in the array). Falls back to the untouched US-first
    order for an unmapped timezone or no guess at all. Live-verified end to end 2026-07-17
    via a real UK test purchase (`STORE_ENABLED` temporarily flipped on for testing, still
    Stripe test keys + `PRINTFUL_SKIP_CONFIRM` set): shipping charged $5.99, exactly
    `RATE_CENTS.light.GB`; tax $0 (Stripe Tax isn't registered outside California, so
    international destinations correctly aren't taxed today — worth revisiting if
    UK/EU VAT compliance ever becomes a real requirement). The 3 non-clothing starter products (tote bag, crossbody bag, pillow) aren't
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
    Orders go through Printful's **stable v1 API** (ported from v2 2026-07-15 — v2's
    order pipeline fails any order with `label_inside`; see "Server-side print
    rendering"): `POST /orders` creates an unconfirmed draft by default, and a separate
    `POST /orders/{id}/confirm` actually charges/fulfills it; the webhook does both
    back-to-back since the customer already paid via Stripe.
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
  - **Checkout branding pass (2026-07-16)**: the Stripe Checkout line item now carries the
    customer's actual approved Printful mockup image (`ProductPage.jsx`'s `heroImage` →
    `checkout.js` → `create-checkout-session`'s `mockupImages`, validated to an `https://`
    string before being forwarded to Stripe rather than trusted blindly) instead of a bare
    text line; the session sets `payment_intent_data.statement_descriptor_suffix:
    "CHROMAFORGE"` (so the card-statement charge is recognizable) and `custom_text.submit`/
    `after_submit` (small branded copy on Stripe's hosted page — deliberately no
    shipping/production-time claim, since none is verified/committed to elsewhere in the
    app). The Printful order itself now sends a `packing_slip` object (store name, the
    `apple-touch-icon.png` mark as `logo_url` — Printful's slip renderer wants a raster
    image, not the SVG wordmark — a thank-you message, and our own order id as
    `custom_order_id` for support correlation) — previously omitted, so Printful's own
    default (unbranded) slip shipped in every box. Deliberately deferred for later
    (Aaron's call, revisit if the store takes off): white-labeling Printful's own
    direct-to-customer shipping/tracking emails (still Printful-branded — would need
    `printful-webhook`, which already tracks status changes, to drive a Chromaforge-branded
    equivalent instead) and Printful's paid custom-packaging-insert add-on.
    **Real bug caught via a live end-to-end test the same day**: `packing_slip`'s
    `custom_order_id` was set to the full order uuid (36 chars incl. dashes) — Printful
    caps that field at 20 chars and rejected `POST /orders` outright with "Custom Order Id
    should contain at most 20 characters," so the order was never created even though
    Stripe had already charged the card (not an edge case — every order id is a uuid, so
    this failed every single checkout). Landed the customer on `CheckoutSuccessPage`'s
    generic "we hit a snag" failure state (see that page's handling of `status: 'failed'`).
    Fixed by stripping dashes and truncating to 20 hex chars; re-verified live
    (order id `707f0344…` → Printful draft `167236336`, `status: 'submitted'`, no failure).
  - **Page-leave guard during checkout, settled 2026-07-17 after two live-caught bugs.**
    `beforeunload` (warns on tab close/refresh/typed URL while Buy Now's async
    render→upload→session-creation is running) only fires on an actual browser-level
    unload — it does nothing for React Router's client-side routing (a `<Link>` click, or
    back/forward) since none of those unload the document, so the async work just kept
    running in the background regardless of what page the customer had navigated to.
    Confirmed live twice: a nav link click, then separately the back button, each showed no
    warning and each forced the browser to Stripe from the Shop page moments later. A
    capture-phase `click` listener (added, then deliberately removed same day) briefly
    plugged the link-click case with a `confirm()` prompt, but back/forward can't be caught
    the same way — `popstate` isn't cancelable and React Router's own history listener has
    already switched routes by the time any handler could run, so closing that gap for real
    would need React Router's data-router APIs (`createBrowserRouter` + `useBlocker`,
    this app uses plain `<BrowserRouter>`) — judged too large a routing migration for the
    payoff. Landed on a smaller, more honest fix instead: `ProductPage.jsx` tracks
    `isMountedRef` and skips the forced `window.location.href` redirect to Stripe if the
    component that kicked off checkout is gone by the time the async work finishes, rather
    than firing from wherever the customer has since navigated to. Once that consequence
    was eliminated, the link-click confirm() no longer had a real justification either
    (Aaron's call): an intentional click is a clear signal to leave, and warning on it while
    back/forward remains a silent zero-friction exit was inconsistent, so it was removed —
    `beforeunload` is the only remaining interruptive guard, kept specifically because a
    real unload kills the JS execution context outright (no graceful background-finish
    fallback exists for that one, unlike in-app navigation). Net state: no exit path can
    force an unannounced redirect to Stripe from an unrelated page anymore; a silently
    abandoned `pending` order is harmless and auto-cancels after 24h (see
    `0010_cancel_stale_pending_orders_cron.sql`), and Buy Now is always re-clickable.
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

`master` is deployed (push triggers GitHub Actions → rsync/SSH → chromaforge.app). As of the
last push, live includes: the seed-based renderer (Phases 1–2 of the print pipeline), the
full Tailwind migration, a batch of ColorField drag-and-drop fixes (dead-zone hit-testing,
swap-instead-of-insert reorder logic, a perf throttle, a listener-leak fix) plus the
jscolor picker theming, the Supabase auth/save/gallery UI, and the Printful catalog/mockup
preview pipeline (Shop/ProductPage, `useMockup`) — confirm what's actually been committed
and pushed before assuming any specific recent change is live, this file tracks what's
*built*, not what's deployed.

**Chromaforge is live, 2026-07-17.** `STRIPE_SECRET_KEY`/`STRIPE_WEBHOOK_SECRET` are the
account's real live-mode values, `STORE_ENABLED=true`, and `PRINTFUL_SKIP_CONFIRM` is
unset — real customers can complete a real purchase and it will actually be produced and
billed. Verified with a real order the same day: a live Apple Pay checkout (session
`cs_live_...`) → `stripe-webhook` verified the live signature and flipped the order to
`submitted` → `printful-webhook` delivered a follow-up status event for the same order.
See `TODO.md`'s go-live sequence (steps 4–5) for the full sequencing/incident notes —
worth reading before ever rotating these secrets again, since a real exposure window
happened once already when the live secret key was set before its matching webhook
secret (caught immediately, zero orders affected, but avoid repeating the order of
operations).

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

**Real, live-tested checkout works end to end, including the previously-failing
label_inside products** (2026-07-15: live-site Stripe test checkout → ported v1
`stripe-webhook` → Printful order 166989163, zip hoodie with all 8 placements `ok` and
stable — the product/placement combination that used to fail every time on v2; see the
label_inside bullet under "Server-side print rendering"). The other six `label_inside`
products (hoodie, sweatshirt, mesh shorts, joggers, track jacket, crossbody bag) still
want a zero-cost draft-order test each before launch, but the failure mechanism is fixed.
`PRINTFUL_SKIP_CONFIRM` is unset and `STORE_ENABLED` is `true` as of 2026-07-17 — see the
"Chromaforge is live" note above. Operational gotcha proven live 2026-07-15: the
Fly render-service ships a frozen bundle of `src/render` — **it must be redeployed
(`flyctl deploy --config render-service/fly.toml` from the repo root) whenever
`GENERATOR_VERSION` bumps**, or every Buy Now fails with "generatorVersion mismatch."

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
