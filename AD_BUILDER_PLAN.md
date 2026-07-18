# Ad builder — plan (drafted 2026-07-18, for next week)

An **admin-only ad builder** that reuses the existing animation engine to produce
marketing videos for the app (Reels/TikTok/social). Same treatment as `TODO.md`: living
doc, prune as things land. Origin: Aaron's idea at the end of the 2026-07-18 session,
right after the animation/export loose ends were closed (speed ramp, constant 3D flight
speed, iOS audio fix — see CLAUDE.md's MP4-export and 3D-mode sections for the current
state of the engine this builds on).

## The idea

A `/admin` route (or similar) with the studio's animation engine plus ad-specific extras
the public studio shouldn't have:

1. **Logo end-card / watermark** — reuse `src/render/generateLabelMark.js` (it already
   rebuilds the vectorclash mark from Logo.jsx's chord geometry, seeded and
   palette-aware), so the mark matches each ad's colors automatically instead of being a
   static PNG overlay.
2. **3D shirts flying past the camera** — spawn a few instances of the TshirtPreview GLTF
   model (design-textured via the same atlas-canvas pipeline) inside the tunnel scene.
   The product inside the artwork it's printed with — the distinctive shot.
3. **Text/CTA overlays** — "chromaforge.app", hook line, end card. The only piece with no
   existing machinery.

## Decisions still open (decide before building)

- **Aspect ratios**: ads want 9:16 (and maybe 1:1), not the studio canvas ratio. Export
  resolution is already a parameter, but the 3D scene composition (tunnel radius vs. FOV)
  was tuned landscape-ish — portrait needs a look pass. Decide which formats matter first.
- **Where it lives**: in-app lazy-loaded `/admin` route (zero infra, uses the signed-in
  session, gate on an `is_admin` profiles flag or a hardcoded user id — client-side gating
  is fine, this is a tool not a security boundary) vs. a local-only never-deployed page.
  Leaning in-app lazy chunk.
- **Scope of v1**: probably logo end-card + 9:16 export first (cheap, immediately usable),
  shirts second (most work, most payoff), text overlays third.

## Technical notes (from the 2026-07-18 discussion — the gotchas that matter)

- **Shirts must respect the tunnel scene's determinism contract**
  (`src/animation3d/tunnelScene.js` header): positions/rotations drawn from the seeded
  rng, ALL motion a pure function of `setTime(seconds)` (no internal clocks), content
  tripled at ±L (the per-scene content length — no longer a constant) so the loop seam
  holds. That's what keeps preview and frame-by-frame export identical.
- **Apply the warp shader** (`applyWarpShader`, per-scene `uWarpStart` uniform) to the
  shirt materials, or they'll pop in at the fog line — the exact defect the early
  geometry iterations had. Note the GLTF's own materials are chunk-based
  (MeshStandardMaterial), so onBeforeCompile should work, but verify against a real
  render — sprites needed the JS-mirror route (`warpFactor`).
- **Shirt textures are async** (island renders via `StudioContext.renderDesignBlob` →
  atlas canvas, see TshirtPreview.jsx's header comment for the island rects/flips —
  every island is UV-mapped vertically flipped, don't rediscover this). Gate scene
  readiness on them like the star sprites: extend the existing `world.ready` promise.
- **Text overlays**: composite on a 2D canvas per-frame inside the exporter's
  `drawAt(elapsed)` (and the same way in the preview) so they ride the shared
  preview/export code path instead of a separate one.
- **Logo mark**: `generateLabelMark`/`renderLabelMark` take a design and a canvas —
  should drop into an end-card composition nearly as-is. Seed off
  `${design.seed}-ad` (separate rng stream, same convention as `-label`/`-3d`).
- **Speed ramp + rush** already work in export; ads probably want them on by default.
- Mind mobile export limits if ads are ever exported from a phone (1080 cap, iOS canvas
  area) — realistically ads get exported on desktop; don't over-engineer for mobile.

## Suggested build order

1. Admin route + gate; mount the existing studio animation flow in it (nothing new yet).
2. 9:16 / 1:1 export presets + the portrait look pass on the 3D scene.
3. Logo end-card (generateLabelMark composition, fade in over the last ~1.5s, still
   loop-safe or explicitly non-looping — decide: ads don't need seamless loops if there's
   an end card; that relaxes the periodicity constraint for ad exports only).
4. 3D shirts flythrough (determinism + warp + ready-gate notes above).
5. Text/CTA overlays.
