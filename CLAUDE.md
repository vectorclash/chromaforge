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
- **A design STATES whether it has the geometry layer; `chance` is odds and is never stored
  (2026-08-26, Aaron: odds should never have been part of a design's DNA).** A finished design
  either has the layer or it does not — the coin was flipped once, at generate time — so
  `generateArtwork` persists **`settings.geometry.present: true|false`** and a stated presence
  overrides the draw entirely (the draw is still taken, so the shared sequence never moves).
  `chance` now means exactly one thing everywhere: a probability, live in the studio, never
  written to storage. Neither field has a second reading. The studio default is **0.7**
  (`STUDIO_DEFAULT_GEOMETRY_CHANCE`) and is free to move — it cannot reach anything already
  made. Eight things worth not re-deriving:
  (1) **A stored design contains no geometry DATA to point at** — a row is only
  `{ generatorVersion, seed, colors, settings }`, and `geometryConfig` (megabytes when
  resolved) is regenerated from the seed every render. So the fact has to be written down as a
  flag; there is nothing whose mere existence could carry it. An interim version encoded it as
  `chance: 1|0`, which renders identically on any bundle and made the first backfill deployable
  with no ordering — but a field named for odds holding a fact is the same improper structure
  wearing a hat, and it confused its own author on sight. Don't reintroduce it.
  (2) **`getGeometrySettings` whitelists keys instead of spreading, and that is load-bearing.**
  Its result becomes DisplayCanvas's slider state, which is the input to the NEXT generate — so
  a spread carried `present` out of a loaded design into the panel, and every Generate after it
  inherited that design's geometry instead of flipping its own coin. Caught in a real browser,
  invisible to the build, to `check-render-regression.mjs` and to any unit test of the render
  path. It also drops the stray legacy `frontOnly` key some old rows still carry.
  (3) **The probability is generation CONTEXT** — `config.geometryChance`, never persisted,
  ignored by `isSameDesign`. `getGenerationSettings(config)` carries it forward for
  "generate more like this" (the mini-generator's Generate, the localStorage prefs mirror):
  a design's DNA plus the user's odds, never the design's own presence.
  **`DisplayCanvas.buildConfig` stamps the live slider value over whatever generateArtwork
  returned**, because when REPRODUCING a stored design the chance that went in was that
  design's own resolved value, not the user's odds. Without the stamp it rode out through the
  prefs mirror and came back as a remembered preference of "always" — also caught in a browser.
  (4) **A legacy `chance` of exactly 1 or 0 IS read as a statement**, by `getGeometryPresence`.
  Those values could only ever have meant "has geometry" / "has none" (threshold 0, the draw
  always passes / threshold 1, never), so reading them as facts renders identically — but it
  makes every such row immune to an rng shift immediately, and it lets `isSameDesign` match a
  legacy row against its own regenerated form. Without that, the artwork picker's dedup
  (`ProductPage`'s `isSameDesign(currentDesign, design.data)`) would see them as two different
  designs and re-break the "one design showing as two" fix. Anything strictly between stays
  real odds and falls through to the coin, since nothing is recoverable from a probability.
  (5) **`LEGACY_GEOMETRY_CHANCE` (0.4) is a compatibility constant, not a tunable**: the
  meaning of an absent chance on a blob that states nothing. Changing it re-rolls the coin for
  every such blob. Share links carry only a row id (no embedded design), so the only blobs that
  could reach it are `order_items.design_data` audit copies, which are never rendered.
  (6) **The backfill has an ordering requirement the rest of this does not.**
  `scripts/backfill-geometry-presence.mjs` converts every row to `present` and REMOVES
  `chance` — so it must run only **after the new frontend is live**, or the deployed bundle
  falls back to the 0.4 coin and re-rolls those designs on the live gallery. Until it runs,
  rows keep `chance: 1|0`, which the new code reads correctly as a statement of fact. Dry run:
  86 rows to rewrite (83 with geometry, 3 without), each verified to generate an identical
  composition at three sizes. Idempotent and re-runnable; saves the previous `data` of every
  touched row to a gitignored rollback file.
  (7) **Deploy render-service BEFORE the frontend** — it ignores an unknown field, so a browser
  sending `present` (and no odds) against an old Fly bundle would re-flip the coin and print a
  garment the mockup never showed. Same hazard as `density`, `mirrorX`, `legSymmetry` and
  `hatWrap`. No `GENERATOR_VERSION` bump and no thumbnail backfill: composition is unchanged.
  (8) **`tunnelScene`'s `densityScale` reads `chance` as a probability**, which is now
  unambiguous — it is fed live slider state via `buildThreeDDesign`, and a stored design has no
  chance at all, so a future 3D replay falls back to the legacy value rather than reading a
  fact as odds.
  Verified: `check-render-regression.mjs` — 86 stored designs × 3 sizes, 0 changed, 0 geometry
  lost or gained. A stated presence survives 5 sizes including the shorts sheet and overrides
  any odds handed alongside it; legacy blobs (absent, and explicit `chance: 1`) still resolve
  exactly as before. **And the property this whole change exists for, measured:** simulating one
  extra `rng()` draw upstream of the geometry coin flips the layer on **22 of the 31** rows that
  originally stored odds, and on **0 of all 86** as they stand today — i.e. the 2026-08-02
  incident can no longer take a saved design's geometry away. Also verified at the seams the
  render check cannot see: a saved row compares equal to the design it came from (the Saved
  button / duplicate-row guard), a legacy row compares equal to its regenerated form (the
  picker's dedup), and `withCurrentGeneratorVersion` keeps the statement intact through
  checkout adoption.
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
- **`starsOnTop` — the star/geometry layer-order setting (2026-08-18, Aaron: geometric
  artworks rarely show the stars).** `settings.geometry.starsOnTop` (boolean, default false)
  swaps the star and geometry layers' compositing order in `renderArtwork`. Default order is
  background → radial field → stars → geometry → overlay; on, the middle pair swaps and the
  overlay still sits on top. Surfaced as a **Stars in front** toggle at the end of the studio's
  Geometry tab, deliberately with **no `settings-label-note`** (it carried "over the geometry
  layer" until it was measured): in this tab the note slot is a value readout — 40%, 3–12, 0%,
  100% — not prose the way the Video tab uses it, and the toggle already is the value. It was
  also the longest label in the panel and the only row to wrap where a comparable one doesn't,
  going to two lines at a 360px viewport (234px against a 300px scroller) while Video's longest
  note, "Speed Ramp ease in and out each loop", fits at 222px. Bare it is 116px and fits at
  every width down to 320px, where four other Geometry rows already wrap. The aria-label spells
  out the referent for screen readers.
  (**Fixed 2026-08-21**, having been found while measuring the above: at 320px the
  `settings-range` sliders overflowed this tab's scroller horizontally by 23px — the sliders,
  measured, not any label. They were `flex-shrink: 0` at a fixed 190px, leaving 50px of a
  240px field for a label whose longest word, "Coherence", measures 82.6px; the worst row
  overhung its own field by 32.6px. They now shrink against a 130px floor that binds on
  nothing in the panel today, with an 8px `gap` keeping a shrunk slider off its label.
  **Shrinking rather than stacking the rows, because panel HEIGHT is the scarce axis here** —
  the 2D Video tab already needs 584px against an iPhone's ~636px, so five sliders on their
  own lines would spend the constrained axis to fix the roomy one. Verified by dumping every
  element's geometry across 6 widths × all 3 tabs: **nothing moves at all at 390px and up**,
  scroll heights are identical everywhere, and only the Geometry tab at 360/320 changes.
  Aaron separately reported the thumb's shadow cut off on the right — a **different bug with
  a different cause**, also fixed. The thumb's drop shadow and its 1.15x hover scale overhang
  the input by ~9px, and every control in the panel sits flush against the scroller's content
  edge, so that ink had to paint into the scroller's own `padding-inline` — where it is at
  the mercy of whatever the engine clips at. **It is now reserved inside the CONTENT box
  instead** (`padding-right: 10px` on `.settings-field`), which is immune to that question:
  the shadow finishes ~1px short of where content ends, so nothing overhangs for any ancestor
  to cut. Costs every control 10px of width, uniformly — on the row, not the sliders alone,
  which would misalign them against the toggles and selects.
  **The 10px does not cost mobile anything, measured on real phone viewports** (320x568 /
  360x640 / 375x635 / 390x664 / 430x741, all three tabs): the panel still fits the viewport
  at every size, horizontal overflow is 0 everywhere, and sliders keep their full 190px on
  iPhone 15 and Pro Max. The only cost lands where slack already existed — the Video tab
  already scrolled on the three smallest phones (the panel caps at `100dvh - 32px` by
  design), and the hidden amount grows 7px at 320 and 360 from one extra wrapped label line.
  **Diagnosis, which took several wrong turns worth not repeating:**
  (1) It is **asymmetric — right side only** (Aaron: not cut on the left), and **immune to the
  scroller's padding**: raising it 10 → 16 → 26px changed nothing for him. Together those say
  the clip on the scrollbar side sits at the CONTENT edge while the left still clips at the
  padding edge, so padding was simply the wrong lever.
  (2) **None of it reproduces in Playwright's WebKit**, which clips correctly at the padding
  box and reports scrollbar width 0 — so a headless WebKit is not a stand-in for Safari here,
  and the only decisive evidence came from Aaron's own browser.
  (3) **The input does not clip its own thumb**: a thumb at max renders byte-identically to
  the same thumb mid-track, both engines. The clip was always an ancestor.
  (4) **A transform does not let the thumb escape an ancestor clip** — rest and 1.15x clip at
  the identical pixel. Hover looks whole for an unrelated reason: a 1.15x shadow is still
  strong where a resting one has faded to nothing (darkness 29 vs 11), so the same cut reads
  as a hard edge on one and is invisible on the other.
  (5) **Diffing "clip edge near" against "clip edge far" cannot see a clip both captures
  share**, which is why the first few measurements came back clean. The control that works is
  the same thumb mid-track, where nothing can clip it.
  (6) A real WebKit finding, true but NOT his bug: a classic (non-overlay) scrollbar is laid
  over the RIGHTMOST ~15px of the scroller's padding, making the real slack
  `padding − scrollbarWidth`. That is why the scroller's padding is no longer load-bearing
  and is back at its original 10px.)
  Kept opt-in because the default reads well while the figure is small — the
  complaint is specifically about large/high-coherence geometry, where `latticeCells()` is a
  near-complete fill of overlapping cells and buries the layer beneath it.
  Five things worth not re-deriving:
  (1) **It consumes zero `rng()` and changes no layer generation** — verified the whole config
  object is identical apart from the flag, across 4 seeds × 3 sizes incl. the 11250×4350 shorts
  sheet. So no `GENERATOR_VERSION` bump, and `check-render-regression.mjs` passes clean on all
  **70** stored designs × 3 sizes (0 changed, 0 geometry lost/gained).
  (2) **It lives under `settings.geometry` rather than a new `settings.layers` block**, which is
  the pragmatic call, not the conceptually pure one: `compactSettings` and `isSameSettings` both
  iterate `DEFAULT_GEOMETRY_SETTINGS`'s keys, so a key there is free while a second top-level
  block means generalising both. It only has meaning when geometry exists anyway.
  (3) **It IS part of a design's identity** — persisted, compared by `isSameDesign` — unlike
  `mirrorX`/`legSymmetry`/`geometryLayout`, which are per-order render context. Verified: it
  compacts away at the default, persists when set, is idempotent, and flips `isSameDesign`.
  (4) **Deploy render-service BEFORE the frontend.** It ignores an unknown setting and would
  render stars-behind while the mockup showed stars-in-front, and with no version bump there is
  no mismatch check to catch it — the same hazard as `density`, `mirrorX` and `legSymmetry`.
  (5) **`starBlendMode`'s premise weakens slightly when this is on, and that is known and
  accepted.** It picks `config.secondBlend` from the BACKGROUND gradient's mean luminance, on
  the assumption the backdrop the stars land on is that gradient; with the stars on top they
  composite against the geometry layer instead. It survives because `source-over` takes three of
  the four biased slots and is backdrop-agnostic — only the 10% unbiased tail and the
  `lighten`/`darken` slot reason about a backdrop no longer directly underneath.
  **Still open, and it is the other half of the same complaint:** `config.thirdBlend` (the
  geometry layer's own blend) is still a uniform pick from all eight `BLEND_MODES`, so a
  `multiply`/`darken` roll dims everything below it — exactly the failure `starBlendMode` was
  introduced to fix for the star layer and never applied to the layer sitting on top of it.
  Reordering stops the stars being COVERED; it does not stop them being dimmed.
  Verified behaviourally: output differs at every coherence (chaotic / mid lattice / full
  lattice) across 3 seeds × 3 sizes, and is **byte-identical** when the design has no geometry
  layer at all (9/9), which is the invariant that proves it moves nothing else.

- **Diffraction spikes: the large star is now DRAWN, not a scaled raster — `GENERATOR_VERSION
  = 11` (2026-08-20, Aaron: the large stars "lose their diffraction spikes quite a lot
  sometimes... it's odd because sometimes smaller ones will have them and larger ones will lose
  them").** `render/starSprite.js` draws the xl/large tiers' star as vector paths at each star's
  real pixel size — core, four tapering arms, a semi-transparent halo disc with a hairline rim
  stroke, and an outer glow to the arm tips, all measured off the original raster (core edge
  0.17 of the half-width, halo 0.34, glow 0.86, arms 0.89) so it reads as the same object.
  **FOUR causes were measured, and only the first is the sprite** — a fix aimed at any one alone
  leaves the complaint standing:
  (1) **The two tiers use structurally different sprites, and this is the whole asymmetry.**
  `star-sprite-small.png` (the 450-strong fine tier) is a SOLID four-point star — the points are
  the silhouette, so they survive any downscale. `star-sprite-large.png` was a glowing ball with
  a cross **4px wide in a 648px sheet (0.62%)** peaking at alpha **125/255 above its own halo**
  against a 255 core. So the cross could never carry more than ~half the star's tint-vs-backdrop
  contrast while the core carried all of it. That is exactly "small ones have them, large ones
  don't". The fine tier is untouched and still uses its PNG.
  (2) **A real mockup-vs-print divergence, previously unrecorded.** At the median drawn size of
  **58px** the arm covered a THIRD of a pixel, and the engines disagreed about how much survived:
  Chromium mipmaps and kept a weak line, `@napi-rs/canvas` (`imageSmoothingQuality` defaults to
  `'low'`) **erased it outright below ~140px**. Measured at 100px: **alpha 47 in the browser
  against 3 on Fly**. 70% of these stars are under 100px, so most of them carried a cross in the
  studio and none in the print file. `check-render-regression.mjs` runs napi-rs at BOTH ends and
  so could never have seen this — a cross-engine check is a different instrument.
  Now within **0.7–11.3%** across 40–500px, with a real arm in both.
  (3) **Backdrop luminance.** Spike contrast against the local backdrop ranged **0.1 → 88** over
  50 designs, tracking `|starTint − backdrop|`. Because the background is a gradient this varies
  WITHIN one design — seed `s8` shows the same cyan star blazing on dark magenta and invisible on
  yellow. Raising the arm's authored alpha helps here but does not remove it.
  (4) **The geometry layer draws on top.** Genuinely size-dependent: a 300px star is far more
  likely to be covered than a 50px one. This is the still-open `config.thirdBlend` half of the
  `starsOnTop` note above, and a second reason to do it.
  Things worth not re-deriving:
  - **The `-3d` sprite variants are a pure no-op here, don't try them.** Their alpha channels are
    **byte-identical** to the originals (0 differing pixels of 419,904, both pairs) and `StarField`
    composites through `destination-atop`, which reads only alpha. Verified end to end: 8/8
    identical PNG hashes across 4 seeds × 2 sizes. Only their RGB is inverted, which is what the
    three.js tunnel needs and this path discards.
  - **An SVG asset solves neither problem**, and this was checked rather than assumed: it
    rasterizes at its intrinsic size and scales like any other bitmap. A 4/648 hairline in an SVG
    measured alpha **31** at a 40px draw in Chromium — no better than the PNG. The fix is drawing
    at the star's own size with a floor on arm width (`spikeMinPx`, 1.25 device px, dimmed in
    proportion when it binds so an arm carries the same total light at every size), not a format
    change. `@napi-rs/canvas` does load SVG, so the option exists; it just buys nothing.
  - **Arms are `spikeW` 0.026 of the half-width, ~4x the raster's 0.0062** (Aaron: "we can make
    the spikes thicker to help matters at least"), chosen from a rendered size × width matrix.
  - Cost is **~5%** per render (131→138ms at 3840×2160, 592→603ms on the shorts sheet).
- **Star shape revisions + the small star is procedural too — `GENERATOR_VERSION = 12`
  (2026-08-20, after Aaron reviewed v11 live).** Four rounds of feedback, and three of them
  turned up something worth not re-deriving. Note the bump is for a DRAWING change only: it
  consumes no rng() and touches no config, so `check-render-regression.mjs` reports 74 designs
  unchanged with 0 star fields changed — which is correct but is **not** reassurance, since that
  check compares generated configs and is blind to this by construction. The bump exists to stop
  a browser on new code rendering mockups against a Fly machine on old code:
  (1) **"The new stars feel a bit more pixelated" was NOT resolution, and higher res is not a
  lever that exists.** The star is drawn as paths at the exact output size — there is no raster
  to enlarge. What changed is edge HARDNESS: the old sprite was a 648px sheet being *upscaled*,
  i.e. blurred, which hid its own antialiasing, while a filled arc lands full contrast inside
  one pixel. At 3x zoom both have identical 1px AA on the halo rim; only the new one had the
  contrast to make the steps read. It also matters that the studio renders at 3840x2160 and
  displays far smaller — a hard edge is high-frequency content that aliases on the downscale.
  Fixed with `featherR`/`featherMinPx` ramps on the core and halo rims. Measured, largest
  single-pixel alpha jump across the rim: **128→83 at 120px, 115→43 at 300px, 125→22 at
  600px**. The gain scales with size, matching the complaint being about the large stars; at
  60px the rim is inherently ~1px wide either way and is unchanged.
  (2) **The fat halo rim was a coupling bug, not a bad number.** The rim highlight was being
  widened by the same `feather` that softens the halo's OUTER edge, so asking for a soft edge
  necessarily produced a wide bright band — about 9px on a 300px star. `haloStrokeW` /
  `rimFeatherR` are now independent of `featherR`. Also added `haloOuterFalloff`: the halo
  drops to 55% of the disc alpha immediately past the rim, which is what the original raster
  does (disc 167, rim peak 203, then straight down to 74) and what makes a rim read as a lit
  edge rather than a gradient shoulder. Rebuild measures **rim peak 205 / disc 173**.
  (3) Arms: `spikeR` 0.89 → **1.335** (50% past the old sprite box — `spikeR > 1` is fine,
  nothing is frame-bounded any more, so `size` is the core-and-halo diameter and arms reach
  beyond it), `spikeW` **0.03**, and **constant width with only the opacity tapering**
  (`spikeHold`) — a diffraction spike is a streak that fades, not a wedge. Glow pulled back
  hard, `glowR` 0.88 → 0.62 and `glowAlpha` 0.42 → 0.20.
  (4) **The small four-point star is now generated too (`buildSmallStarSprite`), but BUILT ONCE
  AND BLITTED rather than drawn per-star.** That split is deliberate and measured, not an
  inconsistency: the large star needed per-star drawing because its hairline went sub-pixel and
  the engines disagreed about whether it survived at all; this shape is SOLID and has no such
  problem (cross-engine ink agrees to 0.4–1.6% from 12px up, and it never vanishes). Meanwhile
  the fine field runs to **103,375 specks**, where drawing each as a path with its own glow
  gradient measured **+290ms** against ~600ms for a whole shorts-sheet render. So the
  *authoring* is consistent and the blit is an implementation detail the count justifies.
  The soft edge is a real Gaussian via `ctx.filter`, which both engines support and agree on
  closely (54/28/11 vs 54/26/10 across a blurred edge).
  **Three traps in that one, all found by measuring:**
  - **`SMALL_SPRITE_PX` must be a FIXED CONSTANT, never derived from the canvas.** A 3px speck
    blitted from a 64px sprite carries 466 ink against 885 from a 512px one — a **47% swing**.
    Deriving it from render size would make a print's fine field brighter than its own mockup,
    the exact divergence class v11 existed to remove. The old PNG was safe from this only by
    accident, being a fixed 648. It is 256, which is also what the shape numbers were fitted
    against, so the two must move together.
  - **The generated sprite MUST be flattened before it is blitted from.** Left as built it
    still carries its recorded draw ops (gradient, blur, two paths) and *every* `drawImage`
    from it re-runs them: **297ms against 14ms** on a real 23,693-speck field, which showed up
    as a ~350ms whole-render regression. `ctx.putImageData(ctx.getImageData(...))` fixes it,
    is lossless (0 differing subpixels) and is portable, unlike `toBuffer()`. A bare
    `getImageData` does NOT work — reading without writing back left blits at 298ms, and
    reading the whole surface was worse at 639ms. After the fix the whole render is within
    1–2% of v11 at every size (137→140ms studio, 610→616ms shorts sheet).
  - **The shape was fitted to INK AT REAL SPECK SIZES, not to the raster's alpha profile.**
    Fitting the profile weights every radius equally and gave a sprite **43% dimmer at 3px**,
    which is the median speck size — total ink at small sizes is dominated by area, so outer
    radii matter far more. Refitting against ink over 3–24px landed at 3.4% mean error with 3px
    exact. Cross-engine ink at real sizes is **0.3–1.1%**, better than the PNG's own 27%/12.5%
    outliers at 5 and 8px. (The generated sprite differs 10.5% subpixel-wise between engines at
    256px, but that is edge antialiasing which averages out entirely on downscale — judge this
    at use size, never at sprite size.)
  **The whole star-sprite loading path is gone (same session).** `renderArtwork` and `StarField`
  no longer take an `images` argument, `StudioContext` and `DisplayCanvas` no longer build a
  createjs `LoadQueue`, and `queueReady` is removed from the context and its five consumers
  (`TshirtPreview`, `SiteFooter`, `MobileNav`, `GalleryModal`, `AboutBlob`). The render pipeline
  is now fully synchronous and asset-free, so a preview surface renders the instant a config
  exists instead of waiting on a PNG. `DisplayCanvas.init()` used to be the LoadQueue's
  `complete` callback and is now called directly from `componentDidMount` — safe because it only
  queries an already-mounted element, reads the URL and kicks off a build, and `buildImage` is
  token-guarded against overlap anyway. render-service's `loadStarImages`/`ASSETS_DIR` are gone
  and the Dockerfile no longer copies the PNGs.
  Three things this does NOT remove, deliberately:
  (1) **The two 2D PNGs stay in `src/assets/images/`** — `AboutBlob` (flares) and `AboutShirts`
  (via `aboutBackground.js` / `aboutShirtFill.js`) still import them directly for their own
  decorative layers. They are no longer used by the artwork pipeline at all. Migrating those two
  to `drawStarSprite`/`buildSmallStarSprite` is the remaining step if the assets are ever to go.
  (2) **The `-3d` variants stay** and are still the only sprites the three.js tunnel uses.
  (3) **createjs stays everywhere** — `index.html`'s script tag, `shim.js`, and the Dockerfile's
  `createjs.min.js` copy. `GeometricShape.js` uses EaselJS `Shape`/`Container`/`Stage`; only the
  `LoadQueue` usage was ever about star sprites.
  Verified: all four main routes render in headless Chromium with **zero console errors and zero
  failed requests**, and — the check that matters for the Dockerfile, since a local build runs
  inside the full checkout and cannot see a missing COPY (exactly how the `COPY
  src/components/Canvas` gap was found originally) — a **real `docker build`** of
  `render-service/Dockerfile` from the repo root, then the real server run inside that image:
  `/warmup` 204, a v11 render 200 with valid PNG bytes **byte-identical to the host run**
  (266806 / 76400 for the plain and pocket-crop `regions` paths), a v10 request correctly 422
  with the mismatch message, and no key correctly 401. Confirmed the image contains no
  `star-sprite*` files and no `/app/src` at all.
- **Large star tuning — `GENERATOR_VERSION = 13` (2026-08-22, Aaron's own values).** `glowR`
  0.62 -> 0.9, `glowAlpha` 0.2 -> 0.3, `spikeHold` 0.5 -> 0.2: the arms hold full opacity over
  only the first fifth of their length and fade across the rest, with a wider, slightly
  stronger glow taking back the presence that removes — a spike reads as a streak leaving the
  glow rather than as one of four bars. Drawing only, same class as v12, so
  `check-render-regression.mjs` reports all **81** stored designs unchanged and is blind to it
  by construction; the bump exists only to stop a browser on new code rendering mockups
  against a Fly machine on old code. Shipped through the full paused-store sequence, thumbnail
  backfill included (81 ok).
  **The values were set by Aaron directly, through a throwaway live tuner** (`star-tuner.html`
  + `star-tuner.js` at the repo root, deleted after use) — a Vite-served page importing the
  real `STAR_SHAPE`/`drawStarSprite` and mutating the exported object, showing the stars at
  their six real drawn sizes composited through `destination-atop` the way `StarField` does,
  over an adjustable backdrop, beside a wipe between two full `generateArtwork` renders of
  real stored designs with only the shape swapped. Worth rebuilding the same way if the star
  is ever revisited; two things it cost to get right the first time:
  (1) **The strip must lay the tint down FIRST and mask it with the stars** — stars first,
  tint over them fills the whole rect and hides the backdrop, which is the one thing the strip
  exists to show.
  (2) **Vite's inline-`<script type="module">` transform emitted a protocol-relative
  `//star-tuner.html?html-proxy&index=0.js`**, which Safari resolved as a HOSTNAME — the page
  silently did nothing, no sliders, blank canvases. An external `src` never goes through that
  path. Headless Chromium did not reproduce it; only Aaron's own browser showed it.

- **Fine star field: wider range and noise-clustered scale (same bump).** `smallStars`' ceiling
  goes `sizeScale/500` → `/300` (~4.3px → ~7.2px at the studio default) and scale now comes from a
  three-octave `render/valueNoise` field sampled at each speck's own position — the same
  clustering idea `animation3d/tunnelScene`'s `clusterDensity` uses for star PLACEMENT, applied
  here to size. The layer gains knots and voids instead of reading as uniform grain.
  Four things worth not re-deriving:
  (1) **It consumes EXACTLY the same three `rng()` draws per speck, in the same order, with the
  same value in the same role.** This loop runs up to **105,000** times off the SHARED sequence,
  so a single added or reordered draw would shift every downstream layer for every saved design.
  The size draw is taken first as before and simply HELD until x and y are known, so the field can
  be sampled at the speck's position — deferring arithmetic costs the sequence nothing.
  `valueNoise` consumes no randomness at all; only the per-design offset does, and it comes from
  `starRng`, drawn after every other `starRng` consumer so it shifts nothing above it.
  (2) **The field is sampled in NORMALISED (0..1) canvas coordinates, never pixels.** `x/width` is
  exactly the raw rng draw, so the field is identical at every render size — verified to
  **4e-16** across 5 sizes including print and square. Sampling in pixels would make the whole
  layer resolution-dependent, i.e. a print that disagrees with its mockup about which specks are
  large.
  (3) **Summed value noise is nothing like uniform, and ignoring that inverted the feature.**
  Measured over 40,000 samples this octave mix spans only **0.25–0.79**, middle 80% inside
  0.37–0.65. The first version fed it in raw and applied a skew on top, which collapsed the layer
  toward its floor and rendered it visibly SPARSER than the flat-random field it replaced.
  `FIELD_LO`/`FIELD_SPAN` are the measured 1st/99th percentiles and stretch it to 0..1, clipping
  ~1% at each end deliberately — those tails are the dense cores and the empty voids.
  (4) **`freqLarge` was solved, not eyeballed.** At 2.1 the largest octave fits barely twice
  across the canvas, so a whole DESIGN could sit in one lobe and the layer's brightness became a
  per-design lottery (median speck **1.89px to 4.42px** over 24 offsets). At **4.5** that holds to
  2.47–3.49 while the within-image spread is widest — field p10–p90 of **0.09–0.86**. `FINE_SKEW`
  1.4 then puts the median speck back where the flat-random field had it, so the layer gains a top
  end and structure without getting brighter or coarser.
  **Verified against all 74 stored designs × 3 sizes** (`check-render-regression.mjs --allow-stars`):
  74 composition unchanged, 0 changed, 0 geometry lost or gained, star field changed on 74.
  **Both follow-ups are required, same as v9 and v10**: redeploy render-service, and re-run
  `backfill-thumbnails.mjs` with NO `--generator-version` filter.
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
  **Mockups moved to v1 too, 2026-08-21 — nothing customer-facing depends on the beta any
  more.** They had stayed on v2 only because they worked there, and the code's stated reason
  for choosing it ("every v1 render came back Internal Server Error for our all-over-print
  products — v1's mockup generator predates AOP/cut-and-sew") was **re-tested and is no longer
  true**: all 15 products render on v1. Things worth not re-deriving:
  (1) **v1 is 1.4–3.9× faster, and far steadier.** Three repeats each, create→completed:
  t-shirt 6.6s vs 17.0s, zip hoodie 8.9s vs 32.9s, mesh shorts 4.6s vs 17.6s, pillow 6.7s vs
  9.0s. **v1 barely scales with placement count** (4→6 placements costs it 2.3s and cost v2
  16s) and varies ±0.09s where v2 swung 28.6–35.1s on the identical request.
  (2) **Mockup style ids are GONE, and with them a whole class of silent drift.** v2 needed a
  hand-maintained style pair per product and per VARIANT on the pillow and bandana, because
  Printful restricts styles to variants — exactly how every pillow size but 18″×18″ broke in
  2026-07. v1 picks its own camera angles. `check-printful-catalog.mjs`'s checks 5 and 6 were
  deleted for the good reason: the failure is now unrepresentable, not merely unchecked.
  (3) **Default output is four ON-MODEL views** (front, back, both three-quarters) at no extra
  time cost — 6.6s either way, measured. Aaron's call. `option_groups: ["Flat"]` reproduces v2's
  old flat lay near-exactly (**RMSE 2.72**, 0.29% of pixels differing by >25) if it's ever
  wanted back. The three-quarter views are the only ones that ever show a customer their
  **sleeve** artwork, which no flat style photographs.
  (4) **Shape differences that bite.** `position` is REQUIRED (400 "Position field is missing"
  without it) — built client-side by `buildMockupFiles` from printfile specs the browser already
  holds, so it costs no extra round trip. `product_options` must be a JSON **object**
  (`{stitch_color:"white"}`); v2's array of `{name,value}` 400s, and `options` is a different
  thing entirely (a variant filter — sending stitch_color there fails with "No variants to
  generate"). No `X-PF-Store-Id`. Polling is by `task_key`.
  (5) **The Edge Function normalizes the response** so the client never sees v1's
  `mockups[]`/`extra[]` split: one ordered list, **de-duplicated by URL** (on the zip hoodie all
  six placements collapse onto two photos), front first, with labels made unique because
  different photos can share a name (the shorts return two distinct "Front" images).
  (6) **Rate limits are identical AND SHARED** — 10/60s on create for both versions, verified by
  alternating v1 and v2 creates inside one window and watching a single counter go 7→6→5. So the
  migration buys no headroom, `GLOBAL_RATE_LIMIT = 10` stays correct, and a phased dual-run
  would compete with real customers.
  (7) **Not fixed by this:** the 2026-08-19 Storage-fetch hang (the file fetch is very likely
  shared infrastructure). **Newly possible because of it:** the mesh shorts' `back` panel and the
  track jacket's `details` strip, which v2 cannot express at all. **The shorts' back landed
  2026-08-29** (Aaron, on seeing the leg-wrap mockups: "it's odd that the shorts mockup on v1
  doesn't have a back shot now") — 693's `placements` is `['front', 'back']`, confirmed against a
  real v1 task first: two real photos come back, and the back is the mirrored render with the side
  seams meeting across it. Until then the shorts were the one product in the catalogue whose back
  panel a customer could buy without ever seeing. **The track jacket's `details` strip landed the same day**, once
  the catalogue-wide audit below turned it up as the only remaining gap: retested on v1, the task
  completes with all six placements, so the v2 restriction is simply gone. Note the previously
  recorded symptom was wrong in detail — it was inferred from the bomber (390) and described a
  blank *hem*; measured on 801 it is the **collar band**, 929 px of the front photo. Both follow-ups
  from the migration are now closed.
  **Deploying it was a BREAKING contract change in both directions**, and the way out is worth
  remembering: rather than land the function and the frontend in the same instant (impossible when
  the frontend ships via a GitHub Action), the function was taught to speak BOTH shapes for one
  deploy cycle — legacy `placements` converted server-side, and both responses carrying the
  normalized shape plus the old `data: [...]` envelope. **That shim was removed 2026-08-21 once
  the new bundle was live** and is gone from the function; the technique is the reusable part.
  **Five follow-ups landed the same day, all found by Aaron testing by hand or by the new checker:**
  (1) **The bucket hat submits all four faces now**, not just the two outside ones. v1 returns every
  camera angle a product has, so the four inside views came back as blank white hats — and the
  exclusion's original justification had expired, since v2's inside styles returned images
  byte-identical to the outside ones. `secondaryDesign` is threaded into the mockup, its cache key
  and the sync effect, so **picking a second artwork now changes the preview** (it previously
  changed no pixel). Nearly free: all four faces share printfile 410, so one design resolves to one
  cached render. With a single design the inside views are suppressed as duplicates — 4 thumbnails,
  not 8.
  (2) **`hideUnsubmittedViews`** drops views of placements we sent no artwork for, derived from the
  product's own placement list rather than hardcoded titles.
  (3) **The mockup cache key carries the variant COLOUR** (not its id — sizes are meant to share a
  photo). Both windbreaker colours share printfile ids, so they collided on one key and switching
  colour silently restored the previous photo. Worst there because that product's two "colours" ARE
  the stitching choice, so the control looked completely inert. Pre-existing, not migration-caused.
  (4) **View labels are collected first and named second**, with every name Printful uses reserved
  before any suffix is handed out. Counting occurrences collided with Printful's own numbered
  titles ("Front", "Front 2") and produced "Front 2 2" on all 14 windbreaker variants.
  (5) **The filmstrip is `components/ui/ScrollStrip.jsx`** — one row, a fade on whichever edge is
  actually hiding something, and a **draggable** scrollbar (4px visual inside a 26px grab zone).
  A non-interactive progress bar was prototyped and rejected because Aaron went to grab it: if it
  looks like a scrollbar it has to be one. `flex-wrap` was tried first and rejected too — 8 wraps
  to a tidy 4+4 at 360px, but 5 orphans one and 8 at 390px breaks a ragged 5+3.
  - **Mockups submit exactly what an ORDER submits — every placement, no curation (2026-08-29,
    Aaron: "all mockups should be sending all the same pieces that a final order sends").**
    `useMockup` and checkout now resolve the identical placement set through
    `mockupPlacementEntries`; `PRODUCT_MOCKUP_CONFIG`'s `placements` no longer has anything to do
    with what a preview asks for, and survives only as the geometry-checkbox list
    (`getGeometryPlacementOptions`'s fallback behind `geometryPlacementKeys`).
    **What the old curation was costing, all found the same day:** the mesh shorts' entire back
    panel; the track jacket's collar band (`details`, rendering blank white in every preview); and
    **every product's label placements** — including the shorts' `label_outside`, which is not a
    sewn-in tag but a **visible 3in patch on the front of the leg**. Customers were buying it
    unseen. Measured on a controlled pair (identical artwork, identical variant, labels the only
    difference): the front photo changes by **9,333 px**, the back by **0**. That asymmetry is the
    whole point — `label_inside` really is invisible, `label_outside` really is not, and no
    reasoning from the placement's NAME would have separated them.
    **Two beliefs that justified the curation had silently expired at the v1 migration and were
    only found by retesting — do not reinstate a filter on their authority.** The bandana (630)
    was recorded as hard-rejecting `label_inside` with a 400; on v1 it is accepted and returns two
    views. The track jacket (801) was recorded as failing the whole task when `details` is combined
    with the sleeves; on v1 it completes. Both were true, of v2, and both outlived the API they
    described. **There are currently no placements any product rejects.**
    Three things worth not re-deriving:
    (1) **Cost is a duplicate photo, not a wasted task.** A placement no camera angle shows collapses
    onto an existing view and the Edge Function's URL de-duplication removes it, so the filmstrip is
    unchanged. What it does cost is render work: labels take the cheap client-side
    `generateLabelMark` path, but `label_panel`, `hood_inner`, `facing` and `inside_pocket` are
    full-size printfiles and add a cached render each on the products that have them.
    (2) **A filter is still expressible, but it belongs in `mockupPlacementEntries` alone**, per
    product, with a reason and a retest date — never at a call site. A filter means a customer can
    buy a piece they were never shown, so it needs to be visible to `checkCoverage`.
    (2b) **`label_panel` is slightly visible — but do not oversell it, and NO product's mockup
    shows an actual label.** Measured on the zip hoodie (controlled pair, identical artwork and
    variant): submitting it changes a **40x38 px wedge at the throat, 0.15% of the frame**, from
    blank white to printed, and changes the back photo by **0**. That is real and worth having, and
    it is also small enough that you have to be told where to look — a first write-up of this
    described it as a triangle of lining showing through the open collar, which reads as something
    a customer would notice, and it isn't.
    **The naming is the trap here.** `label_panel` is not a label: it is the hood/neckline lining,
    a full-size print panel that happens to carry a label-ish name. The actual brand-mark
    placements are `label_inside` and `label_outside`, and of those only `label_outside` is ever
    photographable (the shorts' 3in leg patch). **A sewn-in neck tag has no camera angle on any
    product and never will**, so "why doesn't the mockup show the label?" has the answer "because
    it is inside the garment", not "because we don't submit it". Printful's ORDER view shows every
    label because it lists the FILES, one per placement; the mockup generator returns PHOTOS.
    The generalisable half stands: the two label-named placements on one product are opposite
    cases, and no reasoning from a placement's NAME predicts whether a camera can see it — only a
    controlled pair does. The same panel is on the hoodie (388) and sweatshirt (320), which now
    submit it too, but **neither has been measured** — inferred, not verified. This changes only
    the PREVIEW: `includesGeometry` still forces geometry off on `label_panel`, and the real order
    always printed it.
    (3) **`hideUnsubmittedViews` is now inert** (nothing is unsubmitted, so its hidden-word set is
    empty and it returns its input). Keep it: it is the safety net for exactly the case where a
    future exclusion does get added, and it is what stopped the bucket hat returning four blank
    white photos when its inside placements were unsubmitted.
    **It broke view NAMING, which is customer-facing, and the fix is in `printful-mockup`'s
    normalisation (mirrored in the checker).** Two faults, found by reading the checker's own view
    titles rather than by any assertion: `PLACEMENT_LABELS` had no entry for the three label keys,
    so the fallback put the raw string `label_inside` on a filmstrip tab; and naming is FIRST-WINS
    by URL, so on the track jacket a photo **of the jacket** came back named `label_outside`
    purely because that placement happened to be ordered first. Label placements are now pushed
    last (`LABEL_PLACEMENTS`), so when several placements share one photo the name comes from the
    panel the photo actually shows, and the three keys have real labels (Inside label / Outside
    label / Lining). `check-printful-mockups.mjs` now fails on any view whose name is a raw key
    from `available_placements` — keyed off the real key list, not a regex on "label", so a
    placement Printful adds later is caught the same way.
  - **A mockup asks for three style TIERS in ONE task — the garment FLAT, its PRODUCT DETAILS, and
    one ON-MODEL group — and shows them in that order** (`src/lib/printfulViewPolicy.js`; two tiers
    from 2026-08-29, the model tier added 2026-09-07 on Aaron's ask for on-model shots "after" the
    existing ones, without spending a second mockup call). Every product asks for the same three, so
    a filmstrip reads identically across the shop and nothing is derived from how a given product
    happens to be photographed. Each tier contributes AT MOST ONE group; the patterns inside a tier
    are a preference order, not a list to collect. `Default` is the non-apparel synonym for `Flat`
    (pillow, tote), and the model tier needs several patterns because no single name covers the
    catalogue: 14 of 18 publish `Men's`, the women's tee `Women's`, the pillow `Person`, the tote
    `Standing`.
    **The structural problem that kept this to two groups for a year is REAL and still true** — do
    not conclude from the tier existing that it went away. **Ask v1 for several groups in one task
    and each placement's photo comes back as an untyped `mockup_url` primary, with `option_group`
    present only on the `extra` entries**, so the most important photos — the front, the back —
    arrive saying nothing about what they show. Re-measured 2026-09-07, and the tempting lever does
    not work either: `["Flat","Product details","Men's"]` and `["Men's","Flat","Product details"]`
    give **byte-identical** assignment on the sweatshirt, so **request order does not decide which
    group owns a placement's primary** — Printful has its own fixed notion. Four ordering heuristics
    were tried against real responses and every one left some product jumping between flat lays and
    model shots; the worst, inferring "the group missing this angle", handed every primary to Product
    details and turned the track jacket's whole strip into detail shots. **Filenames are not a
    substitute and were checked**: the flat back and the on-model back are both
    `...-white-back-<hash>.jpg`.
    **WHAT UNLOCKED IT: `generator_mockup_id`, which is on every photo — primary and extra alike —
    and is STABLE across tasks.** So asking for ONE group at a time LEARNS exactly the classification
    a combined task refuses to state, and the learned table then places every photo in a combined
    task exactly, with no inference. Measured on the track jacket: `["Flat"]` returns 57206/57214,
    `["Men's"]` returns 57252/57260, and a task asking for both returns **those same four ids** as
    untyped primaries. Same on the sweatshirt (2291/2292/2295/2296 across three separate tasks).
    That table is `src/lib/printfulMockupStyleGroups.js`, built by
    `scripts/build-mockup-style-groups.mjs` (one task per product per group, ~50 in total, ~6 min).
    **It is NOT the v2 `/mockup-styles` ids** — a different numbering entirely, checked: 0 of 7 ids
    matched.
    Seven things worth not re-deriving:
    (1) **The alternative was a SECOND TASK per preview**, and it was rejected on throughput, not
    effort: Printful's create limit is 10/60s shared store-wide, so peak preview capacity would have
    permanently halved. This costs nothing per preview.
    (2) **"No group" has two opposite causes and `rankView` is the one place that separates them.**
    An id the table does not know is real drift — the strip holds a photo nobody can place, and last
    is where it goes. But a response that could not be classified AT ALL (an Edge Function older than
    the table, which returns no `generator_mockup_id` for anything, or a product the table does not
    cover and so is never asked for model shots) means what untyped meant before any of this existed:
    a placement's own primary, i.e. a FLAT, ranked first.
    **This was shipped wrong first and Aaron caught it live**: ranking the second case last put the
    track jacket's four detail shots ahead of its two flats ("the two flats are no longer first as
    they need to be"), because he was running a new frontend against the not-yet-deployed function.
    A product with no `MODEL_GROUPS_BY_PRODUCT` entry is separately never asked for a model group, so
    it keeps the two-group strip it had.
    (3) **The gate is `MODEL_GROUPS_BY_PRODUCT`, not "is this product in the table"**, because those
    are different facts. 16 of 18 products get the model tier; the bandana has no suitable group, and
    the pillow's `Person` covers only 3 of its 5 sizes.
    (3b) **STYLE IDS ARE PER-VARIANT ON A PRODUCT WITH `restricted_to_variants` STYLES, and learning
    one variant is then not enough.** Exactly two products restrict styles — the pillow (83) and the
    bandana (630), the same pair whose per-variant style ids broke under v2 — and one free catalog
    read (`/v2/catalog-products/{id}/mockup-styles`) says which. The builder walks every variant for
    those and only the first for the other sixteen, so the cost stays ~50 tasks rather than 129.
    Shipped wrong first and caught live: the bandana's M and S returned ids learned from L, the flat
    was therefore unclassifiable, and it sorted BEHIND the Printful-tagged close-up (Aaron: "the flat
    is now second which feels wrong. it's closeup then flat"). Two corollaries. **A group that does
    not cover EVERY variant is never requested at all** — v1 answers a task for an uncovered variant
    with a 400 and the customer gets no preview — which is what keeps the pillow's `Person` out.
    And **`--variants=1` cannot see this class of bug**: only a run covering the restricted products'
    other variants can, and the checker's unclassified-view assertion is what catches it there.
    (3c) **View names are derived PER VARIANT, never pooled across them.** The common-prefix trim
    strips the product slug, and on a restricted product that slug carries the SIZE — so pooling two
    variants' filenames leaves it in, and the filmstrip reads "L Front" and "14x14 Back".
    (3d) **The builder MERGES into the table on disk, it does not replace it.** Writing the whole map
    from a `--products=` run deleted the other sixteen products, and a 429 mid-run deleted a group's
    ids while still writing a file that looked complete. (Recovered by downloading the deployed Edge
    Function — `npx supabase functions download printful-mockup` — since the generated file is the
    only copy and it is not committed until it is committed.)
    (4) **The de-dup key moved from group+title to `generator_mockup_id`, and it had to.** The old
    key could not tell a flat back from an on-model back — same title, both untyped — so one of the
    two was silently dropped, which is precisely the photo the model tier exists to add. The id is
    per style-view, so its repeats across placements are genuinely the same photo (it still solves
    the original track-jacket case: one flat back and three detail shots arriving six times over).
    (5) **The label is a SUFFIX — "Front on model" — and that is load-bearing, not wording.**
    `viewRank` orders a strip by matching the START of a title, so "On model — Front" would rank as
    unrecognised and the model shots would come back in whatever order Printful chose.
    (6) **Deploy the Edge Function BEFORE the frontend — this is not advisory, it was hit.** The
    frontend decides `option_groups`, so a new frontend against an old `printful-mockup` requests
    model shots that come back untyped with no `generator_mockup_id` to classify them by, and they
    interleave with the flats. `rankView` (above) is what keeps that merely untidy rather than
    scrambled; it does not make the ordering right, only the flats first.
    `VIEW_POLICY_VERSION` (now 14) invalidates persisted previews but does nothing about a stale
    function. Same hazard shape as render-service's.
    (7) **A longer strip blew the product grid open, and the cause was a latent layout bug this
    change merely triggered.** ProductPage's gallery column is a grid item, so it defaulted to
    `min-width: auto` and refused to shrink below its min-content width — and the thumbnail rail is
    a flex row of fixed 64px items, so its min-content is the entire strip laid out flat. Past a
    certain count the column takes space from its neighbour, and because the hero is `aspect-square`
    it grows in BOTH directions. Measured on the real built page at 1680px: 8 thumbnails give a
    638px hero, 16 give **1144px with the purchase column crushed from 426px to 132px**, 24 give
    1720px (Aaron, live, on the bucket hat with two artworks: "the entire image container seems to
    break open and take over the entire page"). Fixed with `min-w-0` on that column, which is what
    lets the `overflow-x: auto` rail scroll as it was always meant to; verified stable at 0/8/16/24
    thumbnails, and verified to FAIL at 16 with the class removed. **Any scroller inside a grid or
    flex item needs this** — the strip only fitted before because there were never enough views.
    (8) **`MAX_VIEWS` went 6 → 8**, because the track jacket alone needs exactly 8 (2 flat + 4 detail
    + 2 model) and would otherwise have had its model shots trimmed by the very cap meant to keep the
    strip short. Not raised further: ProductPage preloads every thumbnail at full mockup size
    (~154KB) before the strip appears, so each extra view is paid for in wait, on a phone.
    **Measure a real task before reasoning about what a filmstrip contains.**
    `/v2/catalog-products/{id}/mockup-styles` says which styles EXIST; only a task says what comes
    back, and the two disagree. Three rounds of fixes shipped against the catalog before one real
    task overturned the premise. A throwaway sweep — one task per product, first variant, raw
    responses saved to a file — then let four candidate rules be tested in minutes; build that first.
    **Still load-bearing, with one change:** a placement may not NAME a view unless it is a
    camera-visible panel (`NON_VIEW_PLACEMENTS` — labels plus `pocket`, `details`, `inside_pocket`,
    `hood_inner`, `facing`), or a photo of the jacket comes back labelled "Pocket". It used to be
    dropped outright; now, if the style table can name it, it is KEPT and named from the table
    instead. Dropping it cost the sweatshirt and the joggers their Product details shot the moment
    the model tier landed — those photos had been riding in on a sleeve placement, the model shots
    took those placements, and the only remaining copy sat under a label placement.
    **Measured before/after on all 18 products** (old two-group policy and old normalisation against
    the new, both strips built through the real helpers, compared by `generator_mockup_id` because
    URLs are per-task): **no product loses a single photo**, and the leading flats hold their
    position everywhere. Eight strips do change, and every change is a gain or a correction: 274
    gains Inside Pocket, 458 gains Inside, 320/693/784 gain the Product details shot described above,
    744 gains both a fourth detail shot and its real flat BACK (which had never been in the strip —
    what sat in that slot was a detail shot named "Back"), and 801's mislabelled "Left" turns out to
    be a detail shot and moves into the detail group where it belongs.
    **A view is named from the STYLE TABLE, not from the placement key it arrived under
    (`MOCKUP_STYLE_VIEWS`, same session, Aaron's go-ahead), and `VIEW_NAME_FIXUPS` is GONE with its
    cause rather than patched.** A placement key is not a statement about what a photo shows: 801's
    `front` placement returns the garment's back, which is why a hand-written per-product name swap
    lived in the policy for a year — and measuring found the same fault silently affecting the
    joggers (784) and crossbody (744), where two different flats both arrived on a placement labelled
    "Front" and one was shown as "Front 2". The table's name comes off Printful's own FILENAME, which
    is honest in every case measured, including the ones where the placement is wrong. That is what
    makes it a fix and not a second guess — and it is only trustworthy because the mapping is learned
    per id and pinned in the repo, where `check-printful-mockups.mjs` can see it drift. Deriving a
    name from a filename AT RUNTIME was tried years earlier and made things worse; this is not that.
    Measured over all 18: **801, 784 and 744 now read `Front | Back`** where two of them read
    `Front | Front 2`, and the reversible bucket hat's views finally distinguish
    `Front Outside`/`Front Inside` instead of calling both faces "Front" (which also keeps
    `hideUnsubmittedViews` working, since it hides on the word "inside"). **Extras keep Printful's
    own title**, which is authoritative for them — unlike a primary, an extra states its own view.
    **The pillow (83) still returns fewer views on some sizes**, because Printful marks styles
    `restricted_to_variants` — the same hazard that broke every pillow size but 18x18 under v2, and
    the same one that costs it a model tier. That is theirs, not the policy's.
  **`scripts/check-printful-mockups.mjs` exists because of all of this** — it generates a real
  mockup for **every variant of every product (129 as of 2026-08-28)** and asserts the pipeline
  end to end. Run it
  after any `PRODUCT_MOCKUP_CONFIG` change; ~18 min, needs only `PRINTFUL_API_KEY`.
  **It is also the drift alarm for the style table** (added 2026-09-07): it fails on any view no
  style group could name, listing the `generator_mockup_id`s, and the fix is to re-run
  `build-mockup-style-groups.mjs --products=<id>` — never to loosen the check. Unclassified photos
  still render, they just sort last, so nothing about this is visible from the site.
  **`--variants=N` samples the first N variants per product.** Every run leaves a file in
  Printful's library permanently (no delete or list API), so a full 129-variant sweep is not
  casual. Use the sample when what changed is a property of the PRODUCT (a placement list, an
  option, wrap geometry); use the full run when it could differ per variant (a size- or
  colour-restricted mockup style, per-variant printfile ids, anything touching the cache key's
  colour discriminator).
  **It gained `checkCoverage` on 2026-08-29, and the reason is worth internalising: two full green
  runs sat on top of real gaps.** Every other assertion in that file reasons about the views that
  came back for the placements we SUBMITTED — and the submission list was itself the thing under
  test, so a view nobody thought to request was invisible by construction. Worse, `checkVariant`
  calls `hideUnsubmittedViews`, which correctly hid the shorts' back view, and then asserted only
  `views.length > 0`: **the check ran the code that hides the evidence and reported green on what
  survived.** `checkCoverage` now compares the ORDER's placement set against the MOCKUP's, both
  from the real exported helpers, and allows no difference. It costs no mockup quota and was
  verified to FAIL on the day's real gaps before being trusted.
  **The general lesson, which is not specific to mockups: a checker that derives its inputs from
  the config it is checking can only ever confirm that config is self-consistent.** Something has
  to compare it against the world — and if the two things being compared can both come from the
  same call, the comparison is a tautology that passes forever. That is why "what a mockup
  submits" is one exported function (`mockupPlacementEntries`) rather than an inline call at each
  site: the checker imports the same one the app runs. It found (4),
  which hand-testing had passed over. Two things about it: it imports the REAL helpers (which is
  why `resolvePlacementEntries`/`buildMockupFiles`/`hideUnsubmittedViews` moved to
  `src/lib/printfulPlacements.js` — `lib/printful.js` imports the Supabase client and so cannot run
  in plain Node), and it must MIRROR the Edge Function's response normalisation, which runs in Deno
  and cannot be imported — same discipline as `_shared/compactDesign.ts`.
  **Full pass, 2026-08-21, all green:** catalog drift 15/15, mockups **114/114 variants**, draft
  orders 15/15 with every placement `ok`. What none of it covers: our artwork render, the Supabase
  upload, the Edge Function's auth/rate-limit gates, and all browser UI.
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
**Export bitrate is DERIVED from the export's size and frame rate, not a flat constant
(2026-08-12, Aaron: 3D exports go blurry through the fast mid-cycle stretch).** It was
40Mbps for everything, which is the actual fault — a 3840x2160 60fps export got the same
budget as a 2160x2160 24fps one. Now `VIDEO_QUALITY_K * sqrt(width * height) * FPS`, capped
by `MAX_EXPORT_BYTES` (600MB).
- **The sqrt is measured, not assumed.** Encoding real 3D frames at the ramp's peak and
  decoding them back through WebCodecs, the same PSNR needed 40Mbps at 1080p24 and 80Mbps at
  4K24 — 4x the pixels for 2x the bitrate. So the target scales with the square root of area
  and linearly with frame rate. K is set so 4K24 lands near 120Mbps, at the knee of the
  curve (4K24 measured 29.5dB mean / 27.3dB worst at 40Mbps, 33.5/30.7 at 80, 35.7/34.0 at
  120, still climbing at 160). Real gain at 24fps, worst frame at the peak: **+6.2dB (16:9),
  +5.4 (9:16), +5.4 (1:1)**.
- **The cap exists because mp4-muxer holds the whole file in RAM** (`ArrayBufferTarget` +
  `fastStart: 'in-memory'`), so bitrate x duration IS the allocation — uncapped, 60s at 4K60
  would ask for ~2.2GB. It binds only on long and/or 60fps exports (60s 4K24 → 84Mbps; a
  default 10s 4K24 is 143MB and untouched). Raising quality further means solving the
  in-memory muxer first, not raising K.
- **Mobile deliberately keeps its flat 25Mbps** — phones already OOM-kill on this path (see
  `ANIM_LIMITS`) and the ask was desktop.
- **The profile was NOT changed, and the measurement is why.** `avc1.640C34` (Constrained
  High — High profile with `constraint_set5_flag`, i.e. CABAC and 8x8 transform but
  structurally no B-frames, so it would keep the Windows reordering fix) is reported
  supported, but encodes **byte-identically to Constrained Baseline** in headless Chromium:
  the software encoder (OpenH264) ignores the profile. So there is no evidence it would help,
  and the only place it could differ is the Windows hardware encoder this codebase already
  got burned by. `bitrateMode: 'quantizer'` — the textbook fix for constant quality — reports
  **unsupported** for H.264 there.
- **Caveat on the headless measurements: they are OpenH264, not what a real desktop uses.**
  It refuses to initialise at 3840x2160@60 at all, so nothing here measured 60fps.
  **Closed by a real export (Aaron, 2026-08-12): a 5s 3D 1:1 60fps clip on a real desktop
  encoder "looks perfect".** That is the highest per-frame budget the pickers can produce
  (2160x2160 at 60fps = 225Mbps) and it confirms the uncapped path at 60fps. The CAPPED path
  is still unexercised — the cap only binds at 60fps from 30s up, where the rate falls to
  168Mbps and then 84Mbps at 60s.
- **Slowing the render down would not help, asked and checked** (Aaron, same session). The
  export is already a fixed-timestep, non-realtime loop: every frame is fully rendered and
  its `VideoFrame` constructed in the same task before any `await`, and the loop already
  back-pressures on `encodeQueueSize`. The PSNR figures above compare the decoded output
  against the exact source frames, so the loss measured is entirely compression, not capture —
  a partial or torn frame would read as catastrophic PSNR, not 29dB. `latencyMode: 'quality'`
  is already the "take your time" knob and there is no other.

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

### Logo mark at the animation loop seam (2026-08-12)
A **Logo** toggle in the studio's Video settings tab: the design's own vectorclash mark flies
through the animation's loop seam. Playback/export state only — like Speed Ramp it sets no
`settingsDirty` and is never persisted, since the mark is derived from the seed.
- **Built admin-only, opened to everyone the same day.** It shipped behind a fourth **Admin**
  settings tab gated on `profiles.is_admin`; that tab is gone. Two reasons, and the first is
  the one that forced the question: **four tabs do not fit the strip.** Measured in real
  Quicksand 700 at the tab's own metrics (10px, 2px letter-spacing, `0 18px` padding), the four
  labels total **338.7px** against 310px of inner width at a 390px phone (280px at 360px) and
  336px on desktop — so it overflowed the rounded panel at every width, worst on mobile, and
  the active tab's underline painted outside the glass. Three tabs total 260.9px and fit
  everywhere. The strip has no `overflow`, so nothing clipped it. Second reason: the tab held
  exactly one control, and it is playback/export state exactly like Speed Ramp, which already
  lived in Video. It sits at the end of the SCENE group (not the export group) because both
  previews draw it — it is not something only the file gets.
  **If a control is ever added back to a fourth tab, the strip needs its metrics tightened
  first** (letter-spacing 2px → 1px and padding `0 18px` → `0 10px` under 480px brings four
  tabs to 251.7px, which fits at 360px with headroom).
- **The gate is gone entirely, including `logoMarkConfig()`'s re-check.** That check existed
  only because the toggle's state outlived a sign-out; with no gate there is nothing to leak.
  The mark is derived from the design's own seed and resolved palette — the same mark that
  design's printed tag carries — so it identifies the piece rather than watermarking it, which
  is the argument for giving it to everyone.
- **`profiles.is_admin` already existed in the live DB** with no local migration file and no
  reference anywhere in `src/`. Don't conclude from a repo grep that a column doesn't exist;
  this project applies schema via the Supabase MCP tooling, so `supabase/migrations/` is not a
  complete record. It is a **UI flag only** (`profiles` is world-readable) and anything
  privileged must check it server-side. `profiles.js`'s select list and `AuthContext`'s
  `isAdmin` are still wired but are **currently unconsumed** — deliberately kept for the next
  admin-only control; StudioPage no longer passes it to DisplayCanvas.
- **The motion is ONE continuous flight through the seam, not two animations.**
  `src/utils/logoIntro.js` owns a signed parameter `s`: −1 at the start of the return leg, 0
  at the seam (simultaneously the final frame and frame 1), +1 at the end of the exit leg.
  Scale (`2 ** (s * LOGO_OCTAVES)` — exponential, so velocity is continuous through the sign
  change, which a linear ramp would not be), opacity and stroke fraction are all functions of
  `s`. The loop therefore closes by construction: verified `max delta 0.00e+0` between frame 1
  and the final frame across four period/fps combinations, and the 3D seam frames render
  pixel-identical at t=0 and t=duration.
- **It takes the LINEAR clock and applies its own warp, with its own floor.** Every call site
  passes the pre-warp clock (2D preview publishes it from the ramp driver into a ref; the
  exporter and 3D preview already have it). `RAMP_FLOOR_LOGO` exists because at
  `RAMP_FLOOR_3D = 0.03` a mark warped by the mode's own floor would hang at its frame-1 pose
  for seconds of wall time. Currently 0.25 — the one value to tune by eye.
- **`generateLabelMark.js` gained `generateMarkLines()`, extracted from it, and the print
  path is byte-identical** (60/60 configs across six real label sizes × 5 designs × both ink
  modes). The video mark and the printed label mark are literally the same code against the
  same `${seed}-label` stream, so a design's animation carries the mark its tag would. No
  `LABEL_MARK_GENERATOR_VERSION` bump, no render-service redeploy (label marks are
  client-side), no thumbnail backfill.
- **The mark's accent needs the design's RESOLVED palette, and the caller has to supply it for
  3D (2026-08-12).** See the `LABEL_MARK_GENERATOR_VERSION` bullets in the merch-pipeline
  section for the shared half of this — `design.colors` is a stored identity, empty for every
  auto-palette design, so both the tag and this overlay were locked to `#d1ff1a`.
  `generateMarkLines` now resolves it itself, which covers 2D (a frame's config carries its own
  gradient stops). **3D is the one case it cannot derive**: `tunnelScene` invents its own
  palette for an auto-palette design, so `logoMarkConfig()` passes an explicit override from
  `resolveScenePalette` (`animation3d/scenePalette.js`, extracted from tunnelScene so the scene
  and the mark cannot drift). That helper **takes the rng rather than making one** — the scene
  passes its own `-3d` stream and an external caller passes a fresh `makeRng(`${seed}-3d`)`,
  landing on the identical palette without shifting anything downstream in the scene. It lives
  apart from `tunnelScene.js` only because that file statically imports three.js, which must
  stay in its own lazy chunk. `logoMarkConfig`'s memo key is now seed **+ palette**, since 3D
  applies palette edits live against an unchanged seed.
- **The 2D overlay canvas must leave the layer tree while the mark is absent — the LAYER is
  the cost, not the drawing (2026-08-13, Aaron: the framerate suffers a lot now).** A
  full-viewport `<canvas>` over the frame stack is composited every frame whether or not
  anything was ever painted into it. At `devicePixelRatio` 2 that empty 2880×1800 layer
  **doubled the preview's median frame time — 8.4ms → 16.6ms, 71fps → 62fps** against the same
  build with the toggle off. It is now forced to `display: none` between windows: median 8.9ms
  / 68fps with the mark still on, and the residual is the genuine paint during the windows.
  Three things worth not re-deriving:
  (1) **It was diagnosed by elimination, and the obvious suspects were wrong.** Forcing the
  element `display:none` (8.5ms) and separately shrinking it to 1×1 CSS px (8.4ms) each
  recovered the whole loss while the ticker kept running — so it is neither the `clearRect`,
  nor the ~24 strokes, nor `logoState`. Jank was also spread evenly across the cycle rather
  than clustering in the two windows, which is the tell that it isn't the painting.
  (2) **Measure the size AFTER making it visible.** `clientWidth` reads 0 while `display:none`,
  and it is read on the visibility transition rather than per frame because that read forces a
  synchronous layout.
  (3) **The mark is on screen far longer than the raw window suggests** — 39% of wall time at
  the default duration, measured, because `LOGO_WINDOW` is 0.5s of WARPED time at each end and
  the ramp is at its floor there. So this is worth doing even though it sounds like a 10% case.
  **3D needs none of this** and was measured unaffected: its mark is a plane inside the scene
  that already toggles `mesh.visible`, not an extra compositing layer.
- **2D is a flat overlay, 3D is a real plane in the tunnel** — Aaron's explicit call that the
  two modes may differ. 2D: a `<canvas>` sibling of the frame stack in `AnimationPreview`,
  painted by **its own** `gsap.ticker` (the speedRamp driver only exists when the ramp is on,
  so it can't be reused) which never touches the timeline. 3D: `tunnelScene`'s optional logo
  plane, `depthTest: false` + `renderOrder 999` + `fog: false` and deliberately NOT
  warp-shaded — the camera flies through a continuous bore, so anything depth-tested spends
  the window behind a ring.
- **The 3D plane's z is set RELATIVE TO THE CAMERA every frame** (`camZ + LOGO_SEAM_DISTANCE
  / scale`), which is the whole reason it needs no seam special case: `camZ` wraps modulo `L`
  but an offset from it has nothing to wrap, so no duplicate copies at ±L are needed.
  Measured across a real wrap: distance ahead runs 158 → 97 → 60 (seam) → 37 → 23 with the
  camera jumping 2340 → 0 underneath it. Visibility is gated on `logoState` being non-null,
  so it appears exactly **once per cycle even when the camera laps** (verified at a 20s
  duration, laps = 2, 1200 samples).
- **A scene with the mark off is pixel-identical to one built without the plane at all**, and
  a `logoMark` prop change rebuilds the 3D scene (cheap — 3D builds are instant, unlike the
  30s+ 2D frame build). `LOGO_SCREEN_FRACTION` is shared by the 2D preview and the 2D export
  so the file matches the preview it was approved from; 3D sizes its plane from that same
  fraction against the vertical FOV at the seam distance.
- Which seed is "this generation": 3D uses `threeDDesign`, a 2D animation uses its **first
  frame's** config (the same rule `backfill-thumbnails.mjs` already uses for an animation's
  identity), otherwise `mainConfig`. Memoized on the seed — `logoMarkConfig()` is called from
  `render()` and a fresh object would rebuild `AnimationPreview`'s whole GSAP timeline.
- **`renderLogoMark` fits the mark's VISUAL extent, not its path bounds** (Aaron, 2026-08-12:
  the ring was cut off on the 3D plane). `bounds` is where the path runs, and a stroke is
  centered on its path, so fitting bounds flush to the box leaves half a stroke hanging
  outside. Harmless on the 2D overlay (a huge canvas with nothing at its edge) but the 3D
  texture's edge IS the plane's edge. Padded by a full `RING_WEIGHT` on every side: half is
  the actual stroke, half is slack for antialiasing feather, which is what makes it hold at
  any texture resolution (verified 0 edge pixels across 100 draw fractions at 512/256/128).
  Costs 2.6% of the mark's size.
- **A completed ring uses `arc(…, 0, 2*PI)`, not a sweep whose endpoints differ by exactly
  `2*PI`.** Both are a full circle per spec and both work in browsers, but `@napi-rs/canvas`
  draws **nothing** for the second form — found while measuring the clipping above. Nothing
  renders this headlessly today (label marks and this both run client-side), so it is
  currently latent; it is written this way so correctness isn't a coincidence, same lesson as
  `GenerateLargeRadialField`'s alpha-as-a-string and the tinycolor objects in single-colour
  palettes.
- Inspection artifact (real-pipeline filmstrips, both modes, plus the measurements):
  https://claude.ai/code/artifact/8be1d244-58a8-4dbd-bb3c-68f1a4c50453

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
mirrors not 180° rotations), so every body/sleeve draw counter-flips via drawSlice's
flipY. The thin trim strips (6 of them — 2 hem, 2 cuff, 2 collar; see STRIP_ISLANDS) carry
the composition across their seam onto the garment's trim, rather than sampling arbitrary
rows of the unrelated full-bleed base layer as they originally did (user-caught as "the
little strips look off"). How they get their content is the whole subject of the
2026-09-04 bullet below — the panel reserves a slice for its trim rather than the trim
re-sampling the panel.
Cuff bands wind the same horizontal direction as their sleeve's UVs, so a cuff strip must
mirror exactly when its sleeve's own draw does — enforced by reading a strip's flip from
`BODY_FLIP`/`SLEEVE_FLIP` via its `island` index rather than a separately hardcoded bool,
after the two drifted apart once (see the sleeve-mirroring bullet below); note "left cuff"
in user reports means the WEARER's left, i.e. viewer-right.
**Sleeve mirroring reversed, and the hem/cuff/collar strips' sample WINDOW fixed to match
their panel's own crop — both 2026-09-04, Aaron: "the sleeves are both facing the same way,
but one should be flipped like the actual Printful shirt sleeves" / "the lower strip at the
bottom of the shirt is off a bit and you see the design repeat by a little bit".**
Sleeves: the 2026-07-17 fix (`flipX: i === 1` on the second `SLEEVE_ISLANDS` draw) assumed
both sleeves should read identically and "corrected" a mismatch it found on the bare model
into exactly that. It had the right diagnosis (the two sleeve UV islands wind oppositely)
and the wrong target — that mismatch is what a REAL Printful sleeve does. Checked against
reality rather than reasoned about: product 257's own checkout never mirrors either sleeve
file (`PRODUCT_MOCKUP_CONFIG[257].mirrorPlacements` lists only `'back'`), so
`sleeve_left`/`sleeve_right` get byte-identical uploads — yet a real v1 "Flat" mockup task
fed one directional test image (arrow + 4 distinct corner colors) to both placements comes
back with the two sleeves MIRRORED anyway (the source's top-right corner lands nearest the
collar on the viewer-right sleeve, top-left nearest the collar on the viewer-left sleeve —
a horizontal flip, not a rotation), because Printful's own construction mirrors the shared
file between the two sewn sleeve pieces, same as the back panel. The model's opposite UV
winding reproduces that mirror for free once both islands draw unflipped, so `SLEEVE_FLIP`
is now `[false, false]` — back to what identical draws did before the 2026-07-17 fix.
Strips: the cover-crop math was factored out (`coverSampleRect`) so a trim strip
samples from the SAME window its panel actually shows, instead of the full source image —
previously wrong on whichever axis a strip's family crops: a BODY panel's crop narrows the
WIDTH (destAspect ≈0.688 < srcAspect ≈0.778, so only the center ~88% of the source shows),
so a strip sampling the full width carried ~12% more content squeezed into the same
destination width than the panel directly above it, reading as the design jumping/
repeating at the seam; a SLEEVE panel's crop narrows the HEIGHT instead (destAspect ≈1.894
> srcAspect ≈1.667), so a strip's "bottom edge" sampled off the raw image's true bottom
row rather than the row the panel's own bottom actually shows — an unrelated chunk, not a
continuation. `island` (0/1) on each `STRIP_ISLANDS` entry says which panel a strip
continues from (identities per the same colored-strip harness, not derivable from atlas
x-position — the two cuffs and the two hems each sit at nearly the same x despite
continuing different panels), and both the crop window AND the flip are now derived from
that one index into `BODY_FLIP`/`SLEEVE_FLIP`/`BODY_ISLANDS`/`SLEEVE_ISLANDS` — no
strip-local flip bool left to drift out of sync with its panel's, which is exactly the
class of bug the cuff's hardcoded `flip: true` had already been silently carrying (it
matched the pre-fix `SLEEVE_FLIP`, unnoticed until this session touched it).
**That crop-window fix alone was NOT enough, and it took two more rounds to find the real
cause — both of the intermediate fixes looked convincing on their own evidence, so the
sequence is worth keeping.** Aaron, after round 1: "it doesn't appear that anything has
changed in the bottom strip... the artwork should be aligned as precisely as possible."
Round 2 diagnosed a vertical SCALE mismatch — the old flat `STRIP_BAND_FRAC` (6% of the
panel's crop height) squeezed into the strip's own tiny `dh` did compress ~1.9x harder than
the body panel renders at, and ~1.8x LESS on a cuff (opposite directions, so one flat
fraction could never suit both) — and derived the band from the panel's own rate instead. It
verified clean on a synthetic ruler pattern on the real mesh, which is the one test that
cannot see the actual bug: **a ruler is uniform along x, so it only ever exercises the
y-scale.** Round 3 tested a converging star with its apex at the seam and the trim showed the
star fanning back OUT and re-converging to a SECOND, smaller apex — the "repeat", intact.
**THE CAUSE, which no scale factor addresses: the panel was cover-fit to its own rect, so it
consumed the entire composition, and every fix then had to invent trim content by re-sampling
rows the panel had ALREADY drawn.** Shrinking that to a 3px sliver does kill the repeat, but
only by stretching one row flat — Aaron: "the design appearing to melt across it."
**THE ACTUAL FIX (Aaron's own framing: "just take the whole thing into account and slice and
place accordingly"): stop giving the panel the whole composition.** `compositionSplit`
cover-fits the composition to the COMBINED region — the panel's width by `panel.h + trim.h`
— and cuts it at the seam: the panel takes the first `panel.h / combined`, the trim takes the
remainder. The trim is then showing rows the panel never drew, at the panel's own scale and
horizontal registration, none of which needs forcing — all three fall out of both slices
coming from a single fit. Nothing is re-sampled so nothing can repeat; nothing is stretched
so nothing melts. Costs the panel ~2.5% of its height on the body and ~8% on a sleeve, which
is not a loss — it is the composition being mapped across the whole garment piece assembly
instead of the panel alone.
**What made this solvable was measuring the mesh instead of the atlas** (harness: load the
real `tshirt.glb`, and for every triangle take its 3D area, its UV area, and which island rect
its UV centroid lands in; then find vertex POSITIONS shared between two islands and read back
each island's UV there). That yielded, in one pass:
- **Texel density per island** — body 1774–1808, sleeves 1811–1813, hems 1765–1781, cuffs
  1754–1756 atlas px per world unit, i.e. uniform within ~3%. This is the fact that licenses
  using atlas heights as a stand-in for real-world heights in the split (using the densities
  explicitly moves the reserve by 2.4% OF ITSELF, i.e. 0.0006 of the composition — not worth
  a table in the code).
- **Which strip is sewn to which panel, and along which edge of each rect.** All four
  hem/cuff seams are straight, full-width lines sitting within ~2px of BOTH islands' rect
  edges — the precondition for a horizontal band of the composition to correspond to the
  trim at all. Notably the front panel's HEM seam is on its rect's TOP edge and its neckline
  on the BOTTOM, which is the same vertical inversion `flipY` already corrected, now
  measured rather than inferred.
- **The u-axis direction across each seam**, by fitting `u_strip = m·u_panel + c` over the
  shared vertices: m = +1.00, r² = 1.00 on both hems and both cuffs. So a mirrored panel
  needs an equally mirrored trim — confirming (not merely inheriting) the rule that a strip
  reads its flip from its panel's.
- Two corrections it forced: **the back collar was assigned to the FRONT panel**, and the two
  "interior facing" rects have **ZERO triangles mapped to them** — unused atlas space, now
  dropped (the base layer covers those pixels as it always did).
**The collars are deliberately left on the thin edge slice**, and this is a measured decision
rather than an omission: their seam is a CURVE (the neckline), it sits well inside the panel's
rect rather than on its edge, and it spans only a sub-range of the panel's width (front
collar: panel u 358.6–674.7 stretched across the collar's full 494). No horizontal band of the
composition corresponds to it, so the split cannot be applied; a 3px slice is small enough
that no 2D structure shows across it. They are also the one family whose seam sits on their
rect's TOP edge, so they draw without `flipY`.
**Verified on the real mesh at each round, never on the flat atlas** — a same-canvas "does the
pattern continue across this boundary" check answers a question the mesh never asks, because
a strip's atlas position (packed wherever it fit) has no relation to which panel edge it is
sewn against. Final state, on the converging star: wedge boundaries and the concentric rings
run continuously through the hem, no second apex, no kink. On the ruler: stripe period and
phase carry through the seam unbroken. Then re-confirmed against REAL generated designs by
forcing full geometry coherence via `localStorage['cf-studio:design']` and generating until
lattices landed on the hem — facets run straight through it. Harnesses not saved (one-off
diagnostics, same treatment as `star-tuner.html`); if the trim is touched again, rebuild
BOTH source patterns, because the ruler alone passed a version that was still visibly broken.
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
`.image-container` renders at `HERO_PARALLAX_SCALE` and drifts down across the hero's own
exit progress, capped at the `(scale - 1) / 2` of height the overscale hides. The listener
is on **window** — the document is the scroller site-wide as of 2026-08-11; it used to
attach to a `.overflow-y-auto` ancestor, which today would find nothing and silently attach
nothing. Transform only, so the alpha-only GSAP tweens on `.image-container` don't conflict;
skipped under prefers-reduced-motion.
**The cached geometry must be correctable, and one snapshot at mount is not enough**
(2026-08-11, real bug: the parallax sat at a wrong offset and only popped right on a later
scroll). `measure()` guarded on `rect.height` alone, and WebKit runs the mount mid-layout,
where the host already reports a partial height (534 of its eventual 900) while the artwork
layer inside it is still **0 tall** — so the guard passed, `maxTravel: 0` and a `heroTop`
measured against a mid-layout position were cached, the single rAF retry never fired, and
nothing but a window resize could ever correct it. Measured in Playwright's WebKit: inert
for the whole session, 40 of 48 readings stale; Chromium settles before the mount and shows
none of it, which is exactly why this reads as intermittent rather than broken. Fixed by
requiring BOTH boxes to have a real height and by re-measuring from a `ResizeObserver` on
each of them (its initial observation covers the normal case, later ones cover settling,
however many frames it takes) — every re-measure re-applies, so a correction lands
immediately instead of waiting for the user's next scroll. Verified 0/48 stale in both
engines, dev and production build, desktop and 390px. An ambient `.hero-dot-grid` layer (masked dot pattern, `components.css`) sits behind the
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

### A locked page lies about its scroll position — scroll-driven effects must sit it out
`useScrollLock` pins the body with `position: fixed` (the only thing that actually stops
iOS touch-scrolling), which makes the document report **scroll 0** and shifts every element's
rect by the saved offset. Anything scroll-driven believes it. Found 2026-08-11 from a real
report: opening and closing any homepage modal replayed the entire entrance cascade, because
`useScrollTriggerReveal`'s scrub triggers read the lock as "scrolled back to the top" and
rewound every item — measured, visible cards went opacity 1 → **0.004** the moment the modal
opened and eased back over ~600ms on close.
Both consumers now subscribe to the lock (`subscribeScrollLock`, exported from the hook that
owns the lie) rather than trying to detect it: the reveal triggers `disable(false, true)` /
`enable(false, …)`, and the hero parallax suppresses both its apply and its re-measure.
Three things worth not re-deriving:
- **Don't let `disable` revert.** Reverting snaps items back to their pre-tween values, which
  is the same pop by another route. Not resetting on `enable` either is what makes the resume
  silent: the trigger holds the value it held before, against a scroll position restored to
  exactly what it was, so there is nothing to animate.
- **A section that MOUNTED during a lock is the one case needing a refresh** (navigating from
  an open MobileNav) — its start/end were cached against a collapsed document.
- **Notify order is load-bearing**: on lock, before the body moves; on unlock, after the
  scroll is restored. Either way round, a listener resumes against the wrong number.

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

### A clean build is not evidence a page renders — `scripts/check-routes-smoke.mjs` (2026-09-05)

```
node scripts/check-routes-smoke.mjs        # builds, serves dist/, loads every route
```

Loads all ten routes of the **production** build in a real browser and fails on an uncaught
error, a console error, or the ErrorBoundary's own "Something went wrong" text. ~40s, needs only
`.env.local`. **Run it before pushing any component change**, alongside `npm run build`.

**It exists because a green build shipped a page that could not render at all** (Aaron: "I'm
getting the something went wrong error when viewing products... maybe we need to make sure
nothing is broken rather than just seeing a build go through without error"). A `useRef` was
added below ProductPage's `if (loading)` early return, so the loading render ran fewer hooks than
the loaded one — React error #310 on the second render of **every** product page, with zero build
output. That is the recurring shape here: route-level faults that only exist while a component
RUNS (a hook after an early return, a null deref during a loading phase, a renamed prop), all
visible within a second of loading the page and none of them visible to a bundler.
Four things worth not re-deriving:
(1) **The rule the bug broke, stated plainly: ProductPage has early returns at `if (loading)` /
`if (error)`, so EVERY hook must be declared above them.** The file is ~2300 lines and the busy-
scrim state sits a thousand lines below its own hooks, which is exactly how the two got separated.
(2) **It runs the production build, not the dev server**, because dev's StrictMode double-mounts
components — a second mount can paper over an ordering fault, and it invents warnings no visitor
sees.
(3) **Network failures are reported but never fail the run.** These routes call live Supabase and
Printful, so a flaky remote would otherwise make the check untrustworthy noise. Rendering
essentially nothing DOES fail, whatever the console says.
(4) **`IGNORED_CONSOLE` must stay tiny and exact.** Its only entry is Cloudflare Turnstile's
deliberately-invisible `font-size:0;color:transparent` log on /account — confirmed as theirs
(the page's only third-party hosts are `challenges.cloudflare.com` and `hagen.challenges.
cloudflare.com`) rather than assumed. A broad pattern here turns the whole check into a rubber
stamp, which is the one way it can be worse than useless.
**Verified to FAIL before being trusted**: with the hook put back below the early return it
reports all three product routes red with React #310 and the boundary text, and 10/10 clean with
it fixed.
It does NOT cover anything behind sign-in, and never generates a mockup or touches checkout.

### The mockup-wait narration retypes itself (`TerminalText`, 2026-08-16)
`components/ui/TerminalText.jsx` replaced a GSAP `TextPlugin` tween on ProductPage's two
narration lines (the mockup scrim and BuyNowModal's checkout wait). Aaron's report: going from
one line to two "pops into place". Two real causes, and the second is a bug the old comment
block in ProductPage described while getting its own conclusion wrong:
- **The wrap moved mid-tween.** TextPlugin typed the whole string in one flow, so the
  line-count change landed wherever the typing happened to cross the wrap boundary and snapped
  the loader above and the `Ns elapsed` counter below with it.
- **The orphan guard never survived the tween.** TextPlugin normalizes U+00A0 away while
  typing; the old code knew this and re-slammed the glued string in `onComplete`, which
  re-wrapped the line *after* the motion had settled — the visible pop, reintroduced by the fix
  for it.
Now: each cell runs old char -> `_` -> blank -> block -> new char, staggered so a ragged head
sweeps the line, as **two passes** (erase in the OLD string's grid, then print in the new one).
Five things worth not re-deriving:
1. **Monospace is load-bearing, not a style choice.** Every phase must occupy exactly the width
   of the character it replaces. In proportional type that needs a measured, locked cell per
   character — the frozen-line-box fragility that got the SplitText reveal removed. Callers must
   keep `font-mono` on the element.
2. **Two passes exist so the wrap can only change while the line is blank.** Verified: the wrap
   changes on a frame with **0 visible glyphs**, and the counter below holds Y=331 across all
   338 frames of a transition. A single-pass morph was built first and rejected from its own
   captured frames — it must index the old string into the NEW string's grid, which punctures
   the old text wherever the new string has a space and re-wraps it on frame 1, reading as
   garbled fragments rather than a line being cleared.
3. **The block is a CSS background, not a U+2588 glyph** — a real block char can fall out of the
   monospace stack into a fallback face with a different advance width, reflowing the line on
   every frame the head touches a cell. Same browsers-are-lenient class as
   `GenerateLargeRadialField`'s alpha-as-a-string.
4. **The head reads as a RUN of blocks (per-word), not a single block (per-character), and that
   is accepted** (Aaron, 2026-08-16, having compared it against the CLI animation it came from).
   It is not a separate design choice — run length is block-phase duration / head speed, and the
   sweep's total travel is fixed, so it falls out of string length: a 67-cell sentence advances
   one cell per 7.9ms with each block lit 65ms (~8 lit at once), while the same constants on a
   9-letter word give exactly one. Forcing per-character on sentence-length copy is bounded by
   the display, not taste — a block needs ~3 frames to register, so the sweep would run **~3.3s**
   per line change (4x today, worse at 30fps), and the fast alternative shows each block for one
   frame, i.e. a flicker. Don't "fix" this without redoing that arithmetic.
5. **The reserved height is responsive because the worst case is** (`min-h-12 sm:min-h-8`).
   Measured through the real component: the narration box is **292px** at a 390px viewport,
   where one `STATUS_TIMELINE` line needs three rows; from `sm` up it is capped at `max-w-xs`
   (320px) and two always suffice. Don't "simplify" it to one value.
6. **A counter is never animated; a SENTENCE always is** (settled 2026-09-05, Aaron: "can any
   text that changes be animated like the message field"). The `queued` line and both `Ns
   elapsed` readouts and BuyNowModal's `print file N of M` stay static, because `useMockup`
   ticks them roughly once a second and a ~1.1s sweep would never settle — the number the
   customer wants would spend its life as an underscore. The scrim's **phase label**
   (`STATUS_LABEL`, rendering → creating → polling) now retypes, since it is the other
   changing sentence in that column and having one line sweep while its neighbour hard-cut was
   the remaining inconsistency. It cost the label its proportional face — cells only hold their
   width in a monospace one — measured at **177.2px** for the longest label, fitting the scrim's
   available width at every viewport down to 320px.
7. **A change arriving mid-sweep is QUEUED, coalescing to the latest string** (same date).
   Interrupting has to rebuild the grid from the outgoing string, which snaps a half-erased line
   back to its full text for a frame — and the phase label, which can go creating → polling
   inside a second, is exactly what would do it. Verified in a real browser on a 300ms-apart
   burst: it settles on the last string, and both strings are shown whole. Cost is at most one
   extra sweep of lag; nothing in the app changes a narration string fast enough to queue more
   than one.
Frames + measurements: https://claude.ai/code/artifact/73cfce43-9e68-4131-86cf-84d29551ec6a

**The scrim freezes what it SAYS at completion, not just which mode it is in** (2026-09-05,
Aaron: the transition to the images "feels a bit odd"). `scrimModeRef` already froze the mode so
the loader would fade out intact under the arriving mockup — but every string inside it kept
reading live state that had already moved on, for the 300ms fade plus however long the hero
image preloads. At the instant `status` hits `completed`: `STATUS_LABEL` has no `completed` key
so the bold phase line went **blank**; `useMockup` resets `elapsedSeconds` to 0 the moment the
run stops being busy so the counter snapped **"17s elapsed" → "0s elapsed"**; and
`statusNarration(0)` resolves to the FIRST threshold, whose line is already in the picks map —
so the narration **rewound to "Initiating mockup sequence." and TerminalText started a full
~1.1s retype underneath the fade**. One `busyViewRef` snapshot (label, narration, elapsed,
queued) now freezes alongside the mode, so the scrim leaves exactly as it stood.

**`STATUS_TIMELINE`'s thresholds are tuned to the v1 mockup API and were retuned for it**
(2026-09-05): a typical run is **14–18s**, not the 30–90s the v2 beta took, so the original
0/6/14/22/32/45… spacing meant most customers saw three lines and the run ended mid-sentence
about transmitting files — the report never reached the part where it assembles a preview. Now
0/5/10/15/21/28 puts all six "the machine is working" beats inside ~30s, and the
composure-thinning lines start at **38s**, which is over twice the average where the old 60s was
merely average. Line CONTENT is unchanged; if the API's speed moves again, move the numbers.

### `user === null` is two different facts, and the UI used to assert the wrong one (2026-08-27)
Aaron caught the account icon showing the signed-out state and no avatar while he was signed in.
Not localhost weirdness — a real bug, and the mechanism generalises: **`user` starts null in
`AuthContext` and stays null until Supabase's first auth event, so it means "signed out" and
"not answered yet" at once.** Any surface rendering a signed-out state off `user` alone is
asserting a fact it does not have.
It is not merely a first-paint race. A returning visitor's access token has expired, so
supabase-js must make a **network round trip** to `/auth/v1/token` before it knows anything —
**measured at 779ms against live Supabase.** With the refresh stubbed at 700ms on a warm dev
server the header rendered `Sign in` for **204ms** before correcting to `Account`; the flash is
refresh latency minus paint latency, so it grows with a slower connection.
Fixed with `authResolved` on the context (set by the first `onAuthChange` callback), consumed by
the three surfaces that were guessing: `SiteHeader` and `MobileNav` withhold the word (opacity,
not unmount — and both labels are seven characters, so nothing moves), and `ProductPage` gets a
`pending` scrim mode that renders nothing plus a neutral disabled **Buy now** rather than
`Sign in to buy` — the worst of the three, since it told a signed-in customer to sign in on the
one control the page exists for.
Four things worth not re-deriving:
(1) **`onAuthChange` never calls back at all when Supabase is unconfigured** (it returns a no-op),
so `authResolved` is set directly in that branch — otherwise every consumer waits forever for an
answer that is not coming.
(2) **`authResolved` says nothing about the PROFILE.** `avatarUrl` needs a second round trip that
cannot even start until `user` exists, so the avatar circle stays a placeholder after the label
has already resolved. That is a neutral placeholder rather than a false claim, so it was left
alone — but it is why the original report was "no avatar AND logged out".
(3) **The genuinely signed-out path is untouched and was re-verified**: header `Sign in` at
opacity 1, `Sign in to buy`, and the mockup scrim's sign-in copy all still render.
(4) **A failed refresh is a DIFFERENT thing and was deliberately not touched.** Measured: a 400
from `/auth/v1/token` makes supabase-js clear the whole session from localStorage at 914ms — you
really are signed out then, and saying so is correct. Refresh tokens rotate, so the same session
restored in two places (two ports on localhost are two origins, with two separate stores) is the
ordinary way to reach it.
Verified with a harness that stubs the refresh at a fixed delay and samples the control every
frame: header goes `(withheld)` → `Account`, buy goes `Buy now [disabled]` → `Buy now`, and
neither ever asserts a signed-out state.

### Curated palettes replace the ADD 🌈 button (`render/palettePresets.js`, 2026-08-27)
The Color tab's second button is now a scrolling strip of named palette chips.
**`src/render/palettePresets.js` is the whole editable surface** — an array of
`{ name, colors }`; the old rainbow survives in it byte-identical as `Spectrum`. A dev-only
`validatePalettePresets` warns (never throws) on the four rules a preset has to hold: at most
six colours (the swatch panel's cap, mirrored in `studioPrefs`'s `MAX_COLORS` and the
`colors.length < 6` gate on ADD COLOR — all three move together), `#rrggbb` only (studioPrefs
accepts 3/4/8-digit forms and normalises none, so writing them one way is what makes storage
round-trip exact), unique names, and at least one colour. Nothing records which preset a design
came from, so the list can change freely without touching a stored design.
Seven things worth not re-deriving:
(1) **The strip was picked over a drill-in list, a popover and a stepper**, all mocked at the
panel's real metrics first (https://claude.ai/code/artifact/457f9060-5f54-4a8e-99ce-6ed559f06f5a).
The list and popover are free at rest and the stepper is smaller still, but picking a preset and
then nudging one stop is the actual use, and only the strip keeps that on one screen.
(2) **It costs +123px of Color tab height, measured**, at every viewport (292 → 415px of content
with six swatches). It fits with room to spare down to 360px; at **320×568 the tab scrolls for
the first time**, hiding 57px — reachable, and the Video tab already scrolls on the three
smallest phones by design. If that ever needs clawing back, the label row is 32px of it.
(3) **`ScrollStrip` gained an opt-in `dragToScroll`**, default off, so the ProductPage filmstrip
is untouched. Mouse only — touch already swipes the rail natively, and claiming that gesture
would take the vertical pan that scrolls the settings panel with it (verified: a vertical drag
over the strip scrolls the panel 0 → 57px and moves the rail 0px). A press becomes a drag past
8px, and a real drag swallows the release click in the **capture** phase, which is upstream of
both the chip's own handler and React's root-level bubble dispatch — otherwise every throw of
the strip would also apply whatever palette it started on (verified: drag scrolls 126px, palette
unchanged; a plain click still applies).
(4) **Overscroll was already handled** — the rail's `overscroll-behavior-x: none` is what stops a
swipe past either end chaining out and rubber-banding the page sideways. Verified on a real touch
overswipe: `window.scrollX` stays 0.
(5) **Chips are deliberately NOT `.button-small`.** `changeGradient` recolours every
`.button-small` border from a RANDOM stop of the live palette on each build, so a chip's border
would advertise a different palette than the swatches inside it. They carry their own neutral
border, lit by the accent only on the palette you are currently on. They also reset
`mix-blend-mode` (the panel's shared `lighten` washes the label out over the near-black chip
fill) and recolour rather than lift on hover, since a chip inside a horizontally clipped rail
cannot afford ink outside its own box.
(6) **Fresh colour ids on every apply**, continuing from `nextColorId` — the same lesson the
rainbow button already carried. Reused keys mean React keeps those `ColorField` instances and
their UNCONTROLLED jscolor inputs hold their old values, so only the non-colliding slots
actually change.
(7) **The active-chip highlight lags a jscolor edit by the 350ms debounce**, because
`onColorSwatchEdit` reads the inputs back into state there rather than on every input event.
Known and left alone: it settles on its own and only drives a highlight.
**CLEAR went full-width** (`button-medium`) now the strip has taken its partner. It stays a real
button rather than being demoted to a link: an empty palette is the auto-palette mode the
generator picks its own colours in, i.e. the counterpart to the strip beside it, not merely a
destructive action.
Verified live on the production build in Chromium and WebKit at 1280/390/360/320: palettes apply
and regenerate the artwork, `aria-pressed` tracks the live palette, zero console errors, zero
horizontal page overflow.

### A continuous control commits on release, never mid-drag (`components/ui/SettingsRange.jsx`, 2026-08-26)
Every studio setting answers a change by regenerating the current seed at full studio
resolution, so an in-progress adjustment must not reach that path. **A debounce alone does
not achieve this and never did** — the six geometry sliders were 350ms-debounced and still
fired mid-drag, because any pause longer than the window *while still dragging* schedules a
regenerate; aiming slowly at a value was therefore the case that thrashed hardest. Measured
against the previous commit: one slow drag across the coherence track (8 stops of 600ms) ran
**4 full regenerates before the pointer was ever released**; it is now **0 during, 1 after**.
- **The commit signal is the native `change` event, from a real DOM listener.** React's
  `onChange` on a range (and on a text input) is the `input` event, so there is no React prop
  for this. `SettingsRange` renders the input, reports every tick through `onDrag` and the
  release through `onCommit`. Same split, same reason, as `ColorField`'s jscolor swatch —
  which is where the pattern came from when the colour picker was fixed.
- **What waits is the expensive work, not the control's own feedback.** `onDrag` still runs,
  so the value readout and the `--range-fill` track follow the thumb (verified live: the
  readout reads 100% and the fill 44% mid-drag while zero regenerates have happened).
  `onGeometrySettingChange(patch, committed)` also CLEARS the pending timer on every
  uncommitted tick, so a regenerate queued by the previous release cannot land inside the
  next drag.
- **3D is deliberately still live**, matching `onColorSwatchEdit`'s existing split: its scenes
  rebuild instantly, and `regenerateCurrentSeed` doesn't run in animation mode at all.
- **Discrete controls commit by default** (`committed = true`), because a click has no
  mid-state — the Stars-in-front toggle, the Video tab's steppers, selects and toggles. Those
  were audited and none of them needed changing; the six range inputs are the only continuous
  controls in the app (`grep 'type="range"'` finds nothing outside DisplayCanvas).
Verified live on the production build: track click, keyboard arrow, the dual Points thumbs and
the toggle each still produce exactly one regenerate, 0 console errors at 390px.

### Studio settings are remembered in localStorage (`src/lib/studioPrefs.js`, 2026-08-22)
Two versioned keys: `cf-studio:design` (palette + geometry sliders) and `cf-studio:video`
(the Video tab -- 3D, frames, star frames, duration, speed ramp, logo, export ratio, fps,
music). **The SEED is deliberately not stored** -- a visit still opens on artwork nobody has
seen, it just arrives in the style the user last chose.
- **The design half is read and written in ONE place, StudioContext**, not in each control.
  It seeds `currentDesign`'s `useState` initialiser *synchronously*, so the session's first
  design is already in the user's settings -- no default-then-correct flash, and every
  surface deriving from `currentDesign` (hero, the three MiniGenerators, footer band, About
  blob, product mockups) agrees from frame one. One effect writes it back, because every path
  that can change a palette or slider -- Generate, the debounced slider regen, a colour edit,
  a share/gallery load, the mini-generator -- ends at `setCurrentDesign`. It skips unchanged
  values, which is what keeps a 60-frame 2D animation build from doing 60 writes
  (`buildConfig` runs once per frame and every frame shares the palette).
- **The Video tab has no such carrier** (it is playback/export state, never part of a
  design), so DisplayCanvas restores it in its constructor and mirrors it from
  `componentDidUpdate`, diffed against `DEFAULT_VIDEO_PREFS`'s own key list -- adding a field
  there is all it takes for it to be remembered.
- **Video prefs are re-clamped against the READING device's `ANIM_LIMIT`**, so a desktop's
  60 frames / 60s / 60fps lands inside a phone's caps rather than asking it to build
  something it cannot hold in memory. Star frames are re-capped at half the frame count.
- **Validation coerces nothing.** `JSON.parse` maps `null`, `''` and `[]` to a finite 0, so
  `Number(x)` would read a corrupt entry as "the minimum" instead of falling back to the
  default; the clamps require an actual number. Colours must match a strict hex form and are
  never normalised. Clamp ranges mirror the sliders exactly, so a restored value is always
  representable by the control that produced it.
- **Loading a share link or gallery design overwrites the stored palette/settings**, because
  that is already what the panel does live (`adoptDesignColors`/`adoptDesignSettings` exist
  so the next Generate matches what you are looking at). Consistent, but it does mean opening
  someone else's design replaces your remembered palette.
- **Reset is `RESET` beside `BACK`** in the settings panel's bottom rail (a fixed row OUTSIDE
  `.settings-scroll`, so it costs no scroller height -- the scarce axis), behind
  `ConfirmDialog`. Both are `.button-small` at 48.5%, the split the Color tab's CLEAR/ADD row
  already uses, so BACK stopped being full-width with no new width rule. Two things worth not
  re-deriving: `changeGradient`'s `gsap.set` recolours every `.button-small` border from a
  RANDOM palette stop, so `.button-danger` is excluded from that selector -- tinted like the
  rest it could land on the very stop its BACK sibling got; and its hover LABEL stays white
  rather than taking the border's pink, because `.controls-inner .row button` carries
  `mix-blend-mode: lighten` and pink-on-pink made the word vanish at exactly the moment the
  pointer was on it (caught in a real render). `resetStudioSettings` clears storage AND puts
  the live state back -- clearing alone only shows up on the next load -- then lets one
  `onColorsChanged` regenerate cover both halves; it handles leaving 3D with no 2D frames
  built the way `onThreeDToggle`'s off-branch does, and RESET is disabled mid-export.

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

### The studio canvas is the one active-artwork surface with no staleness guard of its own
Every OTHER surface showing the active design is protected against a late async result —
StudioContext's render effect has a `cancelled` flag, `useCrossfadeImage` an epoch counter,
`TshirtPreview` its own `cancelled`. So those can only ever agree with each other, and when
one surface disagrees with the rest **it is almost always the canvas**, whose display is
simply whatever `DisplayCanvas.setImage` last wrote to `.image-container`.

That path had no guard at all until 2026-08-16, when Aaron caught it live with a screenshot
(hero green, shirt/About/mini/footer/nav all blue) after suspecting it once before and
assuming he'd imagined it — which is what a coin-flip race looks like from the outside.
Three things worth not re-deriving:
- **Two full-size builds could genuinely coexist.** The three `MiniGenerator` instances on the
  homepage (floating, footer, mobile nav) each change the design while the hero is mid-build,
  and their own Generate lock ends when the **480px** preview lands — long before the hero's
  2160px+ render and quality-0.98 JPEG encode finish. Nothing promises two `canvas.toBlob()`
  calls resolve in the order they were made, so the older encode landing last left the canvas
  on a different design from everything else, permanently.
- **`canvas.toBlob` returning null is real**, not defensive programming — WebKit gives up at
  these canvas sizes under memory pressure. It used to throw at `URL.createObjectURL(null)`
  straight out of a detached callback: on its own that strands the loader, but *overlapping an
  earlier build that had already cleared `isLoading`* it looks like nothing is wrong at all —
  no loader, Generate live, canvas quietly holding a design everything else has left behind.
  Same browsers-are-lenient family as `GenerateLargeRadialField`'s alpha-as-a-string.
- **`onModeToggle`'s animation→image restore is the one place `mainConfig` is set without
  going through `buildConfig`**, so it is the one place that has to call `onDesignChange` by
  hand. It didn't, and `buildAnimationFrames` calls `buildConfig` once per frame — so leaving
  animation mode left `currentDesign` on the LAST ANIMATION FRAME while the canvas showed the
  restored still. A guaranteed desync, no race required.
Now: `buildImage` stamps each build with `++this.buildToken` and `setImage` re-checks it at
entry, after the decode, and inside the `DURATION_HOLD` delayed call (all three, because a
newer build can start anywhere in that span); `adoptInitialDesign` defers behind an in-flight
build instead of starting a parallel one, re-reading the newest design on each retry, the same
shape `regenerateCurrentSeed` already used for the sliders; and a null/undecodable blob fades
the previous artwork back in and re-enables the controls. **Keep both the token and the
deferral** — the token makes a race correct, the deferral makes it rare, and two simultaneous
full-size renders on a phone are exactly the memory pressure that produces the null blob.

`scripts/check-hero-build-race.mjs` forces the race deterministically (it holds `toBlob`
callbacks and picks the landing order) and is the thing to run after touching the build/paint
path. Verified to fail 4/11 checks on the pre-fix commit and pass on the fix. **Run it against
the production build** — dev StrictMode double-mounts DisplayCanvas, so two builds exist at
load for an unrelated reason and every count is meaningless.

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
  **PAUSE THE STORE FOR THE WHOLE DEPLOY WINDOW — a version bump has no safe deploy order**
  (established over two live bumps on 2026-08-20, v11 and v12). The "redeploy render-service"
  note above reads as though shipping Fly first is the safe direction. It is not: the check in
  `server.js` is a strict equality, so a new Fly against an old frontend fails every Buy Now
  with a 422, and an old Fly against a new frontend fails identically. Either ordering breaks
  live checkout for however long the gap lasts — and since the frontend ships via a GitHub
  Action, that gap is minutes, not seconds. The sequence that works:
  `npx supabase secrets set STORE_ENABLED=false` (instant, no redeploy) → verify it took by
  reading `storeEnabled` off `printful-catalog` on the live site, not by trusting the CLI →
  `flyctl deploy --config render-service/fly.toml` from the repo root → **`flyctl status` to
  confirm ALL machines took the release** (a split release fails roughly half of checkouts
  intermittently) → confirm the deployed version by reading it off the machine, e.g.
  `flyctl ssh console -C "node -e \"import('/app/render-service/generated/render-lib.js')...\""`
  (hit `/warmup` first — with scale-to-zero, `ssh console` fails with "no started VMs") →
  commit and push → **poll the live site until the new bundle actually serves**, not just until
  the Action goes green → `STORE_ENABLED=true` and verify again → then the thumbnail backfill.
  Gotcha when polling: the star/render code compiles into a SHARED chunk, not `index-*.js`, so
  a poll that greps only the entry bundle waits forever while looking like the deploy is slow.
  Crawl the entry chunk's imports and grep them all for a token from the new code.
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
- **`fulfilled` is a real order status, added 2026-08-17 — before it, the enum only described
  how an order could end BADLY.** `orders.status` was `pending | paid | submitted | failed |
  canceled`, and `listMyActiveOrders` selects `paid`/`submitted`, so **`submitted` was terminal
  in practice**: an order Printful produced and shipped sat in the account page's Active list
  forever reading "In production". Found from two real completed orders (`c15d1c8d` /
  `169226286`, `89c38987` / `168535177`). `printful-webhook` was NOT the gap it looked like —
  it exists to reconcile Printful's state back to ours, but only ever mapped
  `order_canceled`/`order_failed`, and its own header called shipment events a not-yet-built
  feature. Four things worth not re-deriving:
  (1) **No Printful webhook re-registration was needed, and this is the useful part.** The
  existing `order_updated` subscription already delivers status `fulfilled`; the webhook had
  already verified and recorded both events into `printful_status` (2026-07-30 and 2026-08-05)
  — it just had no enum value to act on, so they fell through its "genuinely ambiguous" branch.
  **The data was already sitting in the table**, which is what the backfill in
  `0016_orders_fulfilled_status.sql` reads (driven off `printful_status`, scoped to
  `status = 'submitted'` so it can't resurrect a later-canceled row). Printful publishes no
  `order_fulfilled` event type, so this arrives by STATUS VALUE only — same as `archived`,
  which is why `TERMINAL_EVENT_STATUS` stays failure-only.
  (2) **Terminal and terminal-BAD are now separate sets** (`FAILURE_STATUSES`). The update
  block wrote `failure_reason` unconditionally and fired `sendOrderFailureAlert` for any
  terminal transition — unguarded, a successful order would be stamped "Failed via Printful"
  and page a human about a delivery that went fine.
  (3) **Migration BEFORE the function deploy.** The reverse order makes the webhook write a
  value the check constraint rejects, so every `order_updated` on a shipping order 500s and
  Printful retries it indefinitely.
  (4) `printful-order-preview` filters `status=in.(paid,submitted)`, mirroring the active list
  exactly, so it stopped fetching previews for fulfilled orders on its own — **keep those two
  filters in sync.** Labelled **"Shipped"**, not "Delivered": Printful's `fulfilled` means the
  items left the facility, and no tracking/delivery signal exists anywhere in this app to back
  the stronger claim.
  **The rest of the gap closed the same day (`0017`), so the enum now answers everything
  Printful can report:** `on_hold` and `refunded`. The status set is
  `pending | paid | submitted | on_hold | fulfilled | refunded | failed | canceled`, with
  **Active = `paid`/`submitted`/`on_hold`** and **History = `fulfilled`/`refunded`/`failed`/
  `canceled`**. Six things worth not re-deriving:
  (1) **`on_hold` is ACTIVE, not history, and it is the only reversible thing Printful
  reports.** A held order really is still in flight — it just isn't progressing —
  and `order_remove_hold` returns it to `submitted`. It is the one active status carrying the
  accent treatment, so it doesn't read like normal production. Labelled "On hold" rather than
  `failed`'s "Needs attention", because a hold is usually Printful's to clear (address or
  payment check) and not something the customer can act on.
  (2) **Hold and refund are driven off the EVENT TYPE, not the status string** — Printful
  publishes no complete status enum anywhere findable (checked; their docs don't list it), so
  `order_put_hold`/`order_put_hold_approval`/`order_remove_hold`/`order_refunded` are
  unambiguous by type and need no guessing. Every key in `PRINTFUL_STATUS_STATUS` was instead
  taken from statuses **observed in this store's own `printful_status` column** — `archived`
  (11), `fulfilled` (2), `canceled` (1), `onhold` (1). `draft`/`pending`/`inprocess`/`partial`
  are deliberately unmapped: `submitted` already means "in production", and an unmapped status
  is safe by construction (it falls through to the mirror-only branch).
  (3) **A finished order stays finished.** `TERMINAL_STATUSES` blocks any transition out of
  `fulfilled`/`refunded`/`failed`/`canceled`, so a late, retried or out-of-order delivery can
  never resurrect a dead order into someone's Active list. **`refunded` is exempt as a
  target** — a fulfilled order can be returned and a canceled one can still be refunded, and
  money moving is the more authoritative fact.
  (4) **`sendOrderFailureAlert` now takes an `action`**, defaulting to the submission-failure
  advice it started as (so `stripe-webhook` is unchanged and did **not** need redeploying — the
  default string is byte-identical to the text it used to hardcode). `printful-webhook` passes
  a per-status line, because the right action genuinely differs: a hold is cleared in
  Printful's dashboard, a Printful-side refund may need a *separate* Stripe refund (their
  refund does not touch the customer's payment to us), a failure may just be resubmittable.
  Alerts fire for `failed`/`canceled`/`on_hold`/`refunded` — not `fulfilled` or a lifted hold.
  (5) **`failure_reason` is still written only for `failed`/`canceled`.** It is ops-only
  (nothing in the frontend renders it) and `printful_status` already records Printful's
  vocabulary precisely, so inventing text for a hold would just go stale when the hold lifts.
  (6) **`CheckoutSuccessPage`'s `RESOLVED_STATUSES` is deliberately NOT the terminal set** —
  the trap that nearly shipped. Only `failed` gets its own screen there; anything else that
  resolves falls through to "Order confirmed — your order is on its way to production", so
  adding `canceled`/`refunded` would render a dead order as a confirmed one. It holds
  `submitted`/`fulfilled`/`failed` only; the others keep the poll-then-timeout path, which is
  vague but never false.
- **Size guide on the product page** (2026-07-25): Printful publishes a per-product size
  guide (`GET /products/{id}/sizes`), surfaced via a "Size guide" link beside the size picker
  → `components/ui/SizeGuideModal.jsx`. Reached the codebase as the honest answer to "which
  size am I" after saved default sizes were built and reverted the same day — sizing differs
  per garment, which is exactly what a per-product table addresses and a remembered
  preference cannot (see IDEAS.md).
  Things worth knowing:
  - **The two table types are not interchangeable.** `measure_yourself` is BODY measurements
    (Chest/Waist/Hips) per size — self-explanatory, and the one that actually answers the
    question; present on 11 of 18 products. `product_measure` is the garment laid flat with
    measurements labelled **A, B, C…**, which are keyed to letters on Printful's diagram —
    **the numbers are meaningless without the image**, so the diagram renders inside the
    table's section rather than as decoration, with `image_description` (which explains each
    letter) beneath it. Body measurements are sorted first.
  - **Descriptions are third-party HTML and are rendered as TEXT**, never via
    `dangerouslySetInnerHTML` — this is markup from another company on a page that also takes
    payment. `htmlToText` strips tags and decodes entities; verified across all 18 products'
    real payloads (169 text fields, re-scanned 2026-08-28) that no tag or entity survives the
    strip — the only entities present are `&nbsp;`, `&quot;`, `&rsquo;` and `&Prime;`, all four
    already in the allowlist, and the only tags are `p`/`strong`/`span`/`br`.
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
  placements/technique/required options for all 18 configured products (every entry confirmed
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
    needs tuning, and only visually, from real mockups.
    **Solved 2026-08-22, then DELIBERATELY NOT ADOPTED — read this before "fixing" it.** Aaron
    asked for a recalibration because the pouch didn't line up; true registration is
    `{ x: -0.0668, y: 0.118, w: 1.1381, h: 1.1381 }`, it was measured and confirmed on real
    mockups, it shipped, and he rejected it on sight: **"the before looked better"**. The
    configured window stays the ~10% tighter one.
    **Why the correct answer looks worse, which is the part worth keeping:** perfect continuity
    makes the pouch VANISH. With the body's artwork running straight through it the panel stops
    reading as a design element at all, and the lower third of the garment reads busier because
    whatever wedges sit behind the pouch now intrude into it. The tighter window magnifies the
    pouch's content about a point near its top edge, so the pouch keeps its own focal colour and
    its own shape — accidental in origin, better looking in practice. That makes the shipped
    value a TASTE choice sitting on a solved measurement, not an unsolved approximation.
    **CLOSED — the obvious refinement was built, compared and rejected too.** Expressed as a
    transform of the registered window, the shipped value is a **~1.10x magnification** of the
    pouch's content anchored 0.59in above the pouch's centre; the centred versions (1.10x
    `{-0.0150, 0.1697, 1.0346}` and 1.20x `{0.0281, 0.2128, 0.9484}`) were generated as real
    Printful mockups across three designs and Aaron still preferred what was already there.
    So the pouch's magnification is a KNOB, registration is its zero point, and any future change
    here is a request for a different look rather than a correction.
    **Method note worth keeping, because it wasted a round trip:** a flat-lay preview was built to
    compare options without spending mockup tasks, and it was **circular** — it positioned the
    pouch on the body using the very 297px offset under test, so it showed the registered option
    as perfectly aligned by construction. Aaron caught it. The instrument that actually works is a
    real mockup carrying a coordinate-encoding grid, because Printful places the pouch from its
    own manufacturing geometry; a free draft order's preview (rendered from the real print files
    by a different renderer) is the independent second opinion if one is ever wanted.
    Four things worth not re-deriving from the solve:
    (1) **The front torso template dashes the pocket NOTCH on it** — the safe-print region's
    bottom boundary dips from the side strips up into a trapezoid, and that trapezoid is the
    pouch's footprint. Least-squares fitting its diagonals against the pocket piece's own cut
    edges gives slopes agreeing to 0.6%/1.4% and top-corner widths of 830.8 vs 839.5 template
    px, i.e. **the two templates are drawn at the same scale** and the mapping is a pure 297px
    translation.
    (2) **The file-to-file scale is then just the ratio of the two print areas** (3000/2636 =
    1.1381), because both placements cover-fit the SAME printfile (200) onto differently-sized
    pieces. **That shortcut is only valid for a shared printfile** — on the zip hoodie it
    predicts 1.263 where the truth is ~1.01, since 506 and 507 are different files already at a
    common 150 DPI, so 1:1 pixels really are 1:1 inches there.
    (3) **A window far outside the front file is not the overhang hazard** described above: over
    the pocket PIECE it samples front-file x 0.17–0.83, y 0.52–0.85, entirely in bounds. Only
    the non-fabric parts of the pocket canvas fall outside, and those are cut away.
    (4) **Printful caches fetched files BY URL**, so re-serving different bytes at a
    previously-used Storage path silently reuses their copy — it cost one wasted calibration
    task here (the front came back as the *previous* run's pattern). Content-hash calibration
    uploads, the way `uploadMockupSourceImage` already does.
    Verified on real mockups both ways: with a labelled grid (the registered pouch's bottom row
    reads 17 against the body's 18 immediately below it, consecutive, where the shipped window
    skips a whole row) and with real artwork (shape edges cross the pouch's diagonals unbroken).
    **The zip hoodie (717) was re-measured the same day and is CORRECT as configured** — a
    mockup carrying two different labelled grids (uppercase front, lowercase pocket) makes the
    mapping readable straight off the photo and gave w 1.008 / h 0.643 against its configured
    1 / 0.625, inside the reading error of a photo of curved fabric. Its front template dashes
    no notch, so that photo is the only instrument available for it.
    **Neither needs a render-service deploy**: `pocketCrop` lives in `src/lib`, and the regions
    ride to Fly in the request body.
    The hoodie (388) needed one
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
    from `cfg.placements` — the MOCKUP-visible set — and mesh shorts (693) carried
    `placements: ['front']` only because Printful published no "Flat Back" style for them under
    v2, not because there's no back panel. (That constraint is gone: 693 submits both placements
    since 2026-08-29, see the v1-migration note above. The lesson below is not — `placements` is
    still a preview-visibility list, and narrowing it again for any product would re-open exactly
    this hole.) So `back` had no checkbox, was therefore never in
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
    rule, same as `label_panel`. (That reasoning still holds for GEOMETRY. It did not hold for
    MOCKUPS, and the two were conflated until 2026-08-29 — `details` and `label_panel` are both
    partly visible and were rendering blank; every placement is submitted for a preview now, while
    geometry stays off on all of them.) Note the joggers (784) were **never** affected despite
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
    name; **and "interior" does not quite mean invisible — a 40x38 px wedge of it, 0.15% of the
    frame, shows at the zip hoodie's throat and was rendering blank white; see the measurement in
    the mockups-submit-everything bullet, and note it is far smaller than that sentence sounds**). **Coverage and sizes re-audited live 2026-07-30 against
    `mockup-generator/printfiles/{id}` for all 15 products — the earlier summary of these two
    was wrong in three ways, so trust this list, not a remembered rule:**
    `label_inside` is on **13 of 18** — absent on both t-shirts (257/261), the tote (274), the
    neck gaiter (420, which has no label placement of any kind) and
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
    **The accent comes from the design's RESOLVED palette, not `design.colors` —
    `LABEL_MARK_GENERATOR_VERSION = 6` (2026-08-12, Aaron: the shorts he ordered came back with
    the same yellow tag as the video mark).** `design.colors` is a design's stored IDENTITY: it
    is EMPTY for every auto-palette design and a single entry for a monochrome one. Reading it
    directly sent the most common case straight to `DEFAULT_BASE_COLOR` (`#ccff00`, Logo.jsx's
    own fallback), so every auto-palette design printed the identical `#d1ff1a` mark — measured
    against the live table, **45 of 55 stored designs**. The same bug reached the animation's
    logo overlay, which is how it was found. Four things worth not re-deriving:
    (1) **A compact design has no `gradientBackgroundConfig`, so `resolvedPalette` alone is not
    enough** — and compact is the shape the whole merch pipeline works in.
    `resolveDesignPalette` (resolvedPalette.js) regenerates the palette from the seed. Safe
    because the resolved palette is **independent of canvas size AND renderContext**: verified
    216/216 identical across 9 sizes (320² through the 11250×4350 shorts sheet) × 8 seeds ×
    auto/user/mono, and 45/45 across includeGeometry/mirrorX/legSymmetry/geometryLayout/
    sizeFrame. It probes at 320².
    (2) **It must NOT take `resolvedPalette`'s stored-`colors` fallback** — reasoned wrong first
    and caught by measuring. That shortcut fires on a MONOCHROME design's single colour, which
    would print the tag in the base colour while the video mark (which reads a full config, and
    so gets `expandMonochromePalette`'s expansion) used a companion — breaking the invariant that
    a design's tag and its animation mark are literally the same mark. Only a real resolved
    gradient is trusted; anything else regenerates. Verified after: tag == 2D video mark, 24/24.
    (3) **Consumes the same single `rng()` draw** — `randInt` takes one regardless of the array's
    length — so which chords survive and the greyscale ink on the ~80% that aren't accented are
    byte-identical to v5 (80/80 configs across 5 real label sizes × opaque/transparent × 8
    seeds). Real user-palette designs are **fully** byte-identical; only auto-palette and
    monochrome ones move.
    (4) **Reprints of existing designs get the new colour automatically, and that is correct.**
    The mark is derived, never stored — a design row is only `{ generatorVersion, seed, colors,
    settings }`. Content-hashed uploads mean a recoloured mark lands at a new URL, so Printful's
    cache can't serve the old one, and there is no reorder path reusing
    `orders.print_file_urls` (written once per checkout, read only by `stripe-webhook` for that
    same order and by `cleanup-storage`'s keep-list).
    **The accent is the MOST SATURATED palette stop, not a random one —
    `LABEL_MARK_GENERATOR_VERSION = 7` (2026-08-13, Aaron: animations kept showing marks whose
    lines were all grey).** The cause is specific and was NOT the obvious one: `legibleAccent`
    floors lightness with a **`max`**, so it can raise a dark colour but can never bring a light
    one down — `#eeeeee` → `#f6e5e5`, `#ffffff` → `#ffffff`. So a user palette holding a
    white/near-white/grey stop had a real chance of the uniform random pick landing there, and
    the resulting accent was indistinguishable from the light greys the unaccented chords
    already carry, making the whole mark read grey. Measured on a `['#ffffff','#cccccc','#1e88e5']`
    palette: **57 of 200 seeds** produced a grey-reading accent before, **0 of 200** after.
    Three things worth not re-deriving:
    (1) **The ~80/20 grey/accent split is NOT the cause and was deliberately left alone**
    (Aaron, explicitly: the grey-by-design lines were never the complaint). Measured over 300
    auto-palette seeds, a mark carries a mean of **4.6 accented chords out of 23.5**, and 10.7%
    land at ≤2 — that is Logo.jsx's own behaviour, faithfully mirrored, and it stays.
    (2) **Auto-palette designs could never hit this.** `randomPalette` emits saturation 55–90%
    and lightness 40–65%, so every stop is vivid — measured over 300 seeds, `legibleAccent`
    never once had to rescue a pick (mean picked saturation 0.72). It reaches only USER
    palettes, and **zero of the 56 stored designs contain a grey/near-white stop**, so nothing
    saved changes appearance for this reason; it was being hit on live studio palettes.
    (3) **The deterministic pick still burns its `rng()` draw, on purpose.** That stream also
    decides which chords survive and what grey each unaccented one carries, so dropping the now-
    unused draw would restructure every existing design's mark instead of only recolouring its
    accent. Verified: mark structure identical **3200/3200** and full label configs identical
    **9600/9600** (400 seeds × auto/mono/beige/vivid palettes × opaque+transparent × 6 real label
    sizes); the accent itself changes on 60.5%.
    HSL saturation is the measure, matching `legibleAccent`'s own floors so the two cannot
    disagree about what "dull" means. **Known and accepted:** an all-grey palette ties at
    saturation 0, takes the first stop, and `legibleAccent`'s saturation floor then turns a mid
    grey into a muted red (`#888888` → `#c65353`) rather than leaving it grey — Aaron's "if the
    user chose only grey then so be it" would argue for keeping it achromatic, but it is not
    worth changing print output for a palette nothing in the table has.
    **`label_outside` picks its ink from the artwork underneath — `LABEL_MARK_GENERATOR_VERSION = 8`
    (2026-08-29, Aaron: "it would have been good to use the light variant of the logo since the label
    area is so dark"). This SUPERSEDES the 2026-08-11 "keep it as-is" closure.** That closure was
    correct on its evidence: a contrast halo and a GLOBAL luminance flip were both built and rejected
    on looks ("that looks absolutely horrible"), and Aaron himself established the blocker — nothing
    in Printful's catalog data maps `label_outside` to a location on the front sheet, so there was no
    region to sample, and inferring one from CAD templates is the guessing that produced the
    pocket-crop seam defects. **Neither of those rejected mechanisms is what shipped**, and the
    blocker moved: the calibration-mockup technique built for the leg wrap reads the mapping straight
    off a real garment.
    **The argument that settled it is Aaron's, and it is the important one: `label_inside` ALREADY
    prints the light variant.** The inside tag is white ring + light greys on its own dark panel. So
    the light ink is not a new treatment being introduced — it is the mark already approved and
    already printing, applied where it is legible. The inconsistency was in what shipped: the same
    garment carried a white-ring mark inside and a black-ring one outside, the outside one inverted
    on an assumption (light artwork underneath) that measurement says is wrong most of the time —
    **four of six real saved designs measure 0.15-0.25 luminance where the shorts' label lands**, and
    across 5 products x 12 designs the light ink is the right call on **36 of 60**.
    Six things worth not re-deriving:
    (1) **`transparent` was welded to "dark ink", and that coupling WAS the bug.** One flag meant both
    "paint no background panel" and "invert the greys, darken the ring". `lightInk` separates them.
    (2) **The patch location is MEASURED per product, never derived** (`labelOutsideRegion`). A
    lettered grid on the front plus a marker on `label_outside` gives the cell; a second mockup
    drawing hollow 1x and 2x boxes at the prediction refines position AND size.
    (3) **The SIZE has to be measured too, which was not obvious.** The naive `labelPx / frontPx`
    ratio is right on the shorts and crossbody and **1.21x out on the track jacket**, because the
    front file is cover-fitted to its print area and so is not at 1:1 scale with it. On the bucket hat
    the height is ~1.8x out, since the crown's curvature maps the sheet non-linearly.
    (4) **What is sampled is the RENDERED SHEET, not the composition** — on the two-leg products and
    the hat the sheet is a wrap, so the artwork under a point of the sheet is not the composition at
    that point. `labelBackdrop.js` applies whatever wrap the product uses, at low resolution.
    (5) **Sampling is client-side in BOTH paths, and must stay that way.** The mockup and the print
    file have to reach the identical decision or the preview lies; at checkout the real render happens
    on Fly and the browser never sees its pixels, so a small local re-render is the only thing both
    paths can share. Verified: **60/60 agreement** between true-printfile and capped-mockup dims.
    (6) **A failed or absent sample keeps today's dark ink**, so every product without a visible
    outside label is untouched and a thrown error can never fail an upload.
    No render-service redeploy and no thumbnail backfill: label marks are client-side, and
    `generateArtwork` is not touched. Products affected: 693, 784, 801, 744, 654.
    **Automating the grid read was tried and thrown away** — with 216 cells the hue formula repeats,
    so pixels classify into the wrong cells (residuals of 4-6 CELLS). Read the labels by eye; the
    confirm mockup is what makes that rigorous.
    **The bucket hat's `label_inside` is transparent too — `labelInsideRegion` (2026-08-29, Aaron's
    call).** It is the ONLY product whose `label_inside` is a visible printed patch rather than a
    sewn tag: the hat is reversible, so the inside face is worn outward half the time, and the mark
    landed there as an opaque **300x300 dark panel plus a 150x300 accent block** — a third of the
    patch a solid colour block, in the middle of a panel someone chose to show. Both label files are
    **identical** (printfile 411, 450x300px, 3x2in, aspect 1.50), so the asymmetry was purely our own
    rendering choice, not Printful's. Setting `labelInsideRegion` makes it render like
    `label_outside`: transparent, over the artwork, ink chosen from what it is printed over.
    Three things worth not re-deriving:
    (1) **The two labels sample DIFFERENT artwork, and that is the whole reason the choice is its own
    function.** `label_outside` sits on the front face, `label_inside` on the inside face — and on
    this product those carry different designs whenever the customer picks a second one. Sampling the
    front for both would choose the inside mark's ink from artwork that is not underneath it, with no
    symptom but an occasionally illegible printed mark. `labelBackdropChoice` lives in
    `printfulPlacements.js` (Node-safe, unlike `lib/printful.js` with its Supabase import) and
    `scripts/check-label-backdrop.mjs` pins all eight cases — no key, no network, no canvas.
    (2) **The region is NOT independently calibrated.** It inherits the outside rect, on the grounds
    that both labels are 3x2in on the same printfile and both sit centrally on their face. Good
    enough to choose an ink; run `scripts/calibrate-label-outside.mjs`'s two-round grid process
    before trusting it for anything finer.
    (3) **Every other product is untouched** — a null `labelInsideRegion` keeps the opaque dark tag,
    which is correct for a label nobody sees, and the check asserts it.
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
  - **A new product with a `label_outside` placement needs a CALIBRATION too**
    (`scripts/calibrate-label-outside.mjs`, 2026-08-29). The mark chooses light or dark ink by
    sampling the artwork it will be printed over, and it can only do that if the config says where
    that patch is — `labelOutsideRegion` in PRODUCT_MOCKUP_CONFIG. Without one it silently keeps the
    dark ink unconditionally, which is the wrong choice on most artwork (all five calibrated products
    wanted light ink on a typical vivid design, luminance 0.08–0.27). Products with only
    `label_inside` need nothing: a sewn tag has no camera angle and paints its own dark panel.
    Two rounds, both needing a human to look at a photo:
    `--product N` prints a lettered grid on the front and a marker on the label, and you read which
    cell it lands in; `--product N --predict x,y` then draws hollow 1x and 2x boxes at that guess so
    the label can be measured against them. Repeat until only hairlines of the magenta box show.
    **The SIZE must be measured, not derived** — the obvious `labelPx / frontPx` ratio is right on the
    shorts and crossbody, **1.21x out on the track jacket** (its front file is cover-fitted to its
    print area, so it is not at 1:1 scale with it) and ~1.8x out in height on the bucket hat (the
    crown's curvature maps the sheet non-linearly). That is what the 2x box is for: the label can
    never fully occlude it, so offset and scale both come off one photo.
    **Reading the grid by eye is deliberate.** Classifying mockup pixels back to their source cell by
    colour was tried and thrown away: with a couple of hundred cells the hue formula repeats, so a
    least-squares fit returned residuals of 4–6 CELLS. Automating it needs machine-identifiable cells
    (a per-cell dot code), not a better classifier. And a preview built from our own numbers cannot
    test them — Printful places the label from its own manufacturing geometry, so the mockup is the
    only non-circular instrument, same lesson as the hoodie pocket.
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
  - **Beanie (458), neck gaiter (420) and wide-leg pants (604) added 2026-08-28 — starter set
    is now 18, which is what makes the shop grid six FULL rows of three on desktop.** Aaron
    asked for the beanie and for two more to keep the rows even; the other two were picked from
    the live AOP catalogue (133 products) against their real specs. Each was spec-verified the
    usual way — a real completed mockup for every variant, then a real draft order — and the
    ordering in `STARTER_PRODUCT_IDS` puts the pants beside the joggers and leaves row five as a
    natural beanie/bandana/gaiter trio. Five things worth not re-deriving:
    (1) **The obvious third pick was rejected on FULFILMENT REGION, and that is a check nothing
    in this repo performs.** All-Over Print Unisex Track Pants (618) is the natural partner to
    the track jacket (801), and its config would have been near-identical to 604's — but all 14
    of its variants are stocked `CN` only, where every one of the other 17 products is
    `EU/EU_LV/US`. Priced against real `POST /shipping/rates` calls it costs **$9.29 to GB and
    to EU against the $8.49 the `heavy` class charges** — a loss on every UK and EU order — with
    8–11 day transit where the joggers take 3–4. It also inverts the assumption the rate table
    is built on, that GB/EU are the CHEAP regions. There is no per-product rate override, and
    raising `heavy`'s GB/EU rate would have raised it for the hoodies and joggers too. 604 has
    rates **identical to the joggers' in all five regions**, so it drops into `heavy` with no
    table change at all. **Check `availability_status` before configuring any new product** —
    a CN-sourced item is not visible in placements, printfiles, or any mockup.
    (2) **604 is a third `twoLegCanvas` product and needed its own template measurement**, done
    the same way 693/784 were (flood-fill the transparent = fabric regions inside the declared
    print area). The method was validated against the shorts first and reproduces this file's own
    recorded numbers exactly — leg panels at x 0.156–0.457, and an
    `elementSizeScale(leg)/elementSizeScale(sheet)` of 0.4196. For 604 the FRONT sheet's leg
    pieces sit at 0.1767–0.4730 / 0.5270–0.8237 and the BACK's at 0.1377–0.4973 / 0.5030–0.8623,
    exact reflections about the sheet centre (own-flip IoU 0.987 front, 0.996 back), so the
    per-leg seam argument that brought the shorts and joggers into `mirrorPlacements` applies
    unchanged. `legPanel` is `{ 0.296, 0.924 }`, giving a ratio of 0.688 — beside the joggers'
    0.725 and well clear of the shorts' 0.4196, which is the expected ordering.
    (3) **Neither the beanie nor the gaiter can have its seam closed, and not for the tote's
    reason.** Both genuinely have a seam — each is a single panel sewn into a tube — but
    mirroring is a relationship between a front and a back render and these sheets are on their
    own. Closing them would need a horizontally tileable composition this generator cannot
    produce, the same dead end as the bucket hat's rejected "endless wrap".
    (4) **The beanie is NOT a second bucket hat.** Its template's print area is the full
    3000×3000 sheet with no cut-piece outlines dashed on it at all, so there is no piece geometry
    for `hatWrap` to be pointed at. It returns **nine** views — the same shape the bucket
    hat's blank-inside-faces bug had — and all nine were downloaded and looked at: four
    on-model, five
    product shots including a top-down, none blank, none redundant.
    (5) **None of the three needs `geometryPlacementKeys`.** Checked against each one's real
    `available_placements` rather than assumed: the beanie and gaiter print exactly one visible
    panel, and 604's geometry row is hidden anyway (every `twoLegCanvas` product's is) with its
    selection Set fully populated. The hazard the shorts hit — printed panels outnumbering
    previewable ones — is absent here.
    **Deploy note: `create-checkout-session` must be redeployed**, because `_shared/shipping.ts`
    gained the three weight classes and an unknown product id falls through to `"heavy"`. That is
    safe for 604 (it IS heavy) but would overcharge a beanie or gaiter buyer by $3.50 in the US.
    Nothing else needs deploying — no `GENERATOR_VERSION` bump, no new render field, so
    render-service is untouched, and `printful-catalog`/`printful-mockup` read the config from
    the browser bundle rather than holding a copy.
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
    `mirrorPlacements: ['back']`; it is now 14 of 18** — the mesh shorts and joggers were added
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
    the catalogue, with the wide-leg pants (604) joining on 2026-08-28 — 14 of 18, the four left
    out being the tote (274), bandana (630), beanie (458) and neck gaiter (420), none of which
    has a `back` placement at all. Their
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
    `legArtwork` state with two options, **Detailed** / **Oversized**. (**A third option,
    `'front'` — "Across the front" — was added 2026-08-29 and is now the DEFAULT**; it is not
    another scale but the leg-wrap that closes the centre-front seam, and it sends neither
    `sizeFrame` nor `geometryLayout`. See the leg-wrap bullet below. Everything in this paragraph
    still describes the two flat modes, which stay selectable.)
    Geometry placement is hidden on these products only, so geometry renders on every panel
    there (which is what makes the `geometryPlacementKeys` fix above belt-and-braces rather than
    the only thing standing between a customer and a blank back). In the two flat modes
    `geometryLayout` is fixed at `'mirror'` and `legSymmetry` at `false`; only the size frame
    differs between them.
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
  - **The legs read as one piece across the front now — `src/render/legWrap.js`, the default on
    all three two-leg products (2026-08-29, Aaron: "have the full design across the front of the
    product as the default"). This SUPERSEDES the 2026-08-28 "parked as a signature look" note;
    what is kept below is the part that is still true, namely why the three earlier attempts
    failed and where the real wall is.** The two leg panels are cut with a wedge of fabric BETWEEN
    them that is thrown away — **19.1% of the sheet's width on the shorts, 14.3% on the pants,
    14.1% on the joggers**, measured on the front sheets — and the two edges either side of it are
    then sewn to each other at the centre-front rise, so a composition running straight across the
    sheet JUMPS exactly where the customer looks first. On the two columns actually stitched
    together, over 3 products x 5 real saved designs, mean per-channel difference **57–85 of 255**,
    about **4–6.5x** what the same artwork changes naturally over that span.
    **The fix is a pure translation, and the reason it is available is one measurement nobody had
    taken: the rise edge is essentially STRAIGHT over the part anyone sees.** It looks like a curve
    on the template, but only its last fifth hooks toward the crotch point, and that hook tucks
    under the body — over the visible run it holds to within 10px of 2967 on all three products. So
    one composition is rendered at the assembled front's own size and drawn onto the sheet twice,
    the left half slid right and the right half slid left, each by half the discarded wedge; the
    seam lands on the composition's own centre column and closes by construction. Nothing is
    stretched, sheared or resampled. Below the crotch the legs genuinely separate, there is no seam
    to close, and the composition simply carries on into air that never gets printed.
    **The cone constraint from the 2026-08-28 attempt is real and is NOT contradicted by this.**
    A trouser leg's circumference changes 2.20x down the shorts, 1.80x down the pants, 1.64x down
    the joggers, and no repeating flat pattern wraps a cone seamlessly. That wall applies to
    wrapping a WHOLE LEG all the way round. It says nothing about closing one seam at the front,
    which is all this does — and all Aaron ever asked for. Do not let the earlier note talk a
    future session out of this one.
    Why the three earlier attempts failed, kept because each is a live trap:
    (1) **`renderArtwork`'s `legSymmetry`** (reflect the sheet's left half onto its right) closes
    the seam but discards half the composition and makes a leg's back panel byte-identical to its
    front. Aaron: "it feels like half the design gets cut off." Both halves of that are literally
    true. It remains supported and remains off.
    (2) **Slices of a tileable composition mapped onto each panel's rectangular bounding box.** The
    real fabric edges are curves wandering 3–9% of the sheet, so the two edges meeting at a SIDE
    carried different parts of the design at most heights. Aaron: "now we have a different seem at
    the sides."
    (3) **A row-by-row warp onto the real panel outlines.** Seams closed everywhere and it looked
    *worse*: stretching each row independently shears the artwork, and drawing thousands of 1px
    rows at fractional x let the backdrop bleed through the panel edge. Aaron: "it's much worse now
    and there's some weird lines appearing." The lesson is that a per-row STRETCH is fatal; the
    per-half TRANSLATION that shipped is a different animal entirely.
    **The shipped `shift` deliberately OVERSHOOTS true registration, and that is Aaron's call from
    real mockups (2026-08-29) — do not "correct" it back.** Its geometric zero point is half the
    discarded wedge (0.09623 / 0.07133 / 0.07033 for 693 / 604 / 784); the shipped values are
    0.14161 / 0.10158 / 0.08804. The reason is measured, not aesthetic hand-waving: a numbered
    colour ruler put through this same map and printed on the real garment reads **...9 | 14 across
    the waist** at the zero point — 2–3 bands of 24 simply not visible, real fabric turning away
    from the camera at the centre front (seam allowance, the rise curving under the body, and the
    gathered elastic waist on the shorts). Overshooting hides that in a narrow strip that repeats
    down in the crotch, where nothing is visible, and buys a front that reads continuous from waist
    to crotch. **The two metrics genuinely disagree and each favours the value it is aligned with,
    so quote them in pairs.** On the flat FILE at the stitch columns: today 4.0/5.4/6.5x the noise
    floor, geometric 1.7/1.8/1.5x, shipped 4.6/4.7/3.8x. On the columns that actually end up
    adjacent IN VIEW: today 13.6/7.3/6.0x, geometric 4.1/5.6/4.8x, shipped **3.2/1.8/1.5x**. The
    shorts are the least converged of the three (3.2x as seen) because their overshoot is tuned to
    the waist and over-corrects lower down.
    **Rebuild the ruler mockup if this is ever retuned** — it is the only non-circular instrument,
    since Printful places the pieces from its own manufacturing geometry. `scripts/` has no copy;
    it was a throwaway (a 24-band hue ruler at the composition width, put through `drawLegWrap`,
    uploaded to the `design-mockups` bucket and submitted as a real v1 mockup task). A local
    preview positioned from these same numbers cannot test them — same circularity that wasted a
    round on the hoodie pouch.
    Eight things worth not re-deriving:
    (1) **One implementation, not two.** `legWrap.js` is exported through `render-service/entry.js`
    so esbuild bundles it alongside `generateArtwork` — browser and Fly run the same code, unlike
    `drawRegion` which is mirrored by hand and is an explicit drift hazard. Verified: a sheet
    composited in Chromium, in WebKit and under `@napi-rs/canvas` from the same composition is
    **byte-identical, 0 differing subpixels of 2.28M**. That cross-engine check is a different
    instrument from `check-render-regression.mjs`, which runs napi-rs at both ends — the v11 star
    spike divergence is what proved the two are not interchangeable.
    (2) **`mirrorX` must NOT reach the source render.** For every other placement it reflects the
    composition inside `renderArtwork`; here what has to be reflected is the finished SHEET, so a
    mirrored back meets the front across the side seams. `drawLegWrap` does it. Doing both mirrors
    twice and lands back where it started. Same rule as `hatWrap`. Verified: a mirrored render is a
    **pixel-exact** flip of its unmirrored twin, max subpixel delta 0, all three products.
    (3) **Smoothing is off for the two edge-clamp draws.** A single source column stretched
    sideways has nothing to interpolate, and with smoothing on it resampled slightly differently at
    the two ends, which broke (2) — 7 subpixels of 2.52M on the joggers, all in the sliver outside
    every cut piece. Small, but the flip being exact by construction is what the side seams rest on.
    (4) **`sizeFrame` plays no part in this mode** and is never sent with it. The composition IS one
    leg-pair front, so element sizes are already measured against exactly what the customer sees;
    `legPanel` was only ever approximating that.
    (5) **`geometryLayout` is `null` here, not `'mirror'`.** `'mirror'` exists because on a flat
    sheet the shape's default centring put it on the cut line, lost in the inseam. In this mode the
    composition's centre IS the centre-front seam, so a centred shape straddles it in full view —
    the same thing every other product's front panel does. It is also what the mockups this mode
    was signed off from were rendered without.
    (6) **The centre BACK improves but does not close, deliberately.** The back panels are wider at
    the rise (their inner edge sits at ~1211 / 1142 / 1226 template px against the front's 1214 /
    1286 / 1289), so sharing the front's shift leaves a residual gap there — near zero on the
    shorts, small on the joggers, largest on the pants. Closing it exactly needs the back to shift
    by a different amount, which breaks the mirror relationship and reopens BOTH side seams. Keeping
    the mirror is what keeps the side seams closed and is what makes the back "the reverse of the
    front" the way Aaron described it.
    (7) **It is a customer CHOICE, so it rides as a parameter and belongs in both cache keys** —
    unlike `hatWrap`, which every call site reads straight off the product config. Front and back
    share one printfile id on these products, so without `:legwrap` in the render cache key and
    `legWrapSignature` in `useMockup`'s, a flat render would be served for a wrapped one and the
    Artwork row would silently do nothing. The two flat scales stay selectable (Aaron's call), so
    the look these products shipped with until now is still reachable.
    (8) **No `GENERATOR_VERSION` bump** — it consumes no `rng()` and does not touch
    `generateArtwork`; it is per-order render context like `sizeFrame`.
    `check-render-regression.mjs` passes on all **99** stored designs (0 changed), and every
    non-wrapped render path is **byte-identical** to the previous commit (32/32 hashes across 4
    designs x 8 shapes, incl. `regions`, `mirrorX`, `legSymmetry`, `sizeFrame`, `geometryLayout`
    and `hatWrap`).
    **DEPLOY ORDER: render-service and `render-print-file` BEFORE the frontend.** render-service
    ignores an unknown field, so a browser sending `legWrap` against an old Fly bundle would show a
    wrapped mockup and print a FLAT garment — and with no version bump there is no mismatch check
    to catch it. Exactly the `density` / `mirrorX` / `legSymmetry` / `hatWrap` hazard. No thumbnail
    backfill (composition is unchanged for every stored design) and no Printful payload change, so
    `check-printful-catalog`/`-mockups`/`-draft-orders` are unaffected.
  - **The overshoot is ramped out down the leg — `legWrap.shiftBottom`, shorts and pants (2026-09-01,
    Aaron: "in the middle we see some repeat across both legs and it can look weird on some
    designs").** Held constant, `shift`'s overshoot of its zero point puts a band of design on BOTH
    legs at every height, `2 x (shift - zero)` wide — **3.40in per leg on the shorts, 2.06 on the
    pants, 1.15 on the joggers** (measured by decoding a column-index ramp back out of a real sheet;
    it is arithmetic, not calibration drift). On a busy artwork that reads as a mirror symmetry the
    design does not contain. The fabric the overshoot cancels is a WAIST effect — gathered elastic,
    the rise curving under — and the original ruler mockup was read at the waist only, so a constant
    value outlives what it was cancelling. `shiftBottom` ramps it to the templates' own zero point.
    Approved from real Printful mockups, three stored designs x two rules on the shorts and one pair
    on the pants; the flat butted-panel previews built first were rejected as unjudgeable, which is
    the reusable half — **for this decision only a real mockup is an instrument.**
    Six things worth not re-deriving:
    (1) **It is an affine shear, and the tidier alternative was built, measured and thrown away.**
    Without a taper the map is an integer 1:1 blit, and two properties fall out free: byte-identical
    under `@napi-rs/canvas`/Chromium/WebKit, and a mirrored sheet is a pixel-exact flip (what the
    SIDE seams rest on). A shear gives both up. Quantising the shift into whole-pixel horizontal
    bands restores them exactly — and needs one draw per pixel of drift, 510 per half on a true
    shorts printfile, with `@napi-rs/canvas` materialising a source copy per call that V8 frees only
    lazily: **15GB peak RSS and 3.2s against 360MB and 15ms**. On a 4096MB Fly machine that is an
    OOM kill on every checkout of these products, not a purity trade. Coarser bands buy the memory
    back and put a visible jog on straight edges (a fixed 32 bands steps 0.14% of the sheet width at
    once, in the mockup and the print alike).
    (2) **What the shear actually costs, measured, so nobody re-litigates it from first principles:**
    the mirror differs on **0.0076% of subpixels, max delta 1** (a rounding LSB), and the engines on
    0.381% (max delta 12, Chromium) and 1.662% (max delta 2, WebKit). A print pixel is 1/150in.
    (3) **The clamps must OVERLAP the composition by a pixel, not abut it.** Under a taper `left` is
    fractional, so clamp and composition share a subpixel column, and two antialiased edges
    composited in sequence do not add up to full coverage — a hairline of alpha 144–240 down both
    outer edges, 836 subpixels at mockup size. The composition draws last and covers the overlap, so
    the un-tapered path is unchanged.
    (4) **A product that omits `shiftBottom` is byte-identical, and that is enforced.** The constant
    path still rounds to a whole pixel and never sets a transform. `scripts/check-legwrap-taper.mjs`
    stage 1 compares it against the previous commit at mockup cap and true printfile size, mirrored
    and not, on all three products — run it after anything touching `legWrap.js`. Its stages run as
    separate processes because one process doing all four is OOM-killed part way, which would read
    as a pass.
    (5) **The joggers are deliberately left flat.** 1.15in per leg is little to win, and a taper
    costs the same widening of the centre-BACK gap that one shared shift forces on every product.
    (6) **THE BACK IS A KNOWN LIMIT, NOT A CALIBRATION MISS, and tapering slightly widens it**
    (Aaron: "the back still seems a bit off"). Flood-measuring the shorts' own templates, the front
    rise is straight — half-wedge **0.0930** of sheet width the whole way down, which is where the
    0.09623 zero point came from — while the **back is a different pattern piece**: its rise is
    longer and its wedge wider near the waist (**0.1052**, converging by mid-rise). The back sheet
    has to be an exact mirror of the front or the SIDE seams reopen, so one shift serves both faces,
    and the back sits about **1.8in under-shifted across the seat**. Closing it needs the back to
    shift differently from the front, which trades one seam for two. Accepted.
    **No `GENERATOR_VERSION` bump** (no `rng()`, `generateArtwork` untouched — `check-render-regression.mjs`
    passes on all 87 stored designs, 0 changed) and no thumbnail backfill. **DEPLOY ORDER:
    render-service before the frontend** — it ignores an unknown field, so a browser sending
    `shiftBottom` against an old Fly bundle shows a tapered mockup and prints a flat garment, with no
    version check to catch it. Same hazard as `density` / `mirrorX` / `hatWrap` / `legWrap` itself,
    plus the stale-tab case (a mockup approved under the old rule, bought under the new one), so
    `STORE_ENABLED=false` for the window. `render-service/server.js` validates `shiftBottom` on the
    same bounds as `shift` and treats it as optional.
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
  - **The bucket hat's artwork is WRAPPED onto its real cut pieces, not laid flat across the
    sheet (2026-08-21, Aaron: the panels were "starting to look odd"). `src/render/hatWrap.js`,
    `PRODUCT_MOCKUP_CONFIG`'s `hatWrap`.** Printfile 410 carries **THREE** cut pieces, not the two
    the `mirrorPlacements` note above describes: a **crown top disc** (front faces only), a
    **crown wall half**, and a **brim half**. The lower two are annular sectors at wildly
    different curvature — crown 28.7° of a huge radius, brim 112° of a small one — both
    representing the same 180° of the head. A flat composition knows about none of that, so the
    artwork restarted at the crown/brim seam AND each piece picked up a different amount of polar
    distortion (the brim fanned into radial arcs the crown did not have). Measured over five real
    stored designs, mean per-channel mismatch across that seam was **61–107 of 255**; through the
    map it is **5.8–13.3**, and the residual is the seam allowance, not error.
    The map: generate the composition in the hat's own coordinates (u = angle around the head
    across one half, v = height from the crown's top edge to the brim's outer edge) and
    inverse-map it into each sector. Both panels take u from the same normalised angle, so the
    joins close by construction — which is also why the 8.4% difference between the crown's and
    brim's seam arcs (0.7499 vs 0.6927 of the width) is harmless: it is a small horizontal scale
    step at the seam, not a discontinuity.
    Things worth not re-deriving:
    (1) **The crown top is deliberately NOT in that map, and this was settled from real mockups,
    not reasoning.** Wrapping the composition's horizontal axis around the disc takes it through
    a full 360°, so it converges at the centre — unavoidable for any continuous map, since a disc
    cannot carry a strip without a singularity. On a test grid that read as a tidy sunburst; on
    real artwork it read as a pinwheel smear at exactly the spot the eye lands first. **A hybrid
    (polar at the rim crossfading to planar in the middle) looked like the obvious compromise and
    measured worse**: blending two unrelated compositions dissolves the hard-edged translucent
    facets that are this generator's whole character, and buys no continuity anyone can see. The
    disc takes a plain circular window of a SQUARE render of the same design instead, at the cost
    of a rim boundary that reads as an ordinary panel seam.
    (2) **One implementation, not two.** Unlike `drawRegion` (mirrored by hand between
    `lib/printful.js` and `render-service/render.js`, and explicitly a drift hazard),
    `hatWrap.js` is exported through `render-service/entry.js` so esbuild bundles it alongside
    `generateArtwork` — browser and Fly run the same code.
    (3) **Geometry is fractions of the printfile's WIDTH, never pixels and never mixed against
    height.** A mockup renders through `capMockupRenderSize` while the print file renders at true
    dims; normalising by width alone keeps radii circular under that uniform scale. `cy` past 1
    and radii past 1 are normal (the crown's arc centre sits far above the sheet). Verified the
    two agree: mockup vs. downscaled print RMSE **11.59**, against **12.88** for today's flat
    render — i.e. the wrap adds no divergence, it slightly reduces it.
    (4) **The centres are snapped to exactly 0.5, and that is a correctness requirement.** They
    measured 0.49955 and 0.50019. A mirrored face is the sheet reflected about `width/2`, so an
    off-axis centre would put the two faces out of register at the side seams — the join
    mirroring exists to close. Snapped, a mirrored render is a **pixel-exact** flip of its front
    (max subpixel delta **0**, three designs).
    (5) **`mirrorX` is NOT passed to the source renders on this path.** Everywhere else it
    reflects the composition inside `renderArtwork`; here what must be reflected is the finished
    SHEET, so `drawHatWrap` does it. Doing both would mirror twice and land back where it started.
    (6) **Sources are generated at 2x their mapped size** (`HAT_WRAP_SUPERSAMPLE`) so every sample
    is a downsample — the map stretches up to 1.50x at the brim's outer edge and compresses to
    0.83x at the crown top. Their ASPECT is derived from the geometry, so it is identical at
    capped and true resolution, which is what stops the mockup and the print being two different
    ratio-aware recomposes of one seed.
    Geometry was flood-measured off Printful's own templates (162068/162069/162070) and
    circle-fitted to inside 0.8px; the disc's circumference matches two crown-wall top arcs to
    2.7%, which is what proves each wall piece spans exactly 180°. **The disc's orientation could
    not be got from the template and needed a photograph** — a clock-face test pattern came back
    with 12 at the front, so the sheet's +y on the disc is the hat's front centre.
    **No `GENERATOR_VERSION` bump**: it consumes no `rng()` and does not touch `generateArtwork`
    — it is per-order render context like `sizeFrame`. `check-render-regression.mjs` passes on all
    **77** stored designs (0 changed), and every non-hat render path is **byte-identical** to the
    previous commit (24/24 hashes across 3 designs x 8 shapes, incl. `regions`, `mirrorX`,
    `legSymmetry`, `sizeFrame` and geometry-off).
    **Deploy render-service BEFORE the frontend** — it ignores an unknown field, so a frontend
    sending `hatWrap` against an old bundle would show a wrapped mockup and print a flat garment,
    with no version check to catch it. Same hazard as `density`, `mirrorX` and `legSymmetry`.
    Verified end to end on real Printful mockups at the real capped mockup size, all four faces.
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
  When these surfaces genuinely disagree in the wild, suspect the CANVAS first — it is the only
  one of them not guarded against a stale async result; see "The studio canvas is the one
  active-artwork surface with no staleness guard of its own" above.
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
- **A route's loading state must reserve the height its content will occupy — and the
  SUSPENSE FALLBACK is the half that actually shows the footer** (2026-08-22, Aaron: on the
  product page "right before the products load in you see the footer", then it "pops out of
  view"). Every route under SiteLayout is `React.lazy`, and the boundary's fallback was
  `<PageContainer title="Loading…" />` — an empty main. `min-h-dvh` + `flex-1` then parks the
  footer at the bottom of the VIEWPORT for the length of the chunk download. Measured on the
  production build at 1280x800 over throttled 3G: **footer top 471px on /shop, /gallery AND
  /shop/:id alike**, then 2228 / 1892 / 1308 in one frame. Fixing only the page's own fetch
  (the first attempt) left this untouched, which is why it still looked identical to him.
  `components/ui/RouteSkeleton.jsx` now supplies a per-path placeholder to that fallback, and
  ProductPage renders the **same component** for its own catalog-fetch phase — so blank →
  chunk → fetch → page is one continuous height. After: the three store routes go straight
  from blank to their final height, footer never on screen.
  Six things worth not re-deriving:
  (1) **It must stay cheap to import.** SiteLayout imports it eagerly, so anything it pulls in
  lands in the main bundle — exactly what the lazy routes exist to avoid. Hence
  `SHOP_TILE_COUNT` is a literal instead of `STARTER_PRODUCT_IDS.length` (that import would
  drag `lib/printful` and the whole render pipeline in), with a dev-only `console.warn` in
  ShopPage guarding the drift. Verified: the entry bundle is byte-for-byte the same size and
  RouteSkeleton splits into its own 1.61 kB gzip shared chunk.
  (2) **The fallback is matched on `pathname`, not chosen per `<Route>`** — the boundary sits
  above route matching, and by the time a route element could pick its own fallback its chunk
  has already loaded and there is nothing left to show.
  (3) **Over-reserving and under-reserving are not symmetric, and the generic routes need
  both.** Under-reserving leaves the footer on screen and throws it off; over-reserving makes
  it RISE into view when the content lands — the same jolt in reverse. So the bare generic
  skeleton is small (main 392 against checkout-success's and 404's real **403** — those two
  now never move at all) and `GENERIC_BODY_MIN` only lifts it for routes reliably taller than
  a viewport: terms/privacy start the footer at 1372 and only grow, /account is tuned to its
  signed-out floor (772) so signing in can only push it down.
  (4) **ProductPage's skeleton geometry is exact by construction on desktop**, because the
  `aspect-square` hero in the 3fr column dominates the height: **0px shift at 1280** across
  five products, −11 at 768, +4 to +90 at 390 where the stacked purchase column contributes
  and the size-chip row's real wrap depends on a per-product size count (3 to 11) nothing can
  know before the fetch. That residual is ~1000px below a phone's fold.
  (5) **Chip WIDTH is as load-bearing as chip height** in that skeleton: placeholder chips at
  `w-14` wrapped the row at 390 and over-reserved 46px; the real chips are `px-3` around one
  or two characters.
  (6) **Gallery's own remaining 80px was the infinite-scroll sentinel**, not the grid. It is
  reserved during the skeleton phase, gated on `!hasMore`: `hasMore` is set when the ROWS
  land, which is before the thumbnails preload and the grid reveals, so an ungated spacer
  double-counts with the real sentinel for that window and overshoots by the same 80px it
  exists to save.
  `SkeletonFadeOut` crossfades the product skeleton out over the arriving page (measured:
  opacity 1 → 0 over 500ms with the document height pinned at 1637 throughout), matching what
  Shop and Gallery already do. It needs two rAFs before flipping to `opacity-0` because it
  MOUNTS at the moment of the swap — an element that mounts already transparent has no
  previous painted value to transition from, the same reason FadeImage defers its own reveal
  twice. Shop and Gallery can express the same crossfade as a plain class swap because their
  placeholder is already mounted and visible.
