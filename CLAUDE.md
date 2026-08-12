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
  alters output for a given seed. **It is currently 7** (per-bump history lives in the
  comment block directly above the constant in `generateArtwork.js` — read that, not this
  file, for what each bump changed).
- **What `generatorVersion` does and does NOT do** (clarified 2026-07-24 after a live bug —
  this was previously stated wrong in both this file and the code): `generateArtwork` takes
  no version parameter and **never branches on one**. No code path anywhere renders a
  previous generator version. A stored design is only `{ seed, colors, settings }`, always
  regenerated with whatever code is in the bundle. So a bump changes how *every existing
  design* renders, immediately — a stored `generatorVersion` records what a design was
  SAVED under, it is not a rendering instruction, and phrases like "old designs keep
  rendering the old way until re-saved" (which appear in older notes below) are false.
  Its one real consumer is render-service's mismatch check, whose actual job is catching a
  **stale render-service deploy**. Consequently any stored row adopted back into the live
  pipeline must be re-stamped via `compactDesign.js`'s `withCurrentGeneratorVersion` — see
  the merch-pipeline section for the checkout bug that rule fixed.
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
  comparisons), which is why `GENERATOR_VERSION` did not bump for this change (it was 3 at
  the time — it is 7 now) and old designs were untouched;
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
  **`density` setting added (2026-07-24, Aaron's request)**: `geometry.density` (0–1, default
  1, slider min 0.1) is what fraction of the generated chaotic triangles actually get drawn.
  It exists because of a useful accident: pre-v7, `keepCount` was sliced by
  `getCountScale(width, height)`, so small placements (a 3000×1800 t-shirt sleeve,
  countScale 0.807) silently dropped ~19% of the shapes — and that sparser version reads
  dramatically brighter and more vivid, because the dropped shapes are large translucent
  ones that blend everything beneath them darker. The v7 fix correctly removed that
  (density must never vary by resolution or a mockup lies about the print) and in doing so
  removed the only way to get the look. This setting brings it back as a deliberate,
  **size-independent** choice, so it cannot reintroduce the v7 divergence — verified
  structurally (not just visually) by inspecting `geometryConfig.shapes.length` directly:
  identical counts at 320×320 / 3000×1800 / 4200×5400 / 6000×6000 for every density tried.
  Density 0.8 keeps 25 of seed `1vsx8atp`'s 31 shapes — exactly what the old sleeve slice
  kept (`round(31 × 0.807)`), i.e. it reproduces that look on every panel. Composes with
  coherence via `min()` (coherence still wins, reaching 0 survivors at 1; density can only
  ever remove more, never add back). **No `GENERATOR_VERSION` bump**: `buildShape()` already
  runs `shapeNum` times unconditionally, so rng() consumption is untouched and default 1 is
  byte-identical — verified 25/25 PNG-hash matches against the pre-change bundle across 5
  real saved designs (chaotic/auto-palette, mid-coherence hexagon lattices, custom palettes,
  a reduced-`chance` case) × 5 sizes. **Deploy order matters**: render-service must ship
  BEFORE the frontend. It ignores an unknown setting and renders at full density, so a
  frontend that can send `density` while Fly still runs the old bundle means the mockup
  shows sparse and the print comes back dense — the exact mockup/print divergence v7 fixed,
  and with no `generatorVersion` change there is no mismatch check to catch it.
