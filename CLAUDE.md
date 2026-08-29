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
  - **A mockup asks for exactly two style groups — the garment FLAT and its PRODUCT DETAILS — and
    shows them in that order** (`src/lib/printfulViewPolicy.js`, 2026-08-29, Aaron: "let's just do
    the flats, and details if available. keep it simple"). Every product asks for the same two, so a
    filmstrip reads identically across the shop and nothing is derived from how a given product
    happens to be photographed. `Default` is the non-apparel synonym for `Flat` (pillow, tote).
    **Read this before adding a third group back, because a whole day went into learning it.** An
    earlier version requested four (Flat + an on-model group + Ghost + Product details) and tried to
    ORDER the mixed result. That cannot be made to work, for a structural reason rather than a want
    of a better heuristic: **ask v1 for SEVERAL groups in one task and each placement's photo comes
    back as an untyped `mockup_url` primary, with `option_group` present only on the `extra`
    entries.** So the most important photos — the front, the back — arrive with no indication of what
    they show. Four ordering rules were tried against real responses and every one left some product
    jumping between flat lays and model shots. The worst, inferring "the group missing this angle",
    handed every primary to Product details (which lacks every angle by definition) and turned the
    track jacket's whole strip into detail shots; matching against the catalog's own view names does
    better and still fails wherever Printful's vocabulary differs from ours ("Right Front" vs
    "Right").
    **Ask for ONE group and the ambiguity does not exist** — measured, and the finding the design now
    rests on: there are no `extra` entries at all, every photo is a placement primary, and every one
    belongs to the group asked for. The sweatshirt returns 2 photos for `Flat` (front, back) and 4
    for `Men's` (front, back, both sleeves), clean either way. Flat + Product details keeps that
    property in the one combination that matters: the flats come back as primaries and the details as
    extras, so the two are told apart with no inference (verified on the sweatshirt and the track
    jacket).
    **Model shots would cost a SECOND TASK per preview** — Printful's create limit is 10/60s shared
    store-wide, so peak preview throughput would halve — and that is the lever to reach for if the
    shop wants them back, never another ordering rule.
    **Expect 2–4 views per product**, the accepted cost of the above: the sweatshirt returns 2 and
    the track jacket 4.
    **Measure a real task before reasoning about what a filmstrip contains.**
    `/v2/catalog-products/{id}/mockup-styles` says which styles EXIST; only a task says what comes
    back, and the two disagree. Three rounds of fixes shipped against the catalog before one real
    task overturned the premise. A throwaway sweep — one task per product, first variant, raw
    responses saved to a file — then let four candidate rules be tested in minutes; build that first.
    **Still true and unchanged by any of it:** the strip de-duplicates by URL *and* by group+title,
    because v1 repeats a product's camera angles under EVERY submitted placement and gives the same
    photograph a different URL each time (the track jacket returned one flat back and three detail
    shots six times over). And a placement may not name a view unless it is a camera-visible panel
    (`NON_VIEW_PLACEMENTS` — labels plus `pocket`, `details`, `inside_pocket`, `hood_inner`,
    `facing`), or you get a photo of the jacket labelled "Pocket".
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