- **Generators are now ratio-aware** (this was the `GENERATOR_VERSION = 3` bump — the
  constant has since advanced to 7, `src/render/scale.js`):
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
- **The aspect term is CLAMPED at 1, and "Artwork scale" is a per-order choice
  (2026-07-29, `GENERATOR_VERSION = 8`, Aaron's ask after seeing a real shorts mockup).**
  `getElementSizeScale` multiplied the canvas's short edge by `(aspect/16:9)²`, which was
  tuned only on *portrait* shirt panels (0.72 → 0.52) and pulls just as hard the other way —
  the wide side was never validated against a product, only against an export you view as one
  whole frame. On the mesh shorts sheet (11250×4350, aspect 2.59, the widest canvas in the
  catalogue) it *enlarged* elements 2.12×, sizing them at **2.78× the width of one leg panel
  where a t-shirt front sits at 0.52×** — a 4× inconsistency, plus a knock-on colour bug:
  oversized translucent shapes stack and wash the garment toward white, which is why the
  mockups read pale pastel while the studio artwork was vivid. Fixed by clamping the term so
  it may shrink elements but never enlarge them. **It binds on exactly two canvases in the
  whole catalogue** — the shorts and the bomber's `details` strip (7950×2700) — since every
  other product, the 16:9 studio canvas, and all three export ratios already sat at or below
  1 (verified: 23 of 25 catalog canvases numerically unchanged; 9/9 real render hashes
  byte-identical vs. a build of the previous commit).
  **This bump does NOT invalidate stored thumbnails** (unlike v6→v7): they render square,
  square is below the clamp, and the hashes match — so no `backfill-thumbnails.mjs` run was
  needed. Don't assume the operational rule above applies to every bump; check first.
  Alongside it, `renderContext.sizeFrame` measures element sizes against ONE
  separately-visible panel instead of the whole sheet, for printfiles that get physically cut
  (`PRODUCT_MOCKUP_CONFIG`'s `legPanel`: mesh shorts `0.250 × 0.926`, joggers
  `0.276 × 0.989`, flood-measured off Printful's own CAD sewing templates — the shorts leg is
  2812×4031px/18.7″×26.9″, aspect 1.43, nearly a t-shirt front; the joggers leg is
  2730×8009px, aspect 2.93). Three things worth not re-deriving:
  (1) **The frame is FRACTIONS of the canvas, never pixels.** A mockup renders at
  `capMockupRenderSize`'s capped dims while the print file renders at the printfile's true
  dims; only a relative frame makes both compose identically.
  (2) **The clamp applies to the panel route too**, which is what keeps a tall narrow panel
  honest — unclamped, sizing to the joggers' 2.93-aspect leg would reintroduce the exact
  blow-up this exists to fix.
  (3) **It covers `coherentSize`, not just `getElementSizeScale`'s callers.** Scaling only
  stars and chaotic shapes left the option a no-op for high-coherence designs, whose lattice
  IS the design and kept spanning the sheet while everything around it shrank.
  Surfaced as **Artwork scale — Full sheet (default) / One leg** in ProductPage's Print
  options disclosure; labels name the MECHANISM because the two products get different
  amounts of change from the same choice (wide leg vs. tall leg), so any label promising a
  fixed visual outcome would be false on one of them — same lesson as the Back panel copy.
  Per-order render context, never persisted; in `useMockup`'s cacheKey and the render cache
  key (front and back share a printfile id, so without it the panel render would be served
  the sheet one and the choice would silently do nothing). Consumes **zero** `rng()` — counts
  and structure are identical, only sizes change.
- **No absolute pixel constants in a size formula — `GENERATOR_VERSION = 9` (2026-07-29,
  same day as v8).** `GenerateGeometricShape`'s chaotic-shape minimum was `150 + round(rng() *
  getElementSizeScale(...) / 3)`. That `150` was documented as "an intentional absolute minimum
  (avoids degenerate near-zero shapes at tiny sizes)"; the intent was fine, the mechanism was a
  real bug. **Everything else in that formula is resolution-relative, so an absolute term makes
  a design's composition depend on the pixel size it happens to be rendered at** — which
  directly breaks the guarantee that a mockup and its print are the same piece, since previews
  render through `capMockupRenderSize` while print files render at true printfile dimensions.
  Previews therefore showed systematically LARGER shapes than the print. Worst on the mesh
  shorts, whose 11250px sheet caps to 2000px — a **5.6× ratio, the largest in the catalogue**
  (a t-shirt front is 2.7×): the first shape spanned **37.6% of the sheet in the preview against
  22.9% in the print, +65%**. It also explains those mockups reading washed-out pastel —
  oversized translucent shapes stack toward white, the same symptom that drove v8, but from an
  unrelated cause.
  **How it was found, worth repeating:** Aaron put Printful's own order view (which renders from
  the real print file) next to the live product page (a Printful mockup of our *capped* render)
  and saw "the same elements, but zoomed in." Two Printful mockups of the same design at
  different source resolutions is the comparison that exposes this class of bug; neither view
  alone can.
  Fixed by expressing the floor as a fraction of the size scale —
  `150 / REFERENCE_ELEMENT_SIZE_SCALE` (new export in `scale.js`, = 2160). Things worth not
  re-deriving:
  (1) **The two terms are rounded separately**, matching the old `150 + Math.round(...)`, so the
  studio's own 3840×2160 is **byte-identical**. Rounding the sum instead would differ by up to
  1px there and give up that guarantee for nothing.
  (2) **Consumes the same single `rng()` draw**, so counts, structure and every downstream layer
  are untouched — only chaotic-shape sizes move.
  (3) **A full-coherence design is completely unaffected**, at every size: at coherence 1
  `shapeSize` collapses to exactly `coherentSize`, so `chaoticSize`'s weight is 0.
  (4) A swept check found this was the **only** absolute pixel constant in a size calculation —
  star sizes are all `sizeScale / k`, the radial field is `getSizeScale / 2`. (The
  `-100 + rng() * width + 100` patterns in `GenerateStarField`/`StarField` are positions and
  cancel algebraically; left alone deliberately.)
  Verified: composition is now invariant across pixel sizes *within* an aspect family — max
  shape-size error **2.17%** (rounding in `pointsArray`) across 4 designs × 2 frames × 4 sizes,
  down from +65%. Cross-*aspect* differences are intended (recompose-per-ratio) and a first
  version of that test wrongly compared across aspects and reported a meaningless 159%.
  **This bump DOES invalidate stored thumbnails, and the backfill must run with NO
  `--generator-version` filter** — see the operational-rule bullet in the Supabase section.
  **Verified in production, 2026-07-30** (real live order `c15d1c8d` / Printful `169226286`,
  mesh shorts L): the back print file is an exact horizontal mirror of the front — 0 differing
  subpixels of 195,750,000 at the true 11250×4350 — and carries geometry, with the front
  matching a local v9 "Detailed" render at RMSE 0.45 against 68 for geometry-off and 93 for
  Oversized. See `TODO.md`'s go-live step 6 for the full check list, including the two things
  worth repeating next time: **`flyctl status` to confirm ALL machines took the release** (a
  split release fails roughly half of checkouts intermittently, the nastiest symptom available)
  and the free draft-order check on any product whose submitted payload changed.
- **Star field contrast — `GENERATOR_VERSION = 10` (2026-08-02, Aaron: the stars "fade into
  the background too much and never really pop except every now and then").** THREE causes,
  and fixing any one alone leaves the complaint standing:
  (1) **Blend.** `config.secondBlend` was a uniform pick from all eight `BLEND_MODES`, so 6 of
  a 16-seed sample composited the layer under a mode that erases a star of the kind that design
  wanted. `starBlendMode` now picks from a set chosen by the backdrop, with a 10% tail on the
  fully unbiased pick so the old range of looks stays reachable.
  (2) **Colour, the one that isn't obvious.** The stars are TINTED by the star field's own
  internal gradient — `StarField` composites it through the sprite alpha with
  `destination-atop` — and with a user palette that gradient was `colors.reverse()`, i.e. **the
  background's own palette**: same hues, same lightness, directly on top of each other. So a
  seed could roll `screen` and still vanish.
  (3) **Count and size.** Fixed per-tier trip counts 5/50/200 → 7/90/450 (255 → 547 sprite
  stars at full size), with every tier's size ceiling cut and its size draw skewed toward small.
  Still fixed and size-independent — the `getCountScale` slice is what varies with canvas size.
  **Three things here were reasoned wrong first and corrected only by looking at real renders.
  Don't re-derive them the wrong way round:**
  - **Chroma is the lever, not lightness.** `contrastPalette` first drove lightness hard toward
    a target of 82. Aaron rejected it on sight ("silly and washed out... near white and
    boring"): raising lightness necessarily drains a colour toward white, and a lightening blend
    on top finishes the job. The reference this generator came from is a Hubble plate
    gradient-mapped against the background's gradient running the other way — fully saturated
    yellow-green/cyan/magenta at MID lightness. It now pushes saturation to 96 and confines
    lightness to a **30–56 band**, with the direction (34 or 52) picked by the backdrop.
  - **Perceived luminance, not HSL lightness, decides the direction** (`meanLuminance`, sRGB
    relative luminance; threshold `BRIGHT_BACKDROP = 0.42`, exported so `starBlendMode` and
    `contrastPalette` cannot drift apart). HSL rates pure green at exactly 0.50 — the same as
    mid grey — so a searing green backdrop was classed as "mid" and handed light stars. By
    luminance it is 0.72 and correctly gets deep ones. Caught on seed `aa11bb22`.
  - **`screen` and `hard-light` are excluded from the blend sets entirely**, which reads as
    backwards on a dark backdrop until you look: both blow a saturated mid-lightness star out to
    a white core, and they were the single biggest contributor to the washed-out result.
    `source-over` takes **three of four slots** in each set because it draws the star's own
    colour untouched. Note the sets are chosen from MEAN luminance while washing is driven by
    LOCAL luminance, so a gradient with one light corner can still wash there — that asymmetry
    is why source-over is weighted this heavily rather than trusting the mode.
  **Spectrum roll (added same session, Aaron: "the stars gradient never seem to get too
  colorful... I just want the possibility of extreme colorful starfields, rarely").**
  `SPECTRUM_CHANCE = 0.14` of auto-palette designs sweep **130–260°** of hue instead of the
  usual tight cluster around the background's complement. The old **10–35° cap was not
  arbitrary and was not wrong about its evidence** — a wide spread genuinely did wrap the last
  stop back onto the background's own hue — but it mistook a property of `randomPalette`
  walking stops FORWARD from the anchor for a property of wide spreads. `randomPalette`'s new
  `centered` option spaces them symmetrically around the anchor, so even a 260° sweep keeps
  every stop ≥50° off the background hue. **Capped at 260, not 360, deliberately**: a full
  sweep necessarily passes through the hue it exists to contrast with. One unconditional
  `rng()` draw. It reaches only auto-palette designs — with a real user palette
  `GenerateLinearGradient` takes its `colors.length > 0` branch and neither `hueBias` nor
  `hueSpread` has any effect, which is correct.
  Sizes: `ABUNDANT_CHANCE = 0.15` opens the ceiling for the rare lush design; otherwise
  `Math.pow(rng(), k)` skews each tier's already-taken draw toward the small end (no extra
  draw). Measured over 400 seeds at 3840×2160, the largest star in a design is a median **14%**
  of the short edge. v4's widening of the xl tier was fine for 5 stars and does not survive 7
  next to 90 large ones.
  **THE SIDE STREAM IS LOAD-BEARING, and this was shipped wrong first (2026-08-02).** Every
  draw v10 adds comes from `makeRng(`${seed}-stars`)`, never from the shared `rng` — same
  discipline as `expandMonochromePalette`'s `${seed}-palette` and `generateLabelMark`'s
  `${seed}-label`. The first version drew from the shared stream, and because a star costs
  THREE draws (size, x, y), raising the counts was **+876 draws** sitting upstream of
  `geometryChance`/`overlayChance` — so it silently rerolled the geometry coin for every stored
  design. Measured against all 45 real gallery rows: **13 lost their geometry layer outright**
  (Aaron, live: "the recent render change has completely destroyed the existing artwork...
  nothing we did should have touched the geometry layers at all"). Only 30 kept it, and only
  because 21 of those carry `settings.geometry.chance = 1`, which passes regardless of the draw.
  The tier loops therefore run the FIRST `XL_BASE`/`LARGE_BASE`/`MEDIUM_BASE` (5/50/200 — v9's
  exact counts) off the shared `rng` and every star beyond that off `starRng`. **Never move a
  whole loop to one stream**: all-`rng` reintroduces the bug, and all-`starRng` shifts the
  sequence just as badly by REMOVING draws. The `_BASE` constants are the shape of v9's
  main-stream consumption — add stars by raising `_TOTAL` only.
  Re-verified against all 45 stored designs x 3 sizes: composition (background, radial field,
  geometry, overlay, every blend but the star field's own) **identical to v9 on all 45**, geometry
  presence 43/45 exactly as before, star field changed on all 45.
  **General rule this establishes: a change that is meant to affect ONE layer must not draw from
  the shared stream at all.** The main sequence is a shared resource, and `GENERATOR_VERSION`
  does not protect stored designs from it — nothing renders a previous version.
  Verified: blend, layer presence, geometry-shape counts and star colours are identical across
  320²/2000²/3840×2160/3150×5550/6000² for four seeds, so the mockup-equals-print guarantee
  holds. Comparison artifact (16 seeds, drag-wipe, real pipeline under `@napi-rs/canvas`):
  https://claude.ai/code/artifact/4c487348-f890-4d7a-a5dd-161c3ced0ed6
  **This bump needs BOTH follow-ups** (unlike v8): redeploy render-service, and re-run
  `backfill-thumbnails.mjs` with **no** `--generator-version` filter — it changes output for
  every stored design regardless of what version it was saved under, same as v9.
  Also note `DisplayCanvas`'s two star-only animation-overlay call sites pass the real
  `meanLuminance` of their frames' background; left at the default they'd get a different star
  treatment than the frames they overlay.
- **`legSymmetry` — the centre-front seam mirror (2026-07-29, Aaron's idea, same session).**
  `renderArtwork` optionally reflects the finished raster's LEFT half onto its right, so the
  two leg panels become mirror images and the pattern meets itself at the centre-front seam
  instead of restarting. Applied last, after every layer is composited — same single-shared-
  compositor reasoning as `mirrorX`, so browser mockup and Fly print file mirror identically
  with one implementation. **The geometry layer already mirrored itself** (GeometricShape's
  `legLayout: 'mirror'`, the default here since 2026-07-25); the visible discontinuity was
  the star field, radial field, gradient and overlay, which run straight across the sheet.
  Three things worth not re-deriving:
  (1) **It only lands a matching seam because the leg panels are symmetric about the sheet
  centre** — measured at 0.158–0.408 / 0.592–0.842 on the shorts (exact reflections about
  0.5) and inner edges 0.468/0.532 on the joggers. A product without that symmetry needs a
  different transform, hence the `twoLegCanvas` gate. Verified: max subpixel delta across the
  join is **0**.
  (2) **`legLayout` is NOT made irrelevant by it** — this was reasoned wrong first and caught
  by measuring. "Only the left half survives, and both options put a copy at `width/4` inside
  it" ignores that these shapes are large enough to cross the centre: `'mirror'`'s
  `3*width/4` copy bleeds back LEFT past `width/2`, so it changes the surviving half too.
  Both controls stay visible.
  (3) **No `GENERATOR_VERSION` bump** — opt-in, default off, consumes no `rng()`, and
  off-output is byte-identical (verified). But render-service must still ship BEFORE the
  frontend: it ignores an unknown field, so a frontend sending `legSymmetry` against an old
  bundle shows a mirrored mockup and prints an unmirrored garment, with no version check to
  catch it — the same hazard as the `density` setting.
  Surfaced as **Leg symmetry — Each leg its own (default) / Mirrored legs**, its own row
  rather than folded into Artwork scale so the two compose. Labels avoid a bare "Mirrored"
  because `legLayout`'s row already uses that word for something narrower (the shape only).

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
playback time per cycle (`src/utils/speedRamp.js` — the single
source of the warp; the 2D preview drives its GSAP timeline through it via a gsap.ticker,
the 3D preview/exporter pass warped time + a 0..1 `rush` factor into `setTime`, so preview
and export stay motion-identical and loops stay seamless — velocity is symmetrically zero
at the seam).
**Ramp shape reworked + defaulted ON, 2026-07-28.** Velocity is
`RAMP_FLOOR + A * (1 - |2p - 1|)^RAMP_CURVE` — a rounded triangle rising from the floor at
the seam to the peak at mid-cycle, A solved so the mean stays exactly 1. Currently
`RAMP_CURVE = 1.2`, **accelerating for the entire first half of every cycle and
decelerating through the entire second half** (only ~23% of a loop reads as steady, vs ~70%
for the shape before it). Both knobs are free — the closed-form integral lands on 0.5 at
half a cycle and 1.0 at the seam for ANY (curve, floor), so retuning can't break the loop.
**The floor is the one value that differs per mode**, hence `rampTime`'s third parameter:
`RAMP_FLOOR_3D = 0.03` (a near stop at each loop end — 2.16x top speed; measured in the
real scene, the camera goes ~7 world units/sec at the seam against 519 at mid-cycle) and
`RAMP_FLOOR_2D = 0.25` (2D keeps a real cruise: its animation is a crossfade between still
frames, so near-zero playback speed reads as a frozen picture, not slow flight). A mode's
preview and its export must pass the SAME floor or they ramp differently — the two 3D call
sites are `Animation3DPreview` and `exportAnimationVideo`'s `is3D` branch. `rampRush` needs
no floor: it is `(v - floor) / (peak - floor)`, which cancels the floor out.
**Read this before "just make it faster", because it took three rounds with Aaron to pin
down and the constraint is not obvious**: the warp must cover exactly one period per period
or the loop seam breaks, so mean velocity is pinned at 1, and every bit of top speed is
funded by the rest of the cycle sitting slow. A profile that is ALWAYS ramping therefore
**cannot exceed 2.0x** (a triangle from a standstill is exactly 2.0). The three rounds
walked the whole trade: (1) longer in/out + ~2x top speed → `sin^6`, 3.2x peak, which put
~45% of the loop near-still and read as **a dead stop at the seam** ("a huge break at the
end... like 2 seconds of no movement" — real and measured: 4.5s of a 10s loop under 0.25x);
(2) a velocity FLOOR fixed that, since **seamlessness needs velocity CONTINUOUS at the seam,
not zero** — `v(0) = v(1) = 0.25` is exactly as seamless as `v(0) = v(1) = 0` — but holding
the 3.2x peak alongside a floor forced an even narrower burst, rejected as "way way too
short of a speed up period"; (3) so the peak was traded away for the ramp, landing at 1.9x,
95% of the hard 2.0x ceiling; (4) then 3D's floor went to near-zero on request ("it needs to
come to a near stop at the beginning and end"), which is NOT a return to round 1 — that one
dwelt under 0.25x for 4.5s of a 10s loop because its shape had a flat plateau there, while
this shape ramps continuously and so PASSES THROUGH the slow point (1.5s under 0.25x, 0.6s
under 0.1x). **Duration at low speed is what reads as a break, not touching zero** — that
distinction is the whole reason both complaints could be satisfied. Dropping the floor also
returned some peak (2.16x in 3D), since the area it frees funds the burst.
**More absolute speed beyond that can only come from outside the ramp** — tunnelScene's
`FLIGHT_SPEED` in 3D, or a shorter Duration in either mode.
Raising `RAMP_CURVE` buys peak back at a known price: 2.0 → 2.5x peak/37% steady, 4.0 →
3.75x peak/55% steady. Side benefit of the floor: velocity never approaches zero, so the
warp is strictly monotonic in floating point (the `sin^6` shape had ~1e-15 backward steps in
its frozen stretch — harmless, but gone). No stored-design impact — playback timing only.
**One real bug fixed alongside it, in the 2D ticker driver** (`AnimationPreview`): GSAP
clamps `tl.time()` to the timeline's CURRENT duration, and that timeline grows only when
the `tl.call()` scheduled one frame `spacing` ahead fires and appends the next frame. So any
single tick longer than `spacing` was silently capped — the preview fell behind to one frame
per tick and stopped matching the export. Latent before (needed <19fps) but the 3.2x peak
brings it to <38fps on the densest frames/duration the UI allows, i.e. any 30fps device.
The driver now walks to the target playhead in <=`spacing` hops (a no-op at normal frame
rates — the loop body never runs). Verified against the real gsap module with the exact
timeline structure: pre-fix, a step 1.28x `spacing` diverges immediately and caps; post-fix
it tracks the requested time exactly at up to 12x `spacing`. Watch item, not yet retuned:
the encoder settings under "Fast-motion blockiness" below were tuned for the old 1.57x peak.
iOS music export was silently broken: WebKit's AudioEncoder omits the AAC
`decoderConfig.description`, so mp4-muxer wrote an unplayable audio track with no error —
`encodeAudioTrack` now synthesizes the AudioSpecificConfig bytes when missing
(phone-verified fix), and a requested-but-skipped music track alerts instead of failing
silently. Fast-motion blockiness fixed: `latencyMode: 'quality'` on Constrained Baseline
(structurally can't B-frame; only the High Profile fallback keeps 'realtime'), mobile
bitrate 15→25Mbps, keyframes every 2s. Previews (both modes) freeze during export so a
live scene never competes with the encoder.
**Export ratio + frame rate pickers, 2026-07-28** (Aaron, for ad formats): one Video-tab row
carrying two selects — `EXPORT_ASPECTS` (`16:9` 3840×2160, `9:16` 2160×3840, `1:1`
2160×2160) and `EXPORT_FPS_OPTIONS` (24/30/60). Export-only state, so switching either is
instant — no rebuild, no `settingsDirty`. Deliberately ONE row rather than two: both answer
"what file comes out of Download", and the Video tab already carries six rows (Aaron
explicitly didn't want the panel cluttered).
**Mobile OOM crashes from the animation settings, fixed 2026-07-28** (Aaron: phones would
"crash and refresh" when the Video settings were pushed up). It was an out-of-memory kill,
and the two modes fail for unrelated reasons — all numbers below MEASURED on an emulated
phone, not estimated:
- **2D is the dangerous one.** Every frame AND star frame is an `<img>` in the DOM, and
  `AnimationPreview` decodes them all up front deliberately (lazy decode painted black
  frames), so all are resident as RGBA bitmaps simultaneously. At the mobile studio size
  (2160×2160) that is **17.8MB each** — the DEFAULT 20+10 already held **534MB**, and the
  old 60+60 ceiling would have asked for **2.1GB**. Encoded blobs (17MB total) and the JS
  heap (40MB) are irrelevant; it is entirely decoded pixels.
- **3D is bounded by construction**: scene geometry measures **5.6MB at any duration ≥10s**,
  because content length is capped at `MAX_CONTENT_LENGTH` and the camera laps it. Nothing
  in the scene grows with the sliders.
- **Both modes** pay at export: mp4-muxer holds the ENTIRE file in memory
  (`ArrayBufferTarget` + `fastStart: 'in-memory'`), which at the mobile 25Mbps bitrate is
  89MB at 30s and 179MB at 60s.
Two fixes. `ANIM_LIMITS` caps mobile at frames 30 / duration 30s / fps ≤30 (desktop keeps
60 / 60s / 60fps), and star frames are capped at **half the frame count** on both
(`maxStarFrames`, Aaron's call) rather than by a flat per-device number. A star frame costs
exactly what a main frame costs, and half is already the relationship the rest of the code
assumes — `getAnimTiming` falls back to `ceil(fc / 2)` and the 20/10 default IS frames/2 —
so this removes a second source of truth, scales instead of staying wrong at the low end
(10 frames used to allow 10 star frames), and bounds total resident bitmaps at 1.5x frames,
which is what lets the frame cap alone be the number you reason about. Lowering Frames pulls
Star Frames down to the new cap. Desktop's worst case drops 3.8GB → 2.85GB as a side effect. And — the part that actually buys the headroom, since caps
alone would have put the mobile ceiling BELOW today's default — mobile 2D frames are
RASTERIZED at `MOBILE_ANIM_RASTER` (1440 long edge) while still being GENERATED at full
studio size, so composition and density are untouched (element counts scale with canvas
area) and each resident bitmap drops 17.8MB → 7.9MB. 1440 not 1080 because mobile exports
at up to 1080 on the short edge and a 1080 source would UPSCALE on the 9:16 crop.
Result: default 534MB → **237MB**, and the new mobile worst case (30 frames + 15 star) is
356MB — still below what the default used to cost. **Gotcha this introduced and closed**: the 2D export's source
rect came from `this.props`, which is no longer the frame size on phones — a rect larger
than the image draws a clipped, half-empty frame. It now measures a loaded frame
(`images[0].naturalWidth`). Verified with a real mobile 9:16 export: frames 1440×1440,
source rect 810×1440 @315,0 (inside the frame), file 1080×1920, 120 samples over 5.000s.
**Desktop is untouched and still uncapped-ish** — 3840×2160 frames at 31.6MB each, 949MB at
the default, which means its own 60+60 ceiling is ~3.8GB. Not observed failing, but the same
class of problem is one setting away if it ever needs attention.
**The Video tab is now grouped by what each control affects** (Aaron, same session): the
scene itself first (3D → Frames → Star Frames → Duration → Speed Ramp — timing last, "how
long" then "how it's paced"), then a `settings-group-start` rule/gap, then the export group
(Export ratio+fps → Music). **Music moved into that group because it is an export setting
and always has been** — previews are silent, so the toggle has never had any effect except
on the MP4 — and its label says so ("added to the export only"). The group is marked with a
gap and a brighter rule rather than a heading, which would spend a whole row saying nothing. Framing now comes from the picker rather than
the studio canvas, so the same design exports identically from any screen, and mobile HALVES
the chosen size instead of forcing a flat 1080×1080 — the old rule silently changed a
desktop-shaped export into a square one.
**The two modes reframe differently, and this is the thing to know before touching it**:
3D re-renders the scene at the export size (camera aspect follows), so portrait/square is a
true recompose. 2D physically cannot — its frames are stills baked at the studio's own
resolution during a 30s+ Generate, and re-rendering 20–60 of them is not something a
Download click can pay for — so it gets a centered cover-crop (`coverSourceRect`, exported
for testing). That crop is real content loss: 9:16 off a 16:9 build keeps the middle 31.6%
of the width and upscales it. The row's note says "2D crops to fit" only when the picked
ratio actually differs from the frames' own, so it never warns when nothing is cropped.
`coverSourceRect` returns the whole source on matching aspects, which is what keeps the
default 16:9 path byte-identical to before. Verified with real exported files, parsed out of
the MP4 boxes rather than assumed: 1:1@24 → 2160×2160, 120 samples over exactly 5.000s
(24.00fps); all three ratios and frame rates confirmed reaching `VideoEncoder.configure`.

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
- **Star streaking at full rush (2026-07-28, Aaron's ask — "stars streak at full speed and
  return to how it is now at rest").** Each star field gains a companion `LineSegments`
  layer: ONE segment per star, anchored at the star (`aStreak` attribute 0, full
  brightness) and trailing to `aStreak` 1, which the vertex shader extrudes along the
  flight axis by `uStreak` and dims to `STREAK_END_FADE`, so a trail reads as a bright head
  with a fading tail. **It extrudes toward +z, AWAY from the camera, and that is the
  physically correct direction** — the stars are static and the camera flies toward +z, so
  in camera-relative terms every star travels far → near and the smear covers ground already
  crossed. On screen the head sits at the star with the tail receding to the vanishing
  point. A first version straddled the star (-1 → 0 → +1) and read wrong for exactly that
  reason (Aaron, 2026-07-28); verified numerically after the fix — the light ADDED at full
  rush has a mean screen radius of 209px against the resting stars' 253px, i.e. it falls
  toward the centre, not around them. Both the extrusion and the opacity ride `rush`, and
  below `RUSH_STREAK_EPS` the layer is `visible = false` outright.
  Points sprites can't be stretched (`gl_PointSize` is square),
  which is why this is a separate line layer rather than a change to the existing materials.
  Doing the extrusion in the shader keeps per-frame JS to two uniform writes regardless of
  star count; the only per-frame buffer work is copying each star's palette color onto its
  4 trail vertices, and that is skipped while the layer is hidden. `frustumCulled = false`
  because the CPU-side bounding box doesn't know about the shader's displacement.
  Verified rather than assumed: at rush 0 the scene is **pixel-identical** to the pre-streak
  build (max delta 0 over 1.4M subpixels, at 5 times through the cycle — it consumes no
  `rng()` either, so scene generation is untouched), t=0 and t=duration stay frame-identical
  (seam intact, since rush is 0 there), and at full rush hundreds of thousands of subpixels
  differ. Length and opacity (12 units / 0.45) were tuned against real renders — the first
  pass (a 9-unit half-length at 0.85) buried the tunnel geometry in white, the same blow-out
  failure the additive panels hit earlier.
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
**Scope, per Aaron (2026-07-28) — read this before the calibration detail below, and note
the two halves are NOT the same claim.** This shirt is a fun extra rather than a
representation of any *specific* product, so it doesn't need to track a given SKU's
placements or printfile changes, and ProductPage's Printful mockups remain the
product-accurate surface. **But the texture must land as close as possible to how a print
sits on a real shirt** — that is the actual constraint, and the calibration below (measured
island rects, the vertical flip, the 8 trim-strip identities, the cuff handedness) is what
achieves it, not over-investment. An earlier version of this component got placement
"completely wrong" and had to be fixed; every rect below is the fix. Aaron's read as of
2026-07-28 is that the current state is **close enough** — so treat it as the acceptance
bar to preserve, not a starting point to approximate away from. Anything that moves UVs or
island rects (a different model, more aggressive decimation) must be checked against real
renders, since it can silently reintroduce that failure.
**The shirt looks like a DIFFERENT PIECE from the artwork behind it, and that is intended —
settled 2026-08-05 (Aaron: keep print fidelity). Don't re-diagnose it as a lighting or
colour bug; it isn't one.** Reported twice as the shirt "feeling different" / "darker". The
body texture renders at the t-shirt printfile's aspect (4200×5400, capped to 1556×2000)
while the wall behind it is the studio's 16:9, and `getElementSizeScale`'s aspect term puts
the panel's elements at **52% of the short edge against the background's 100%**, at
`getCountScale` **0.61**. On top of that, recompose-per-ratio means the portrait render is a
freshly generated layout from the seed, not a crop of the landscape one — so the shapes are
smaller AND somewhere else. Half-size translucent shapes stack denser, which is why the
shirt reads more saturated while the wall reads washed. The only real lever is rendering the
texture at 16:9 and cover-cropping it into the island rects (the shirt would then show
literally the same composition, cropped) — explicitly rejected, since it would stop
depicting how the design actually prints.
**Lighting was separately recalibrated the same day**, a real 8% fix that is NOT the above:
the previous ambient 2.26 / key 1.04 solved for a camera-facing surface, which is the
brightest fabric on screen rather than the typical fabric — measured over every visible
triangle of the real `.glb` weighted by projected area, that 0.964 sat at the top of a
0.78→1.05 spread whose mean was **0.921**, with a third of the garment below 0.9. The target
is now the area-weighted mean, not the peak.
Same session, the garment also gained the two cues that make it read as CLOTH rather than a
printed surface — a procedural sky/floor gradient environment (built in-component, PMREM'd;
NOT `RoomEnvironment`, whose coloured panels would tint the fabric) and `sheen` on both
materials. Both were chosen because they leave camera-facing colour alone: sheen peaks at
grazing angles, and the environment's mean radiance is normalised so it trades against
`AmbientLight` one-for-one (a uniform env of radiance L gives irradiance πL, i.e. a displayed
factor of exactly L). Hence `AMBIENT` is DERIVED, not typed — `π * (1 - ENV_IRRADIANCE) -
key * 0.743`, with 0.743 the measured mean of N·L over the visible garment. `KEY_INTENSITY`,
`ENV_IRRADIANCE` and `SHEEN` are the only knobs; the brightness sum is conserved whatever
they're set to. **A spotlight is the wrong tool here despite being the usual reach** (and
despite Aaron's past three.js experience that only spotlights behaved — that was almost
certainly the pre-r155 `useLegacyLights` unit change, long gone at three 0.185): its distance
decay makes brightness positional, so no single factor could map a texel to the background's
colour.
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
attribution in its license.txt, which is a licence obligation and must ship) lives in
`public/models/tshirt/` (fetched by URL; Vite can't resolve it from src/assets — the
src/assets copy is the unmodified original and is kept as the archival source).
**What's served is an OPTIMIZED build, not the Sketchfab download** (2026-07-28): the
original is scan-density — 154,048 triangles for something drawn at 190 CSS px — and shipped
as 5 requests totalling 4717KB, *uncompressed*, on the landing page (Hostinger compresses by
extension and `.bin` isn't on its list). Now one 708KB `tshirt.glb`: welded, simplified to
10%, quantized, pruned, textures embedded (see TshirtPreview.jsx's header for the exact
`gltf-transform` pipeline). Deliberately NOT meshopt/Draco — either shaves ~270KB more but
drags a decoder in for one small model; `KHR_mesh_quantization` is the only required
extension and three.js supports it natively, so this needs no loader plugin.
Two invariants any future re-optimization must hold, because the texture compositing below
depends on them: the **UV layout** (island rects are measured in atlas space — decimation
must not move them) and the **material names / 2-mesh split** (the `traverse` keys off them).
Verified rather than assumed: UV bounds identical modulo ~0.0002 of int16 rounding
(sub-pixel on a 2048 sheet), front-view silhouette IoU **99.82%** vs the original (bbox
0.12% narrower, same height), and a real headless render of the component from both models
with zero console errors or failed requests.
**Swapping in a different model is far more expensive than it looks** — every island rect,
the vertical-flip discovery, all 8 trim-strip identities, and the cuff `flipX` handedness
below are calibrated to *this* atlas, so a new model invalidates all of it and needs the
orientation harness re-run. Optimizing keeps the calibration intact; replacing does not. Its baseColor atlas is a square sheet of flat cut-pattern UV islands
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

### ProductPage's hero image slot — one animated layer, and why
Recorded because getting this wrong cost a long, ugly debugging session (2026-07-29) and every
mistake in it looked like a fresh bug rather than the same structural fault.
**The rule: exactly ONE thing in that slot animates — the mockup layer's opacity.** The base
(the product's stock photo, the dim scrim, and the loader/button content) is static: it never
unmounts, never transitions, never moves. It is only `inert` while covered.
- **Never give the hero `<img>` a CSS animation class.** It used to carry `--animate-reveal-quick`
  or `--animate-pop-in`, chosen by a small state machine. Both animate OPACITY, which is also
  what `FadeImage` transitions, and **a CSS animation overrides an element's own transition
  outright** — two owners of one property, unfixable by tuning either. That combination produced
  a fade on cache restores, a scale-up with no user action behind it, and two visibly conflicting
  fades on generation.
- **Preload before showing.** `readyHeroUrl` is only set once the image has *decoded*, so the
  layer is fully drawn before it fades and a camera-angle switch swaps `src` underneath an
  already-visible layer. Clear it *after* the fade-out (`HERO_FADE_OUT_MS`), never on the state
  flip — unmounting mid-transition means it vanishes instead of fading.
- **A layer that mounts at `opacity-100` cannot fade** — there is no previous painted value to
  transition from. It mounts transparent and flips after two rAFs (same reason `FadeImage`'s own
  `reveal()` defers twice). Reset that flag only when the layer truly goes away, never on a `src`
  swap, or an angle switch flashes.
- **Freeze the base's content while a mockup exists.** `busy` goes false the instant status hits
  `completed`, which is *before* the image preloads, so the loader snapped to the Generate button
  first and only then faded. Frozen, it fades out intact under the incoming mockup.
- Stacking alone never fixes this: mockup on top shows the loader through it, mockup underneath
  shows the button over it. What makes either safe is the content fading rather than snapping.

### MANDATORY before any renderer change goes live: `scripts/check-render-regression.mjs`

```
node scripts/check-render-regression.mjs --base <last-deployed-ref> [--allow-stars]
```

Exit 0 = every stored design still composes exactly as it did. **Exit 1 = the change rewrites
artwork customers have already saved, and it must not ship in that form.** Run it before a
render-service deploy, before pushing the frontend, and before a thumbnail backfill. It needs
no secrets — designs are public-readable, so the anon key in `.env.local` is enough.

**This exists because of a live incident (2026-08-02), not as a precaution.** The star field
rework raised the per-tier star counts; a star costs THREE `rng()` draws (size, x, y), so that
was **+876 draws** taken from the SHARED sequence, sitting upstream of `geometryChance` and
`overlayChance`. Of 45 real gallery designs, **13 lost their geometry layer outright** —
reported by Aaron on the live site as "the recent render change has completely destroyed the
existing artwork". It only looked survivable because 21 of the rest carry
`settings.geometry.chance = 1`, which passes regardless of the draw. Nothing in the process
caught it before it was deployed.

**Why the checks that were run did not catch it** — this is the part worth internalising,
because each of them felt like diligence at the time:
- **"Composition is identical ACROSS SIZES for a seed"** was verified and passed. It is the
  invariant this project usually worries about (mockup-equals-print) and it is *orthogonal*: a
  change can be perfectly size-invariant and still rewrite every stored design.
- **"GENERATOR_VERSION was bumped"** protects nothing at all. `generateArtwork` never branches
  on the version and nothing renders a previous one — a stored design is always regenerated by
  whatever is in the bundle.
- **Rendering fresh seeds and liking the result** proves nothing either: a fresh seed has no
  prior appearance to preserve. Every render reviewed and approved during that work was a new
  seed.
- **Comparing PNG hashes on a handful of designs** is what earlier bumps did, and it would have
  caught this — but only if the sample included designs relying on the default geometry chance.

**The rule this enforces: a change meant to affect ONE layer must not draw from the shared rng
stream at all.** Give it its own stream, `makeRng(`${seed}-<thing>`)`, exactly as
`expandMonochromePalette` (`-palette`), `generateLabelMark` (`-label`) and `GenerateStarField`
(`-stars`) already do. The shared sequence is a global resource: any draw added or removed
anywhere shifts every layer generated after it. If a change genuinely must touch the shared
stream, this check will fail, and that has to be an explicit, stated decision to rewrite
everyone's saved artwork — not a side effect noticed in production.

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
- **Operational rule: a `GENERATOR_VERSION` bump invalidates every older design's stored
  thumbnail** (2026-07-24). Because nothing ever renders a previous generator version (see
  the renderer section), a bump silently leaves older cards showing a JPEG baked under the
  *previous* algorithm while clicking through renders the new one. Not hypothetical for
  v6→v7: that bump changed `GenerateGeometricShape`'s `keepCount` slicing for any canvas
  with `countScale < 1`, and thumbnails generate at a 2000px density floor
  (√(4Mpx/8.29Mpx) ≈ 0.69 < 1), so all 13 v6 cards genuinely mismatched their artwork.
  `backfill-thumbnails.mjs` now takes `--generator-version=N` to re-render exactly the set a
  bump invalidated instead of the whole table:
  `SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node backfill-thumbnails.mjs --generator-version=6 --dry-run`
  (drop `--dry-run` to apply). The filter reads the version off the same `source` the render
  uses (an animation's FIRST FRAME — an animation row's top-level data has no
  `generatorVersion` of its own). A filter matching zero rows exits 1 rather than looking
  like a clean run. **Add this to the checklist whenever `GENERATOR_VERSION` bumps**,
  alongside the existing "redeploy render-service" step.
  **When to use the filter, and when NOT to (clarified at v8 → v9, 2026-07-29).** The filter is
  right when a bump only changes output for designs *saved* under particular versions. It is
  **wrong** when a bump changes output for every stored design — v9 did, since it altered the
  size formula itself and nothing ever renders a previous version. Two traps in that case:
  the filter would skip most of the table, and because the script is **read-only on the
  `designs` table** a row's stored `generatorVersion` never advances, so a filtered run
  re-selects the same subset forever and the rest stay stale indefinitely. Run it bare
  (`node backfill-thumbnails.mjs`, 37 rows at v9) whenever the change isn't version-scoped.
  Corollary: **the version column is not a record of thumbnail freshness** — after any backfill
  the JPEG is current while the stored version still reads whatever it was saved under. The
  live distribution at v9 (10 rows at v6, 26 at v7, 1 at v8) reflects save history only.
- **Gallery thumbnails legitimately look "zoomed out" next to the studio, and this is NOT a
  regression — decided 2026-07-31 (Aaron: leave as-is). Don't re-diagnose it.** Reported after
  the v9 backfill as thumbnails no longer matching a downloaded image. Two effects stack, both
  measured through the real pipeline:
  (1) **Thumbnails are SQUARE (320², generated at 2000² via the density floor) and the studio
  is 16:9.** `getElementSizeScale`'s aspect term squares how far a canvas sits from 16:9, so a
  square gets `(1/1.778)² = 0.316` — every element is sized to ~32% of its 16:9 size. Measured
  mean geometry-shape extent as a fraction of the short edge, three seeds: 72.5 / 48.6 / 30.6%
  at 16:9 against 22.9 / 15.4 / 9.7% square, a 3.16x gap; star sizes 3.15% vs 1.09%. Element
  **counts are identical** (31 shapes either way), so it is scale, not density — and it has
  been true since v3, for every thumbnail ever generated.
  (2) **v9 widened it, at square sizes only.** Replacing the chaotic floor's absolute 150px
  with a fraction of the size scale reproduces 150 exactly at the studio's 2160, but a square
  thumbnail's size scale is just 632 (2000 × 0.316), so the floor fell to 44px. Versus a v8
  bundle built from `ffe9b79^`: **−36.3 / −29.4 / −44.4% at 2000², and exactly 0.0% at
  3840×2160.** Pre-backfill cards were v6/v7 JPEGs still carrying the 150px floor, which is
  why only the thumbnail side of the comparison moved.
  **Do not "fix" this by reverting v9** — the absolute constant it removed was a real bug worth
  up to 65% on mockup-vs-print. The real fix, if it is ever wanted, is to stop previewing a
  16:9 canvas with a square image: render thumbnails at 16:9 and cover-crop into the square
  card (loses ~44% of the width), or make the cards 16:9 (touches GalleryPage, GallerySection
  and GalleryModal). Both need a backfill re-run. Note the mismatch is **desktop-only** —
  StudioPage renders 2160×2160 on mobile, where the studio and the thumbnail agree.
- **`THUMBNAIL_SIZE` is 640, raised from 320 on 2026-07-31** (`StudioContext.jsx`, mirrored in
  `backfill-thumbnails.mjs` — the two must stay in sync). 320 was an upscale on every 2x
  desktop card: measured live, cards occupy 259 CSS px on the gallery page and 227 on the
  homepage, so a retina screen asks for 518 and 454 device pixels. Mobile needed 318 against
  320 stored, which is why phones always looked right and only desktop was soft. Reported as
  "why are the thumbnails so pixelated now" right after the v9 backfill, and the "now" is the
  interesting half: the undersizing was always there, but v9's ~3x smaller elements gave the
  same raster far finer detail, and fine detail survives an upscale much worse than the large
  flat gradient shapes it used to carry. Verified against the 2000px render resampled to a real
  518px card: RMSE 8.22/7.27/5.48 → 5.42/4.73/3.67 across three seeds. Thumbnails for the whole
  table go from roughly 0.7MB to 1.7MB.
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
- **Printful's own order preview on the account page's Active orders** (2026-08-11, built,
  NOT yet deployed — `printful-order-preview` must be deployed before the frontend ships or
  the thumbnails simply never appear). v1 `GET /orders/{id}` returns each item's placement
  files **plus a fifth entry of `type: 'preview'`** — an 800×800 composite of the finished
  garment that Printful renders from the REAL print files. Three things worth not
  re-deriving:
  (1) **It is generated at order-CREATION time, not at fulfillment** — verified against
  canceled/never-confirmed order 169189293, which carries it. So a free draft order yields
  one, which makes it a zero-cost verification surface for any placement change (the same
  "compare against Printful's own render" technique that caught v9).
  (2) **It is not the mockup the customer approved.** `mockup_image_url` is our own capped
  render through a mockup task, restricted to the placements a Flat photo can show. On the
  mesh shorts (693) there is no Flat Back style and no style carrying a label at all, so
  this preview is the ONLY view of the ordered garment showing the back or either label.
  (3) The client sends **no order ids** — the function derives the caller's own active
  orders via the service role, so there is nothing to enumerate. `verify_jwt = true` is only
  the outer gate (the anon key passes it); the GoTrue `/auth/v1/user` check is what
  identifies the user, and it is load-bearing here since this reads order data.
  Active orders only, chained after the rows land (most account views have no active order,
  and this one leaves our infrastructure). Printful's preview is a full-body model shot, so
  the thumbnail is 64px — the garment is only ~a quarter of the frame and smaller reads as a
  blob. The thumbnail slot is **reserved before the URL exists**, predicted from
  `order.printful_order_id` (the same condition the function selects on), so the image fades
  into a held box instead of appearing and shoving the text — verified at 0.0px title shift
  across the arrival.
- **The order lists don't scroll until their rows have finished animating in** (2026-08-11,
  Aaron's call, `OrderList` in AccountPage). `fade-slide-up`'s `backwards` fill holds each row
  16px BELOW its final position for the whole length of its stagger delay, and inside an
  `overflow-y-auto` box that counts as scrollable overflow — so a list that will never need a
  scrollbar grew one anyway and then lost it (measured: exactly 16px, t=1360→2000ms on a
  3-row list; it happens at ANY row count, not just near the 32rem cap, because the container
  is content-height until then). **Absorbing it with bottom padding was tried first and is
  worse** — it fixes the short case but pushes a 5-row list past `max-h` into scrolling it
  didn't previously need. Two load-bearing details: the wait keys off the real
  `getAnimations()` rather than re-deriving the timing from delay props + `--duration-slow`,
  and it must filter out the skeleton's INFINITE `animate-pulse` or scrolling would never
  return; and it settles once and never un-settles, since clamping overflow on an
  already-scrolled list would jump the user to the top when "Load more" appends rows.
  Verified: a 3-row list is never scrollable, while 5- and 8-row lists become scrollable only
  after settling and stay that way.
- **Order history lists PAID orders only** (2026-07-25). `listMyOrderHistory` filters on
  `stripe_payment_intent_id is not null`, because `canceled` covers two unrelated things: a
  real order Printful later canceled (`printful-webhook`'s `order_canceled`), which the
  customer paid for and belongs in history — and a checkout that was started then abandoned,
  which `create-checkout-session` and the stale-pending cron (`0010`) also mark `canceled`
  and which never charged anyone. The second kind dominates the list (every closed Stripe tab
  leaves one) and listing it as "order history" is simply wrong: nothing was ordered. Live
  numbers when this was found: 22 rows in history, only 13 of them paid. The payment intent
  is the clean discriminator — `stripe-webhook` sets it only once payment completes, and an
  order whose webhook never ran stays `pending`, which the status filter already excludes.
  The list also scrolls inside its card above `lg` (`lg:max-h-[32rem]`), since at desktop
  width it sits beside a short side column and an unbounded list strands the profile/stats
  cards against a wall of orders; below `lg` it's one column and the page's own scroll is
  the natural one.
- **Size guide on the product page** (2026-07-25): Printful publishes a per-product size
  guide (`GET /products/{id}/sizes`), surfaced via a "Size guide" link beside the size picker
  → `components/ui/SizeGuideModal.jsx`. Reached the codebase as the honest answer to "which
  size am I" after saved default sizes were built and reverted the same day — sizing differs
  per garment, which is exactly what a per-product table addresses and a remembered
  preference cannot (see IDEAS.md).
  Things worth knowing:
  - **The two table types are not interchangeable.** `measure_yourself` is BODY measurements
    (Chest/Waist/Hips) per size — self-explanatory, and the one that actually answers the
    question; present on 10 of 15 products. `product_measure` is the garment laid flat with
    measurements labelled **A, B, C…**, which are keyed to letters on Printful's diagram —
    **the numbers are meaningless without the image**, so the diagram renders inside the
    table's section rather than as decoration, with `image_description` (which explains each
    letter) beneath it. Body measurements are sorted first.
  - **Descriptions are third-party HTML and are rendered as TEXT**, never via
    `dangerouslySetInnerHTML` — this is markup from another company on a page that also takes
    payment. `htmlToText` strips tags and decodes entities; verified across all 15 products'
    real payloads (48 description fields) that no tag or entity survives the strip.
    That claim used to be made about tags only, and the entity half of it was false —
    `&rsquo;` and `&Prime;` weren't in the decode allowlist and rendered literally
    ("they&rsquo;re") on most products' size guides, found and fixed 2026-07-27 while adding
    the bandana. Decoding is deliberately a string allowlist + numeric escapes, NOT the usual
    innerHTML/textContent trick, which decodes everything but reintroduces exactly the
    injection surface this avoids; `&amp;` is decoded last so a literal `&amp;rsquo;` doesn't
    double-decode.
  - Sizes are ROWS, measurements COLUMNS: a product carries up to 11 sizes (hoodie 2XS–6XL)
    but at most 5 measurements, and 11 columns is unreadable on a phone.
  - Fetched **lazily on open** through `printful-catalog?id=N&sizes=1` (new param, same
    pattern as `printfiles=1`/`templates=1`), then cached — most product views never open it.
    Unit is fixed to inches upstream; cm is converted client-side rather than spending a
    second request and cache entry on the same numbers.
  - The diagram is a Printful CDN image. That's **not** new third-party exposure — the page
    already loads product photos and mockups from that same host, unlike the gallery avatar
    case where rendering a provider URL would have introduced a brand-new one.
  - **`printful-catalog` must be redeployed** for this to work.
- **Avatars are always Chromaforge-generated, never a provider's** (2026-07-25, Aaron's
  call). `handle_new_user()` used to copy `raw_user_meta_data->>'avatar_url'` into
  `profiles.avatar_url`, so every Google sign-up arrived carrying an
  `lh3.googleusercontent.com` URL. Migration `0015_never_adopt_provider_avatars.sql` stops
  that and nulls the ones already stored; `display_name` is still taken from OAuth metadata
  (a string we store, not a third-party asset every visitor's browser must fetch).
  AccountPage already generates and uploads an avatar for any profile with none, so null is
  the route INTO the generated-avatar path, not a gap. **`AuthorBadge.jsx` keeps its own
  self-hosted-origin check on top of this by design** — `avatar_url` is a free-text column
  and RLS lets a user update their own profile row, so the client must never assume the
  value came from the trigger. That check matches the project's own Storage origin with
  `startsWith`, NOT a `/avatars/` substring: a substring test would let any user point
  `avatar_url` at their own server with that path and get a tracking pixel loaded from every
  gallery visitor's browser (found by testing the predicate against a deliberate lookalike).
  Author bylines across the gallery, homepage gallery section and design modal share
  `AuthorBadge`; the artwork picker uses its `authorName` helper but deliberately shows no
  avatar (its tiles are ~70px and the byline is already hidden on phones). No new queries —
  `listPublicDesigns` already embedded `avatar_url`.
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
  placements/technique/required options for all 15 configured products (every entry confirmed
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
    **Real bug from this, found in a live order 2026-07-29**: the checkbox list is derived
    from `cfg.placements` — the MOCKUP-visible set — and mesh shorts (693) carry
    `placements: ['front']` only because Printful publishes no "Flat Back" style for them,
    not because there's no back panel. So `back` had no checkbox, was therefore never in
    ProductPage's selection Set, and `includesGeometry` reads an absent placement as
    **geometry OFF** — every pair of shorts printed a geometry-less back (stars + gradient
    only), with no UI able to change it, and the front-only mockup could never reveal it.
    The section is also gated on `geometryOptions.length > 1`, so it was hidden entirely.
    Fixed with `geometryPlacementKeys: ['front', 'back']` on 693 — the same override the
    bucket hat (654) already needed for its unphotographable inside faces, which is the tell
    that this is a general hazard and not a one-off: **any product whose printed panels
    outnumber its previewable ones needs the override.** Audited all 15 against the live
    catalog's real `available_placements` (not assumed): **693 was the only one.** The other
    mismatches are deliberate — `744`'s `inside_pocket`, `615`'s `hood_inner`/`facing`, and
    `801`/`390`'s `details` are interior/trim surfaces where geometry-off is the intended
    rule, same as `label_panel`. Note the joggers (784) were **never** affected despite
    being the shorts' twin in every other respect: they do list `['front', 'back']`. With
    both panels on, the shorts' front and back resolved to the same render cache key (one
    printfile, and `twoLegCanvas` products were excluded from `mirrorPlacements` at the time),
    so the back was byte-identical to the front and cost no extra render. **No longer true as
    of later the same day**: 693/784 now carry `mirrorPlacements: ['back']` and the Back panel
    toggle defaults on, so the back is a genuinely different render. Front and back only share
    one render when the customer turns that toggle off.
  - **Label placements, 2026-07-04**: Printful's catalog was audited product-by-product
    (`getPrintfileSpecs`/`getPrintfileSpecs?templates=1`, live) and turned out to expose
    *three* distinct label-type placements, not one, previously never even considered:
    `label_inside`, `label_outside`, and
    `label_panel` (hoodie/zip hoodie/sweatshirt only — confirmed via Printful's own
    mockup-generator template reference images to be the hood/neckline **interior lining**
    panel, sharing a full-size printfile with front/pocket, not a small tag despite the
    name). **Coverage and sizes re-audited live 2026-07-30 against
    `mockup-generator/printfiles/{id}` for all 15 products — the earlier summary of these two
    was wrong in three ways, so trust this list, not a remembered rule:**
    `label_inside` is on **11 of 15** — absent on both t-shirts (257/261), the tote (274) and
    the pillow (83), so it is NOT universal and NOT "every crewneck product". `label_outside`
    is on **5**: track jacket (801), mesh shorts (693), joggers (784), crossbody bag (744) and
    bucket hat (654) — not the "joggers/track jacket only" previously recorded here (which
    this file already contradicted itself, since the 654 draft-order note names
    `label_outside` on the hat). **Neither placement is a fixed size.** `label_inside` is
    375×150px/2.5"×1" on 8 products but 1050×600/7"×4" on the windbreaker (615) and
    450×300/3"×2" on the bucket hat; `label_outside` is 450×450/3"×3" on the jacket, shorts
    and joggers, 300×300/2"×2" on the crossbody, 450×300/3"×2" on the hat. All are 150 DPI.
    This costs nothing in code — the split-panel layout keys off the aspect ratio (≥ 1.6), not
    a hardcoded size, so the 2.5:1 and 1.75:1 tags split and the 1.5:1 and square ones don't —
    but any future change that assumes one label size would be wrong on four products.
    Real checkout already submits every placement Printful returns
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
    centered in a long dark field — wide placements (originally aspect ≥ 1.6,
    `LABEL_MARK_GENERATOR_VERSION = 3`; the threshold is GONE as of v5, see below) split into a square dark panel with the mark plus
    a flat fill of the design's chosen accent (the same `mainColorHex` the colored chords
    spin from, so the panels share a root color; zero new rng draws). Panel rects live in
    the generator's config (`panels.mark`/`panels.accent`) so `renderLabelMark` stays
    layout-agnostic; square `label_outside` keeps the single centered panel
    (`panels.accent = null`).
    **Split threshold removed — `LABEL_MARK_GENERATOR_VERSION = 5` (2026-07-30, Aaron's call:
    "the logo should get a proper square area and the rest is color so however that ends up
    being is fine").** The accent's share was already a smooth continuous function of the
    label's shape — `1 - 1/aspect`, i.e. 60% at 2.5:1, 43% at 1.75:1, 33% at 1.5:1 — reaching
    exactly 0 at a square on its own. `SPLIT_MIN_ASPECT = 1.6` was therefore a cliff on a
    function that needed no floor, and it zeroed the **bucket hat**'s natural 33% (its
    `label_inside` is 450×300, aspect 1.50) for no reason. Now `mark` is a square of side
    `min(width, height)` and `accent` is whatever is left; a portrait label leaves nothing
    over and correctly falls back to the single centered panel. **Exactly one label in the
    catalogue changed** — verified by PNG hash across all six real sizes, rendered through the
    real generator under `@napi-rs/canvas`.
    **Real bug caught by that hash check, worth not repeating:** the transparent branch was
    `{ ...panels, accent: null }`, which nulls the accent but keeps the *square* mark panel —
    so removing the threshold silently shrank the hat's `label_outside` mark and shoved it to
    the left edge. A transparent label now builds its own full-canvas mark panel explicitly.
    Nulling one field of a computed layout is not the same as choosing a different layout.
    **No render-service redeploy needed for label changes** — unlike every other placement,
    label marks are rendered client-side and uploaded directly (see the bypass note above), so
    `generateLabelMark` is not in the Fly bundle at all. Uploads are content-hashed, so changed
    bytes get a new URL and Printful's fetch-by-URL cache is not a hazard here.
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
  - **Single-colour palettes, fixed 2026-07-25** (Aaron's call on the behaviour: derive
    similar colours so it still reads monochromatic). Removing colours down to one is
    something the studio genuinely allows — nothing in the colour list stops you — and three
    generators each special-cased `colors.length === 1` by improvising their own companion,
    usually a **random greyscale value**. Three distinct problems came out of that:
    (1) **It crashed the print pipeline.** Those branches pushed raw *tinycolor objects* into
    a colour list that ends up at `addColorStop`. Browsers accept that (they stringify via
    `toString()`, and tinycolor's returns the colour); `@napi-rs/canvas` rejects it outright
    with `Failed to convert JavaScript value ... into rust type String`. So a single-colour
    design looked fine on screen and failed at checkout — **the same browsers-are-lenient
    trap as `GenerateLargeRadialField`'s alpha-as-a-string bug**, found the same way.
    (2) `GenerateLargeRadialField`'s branch pushed nothing at all on the `else` path, leaving
    `radGrad.colors` empty — roughly **half of a single-colour design's blobs rendered
    invisible**.
    (3) A random grey is neither similar to the chosen colour nor monochromatic, and each
    layer picked its own, so the piece didn't hold together.
    Replaced by `expandMonochromePalette` (`render/prng.js`), applied **once centrally** in
    `generateArtwork` so every layer shares one derived set: the base kept exactly, plus
    companions bracketing it lighter and darker inside a narrow analogous hue window. A
    greyscale base deliberately stays greyscale. The three special-case branches are gone.
    Seeded off its **own rng stream** (`${seed}-palette`), so it consumes zero draws from the
    sequence every other layer shares — which is why this needed **no `GENERATOR_VERSION`
    bump**: multi-colour and auto-palette output is byte-identical (verified, 12 PNG hashes
    across 4 designs × 3 sizes incl. print), and a single-colour design keeps the same
    composition structure it would have had, only recoloured. The stored design also keeps
    the customer's single colour — the expansion is derived at render time, so a saved
    one-colour design stays a one-colour design.
    Checked against the live DB before deciding: **zero saved designs have exactly one
    colour** (30 use the auto-palette/empty array, the rest 3/5/6), so nothing existing
    changed appearance and no thumbnail backfill was needed.
  - **A new product needs a DRAFT-ORDER check before it can be bought, not just a working
    mockup** (`scripts/check-printful-draft-orders.mjs`, added 2026-07-25). A mockup
    exercises Printful's mockup generator; the failures that have actually bitten this
    project happen at ORDER time and are invisible to it — the zip hoodie 400ing without an
    explicit `stitch_color`, the track jacket rejecting `details` alongside the sleeves, and
    every `label_inside` order silently failing on v2. The script creates an UNCONFIRMED
    draft per product (never charged, never produced — it never calls `/confirm`), waits out
    Printful's async file processing, asserts every placement came back `ok`, then deletes
    the drafts; exit 1 on any failure. It needs only `PRINTFUL_API_KEY` — **no Stripe, no
    `STORE_ENABLED` flip, and no `PRINTFUL_SKIP_CONFIRM` toggle**, which is the point: the
    obvious alternative (a real checkout with `PRINTFUL_SKIP_CONFIRM` set) costs a live
    Stripe charge and puts a launch-critical secret in a state someone has to remember to
    undo. It imports `PRODUCT_MOCKUP_CONFIG` directly so its options can't drift from the
    app's. Run: `PRINTFUL_API_KEY=... node scripts/check-printful-draft-orders.mjs
    --products 390,615,654`.
  - **Three products added 2026-07-25** (windbreaker 615, bomber jacket 390, reversible
    bucket hat 654 — starter set is now 14), each spec-verified the usual way with a real
    completed v2 mockup task before its config was written, and **all three draft-order
    validated the same day** (every placement `ok`, incl. `label_inside` on all three and
    `label_outside` on the hat; the windbreaker confirmed to order cleanly with no options
    at all, settling the v1/v2 `stitch_color` discrepancy in (1) below). Each turned up
    something the existing 11 hadn't:
    (1) **v1's `product.options` is not a reliable "is this option required" list.** The
    windbreaker omits `stitch_color` entirely from v1 `GET /products/615`, while v2
    `mockup-tasks` hard-rejects any task without it and v2 `GET /catalog-products/615`
    does list it. Consequence: `getStitchColorOption` (which reads the v1 list, via
    `printful-catalog`) returns null for this product, so it shows no stitch-color picker
    and silently uses `PRODUCT_MOCKUP_CONFIG`'s configured default — a clean degradation to
    exactly the pre-picker behavior, not a break. `check-printful-catalog.mjs`'s option
    check now falls back to v2's `product_options` before failing, so this doesn't read as
    drift on every scheduled run. **The reason for the omission**, confirmed against
    Printful's own per-variant photos: the windbreaker's two variant COLOURS (Black/White)
    are not two jackets. Both are the *identical white jacket*; the only difference is the
    zipper tape and the seam stitching. So this product already expresses the stitch-colour
    choice through its variant dimension, which is why it carries no `stitch_color` option —
    and it's the only garment in the catalogue with more than one variant colour. Every other
    garment has a single "White" variant colour and carries the option instead. Net effect:
    the customer gets exactly one stitching control either way, by two different routes.
    Because the fabric is white regardless (and fully covered by the artwork), "Color" is an
    actively misleading label here — someone picking "Black" would reasonably expect a black
    jacket. `PRODUCT_MOCKUP_CONFIG` gains `colorLabel`/`colorHint` for exactly this case
    (windbreaker only: "Stitching", plus a line saying both options are the same white
    jacket). The tote keeps the default "Color", because its Black/Red/Yellow really are
    three differently coloured bags. **That override also decides WHERE the picker lives**: a
    product declaring its variant colour is a finish detail gets it inside the collapsed Print
    options panel, next to where every other product's `stitch_color` sits, because it's the
    same decision; without the override the colour is part of what you're buying and stays
    beside size. Safe to collapse for the windbreaker specifically, and checked rather than
    assumed — its two colours are the same price at every size (price varies by size only)
    and both are in stock, so nothing behind the disclosure can change price or availability.
    The collapsed summary shows "Black stitching", never a bare "Black". The label also qualifies the order line, so it reads
    "L / Black stitching" rather than "L / Black".
    That also drove a UI fix: the size picker listed every size-colour COMBINATION, so the
    windbreaker showed 7 sizes x 2 colours = 14 buttons with each size appearing twice
    ("S / Black", "S / White"), reading as though colour were baked into the size. Colour and
    size are now separate rows (14 buttons -> 9), with sizes filtered to the chosen colour and
    the colour derived from the selected variant rather than held as its own state, so the two
    rows can't disagree. Single-colour products render exactly as before.
    (2) **The bomber needs `details` in its mockup placements, and the track jacket's
    inability to include it is a real preview gap.** 801 fails the whole task when `details`
    is combined with the sleeves; 390 completes fine with the identical combination
    (verified live). It also *matters*: a front/back/sleeves-only bomber mockup renders the
    ribbed waistband and both pocket welts as blank white, a wide unprinted band across the
    bottom of the jacket (compared byte-for-byte against the with-details render of the same
    variant). The real garment is unaffected either way — checkout submits every placement
    unfiltered — but 801's *preview* has been showing that same blank hem all along and
    can't stop until Printful accepts the combination there.
    (3) **A reversible product breaks the "mockup placements == placements the customer
    sees" assumption.** The hat's inside panels are really printed and really worn, but no
    mockup style photographs them: its catalog's "Front Inside"/"Back Inside" styles
    (4900/4865) return **byte-identical** images to their Outside counterparts (verified by
    md5), and submitting only the outside placements yields byte-identical photos to
    submitting all four. So `placements` is the two outside ones, and a new optional
    `geometryPlacementKeys` config field supplies the geometry checkboxes instead —
    `getGeometryPlacementOptions` derived them from `placements`, which would have left the
    inside panels with no checkbox, and a placement absent from ProductPage's selection Set
    is read by `includesGeometry` as *geometry off*, silently and with no UI to fix it.
  - **Bandana (630) added 2026-07-27** — starter set is now 15. Simplest product in the
    catalogue (one hemmed square: a single `front` placement, printfile 380 at 4125×4125,
    three sizes S/M/L, one colour), so it needs no `mirrorPlacements` (no back panel to
    mirror, same as the tote), no pocket crop, no two-leg canvas, and its geometry section is
    a single Front checkbox. Two things it turned up that are worth not re-deriving:
    (1) **The first product where a mockup placement is rejected outright rather than merely
    invisible.** `label_inside` is the only other placement it has, and submitting it in a
    mockup task returns http 400 `Invalid variant_id: 16031 and placement: label_inside
    combination` — even though `GET /v2/catalog-products/630/mockup-styles` *advertises*
    `label_inside` under both configured styles. Every other product's label placements are
    left out of `placements` because they aren't visible in a Flat photo; here including it
    would fail every preview on the product. The real order is unaffected —
    `resolvePlacementEntries` runs unfiltered at checkout, and the draft-order check confirmed
    both `default` and `label_inside` come back `ok` (order 168890021, deleted). A cleaner
    demonstration of the draft-check's whole premise than the products it was written for: the
    mockup and the order genuinely disagree about the same placement, in the direction that
    only the order test can see.
    (2) **No "Flat Back" style exists, so this is the only product whose second preview isn't
    the Flat Front/Back pair.** The second view is the catalog's "Product details" macro shot
    — a real close-up of the customer's own artwork on the fabric with the hemmed edge, which
    still shows the design. The three Lifestyle styles were rejected for the opposite reason:
    they photograph the bandana knotted in hair or on a bag handle, i.e. a twisted sliver of
    the artwork. Every style on this product is `restricted_to_variants` a **single size**, so
    a shared pair would fail for two of the three sizes — the pillow's (83) failure mode,
    handled the same way with `mockupStyleIdsByVariant`.
  - **Seam mirroring, 2026-07-25** (`mirrorPlacements` in `PRODUCT_MOCKUP_CONFIG`, bucket
    hat only so far). Each of that product's faces carries TWO cut pieces — half the crown
    side-wall and half the brim — so front and back meet at the two seams Printful's own
    template labels "Visible seams", and since both halves share printfile 410 they rendered
    the identical image and the composition visibly restarted at each seam (confirmed on a
    real side-view mockup, style 4899). **Mirroring the back half closes BOTH seams from one
    render**, which is the non-obvious part worth not re-deriving: going round the crown the
    front's right edge meets the back's left edge, and a mirrored back's left edge *is* the
    front's right edge; continuing round, the mirrored back's right edge is the front's left
    edge, exactly what the other seam leads into.
    Three things to know:
    (1) **The flip lives in `renderArtwork.js` — one implementation, not two.** An earlier
    estimate in this project said it would need mirroring into `render-service/render.js`
    like `drawRegion` does; that was wrong. `drawRegion` is duplicated only because it sits
    *outside* the shared renderer. `renderArtwork` IS the shared compositor (render-service
    bundles and runs it verbatim), every layer there is a `drawImage(el, 0, 0)`, and nothing
    resets the transform — so one `translate`/`scale(-1, 1)` at the top covers all of them,
    in the browser and on Fly, identically. It rides the same end-to-end channel
    `geometryLayout` already uses (ProductPage → `renderAndUploadPrintFiles` →
    `render-print-file` → render-service → `generateArtwork`), and consumes no `rng()`.
    (2) **`mirrorX` is in the render cache key**, for the same reason the secondary-design
    discriminator is: a mirrored back shares its front's printfile id, so without it the back
    would be served the front's unmirrored render and the fix would silently do nothing. It's
    also in `useMockup`'s `cacheKey` — unlike the inside-face design choice, this one *does*
    change the returned photo.
    (3) **Deploy render-service BEFORE the frontend.** It ignores an unknown field and would
    render unmirrored while the mockup shows mirrored — the exact density-slider hazard, and
    with no `GENERATOR_VERSION` change there's no mismatch check to catch it.
    Verified: a mirrored render is a pixel-exact horizontal flip of its unmirrored twin (max
    delta 0 across 25.5M subpixels, at real print resolution and an off-square size, on both
    a chaotic seed and a full-coherence lattice), and the default path is untouched (12 PNG
    hashes across 4 designs × 3 sizes identical before vs. after). Exposed as a per-order
    customer toggle (Back panel: Flipped / Same as front, **default Flipped**) rather
    than decided globally, because the result is bilaterally symmetric — a taste call.
    That copy was rewritten 2026-07-25 from an earlier "Side seams: Continuous / Independent":
    the labels now name the MECHANISM, because the old off-state hint ("each half its own
    composition") was simply false — front and back resolve to printfiles of identical
    dimensions on every mirrored product, and the renderer is deterministic on
    (seed, colors, settings, w, h), so unmirrored the back is byte-identical to the front and
    both come from ONE cached render. The only thing this toggle changes is the flip.
    Endless wrap is not reachable; it needs a horizontally tileable composition this
    generator can't produce.
    **Extended to every product with a distinct back panel, same session** (Aaron's ask), so
    this is not a bucket-hat feature. (**At the time this was written 11 of 15 carried
    `mirrorPlacements: ['back']`; it is now 13 of 15** — the mesh shorts and joggers were added
    later the same day, see the two-leg-products section below, which supersedes the exclusion
    reasoning in this paragraph. Only the tote (274) and bandana (630) are still out, and
    neither has a `back` placement at all.) Two facts were checked rather than assumed before extending: every one of
    those products' back print area is centered in its template to within 2px of 3000
    (0.07%), and garment front/back panels are themselves symmetric about their own vertical
    centerline, so a full-canvas mirror maps the panel onto itself instead of shifting
    artwork relative to fabric. **Three products were excluded at this point**: the tote (274,
    no distinct back — one canvas wraps the bag), and the mesh shorts (693) and joggers
    (784), which DO have a back placement but are `twoLegCanvas` — their canvas is cut in
    half into two legs, so front and back never meet as one cylinder at two side seams and
    the argument that justifies mirroring everywhere else doesn't hold. **That reasoning about
    the two leg products was later proven wrong and both are now mirrored** — the argument does
    hold, it just applies per leg; see the two-leg-products section below for the measurement
    that reversed it. The tote's exclusion stands.
    Costs one extra print render per checkout on a mirrored product (the back is genuinely a
    different image now). Verified per product that turning the toggle on changes exactly the
    intended placement and nothing else, and that the toggle-OFF path is identical to
    pre-change code across all 11 pre-existing products × 3 geometry layouts.
    **Same session, `geometryLayout`'s default flipped `'single'` → `'mirror'`** (Aaron's
    call) for the two-leg-canvas products (mesh shorts, joggers). It was `'single'` only as
    the closer-to-everything-else option; a shape spanning both legs is the better default
    and matches the seam default above.
  - **The two leg products: seam mirroring enabled, and five option rows collapsed to two
    (2026-07-29, Aaron's call after the geometry bug above).** Two separate changes, same
    session, driven by "it's too complicated as it is and none of the settings other than
    stitch color really make any sense the way they are worded now."
    **(1) `mirrorPlacements: ['back']` now covers mesh shorts (693) and joggers (784)** — 13 of
    15 products, only the tote and bandana left out (neither has a back placement at all). Their
    earlier exclusion, on the grounds that a cut-in-half canvas means front and back never meet
    as one cylinder so the front's-right-meets-back's-left argument can't apply, **was wrong**:
    the argument holds, it just applies per leg. Flood-measuring Printful's own front AND back
    templates (transparent region = fabric piece) shows every sheet is a mirror-symmetric
    *layout* — shorts leg panels at x 0.156–0.455 / 0.546–0.844, joggers 0.147–0.492 /
    0.507–0.852, own-flip IoU 0.978 and 0.996 — with inner crotch/inseam edges facing the sheet
    centre. Worn, the back sheet is rotated 180° about the vertical (not flipped), so its x axis
    runs opposite the front's in world space and the front's LOW-x panel is sewn to the back's
    HIGH-x one; because the panels are exact reflections, the existing full-sheet `mirrorX` maps
    panel onto partner edge-for-edge and the seam condition reduces to `F(x) == F(x)`. Confirmed
    on real renders at the true 11250×4350 printfile across three designs (chaotic, custom
    palette, full-coherence lattice): **mirrored takes both the outseam and the inseam to max
    subpixel delta 0, from 161–251 unmirrored.** No renderer change was needed. Caveat: the
    pairing is derived from construction plus that measurement, never photographed — no mockup
    style on either product shows a back or side view.
    **The one real trap here, and it was reasoned WRONG first:** under leg symmetry the back must
    NOT be mirrored. The initial claim was "the flip is a no-op there, since mirroring a
    symmetric image returns itself." Measuring killed it — `mirrorX` sets its transform at the
    TOP of `renderArtwork` so every layer draws flipped, while `legSymmetry` reflects the
    FINISHED raster at the bottom; together they build a symmetric sheet out of the *flipped*
    composition's left half, which is not the front's sheet, so seams go from **0 to 238**.
    ProductPage hides the row and skips `mirrorX` in that mode (`seamsAlreadyMatch`) — a
    correctness requirement, with front/back continuing to share one cached render as a bonus.
    **(2) Five rows → two.** `artworkScale` + `legSymmetry` + `geometryLayout` collapsed into one
    `legArtwork` state with two options, **Detailed (default)** / **Oversized**;
    Geometry placement is hidden on these two products only, so geometry renders on every panel
    there (which is what makes the `geometryPlacementKeys` fix above belt-and-braces rather than
    the only thing standing between a customer and a blank back). `geometryLayout` is now fixed
    at `'mirror'` and `legSymmetry` at `false`; only the size frame differs between the modes.
    **`legSymmetry` is deliberately NOT in either mode, and getting that wrong is the trap.**
    First pass folded it into the default, reading Aaron's "the one leg option == mirrored,
    that's the default" as the SHEET mirror. It meant the **geometry layout** mirror — the shape
    repeated flipped on each leg — which was already on by default. He caught it immediately
    ("both layout options fail to reproduce the front of the shorts I did order"). Settled by
    matching real renders against the actual print file of the order (design `e2bcfaa7`, seed
    `qos0t1c0`, still in Storage inside the 24h `cleanup-storage` window — the per-order render
    context is never persisted, so the print file IS the only record of what was used):
    one-leg + layout-mirror + symmetry-OFF reproduces the front at **RMSE 0.46 / max 5**
    (rounding noise; the reference came off Fly, a different `@napi-rs/canvas` build), while the
    symmetric variant sits at 57.5 and every other combination at 50–99. The back matched at
    **RMSE 0.17 with geometry OFF**, independently confirming both the ordered scale and the
    geometry bug. **Technique worth reusing: when a per-order setting isn't persisted, recover it
    by matching candidate renders against the stored print file.**
    **The labels name SCALE, and neither uses the word "mirrored" — it took three tries to get
    there, so don't undo it.** "Mirrored legs" was wrong first (without leg symmetry the legs
    aren't mirror images; the stars, gradient and overlay run straight across the sheet), and
    "Mirrored **shapes**" was still wrong (Aaron, live: "I don't know if the way we have things
    worded makes sense to what's actually happening") because `effectiveGeometryLayout` is fixed
    at `'mirror'` for BOTH modes — so naming one option after mirroring implied the other wasn't,
    while the row directly below is **Front & back → Mirrored**, where the word is literally
    true. Two adjacent rows using "mirrored" for different things, and non-distinguishingly in
    one of them, is the same false-label class the Back panel copy was rewritten to remove. The
    word now belongs to that row alone.
    Measured so the labels can be trusted: element **counts are identical** between the modes
    (31/14/28 geometry shapes, 255 stars, three designs) and every shape scales by one constant
    **0.4196** = `elementSizeScale(leg) / elementSizeScale(sheet)` = 1825.4/4350. Oversized is
    the same composition zoomed until few shapes fit a leg — not a busier or different one. Which
    is also the answer to "why does Detailed have more stuff": it has *smaller* stuff.
    Verified with real renders (routing: 1 shared render with the seam flip off, 2 with it on,
    geometry on in every one) and headless at 1280px and 390px on both products, no console
    errors, with every other product's routing byte-identical. **Untouched by all of this:
    `render/scale.js`'s aspect clamp and its `frame` parameter** — Aaron asked directly whether
    the same-day scaling fix had been reverted; it hadn't, and the RMSE 0.46 match against a
    v8-clamped, one-leg-scaled print file is itself the proof.
    **Still open: the other 13 products keep Geometry placement and were not otherwise
    reworded** — Aaron's complaint was general, so this is a candidate for the same treatment.
  - **ProductPage's options collapsed into one "Print options" disclosure, 2026-07-25**
    (Aaron: the page felt cluttered — fairly, since two of the sections had landed that same
    day). Five refinement sections (inside artwork, geometry placement, geometry layout, side
    seams, stitch color) sat stacked open between the two things a customer must actually do,
    pick artwork and pick a size. They share a defining property — each has a sensible
    default, each is per-order rather than saved, and each invalidates the current mockup —
    which is what makes them one group rather than five. Deliberately ONE disclosure, not one
    accordion per section: five collapsed sections would be no less cluttered than five open
    ones, just with more clicks.
    **The collapsed summary line is load-bearing, not decoration** ("Geometry on all panels ·
    Continuous seams · White stitching"): because these settings invalidate the preview,
    hiding them bare would let someone change one, forget, and buy under settings they can no
    longer see. It also keeps geometry placement — the one option no other print-on-demand
    store offers — advertised while shut, which is the main cost of collapsing it.
    This also resolved a real numbering inconsistency: "1. Choose artwork" and "2. Size" had
    four unnumbered sections wedged between them. The numbers stay on the required steps
    only, since numbering a clearly-optional disclosure as "step 2" would imply a sequence
    that isn't one.
  - **Two designs on one reversible garment, 2026-07-25** (Aaron's idea, raised while the
    hat above was being added — both faces printing the same artwork wastes the format).
    `PRODUCT_MOCKUP_CONFIG`'s new `secondaryDesign` block (bucket hat only) declares which
    placements a second design covers; `ProductPage.jsx` renders an optional second artwork
    slot for it (same `ArtworkPickerModal`, now targeted via `pickerTarget`), and
    `renderAndUploadPrintFiles` takes `secondaryDesign`/`secondaryPlacements`.
    Three things worth knowing before touching it:
    (1) **The render cache key had to gain a design discriminator.** All four hat face
    placements share one printfile (410), and the key was
    `printfileId:includeGeometry:layout` — so the inside would have collided with the
    outside's entry and been served the outside's render. The `:b` suffix only ever appears
    when a genuinely different second design is in play, so every other product's keys are
    untouched (verified: render routing byte-identical across all 11 pre-existing products ×
    3 geometry layouts, before vs. after).
    (2) **A secondary equal to the primary is treated as no secondary** (`isSameDesign`, not
    `===` — ProductPage builds the two objects separately). Both faces then share one render
    rather than paying twice for identical output. Verified all three cases directly against
    the real hat printfile spec: none → 1 render, same-design → 1 render, two designs → 2
    renders with the inside placements correctly on the second.
    (3) **It is deliberately absent from the mockup path and its cache key.** The mockup
    only requests `cfg.placements`, which excludes both inside placements, so a second
    design cannot change any preview pixel — listing it as a dependency would throw away an
    accurate mockup and cost the customer another 30–90s Printful round trip for an
    identical photo. The audit copy rides in `order_items.design_data` as a nested
    `secondaryDesign` key (that column is write-only, so this needed no migration and leaves
    every other product's row shape byte-identical).
- **JPEG print files: evaluated 2026-07-28, DEFERRED — print files stay PNG.** Don't
  re-derive this; the measurement is done. Real render of design `b6942c8f` (seed
  `1vsx8atp`) at the t-shirt front printfile (3150×5550, 17.5Mpx) through render-service's
  own bundled pipeline: PNG 4.39MB, JPEG 100 3.43MB, **98 2.20MB**, 95 1.45MB, 90 0.88MB.
  **The decisive finding: `@napi-rs/canvas` subsamples chroma at EVERY jpeg quality,
  including 100** — proven with a colour-only pattern where luma RMSE stayed 0.48 while Cr
  RMSE sat at 21.77, *identical* at q100/q98/q90. The library exposes `chromaSubsampling`
  only on its AVIF config; the JPEG path takes quality alone, so 4:4:4 is not reachable
  without swapping encoders. Consequence: **quality 98 is the wrong dial** — full-image
  RMSE moves only 1.86 → 2.38 across q100 → q85, so 98 costs 50% more bytes than 95 for
  0.1 RMSE. If this is ever revisited, 95 is the pick, not 98. Two reasons it wasn't worth
  doing now: PNG is already small on this artwork (smooth gradients compress well), so the
  saving is ~2.2MB per file rather than the order of magnitude JPEG gives on photos; and
  the error lands entirely on hard colour edges at single-pixel scale, which 150 DPI DTG
  almost certainly won't resolve. **Blockers if resumed:** `label_outside` is deliberately
  transparent so it must stay PNG (any switch is per-placement, never global), and nobody
  has checked whether Printful re-encodes what we send — one draft order with a JPEG file
  would settle that. Comparison artifact (crops chosen by measurement, wipe view at 1:1):
  https://claude.ai/code/artifact/8408d969-c3f6-477b-aa02-efd8ce712e53
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
  deletes print files older than 24h and mockup sources older than `MOCKUP_MAX_AGE_DAYS`
  (14 days originally; shortened to **3** on 2026-07-21), ALWAYS keeping
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
    UK/EU VAT compliance ever becomes a real requirement). The 4 non-garment starter products (tote bag, crossbody bag, pillow, bucket hat) aren't
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
  - **Stored designs must be re-stamped with the current generator version before checkout
    (`withCurrentGeneratorVersion`, 2026-07-24).** Real live bug, found by audit: the
    artwork picker's Gallery tile and the Gallery's "Print this" hand-off passed a `designs`
    row's `data` through **verbatim** — stale `generatorVersion` included — while the mockup
    preview path (client-side `generateArtwork`) ignores that field entirely and renders with
    current code. So an older design previewed as a perfectly good mockup, then failed at Buy
    Now with render-service's 422 `generatorVersion mismatch`, *after* the customer sat
    through the 30–90s mockup round trip. At the time this was found, 13 of the 38 public
    gallery designs (every one saved before the v6→v7 bump) were mockup-able but unbuyable.
    Fixed by stamping the bundle's own `GENERATOR_VERSION` onto a stored row at the point of
    adoption (`ProductPage.jsx`'s `choices`), so the mockup, the print file, and
    `order_items.design_data` all agree. **This does not weaken the version check**: that
    check's real purpose is catching a render-service running older code than the browser
    bundle, so comparing client-code-version to service-code-version is exactly right —
    comparing a stored row's *age* never tested that at all. A genuinely stale service still
    fails loudly. Verified against the two real v6 rows: stamps to 7, preserves
    seed/colors/settings byte-for-byte, does not mutate the source row (it's React state).
    General rule: **any path that adopts a stored design back into the live render pipeline
    needs this** — see the `generatorVersion` clarification in the renderer section.

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

### Serving & HTTP caching (`public/.htaccess`), 2026-07-28
Cache policy is declared in the repo, not inherited from the host. Found from a real
symptom (Aaron's phone intermittently loading an older build): Hostinger served
`index.html` with **no `Cache-Control` at all**, and no explicit freshness means browsers
fall back to *heuristic* caching (RFC 9111 §4.2.2, commonly 10% of the age since
`Last-Modified`) — so the longer a deploy had been live, the longer a returning phone
served cached HTML without even revalidating. Since `index.html` is what names the hashed
bundles, stale HTML pins the entire app to an old version. iOS Safari is the worst offender;
desktop hid it because tabs get closed and refreshed.
Three mutually-exclusive rules: `.html` → `no-cache, must-revalidate` (the ETag makes the
check a ~4KB 304); `/assets/*` → one year `immutable` (content-hashed, can't go stale);
everything else from `public/` → `max-age=3600, must-revalidate`, since those filenames are
FIXED across deploys (`createjs.min.js`, `jscolor.js`, `manifest.json`, `og-image.jpg`,
`models/tshirt/*`) and the host's 7-day default meant a change took a week to reach a repeat
visitor. The rules live in TWO files — `public/.htaccess` for html and the fixed-name
files, `public/assets/.htaccess` for the hashed bundles. Notes for anyone touching this:
- **`env=` conditions do not work on Hostinger.** The first version singled out `/assets/`
  in the root file via a `RewriteRule ^assets/ - [E=HASHED_ASSET:1]` var read back as
  `Header ... env=HASHED_ASSET`. That is correct Apache, passes locally, and **LiteSpeed
  silently ignores it** — measured live: hashed bundles came back on the generic one-hour
  rule. Hence the directory-scoped second file. Don't reintroduce `env=` here.
- **`<FilesMatch>` beats a bare `Header` even from a shallower `.htaccess`.** Apache
  applies every `<Files>`/`<FilesMatch>` section, from *all* levels, after *all* main-scope
  directives — so the child file's rule is wrapped in `<FilesMatch ".">` purely to get into
  the same phase, where being deeper makes it win. Unwrapped it loses to the root's section
  (verified: bundles served at one hour). `<FilesMatch>` also matches BASENAME only, which
  is why path scoping has to come from the file's location.
- **`Header set`, not `Header always`, on both positive-lifetime rules.** `always` also
  writes onto error responses — verified it put a year of `immutable` on the 404 below,
  which for a content-hashed (therefore stable) URL breaks that chunk permanently for that
  browser.
- A **missing** file under `/assets/` returns a real 404 (it used to fall through to the SPA
  fallback and return `index.html` as `200 text/html` where the browser expected JS — a
  blank page or an opaque "failed to fetch dynamically imported module"). `ErrorDocument
  404 /404.html` then routes that through a `.html` file **specifically so it inherits the
  no-cache rule**: LiteSpeed's built-in 404 page carries a ~15-month-old `Last-Modified`
  and no `Cache-Control`, and 404 is heuristically cacheable (RFC 9110 §15.1), so a browser
  could cache it for weeks — on a URL that by design never changes name. `public/404.html`
  is deliberately self-contained (no bundle, no webfont): it renders precisely when the
  app's own JS failed to load. Humans essentially never see it; client routes 404 through
  React Router's `NotFoundPage` instead.
- Verified against real Apache 2.4 serving the actual `dist/` — all four categories, the
  304, the uncacheable 404, and no duplicate `Cache-Control` — then **re-verified live with
  `curl -I` against chromaforge.app**, which is what caught the `env=` failure. Local green
  is not sufficient evidence here; LiteSpeed is a different server.
- Related, in `deploy.yml`: rsync uses `--delete-after`, not plain `--delete` (which means
  `--delete-during` and prunes the previous build's chunks while the new ones are still
  transferring, breaking lazy route loads for anyone mid-session during a sync).
- Already-stale caches heal on their own the first time a browser revalidates; no way to
  reach back and invalidate them.

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

- **Every surface showing the current active artwork reveals on the SAME shared timing —
  site-wide, always.** Not an instant swap, not a privately-tuned duration. Several surfaces
  display the same design at once (hero, MiniGenerator, SiteFooter, MobileNav, ProductPage's
  design tile, GalleryPage's empty state, AboutBlob), so one revealing on its own schedule
  visibly desynchronises the page, and a surface that pops while its neighbours crossfade
  reads as a bug. Rules: trigger on `StudioContext.previewUrl`, **never** `currentDesign`
  (which changes the instant Generate is clicked — a small preview finishes in ~200ms while
  the studio's full render is still going, so keying off it reveals early and alone; this
  exact mistake was caught and rejected in both TshirtPreview and AboutBlob). DOM surfaces
  use `useCrossfadeImage`; don't hand-roll it. Timings come from `utils/motionTokens.js`
  (`DURATION_FAST` out, `DURATION_HOLD` blank beat, `DURATION_SLOW` in, `power2.inOut`).
  Canvas/WebGL surfaces can't use the hook, so they reproduce the beat from those same
  tokens and **crossfade instead of dipping out** — a persistent object vanishing for the
  hold beat reads as breakage (rejected in TshirtPreview, then again in AboutBlob) — offset
  by `DURATION_FAST + DURATION_HOLD` so they start and end exactly with the DOM surfaces.
  The hook's `instant: true` is a documented exception for surfaces hidden while the design
  changed (MobileNav), not a shortcut. TshirtPreview is the one legitimate variant: it sits
  beside the hero and syncs to DisplayCanvas's own `isLoading` via `waiting`.
  **This extends to a surface's COLOUR, not just its images (2026-08-11, Aaron's ask).** The
  mini-generator's panel carries a 2px hairline along its top edge — the `.cf-spectrum-line`
  treatment from under the wordmark, but built from the active design's own palette
  (`.mini-palette-edge`, `PaletteEdge` in MiniGenerator). Four things worth not re-deriving:
  (1) **The palette comes from `gradientBackgroundConfig.colors`, never `design.colors`**
  (`render/resolvedPalette.js`). The stored field is a design's *identity* and is EMPTY for
  every auto-palette design and a single entry for a monochrome one — reading it directly
  leaves the most common case with no colours at all.
  (2) **It rides `previewPalette` (new StudioContext state, set in the same `.then` as
  `previewUrl`), not `currentDesign`** — the same rule as above, for the same reason: the design
  changes on click, a full render before the image it belongs to.
  (3) **The recolour is a real crossfade of two stacked layers**, because a CSS gradient can't
  be transitioned between arbitrary stop lists. The incoming layer's tween is started from a
  **layout** effect on the hook's `incoming`, which is what puts it in the same frame as the
  image's own tween — a passive effect commits a render later and the two curves visibly
  separate (measured mid-fade: 0.747 against 0.837; after the fix they are identical at every
  sample, 0.026/0.511/0.974).
  (4) A `useCrossfadeImage` consumer gets this beat for free by watching `incoming`; anything
  else has to reproduce it from `motionTokens`.
- **An entrance animation must never be applied to a WRAPPER around a `backdrop-filter`
  surface** (2026-08-11, real bug, Aaron: the mini-generator's glass "doesn't show the artwork
  correctly behind it at first but then it settles"). Any ancestor with `opacity < 1` (or a
  transform/filter) becomes a **backdrop root**, and a backdrop-filter can only sample what is
  painted inside its own root — so a wrapper holding nothing behind the panel leaves the filter
  with an empty backdrop: the artwork shows through sharp and unblurred for the whole animation,
  then snaps to frosted when it ends. MobileNav put `fade-slide-up` on the padding div around
  MiniGenerator; it now passes the animation down via the widget's `style` prop. Verified in
  Chromium: an ancestor's opacity kills the blur, **the element's OWN opacity does not** — which
  is why moving the animation down one level is the entire fix, and why the floating variant can
  animate its own opacity freely. The footer was never affected (its wrapper doesn't animate).
- **Verify every styling/behavior change against a live baseline** — computed-style
  diffs, screenshots, and actual interaction tests (drag, click, toggle), not just "it
  builds." This caught several real bugs (clipped pointer indicators, dead-zone hit
  testing, a reorder-logic bug) that a build-only check would have missed.
- Prefer fixing root causes over hardcoded magic numbers — e.g. the close-button width
  fix uses `left`/`right` anchoring so it self-adjusts if the picker is resized, instead
  of a fixed pixel width that would drift out of sync.
- Don't migrate/touch code that isn't actually exercised yet (see Logo.jsx above) — you
  can't verify a change against a render that doesn't exist.
