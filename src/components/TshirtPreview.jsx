import React, { useEffect, useRef, useState } from 'react';
import { gsap } from 'gsap/all';
import ArrowIcon from './buttons/ArrowIcon';
import { useStudio } from '../context/StudioContext';
import { DURATION_FAST, DURATION_SLOW } from '../utils/motionTokens';
import { capMockupRenderSize } from '../lib/printful';
import { resolvedPalette } from '../render/resolvedPalette';
import { createTshirtSwirl } from './tshirtSwirl';

// Small live 3D garment preview for the homepage hero panel: the current design rendered
// as the base-color texture of a t-shirt model, slowly rotating. three.js is dynamically
// imported (same lazy-chunk treatment as Animation3DPreview) so it never loads for
// visitors who bounce before the hero settles.
//
// Model: "Tshirt" (https://sketchfab.com/3d-models/tshirt-a88d6e25d67c4b0c91b9ea013e679870)
// by khalilchahi99 (https://sketchfab.com/khalilchahi99), CC-BY-4.0 -- served from
// public/models/tshirt/ (fetched by URL, which Vite's import pipeline can't resolve from
// src/assets). license.txt ships alongside it and is a licence obligation, not optional.
//
// The .glb here is an OPTIMIZED build of the Sketchfab download, not the download itself:
// 4717KB across 5 requests (scene.gltf + scene.bin + 3 textures) -> 708KB in one. The
// source asset is scan-density -- 154,048 triangles for something drawn at 190 CSS px --
// so it is welded, simplified to 10% (22,624 tris, still well past what that size can
// resolve), quantized, and pruned, with the textures embedded. Rebuild with:
//   gltf-transform dedup  in.gltf p1.glb   &&  gltf-transform weld     p1.glb p2.glb
//   gltf-transform simplify p2.glb p3.glb --ratio 0.1 --error 0.001
//   gltf-transform quantize p3.glb p4.glb  &&  gltf-transform prune    p4.glb tshirt.glb
// The unmodified original is kept at src/assets/models/tshirt/ as the archival source.
//
// Two properties this pipeline had to preserve, since everything below depends on them:
// the UV LAYOUT (island rects are measured in atlas space -- simplification must not move
// them; verified identical bounds before/after, modulo ~0.0002 of int16 quantization
// rounding, i.e. sub-pixel on a 2048 sheet) and the MATERIAL NAMES/mesh split, which the
// traverse below relies on. It needs no loader plugin: KHR_mesh_quantization is the only
// required extension and three.js supports it natively. Deliberately NOT meshopt/Draco --
// both would shave another ~270KB but drag in a decoder for one small model.
//
// Texture spec (from the model's own baseColor atlas): a single square 2048x2048 sheet
// holding the front/back body panels, two sleeves, and hem-strip UV islands as flat
// cut-pattern shapes. A naive full-bleed square render put an arbitrary off-center CROP
// of the artwork on each panel (each island samples its own region of the sheet) -- the
// design never read as centered on the shirt. Instead, each island gets its own
// recompose-per-ratio render (same philosophy as the print pipeline: a sibling
// composition generated fresh from the seed), composited into the island's measured
// rect. Rects were flood-fill measured off the model's own material_baseColor.jpeg
// (2048-space, generous bounding boxes; the curved neckline/hem edges just clip
// whatever falls outside the island -- invisible, same as any print overhang). Both body
// panels share one render, as do the sleeves (matching the real product's own printfile
// sharing -- see below); the tiny hem strips sample the full-bleed base layer drawn
// underneath.
//
// Render size matches EXACTLY what a real mockup preview generates for this garment's
// front/back and sleeve panels -- not just the aspect ratio, but the actual resolution,
// via capMockupRenderSize (the same cap-and-scale math capRenderStrategy in lib/printful.js
// uses for real Printful mockup source images, factored out so both stay numerically
// identical). Body/sleeve printfile dims (product 257 -- All-Over Print Men's Crew Neck
// T-Shirt, the closest real product to this decorative model, from
// `scripts/printful-catalog-baseline.json`: front/back share printfile 94 at 4200x5400,
// both sleeves share printfile 95 at 3000x1800) are the same numbers a real mockup/order
// for this product would use.
//
// Matching only the ASPECT ratio (an earlier version of this fix) wasn't enough: the
// generator is ratio-aware, and getCountScale (render/scale.js) scales element counts off
// the render's ABSOLUTE area relative to the studio's reference resolution, not the aspect
// alone -- rendering at a small island-sized canvas (the original bug) or even a modest
// same-aspect canvas (this component's first attempted fix) still lands far below a real
// mockup's ~61%-of-reference density (RENDER_CAP=2000's own comment has the math), so the
// shirt visibly showed fewer stars/geometry and a different color structure than an actual
// Printful mockup of the same design (Aaron, live comparison). Rendering at the mockup
// pipeline's own resolution and then downscaling into the small UV islands (via drawSlice,
// below) keeps the generated COMPOSITION itself density-matched to a real mockup; only the
// on-screen presentation is small, same as thumbnailing any other full-resolution image.
const TEXTURE_SIZE = 1024;
const ATLAS = 2048;
// [0] is the FRONT panel, [1] is the BACK -- the order is load-bearing (the back is drawn
// mirrored, see the draw call) and is NOT guessable from the rects, so it was measured off
// the model rather than assumed: for every triangle whose UV lands inside each rect, the mean
// POSITION z is +0.170 for [0] and -0.198 for [1], and the camera sits at +z looking at the
// origin with no base rotation on the pivot. Normals are useless for this -- the mesh is a
// closed solid, so each panel carries an inner and an outer surface and the +z/-z counts come
// out even (2632 vs 2606 on [0]). Re-measure if the model is ever replaced.
const BODY_ISLANDS = [
  { x: 61, y: 440, w: 916, h: 1332 },
  { x: 1114, y: 520, w: 872, h: 1267 }
];
const SLEEVE_ISLANDS = [
  { x: 125, y: 30, w: 729, h: 385 },
  { x: 1196, y: 33, w: 729, h: 385 }
];
// Which islands draw horizontally mirrored, indexed the same way as BODY_ISLANDS/
// SLEEVE_ISLANDS -- the single source of truth STRIP_ISLANDS' `island` field reads from
// below, so a strip's flip can never drift out of sync with its panel's own (see the
// 2026-09-04 sleeve note past STRIP_ISLANDS for why that drift already happened once).
//
// BODY_FLIP[1] mirrors the back panel, matching every real order's own default
// (PRODUCT_MOCKUP_CONFIG[257].mirrorPlacements: ['back']) -- see the merch-pipeline
// section's seam-mirroring notes for why a mirrored back is correct on this product.
const BODY_FLIP = [false, true];
// SLEEVE_FLIP is [false, false] -- see the note below STRIP_ISLANDS for why NEITHER
// sleeve island is code-flipped, despite that reading like it reintroduces the
// left/right-mismatch bug a 2026-07-17 fix "corrected".
const SLEEVE_FLIP = [false, false];
// The thin trim strips, flood-fill measured like the islands above. `island` names which
// BODY_ISLANDS/SLEEVE_ISLANDS entry (0 or 1) each one is sewn to, and `edge` which end of
// the composition it sits at ('bottom' = the garment's hem/cuff, 'top' = its neckline).
//
// EVERY FIELD HERE IS MEASURED OFF THE MESH, not inferred from the atlas layout (2026-09-04,
// harness below). Atlas position tells you nothing: the two hems sit at nearly the same x
// despite belonging to opposite panels, and UV islands are packed wherever they fit. What
// was measured, per seam, by finding vertex POSITIONS shared between two islands and reading
// back each island's UV at those vertices:
//   * which panel each strip is actually sewn to, and along which edge of each one's rect;
//   * whether the two u-axes run the same direction across the seam (they all do -- fitted
//     u_strip = m * u_panel + c gives m = +1.00 on both hems and both cuffs, r^2 = 1.00);
//   * per-island TEXEL DENSITY (atlas px per world unit), from each triangle's UV area over
//     its 3D area: body 1774-1808, sleeves 1811-1813, hems 1765-1781, cuffs 1754-1756 --
//     uniform within ~3%, which is what makes atlas heights a valid stand-in for real-world
//     heights in the `continues` split below.
// Corrections it forced: the back collar was assigned to the FRONT panel, and two entries
// ("interior facings", 1219x1811 and 1209x1848) had ZERO triangles mapped to them -- unused
// atlas space, now dropped. The base layer underneath covers those pixels as it always did.
//
// `continues: true` marks a strip whose seam is a straight, full-width line lying on BOTH
// islands' rect edges (verified: within ~2px on all four) -- the precondition for the
// composition to genuinely run across it, see the split in the render effect. The collars
// are deliberately NOT marked: their seam is a CURVE (the neckline), spanning only a
// sub-range of the panel's width (front collar: panel u 358.6-674.7 mapped across the
// collar's full 494) and sitting well inside the panel's rect rather than on its edge, so
// no horizontal band of the composition corresponds to them. They keep a thin edge slice.
const STRIP_ISLANDS = [
  { x: 29, y: 1797, w: 918, h: 34, from: 'body', edge: 'bottom', island: 1, continues: true }, // back hem
  { x: 30, y: 1838, w: 917, h: 34, from: 'body', edge: 'bottom', island: 0, continues: true }, // front hem
  { x: 29, y: 1879, w: 725, h: 34, from: 'sleeve', edge: 'bottom', island: 1, continues: true }, // cuff
  { x: 29, y: 1919, w: 725, h: 34, from: 'sleeve', edge: 'bottom', island: 0, continues: true }, // cuff
  { x: 29, y: 1960, w: 494, h: 25, from: 'body', edge: 'top', island: 0 }, // collar (front)
  { x: 30, y: 1993, w: 329, h: 26, from: 'body', edge: 'top', island: 1 } // collar (back)
];
// The trim that continues a given panel past the composition's bottom edge, if any.
function continuationFor(from, island) {
  return STRIP_ISLANDS.find(s => s.continues && s.from === from && s.island === island) || null;
}
// How a panel and its continuing trim split one composition. The composition is cover-fit to
// the COMBINED region (the panel's width by panel.h + trim.h, both in atlas units, which the
// uniform texel density above makes proportional to real-world size), then cut at the seam:
// the panel takes the first `panel.h / combined` of it, the trim takes the rest. Because both
// slices come from one fit, they land at the same source-px-per-texture-px rate with no
// arithmetic needed to force it -- and the trim shows rows the panel never drew, which is
// what makes it a continuation rather than a second copy of the panel's own edge.
function compositionSplit(img, panel, trim) {
  const combinedH = panel.h + (trim ? trim.h : 0);
  const crop = coverSampleRect(img, panel.w / combinedH);
  return { ...crop, panelSh: crop.sh * (panel.h / combinedH) };
}
// SLEEVE_FLIP REVERSED, 2026-09-04 (Aaron: "the sleeves are both facing the same way, but
// one should be flipped like the actual Printful shirt sleeves"). The 2026-07-17 fix above
// (`flipX: i === 1`, see git history) assumed both sleeves should read identically and
// "corrected" a mismatch it found on the bare model into that. A real mockup task settles
// which was right: product 257's own checkout NEVER mirrors either sleeve file --
// PRODUCT_MOCKUP_CONFIG[257].mirrorPlacements only lists 'back' -- so `sleeve_left` and
// `sleeve_right` receive byte-identical uploads. Submitting one directional test image
// (arrow + 4 distinct corner colors) to both placements and pulling a real v1 "Flat" mockup
// shows the TWO SLEEVES COME BACK MIRRORED ANYWAY -- Printful's own garment construction
// mirrors the shared file between the two sewn sleeve pieces, the same way the back panel
// is mirrored by default. (Corner check: the source's top-right corner lands nearest the
// collar on the viewer-right sleeve in the flat photo, and the top-LEFT corner lands
// nearest the collar on the viewer-left sleeve -- opposite corners, i.e. a horizontal flip
// between the two, not a rotation.) This model's own "opposite orientation" UV winding
// (see the comment the old fix left, still true, git blame it) produces exactly that
// mirror for free when BOTH islands draw unflipped -- which is what identical-draws did
// before the 2026-07-17 fix, and is restored here. So the fix that shipped then had the
// right diagnosis (the two sleeve UV islands do wind oppositely) and the wrong target (it
// should have left that alone, not cancelled it).

const BODY_PRINTFILE = { width: 4200, height: 5400 }; // product 257, printfile 94 (front+back)
const SLEEVE_PRINTFILE = { width: 3000, height: 1800 }; // product 257, printfile 95 (both sleeves)
const bodyCap = capMockupRenderSize(BODY_PRINTFILE.width, BODY_PRINTFILE.height);
const sleeveCap = capMockupRenderSize(SLEEVE_PRINTFILE.width, SLEEVE_PRINTFILE.height);
const BODY_RENDER = { w: bodyCap.width, h: bodyCap.height };
const SLEEVE_RENDER = { w: sleeveCap.width, h: sleeveCap.height };

// The centered "cover" crop window that fills a `destAspect` rect from `img` with no
// stretching. Callers slice this window up themselves (see compositionSplit) rather than
// each computing their own fit, which is what lets a panel and its trim share one.
function coverSampleRect(img, destAspect) {
  const srcAspect = img.width / img.height;
  if (srcAspect > destAspect) {
    const sh = img.height;
    return { sx: (img.width - sh * destAspect) / 2, sy: 0, sw: sh * destAspect, sh };
  }
  const sw = img.width;
  return { sx: 0, sy: (img.height - sw / destAspect) / 2, sw, sh: sw / destAspect };
}

// Draws an explicit source rect into an explicit dest rect, optionally mirrored on either
// axis. Every body/sleeve/trim draw passes flipY, because every island in this model's atlas
// is UV-mapped VERTICALLY FLIPPED on the garment (confirmed on a headless harness with
// orientation-marked test textures -- a top-of-rect marker lands at the hem, and labels read
// as vertical mirrors, not 180° rotations; re-confirmed 2026-09-04 by measuring the seams
// directly, which put the front panel's hem seam on its rect's TOP edge and its neckline on
// the BOTTOM). Without it the design appears upside down on the shirt (user-caught).
function drawSlice(
  ctx,
  img,
  sx,
  sy,
  sw,
  sh,
  dx,
  dy,
  dw,
  dh,
  { flipX = false, flipY = false } = {}
) {
  ctx.save();
  ctx.translate(dx + (flipX ? dw : 0), dy + (flipY ? dh : 0));
  ctx.scale(flipX ? -1 : 1, flipY ? -1 : 1);
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, dw, dh);
  ctx.restore();
}

// Generate-transition pass: chromatic aberration + a shockwave distortion, both scaled
// by one normalized strength uniform (uAmount 0..1) so they rise and fall together.
//
// The aberration is a uniform LATERAL RGB split (red left, blue right) rather than
// radial-from-center -- radial was tried first and didn't read as aberration at this
// size (nothing happens at the centered shirt's chest while the edges turn into
// misregistered anaglyph channels); a small constant split gives the classic crisp
// red/blue ghost edges everywhere. Alpha takes the max of the three taps so the fringe
// isn't clipped at the silhouette.
//
// The distortion replaced a scrolling two-octave sine "heat haze" (2026-08-24). Four
// candidates were built and compared live on the real hero; this one won. The lesson
// worth keeping from that pass: the FIRST version of this shockwave read as barely
// different from the haze it replaced, and randomizing its parameters harder did not
// help. The cause was the wavefront profile -- a sine inside a gaussian envelope packs
// 1.5 to 2.7 full oscillations into the band, i.e. fine corrugation, which is what the
// haze already was. Switching the profile to a derivative-of-gaussian (one compression,
// one rarefaction: a single lens sweeping outward, ~2.5x the peak displacement at a
// fraction of the spatial frequency) is what made it a different effect at all.
//
// One pulse is STRUCK on every raise of the effect (2026-09-25, Aaron: "occasionally it
// hardly moves at all"). The three ambient pulses run on the page's wall clock, so which
// part of their schedule a generate lands in was a lottery: a ~1 in 5 dud rate and
// amplitudes down to 0.35 meant that, simulated over 500 generates with the usual ~1.3s
// wait, 12% peaked under 5px of displacement on the 190px mount and some at 0. The struck
// pulse starts at the raise itself, is never a dud, and draws its strength from the top of
// the ambient range, while its origin, reach, width and lobes are still fresh random draws
// each time. Measured the same way: floor 0 -> 5.8px, none of 500 under 5px, median
// 8.4 -> 12.5px. It deliberately does not duck the ambient pulses -- a livelier average was
// fine by Aaron ("the effect is really fun to watch").
const ABERRATION_PEAK = 1;
// The WebGL canvas is this many times the shirt's own layout box, overflowing it on every
// side, so the swirl particles (tshirtSwirl.js) have room to orbit the garment instead of
// being cut off by a square the shirt already nearly fills (its half-height is 91% of the
// old frame). Layout, the hit area and the shirt's own pixels are all unchanged: the canvas
// is absolutely positioned and pointer-events: none, the camera's field of view widens by
// the same factor (so the shirt projects to exactly the pixels it did before), and the
// aberration pass works in the shirt's box (uScale).
const SWIRL_ROOM = 1.5;
const PULSE_RATE = 0.45; // pulse cycles per second, shared by the ambient and struck pulses
const AberrationShader = {
  uniforms: {
    tDiffuse: { value: null },
    uAmount: { value: 0 },
    uTime: { value: 0 },
    // uTime at the last strike; far in the past until the first one, so it never fires.
    uStrike: { value: -1e4 },
    // The struck pulse's random draws, made in JS per strike: origin/lobe phases (x, y),
    // reach (z) and strength (w). Same roles as an ambient pulse's h1/h2/h3.
    uStrikeShape: { value: [0.5, 0.5, 0.5, 0.5] },
    // Canvas size over the shirt's own box (SWIRL_ROOM); see main().
    uScale: { value: 1 },
    // The swirl's spark layer, composited unsplit; see main().
    tSparks: { value: null }
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uAmount;
    uniform float uTime;
    uniform float uStrike;
    uniform vec4 uStrikeShape;
    uniform float uScale;
    uniform sampler2D tSparks;
    varying vec2 vUv;

    const float PULSE_RATE = ${PULSE_RATE.toFixed(4)};

    float hash(float n) { return fract(sin(n * 78.233) * 43758.5453); }

    // One expanding wavefront at phase (0..1 through its life). h1..h3 are its random
    // draws: origin and lobe phases, width, reach.
    vec2 pulse(vec2 uv, float phase, float h1, float h2, float h3, float amp) {
      vec2 origin = vec2(0.5) + (vec2(h1, h2) - 0.5) * 0.34;
      vec2 oc = uv - origin;
      float od = length(oc);
      float ang = atan(oc.y, oc.x);
      // Low-order lobes at random phase, growing with the ring: near-round at the
      // origin, an irregular blob by the time it reaches the hem.
      float wobble = (0.060 * sin(ang * 2.0 + h1 * 6.28)
                    + 0.040 * sin(ang * 3.7 - h2 * 6.28)
                    + 0.025 * sin(ang * 6.3 + h3 * 6.28)) * (0.35 + phase);
      float r = phase * (0.60 + h3 * 0.60) + wobble;
      float width = 0.045 + h2 * 0.070;
      float x = (od - r) / width;
      // 1.6487 = e^0.5, normalizing the derivative-of-gaussian to a peak of 1.
      float profile = -x * exp(-x * x) * 1.6487;
      return (oc / max(od, 1e-4)) * profile * amp * (1.0 - phase);
    }

    void main() {
      // Measured in the SHIRT'S box, not the canvas: the canvas is uScale times wider than
      // the shirt (room for the swirl particles), so every distance in here -- pulse origin,
      // reach, width, tear rows, the RGB split -- is taken in shirt space and converted back
      // at the end. The effect lands on the garment exactly as it did on a shirt-sized
      // canvas, and simply carries on into the margin.
      vec2 uv = (vUv - 0.5) * uScale + 0.5;

      // Three pulses on staggered, incommensurate clocks so rings overlap irregularly
      // rather than marching. Everything about a pulse is hashed off its own cycle
      // index -- origin, reach, width, strength, lobe phases -- and some cycles don't
      // fire at all, so the rhythm never settles into a pattern.
      vec2 push = vec2(0.0);
      for (int i = 0; i < 3; i++) {
        float fi = float(i);
        float tt = uTime * PULSE_RATE + fi * 0.37;
        float k = floor(tt);
        float phase = fract(tt);
        float h1 = hash(k * 13.1 + fi * 7.7);
        float h2 = hash(k * 29.3 + fi * 3.1);
        float h3 = hash(k * 5.7 + fi * 11.9);
        float h4 = hash(k * 41.7 + fi * 2.3);
        // ~1 cycle in 5 is a dud, so pulses arrive in clusters and gaps.
        float gate = step(0.2, h4);
        push += pulse(uv, phase, h1, h2, h3, (0.35 + h1 * 1.30) * gate);
      }

      // The struck pulse: one cycle from the moment the effect was raised, never a dud,
      // strength 1.0 to 1.65 (the top of the ambient range). See the header comment.
      float sp = (uTime - uStrike) * PULSE_RATE;
      if (sp >= 0.0 && sp < 1.0) {
        push += pulse(uv, sp, uStrikeShape.x, uStrikeShape.y, uStrikeShape.z,
                      1.0 + uStrikeShape.w * 0.65);
      }

      // A little tearing on top, mostly where a wavefront is passing -- the shock is
      // what breaks the picture up, so the two read as one event rather than two
      // effects sharing a clock. Bands are NOT uniform: a coarse zone index picks its
      // own row density (5 to 26 rows), so tall slabs and thin slivers coexist and the
      // partition itself reshuffles as the zone offset drifts.
      float gt = floor(uTime * 14.0);
      float burst = step(0.72, hash(gt * 0.13)); // ~1 frame in 4 tears at all
      float zone = floor(uv.y * 5.0 + hash(gt * 3.3) * 3.0);
      float density = mix(5.0, 26.0, hash(zone * 7.1 + gt * 0.7));
      float row = floor(uv.y * density);
      float live = step(0.55, hash(row * 3.7 + gt * 1.73 + zone * 0.9));
      float shockBoost = smoothstep(0.2, 0.9, length(push));
      float tear = burst * live * (0.3 + 0.7 * shockBoost);
      vec2 shift = push * 0.045 * uAmount;
      shift.x += (hash(row * 1.31 + gt * 7.13 + zone) - 0.5) * 0.075 * tear * uAmount;
      uv = vUv + shift / uScale;

      vec2 off = vec2(0.06 * uAmount / uScale, 0.0);
      vec4 cr = texture2D(tDiffuse, uv - off);
      vec4 cc = texture2D(tDiffuse, uv);
      vec4 cb = texture2D(tDiffuse, uv + off);
      gl_FragColor = vec4(cr.r, cc.g, cb.b, max(max(cr.a, cc.a), cb.a));
      // The swirl sparks (tshirtSwirl.js): carried through the same warp and tearing, but not
      // the channel split, which would reduce every palette colour to red, green and blue.
      vec4 sparks = texture2D(tSparks, uv);
      gl_FragColor = vec4(gl_FragColor.rgb + sparks.rgb, min(1.0, gl_FragColor.a + sparks.a));
    }
  `
};

// `waiting` is the hero background's own isLoading (true from the Generate click until
// setImage fades the new artwork in). The shirt NEVER leaves during a generate (an
// earlier dip-out/return version made the centered shirt+buttons+loader arrangement
// visibly lose its left element for the whole render, user-rejected) -- instead the new
// design's sheet is staged as soon as it's composited (~200ms, long before the 4K
// background render finishes) and COMMITTED as a texture-level crossfade the moment
// `waiting` flips false, i.e. on the same beat the new background fades in. The
// crossfade redraws the material's single canvas each frame as an old/new blend
// (drawSheet with globalAlpha), which sidesteps the z-fighting/depth-sorting artifacts a
// literal second shirt mesh fading on top of the first would have.
export default function TshirtPreview({
  size = 116,
  waiting = false,
  revealDelay = null,
  revealed = true,
  onShopClick
}) {
  const mountRef = useRef(null);
  // Bridge between the async scene init and the async texture renders, whichever finishes
  // first: `api` appears once the scene is live; `stagedSheet` holds the latest composited
  // design sheet until it can be committed (scene ready AND background landed).
  // `hasTexture` gates the one-time entrance fade; `waiting` mirrors the prop for the
  // async paths.
  const stateRef = useRef({
    api: null,
    stagedSheet: null,
    // The palette of the design `stagedSheet` was rendered from, handed to the sparks at the
    // same moment the sheet commits -- so they change colour with the shirt, never before it.
    stagedPalette: null,
    hasTexture: false,
    waiting,
    // The hero holds the shirt back until its artwork has painted, so this is a second gate on
    // the entrance alongside "is the scene up" -- whichever finishes last opens it. See
    // utils/heroIntro.js; every other host leaves `revealed` true and is unaffected.
    revealed,
    revealDelay,
    revealedAt: revealed ? performance.now() : null
  });
  // Set by the touch-drag rotation the moment a press turns into a drag, so the click
  // that fires on release doesn't ALSO navigate to the shop (see the button's onClick).
  const dragSuppressClickRef = useRef(false);
  const [failed, setFailed] = useState(false);
  const { currentDesign, renderDesignBlob } = useStudio();

  stateRef.current.waiting = waiting;
  stateRef.current.revealDelay = revealDelay;

  // Commit the staged sheet if every gate is open: scene live, sheet ready, background
  // landed. Called from all three places a gate can open. Always a texture-level
  // crossfade -- the scene comes up already wearing the model's white sheet (see init),
  // so even the first design has something to dissolve from.
  const commitStagedSheet = () => {
    const s = stateRef.current;
    if (!s.api || !s.stagedSheet || s.waiting) return;
    const sheet = s.stagedSheet;
    s.stagedSheet = null;
    s.api.setSheet(sheet, { animate: true });
    s.api.setSparkPalette(s.stagedPalette);
  };

  // The entrance. Two gates, opened in either order -- the scene has to be up, and the hero
  // has to have reached the beat where the shirt belongs. Same shape as commitStagedSheet
  // above, and for the same reason: both halves are async and neither can assume it is last.
  //
  // The hero holds this until its artwork has painted, which is also when TshirtPreview's own
  // staged sheet commits -- so the shirt is revealed ALREADY WEARING the design. Before that
  // it was on screen from 912ms as a blank white tee running the generate-transition glitch,
  // for the ~1.6s the first render takes, which read as something broken rather than something
  // loading.
  //
  // On the beat: the sequence's own 500ms, so it arrives as one of the hero's parts. Late (a
  // slow connection -- the model is a lazy three.js chunk plus a 708KB .glb, and had still not
  // landed 22s in when throttled to 400kbps): nothing else on the page is moving any more, so
  // the same 500ms would read as something switching on, and it gets a longer, deeper ease
  // instead. That difference is the only reason the two numbers are not shared.
  const revealShirt = () => {
    const s = stateRef.current;
    if (!s.sceneReady || !s.revealed || s.hasTexture) return;
    s.hasTexture = true;
    const mount = mountRef.current;
    if (!mount) return;
    const waited = performance.now() - (s.revealedAt ?? performance.now());
    const onBeat = s.revealDelay !== null && waited < s.revealDelay;
    const fade = onBeat ? DURATION_SLOW : DURATION_SLOW * 1.5;
    gsap.fromTo(
      mount,
      { autoAlpha: 0, scale: onBeat ? 0.96 : 0.9 },
      {
        autoAlpha: 1,
        scale: 1,
        duration: fade,
        delay: onBeat ? (s.revealDelay - waited) / 1000 : 0,
        ease: 'power3.out',
        // The shirt does not merely fade -- it resolves out of the shockwave pass, which is
        // the same effect a Generate already puts it through (Aaron: "couldn't you do
        // something fun with the existing shader animation too? have it rippling and fading
        // in?"). No new code path: uAmount drives the pass's aberration and its lens sweep
        // together, so the entrance just owns that uniform for its own length.
        //
        // It has to be re-struck HERE rather than left to run down on its own, and that is
        // the whole reason this is not a one-liner. The pass is already at peak when the page
        // mounts (the first build counts as a generate, so `waiting` is true), and `waiting`
        // flips false on the ARTWORK beat -- which starts uAmount decaying at +0ms while the
        // shirt is still held until its own beat at +300. By the time it appeared the ripple
        // was nearly spent, which is exactly why it read as a plain fade.
        //
        // onStart, not before: the tween carries the beat's delay, so this fires on the frame
        // the shirt actually starts appearing rather than when the tween is created.
        // Outlasts the fade by 60%, so the shirt is fully opaque and still settling rather
        // than arriving and stopping dead on the same frame.
        onStart: () => stateRef.current.api?.setAberration(0, fade * 1.6, ABERRATION_PEAK)
      }
    );
  };
  stateRef.current.revealShirt = revealShirt;

  // The hero opening its reveal phase is the second gate. Recorded with a timestamp, not just
  // a flag, because the shirt's own beat is an offset from that instant.
  useEffect(() => {
    if (!revealed || stateRef.current.revealed) return;
    stateRef.current.revealed = true;
    stateRef.current.revealedAt = performance.now();
    revealShirt();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealed]);

  // Chromatic aberration rides the same signal: snaps up when a generate starts, eases
  // back to zero over the same span as the texture crossfade when the new design lands.
  useEffect(() => {
    if (waiting) {
      stateRef.current.api?.setAberration(ABERRATION_PEAK, DURATION_FAST);
    } else {
      commitStagedSheet();
      stateRef.current.api?.setAberration(0, DURATION_SLOW);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waiting]);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return undefined;
    let disposed = false;
    let cleanup = null;
    const mountedAt = performance.now();

    (async () => {
      try {
        const [THREE, { GLTFLoader }, { EffectComposer }, { RenderPass }, { ShaderPass }, { Pass }] =
          await Promise.all([
            import('three'),
            import('three/examples/jsm/loaders/GLTFLoader.js'),
            import('three/examples/jsm/postprocessing/EffectComposer.js'),
            import('three/examples/jsm/postprocessing/RenderPass.js'),
            import('three/examples/jsm/postprocessing/ShaderPass.js'),
            import('three/examples/jsm/postprocessing/Pass.js')
          ]);
        if (disposed) return;

        // WebGL context creation can genuinely fail (GPU blocklists, headless) -- the
        // catch below hides the preview instead of leaving a dead canvas.
        //
        // No `antialias`: it multisamples only the CANVAS's own framebuffer, and nothing drawn
        // there has an edge -- the shirt renders into the composer's non-multisampled target
        // and only the aberration pass's full-screen quad reaches the canvas. So it bought
        // nothing (verified pixel-identical without it) while costing ~10MB of GPU memory per
        // context at a phone's pixel ratio.
        const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: false });
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        // An even margin on each side, so the canvas sits on the pixel grid: an odd difference
        // puts it at a half-pixel offset, which the browser resamples and the shirt goes soft.
        const canvasSize = size + 2 * Math.round((size * (SWIRL_ROOM - 1)) / 2);
        renderer.setSize(canvasSize, canvasSize);
        Object.assign(renderer.domElement.style, {
          position: 'absolute',
          left: `${(size - canvasSize) / 2}px`,
          top: `${(size - canvasSize) / 2}px`,
          pointerEvents: 'none'
        });
        // LIGHTING IS CALIBRATED SO THE SHIRT REPRODUCES THE TEXTURE, NOT MERELY SO IT
        // LOOKS LIT. The shirt sits directly beside the same design rendered flat as the
        // page background, so any deviation reads as the two being different colours --
        // reported live (2026-08-05) as the shirt's colours "feeling different" on bright,
        // saturated designs.
        //
        // The previous setup (ambient 3.2 / key 1.6 under ACESFilmicToneMapping) had the
        // whole garment past white before tone mapping: the diffuse term is
        // irradiance * albedo/pi, so even the DIMMEST, ambient-only part of the shirt sat at
        // 3.2/pi = 1.02, and the lit side at 1.53. That put every pixel of the garment inside
        // the compressed shoulder of the ACES curve, which desaturates and hue-shifts as it
        // rolls off. Measured against three.js's own ACES fit, front-facing fabric averaged
        // dE 17.5 off the true texture colour and peaked at 37.5 -- cyan #00e5ff rendered as
        // #a5e6ea, a pale grey-cyan with its red channel pushed from 0 to 165. Saturated
        // brights were the worst hit, which is exactly the case that was reported.
        //
        // The fix is to keep the whole garment on the LINEAR part of the response instead:
        // no tone mapping, and the total irradiance chosen so the fabric lands at a factor
        // of 1.0, where a texel survives sRGB-decode -> multiply -> sRGB-encode unchanged
        // and the garment is the same colour as the flat background beside it.
        //
        // WHICH PART of the garment that factor is calibrated ON is the whole game, and the
        // first version got it wrong (reported again 2026-08-05: the shirt still "feels
        // darker"). It solved for a surface facing the camera dead-on -- but on a t-shirt
        // that is the BRIGHTEST fabric on screen, not the typical fabric. Measured over the
        // real .glb (every camera-visible triangle, weighted by its projected screen area):
        // the front-facing 0.964 sat at the top of a 0.78 -> 1.05 spread whose area-weighted
        // MEAN was 0.921, with a THIRD of the visible garment below 0.9. So the calibration
        // was correct at its reference point and the shirt was still genuinely darker than
        // the background nearly everywhere -- which is exactly what the eye reports, since
        // it judges the garment as a whole and not its brightest facet.
        //
        // So the target is the area-weighted mean, not the peak: ambient + key * <mean N.L>
        // = pi. `key` then only picks how wide the spread around that mean is, and it costs
        // clipping at the top -- holding the mean at 1.0, key 1.04 runs 0.81 -> 1.12 (any
        // texel above 0.89 blows out on the lit shoulder, the same desaturation of saturated
        // brights this calibration exists to prevent), while key 0.55 runs 0.89 -> 1.07.
        // Chose the latter: the model carries no normal map, no AO and no vertex colours
        // (verified in the .glb), so the only thing a big `key` buys is a soft gradient
        // across a 190px shirt -- not worth spending the highlights on.
        //
        // DO NOT "RESTORE" A BIGGER KEY TO GET DEPTH BACK without re-running the numbers:
        // the two values are one calibration. To retune, pick a `key` and solve
        // ambient = pi * (1 - ENV_IRRADIANCE) - key * 0.743 (0.743 being the measured
        // area-weighted mean of N.L over the visible garment for this model and this light
        // direction). AMBIENT below does exactly that, so `key` and ENV_IRRADIANCE are the
        // only two numbers to touch -- the sum is always conserved.
        //
        // WHY THERE IS AN ENVIRONMENT AND A SHEEN AT ALL, given flat fill is what reproduces
        // the texture: with no env map, a roughness-1 standard material has nothing to
        // reflect, so the garment is a printed SURFACE rather than cloth. The two additions
        // below are the fabric cues, both chosen because they leave camera-facing colour
        // alone (which is the whole calibration):
        //   - a vertical sky/floor gradient environment, which replaces a slice of the flat
        //     ambient with light that has a DIRECTION, so the shoulders read lit-from-above
        //     and the hem falls off. Its mean radiance is normalised to ENV_IRRADIANCE
        //     exactly (see makeGradientEnv), and a uniform-radiance environment contributes
        //     irradiance pi*L -- i.e. a displayed factor of exactly L -- so it can be traded
        //     against AmbientLight one-for-one with no net brightness change.
        //   - sheen, the retroreflective fibre rim real cloth has. It peaks at GRAZING
        //     angles and falls to ~0 head-on, so it draws the silhouette's edge without
        //     touching the fabric facing the viewer.
        // DELIBERATELY NOT a spotlight, which is the usual reach here: a spotlight has
        // distance decay, so brightness would depend on where a triangle sits in space and
        // no single factor could map a texel to the background's colour any more.
        const KEY_INTENSITY = 0.55;
        const ENV_IRRADIANCE = 0.25; // share of the total taken by the environment
        const AMBIENT = Math.PI * (1 - ENV_IRRADIANCE) - KEY_INTENSITY * 0.743;
        renderer.toneMapping = THREE.NoToneMapping;

        const scene = new THREE.Scene();
        // 28deg across the shirt's own box, widened to the whole canvas (see SWIRL_ROOM).
        const fov = (2 * Math.atan((canvasSize / size) * Math.tan((14 * Math.PI) / 180)) * 180) / Math.PI;
        const camera = new THREE.PerspectiveCamera(fov, 1, 0.05, 50);
        scene.add(new THREE.AmbientLight(0xffffff, AMBIENT));
        const key = new THREE.DirectionalLight(0xffffff, KEY_INTENSITY);
        key.position.set(2, 3, 4);
        scene.add(key);

        // Equirect gradient, built here rather than loaded: an HDR/RoomEnvironment would be
        // another request (and RoomEnvironment's coloured emissive panels would tint the
        // garment, which is exactly what this calibration cannot afford). Rows are weighted
        // by sin(theta) -- their real solid angle -- when normalising, so the mean radiance
        // lands on ENV_IRRADIANCE as seen by a surface, not merely as an average of pixels.
        const makeGradientEnv = () => {
          const H = 64;
          const rows = new Float32Array(H);
          let weighted = 0;
          let weight = 0;
          for (let y = 0; y < H; y++) {
            const t = (y + 0.5) / H; // 0 = up
            const solid = Math.sin(t * Math.PI);
            rows[y] = 1 - t; // bright sky above, dark floor below
            weighted += rows[y] * solid;
            weight += solid;
          }
          const norm = ENV_IRRADIANCE / (weighted / weight);
          const data = new Float32Array(H * 2 * H * 4);
          for (let y = 0; y < H; y++) {
            const v = rows[y] * norm;
            for (let x = 0; x < H * 2; x++) {
              const i = (y * H * 2 + x) * 4;
              data[i] = data[i + 1] = data[i + 2] = v;
              data[i + 3] = 1;
            }
          }
          const tex = new THREE.DataTexture(data, H * 2, H, THREE.RGBAFormat, THREE.FloatType);
          tex.mapping = THREE.EquirectangularReflectionMapping;
          tex.colorSpace = THREE.LinearSRGBColorSpace;
          tex.needsUpdate = true;
          const pmrem = new THREE.PMREMGenerator(renderer);
          const env = pmrem.fromEquirectangular(tex).texture;
          pmrem.dispose();
          tex.dispose();
          return env;
        };
        const envMap = makeGradientEnv();
        scene.environment = envMap; // lights the garment; never scene.background (transparent)

        const gltf = await new GLTFLoader().loadAsync('/models/tshirt/tshirt.glb');
        if (disposed) {
          renderer.dispose();
          renderer.forceContextLoss();
          return;
        }

        // Center the model in a pivot group so rotation spins it about its own axis.
        const pivot = new THREE.Group();
        const box = new THREE.Box3().setFromObject(gltf.scene);
        const center = box.getCenter(new THREE.Vector3());
        gltf.scene.position.sub(center);
        pivot.add(gltf.scene);
        scene.add(pivot);

        const sphere = box.getBoundingSphere(new THREE.Sphere());
        camera.position.set(0, 0, sphere.radius * 3.1);
        camera.lookAt(0, 0, 0);

        // Its own layer, NOT added to `scene` -- see tshirtSwirl.js for why.
        const swirl = createTshirtSwirl(THREE, Pass, {
          camera,
          radius: sphere.radius,
          pixelSize: 6 * renderer.getPixelRatio(),
          // Pure ambient motion, so it sits out prefers-reduced-motion. (The glitch pass itself
          // predates this and is left as it was.)
          enabled: !window.matchMedia('(prefers-reduced-motion: reduce)').matches
        });

        // Sheen only exists on MeshPhysicalMaterial, and the model ships one of each (a
        // Physical body and a Standard trim mesh -- verified in the .glb), so the Standard
        // one is promoted. The promotion borrows MeshStandardMaterial's OWN copy rather than
        // calling `physical.copy(mat)`: MeshPhysicalMaterial.copy reads physical-only fields
        // off its source and would throw on a Standard one (`clearcoatNormalScale.copy(
        // undefined )`). Borrowing it carries every base + standard field across and leaves
        // the physical extras at their constructed defaults, which is exactly what's wanted.
        // The promoted material is written back onto the mesh and `materials` holds the live
        // ones either way, so the texture plumbing below is unaffected.
        //
        // sheenRoughness is deliberately high: a tight sheen lobe reads as satin/silk, and
        // this is a cotton tee. Low `sheen` for the same reason -- it is meant to be felt at
        // the silhouette, not seen as a rim light.
        const SHEEN = 0.3;
        const materials = [];
        gltf.scene.traverse(obj => {
          if (!obj.isMesh) return;
          let mat = obj.material;
          if (!mat.isMeshPhysicalMaterial) {
            const physical = new THREE.MeshPhysicalMaterial();
            THREE.MeshStandardMaterial.prototype.copy.call(physical, mat);
            mat.dispose();
            obj.material = physical;
            mat = physical;
          }
          mat.sheen = SHEEN;
          mat.sheenRoughness = 0.85;
          mat.sheenColor = new THREE.Color(0xffffff);
          mat.needsUpdate = true;
          materials.push(mat);
        });

        // One persistent canvas backs the material texture for the shirt's whole life;
        // setSheet either stamps a new design sheet onto it directly or crossfades to it
        // by re-blending old over new each tween frame (globalAlpha), so design changes
        // dissolve on the garment without the shirt itself ever leaving the scene.
        const textureCanvas = document.createElement('canvas');
        textureCanvas.width = TEXTURE_SIZE;
        textureCanvas.height = TEXTURE_SIZE;
        const textureCtx = textureCanvas.getContext('2d');
        // Seed with the model's own white baseColor sheet so the shirt is presentable
        // (a plain blank tee) the moment the scene is up, instead of the element staying
        // hidden until the first design render lands -- the first design then crossfades
        // in from white like any later design change. The seed lives on its own canvas
        // (not just stamped into textureCanvas) because setSheet's blend needs a stable
        // `from` source: drawing textureCanvas onto itself would compound per frame.
        const initialSheet = document.createElement('canvas');
        initialSheet.width = TEXTURE_SIZE;
        initialSheet.height = TEXTURE_SIZE;
        const initialCtx = initialSheet.getContext('2d');
        const originalImage = materials.find(mat => mat.map?.image)?.map?.image;
        if (originalImage) {
          initialCtx.drawImage(originalImage, 0, 0, TEXTURE_SIZE, TEXTURE_SIZE);
        } else {
          initialCtx.fillStyle = '#f4f4f4';
          initialCtx.fillRect(0, 0, TEXTURE_SIZE, TEXTURE_SIZE);
        }
        textureCtx.drawImage(initialSheet, 0, 0);
        const texture = new THREE.CanvasTexture(textureCanvas);
        texture.flipY = false; // glTF UV convention
        texture.colorSpace = THREE.SRGBColorSpace;
        materials.forEach(mat => {
          const old = mat.map;
          mat.map = texture;
          mat.needsUpdate = true;
          if (old) old.dispose();
        });

        let currentSheet = initialSheet;
        let crossfadeTween = null;
        const setSheet = (sheet, { animate }) => {
          crossfadeTween?.kill();
          const from = currentSheet;
          currentSheet = sheet;
          if (!animate || !from) {
            textureCtx.globalAlpha = 1;
            textureCtx.drawImage(sheet, 0, 0);
            texture.needsUpdate = true;
            stateRef.current.wake?.();
            return;
          }
          const f = { t: 0 };
          crossfadeTween = gsap.to(f, {
            t: 1,
            duration: DURATION_SLOW,
            ease: 'power2.inOut',
            onUpdate: () => {
              textureCtx.globalAlpha = 1;
              textureCtx.drawImage(from, 0, 0);
              textureCtx.globalAlpha = f.t;
              textureCtx.drawImage(sheet, 0, 0);
              texture.needsUpdate = true;
            },
            onComplete: () => {
              textureCtx.globalAlpha = 1;
              textureCtx.drawImage(sheet, 0, 0);
              texture.needsUpdate = true;
              crossfadeTween = null;
              // The final frame of the crossfade is drawn here, after the loop's last render;
              // one more frame is needed to actually show it.
              stateRef.current.wake?.();
            }
          });
          stateRef.current.wake?.();
        };

        mount.appendChild(renderer.domElement);

        // No idle spin -- the shirt faces forward and turns slowly toward the mouse
        // (desktop) or with the phone's left/right tilt (touch devices, deviceorientation
        // gamma), capped at ±25° of yaw either way. Static under prefers-reduced-motion.
        const MAX_YAW = (25 * Math.PI) / 180;
        const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        const isTouch = window.matchMedia('(pointer: coarse)').matches;
        let targetYaw = 0;
        const inputCleanups = [];

        const onMouseMove = e => {
          const rect = renderer.domElement.getBoundingClientRect();
          const centerX = rect.left + rect.width / 2;
          // Normalize by half the viewport so the cap is only reached at the screen edges.
          const t = (e.clientX - centerX) / (window.innerWidth / 2);
          targetYaw = Math.max(-1, Math.min(1, t)) * MAX_YAW;
          stateRef.current.wake?.();
        };

        // Phones have no hover, so gamma (side-to-side tilt, degrees) stands in for the
        // mouse: ±25° of tilt from the holding angle covers the full yaw range. There's no
        // universal "neutral" grip, so the baseline is the first reading, then drifts
        // slowly toward the live angle -- shift how you're holding the phone and the shirt
        // eases back to center instead of sticking at the cap forever.
        let baseGamma = null;
        const onOrientation = e => {
          if (e.gamma == null) return;
          if (baseGamma === null) baseGamma = e.gamma;
          baseGamma += (e.gamma - baseGamma) * 0.01;
          const t = (e.gamma - baseGamma) / 25;
          targetYaw = Math.max(-1, Math.min(1, t)) * MAX_YAW;
          stateRef.current.wake?.();
        };
        const startOrientation = () => {
          window.addEventListener('deviceorientation', onOrientation);
          inputCleanups.push(() => window.removeEventListener('deviceorientation', onOrientation));
        };

        // Touch devices can also DRAG the shirt to rotate it -- clamped to ±40°
        // (wider than the ±25° ambient yaw, but not a free spin), returning to
        // forward-facing once the finger lifts. The shirt is still a shop link: a
        // press only becomes a drag past a horizontal 8px threshold (and only when
        // horizontal movement dominates -- vertical swipes stay with the page scroll
        // via touch-action: pan-y on the button, which fires pointercancel once the
        // browser takes the gesture), and a real drag suppresses the click that
        // fires on release. Allowed under prefers-reduced-motion (direct
        // manipulation, not ambient animation); the eased return is skipped there
        // in favor of an immediate reset.
        let dragYaw = 0;
        let dragging = false;
        if (isTouch) {
          const DRAG_THRESHOLD = 8;
          const DRAG_MAX_YAW = (40 * Math.PI) / 180;
          let pressed = false;
          let startX = 0;
          let startY = 0;
          let lastX = 0;
          const onPointerDown = e => {
            pressed = true;
            dragging = false;
            startX = lastX = e.clientX;
            startY = e.clientY;
          };
          const onPointerMove = e => {
            if (!pressed) return;
            if (!dragging) {
              const dxTotal = e.clientX - startX;
              if (
                Math.abs(dxTotal) < DRAG_THRESHOLD ||
                Math.abs(dxTotal) < Math.abs(e.clientY - startY)
              )
                return;
              dragging = true;
              dragSuppressClickRef.current = true;
              mount.setPointerCapture?.(e.pointerId);
              lastX = e.clientX;
              return;
            }
            const dx = e.clientX - lastX;
            const dYaw = dx * 0.012; // ~0.7° of spin per pixel
            dragYaw = Math.max(-DRAG_MAX_YAW, Math.min(DRAG_MAX_YAW, dragYaw + dYaw));
            stateRef.current.wake?.();
            lastX = e.clientX;
          };
          const onPointerEnd = () => {
            pressed = false;
            dragging = false;
            if (reducedMotion) dragYaw = 0;
          };
          mount.addEventListener('pointerdown', onPointerDown);
          mount.addEventListener('pointermove', onPointerMove);
          mount.addEventListener('pointerup', onPointerEnd);
          mount.addEventListener('pointercancel', onPointerEnd);
          inputCleanups.push(() => {
            mount.removeEventListener('pointerdown', onPointerDown);
            mount.removeEventListener('pointermove', onPointerMove);
            mount.removeEventListener('pointerup', onPointerEnd);
            mount.removeEventListener('pointercancel', onPointerEnd);
          });
        }

        if (!reducedMotion) {
          if (isTouch && typeof DeviceOrientationEvent !== 'undefined') {
            // Only where orientation works WITHOUT a permission prompt (Android). iOS 13+
            // gates it behind DeviceOrientationEvent.requestPermission(), which must be
            // called from a tap -- tried and user-rejected: the natural first tap is the
            // shirt itself, so the prompt appeared after navigating away to the shop.
            // A permission dialog isn't worth a decorative tilt; iOS gets a static shirt.
            if (typeof DeviceOrientationEvent.requestPermission !== 'function') {
              startOrientation();
            }
          } else {
            window.addEventListener('mousemove', onMouseMove);
            inputCleanups.push(() => window.removeEventListener('mousemove', onMouseMove));
          }
        }

        // Postprocessing chain for the generate-transition chromatic aberration. The
        // pass stays in the chain at uAmount 0 (visually identity) -- swapping between
        // composer/direct rendering per state isn't worth the branching at this size.
        //
        // The scene target carries a depth texture so the spark layer can test itself against
        // the garment (the composer clones it for its second buffer, depth texture included).
        const targetPx = canvasSize * renderer.getPixelRatio();
        const composer = new EffectComposer(
          renderer,
          new THREE.WebGLRenderTarget(targetPx, targetPx, {
            type: THREE.HalfFloatType,
            depthTexture: new THREE.DepthTexture(targetPx, targetPx)
          })
        );
        composer.setPixelRatio(renderer.getPixelRatio());
        composer.setSize(canvasSize, canvasSize);
        composer.addPass(new RenderPass(scene, camera));
        composer.addPass(swirl.pass);
        const aberrationPass = new ShaderPass(AberrationShader);
        aberrationPass.uniforms.uScale.value = canvasSize / size;
        aberrationPass.uniforms.tSparks.value = swirl.texture;
        composer.addPass(aberrationPass);
        let aberrationTween = null;
        let strikePending = false;
        // `from` re-strikes the uniform before the tween starts, for a caller that wants a
        // ramp DOWN from a known peak rather than from wherever the effect happens to be
        // sitting (the entrance does -- see revealShirt). It is a direct assignment rather
        // than a second setAberration call with duration 0, which does not work: the two
        // calls land in the same frame and the second kills the first before a zero-duration
        // tween has ticked, so the peak may never be reached at all.
        //
        // Any call that RAISES the effect -- a generate starting, or `from` re-striking it --
        // also strikes a fresh pulse, so every raise ripples however the ambient pulses happen
        // to fall (see AberrationShader's header). The easing down never strikes one.
        //
        // The pulse's start time is stamped by the first frame that actually DRAWS, not here.
        // A hero Generate kicks off the full-size artwork build on the main thread right after
        // this runs, and no frame renders until it yields -- measured up to 761ms on a real
        // click. Stamped here, the pulse would spend that stall invisibly expanding and show
        // up a third of the way through its life, past its strongest part.
        const setAberration = (value, duration, from) => {
          aberrationTween?.kill();
          stateRef.current.wake?.();
          if (value > 0 || from !== undefined) {
            aberrationPass.uniforms.uStrikeShape.value = [
              Math.random(),
              Math.random(),
              Math.random(),
              Math.random()
            ];
            strikePending = true;
            swirl.strike();
          }
          if (from !== undefined) aberrationPass.uniforms.uAmount.value = from;
          // Easing down flings the sparks outward as they fade, over the same span.
          if (value === 0) swirl.release();
          aberrationTween = gsap.to(aberrationPass.uniforms.uAmount, {
            value,
            duration,
            ease: value > 0 ? 'power2.out' : 'power2.inOut'
          });
        };

        // Two gates on the render loop, because neither is enough alone and this scene is the
        // most expensive thing on the page per frame (a RenderPass plus a full-screen
        // ShaderPass). It used to render unconditionally, 60 times a second, for as long as the
        // page was open -- including while you were reading About or sitting at the footer,
        // with a motionless shirt.
        //
        //   onScreen  -- the mount is actually in view. Nothing below matters if it isn't.
        //   settled   -- the shirt has reached its target angle and no effect is running, so
        //                consecutive frames would be identical.
        //
        // Any input, any generate, and any texture change has to clear `settled` or the change
        // never reaches the screen; `wake()` is that one door, and everything that mutates the
        // scene goes through it.
        let raf = 0;
        let onScreen = true;
        let settled = false;
        const wake = () => {
          settled = false;
          // Off-screen input still updates targetYaw and the texture -- it just doesn't get
          // rendered until the mount comes back, which the observer below handles. Without the
          // onScreen check here, every mousemove anywhere on the page would render one frame of
          // a shirt nobody can see.
          if (!raf && onScreen) raf = requestAnimationFrame(animate);
        };
        stateRef.current.wake = wake;

        function animate(now) {
          raf = 0;
          // After release, ease the drag rotation back to forward-facing.
          if (!dragging && dragYaw !== 0) {
            dragYaw *= 0.92;
            if (Math.abs(dragYaw) < 0.001) dragYaw = 0;
          }
          // Direct manipulation tracks the finger tightly; ambient follow stays lazy.
          const followRate = dragging ? 0.35 : 0.04;
          const before = pivot.rotation.y;
          pivot.rotation.y += (dragYaw + targetYaw - pivot.rotation.y) * followRate;
          aberrationPass.uniforms.uTime.value = now * 0.001;
          if (strikePending) {
            aberrationPass.uniforms.uStrike.value = now * 0.001;
            strikePending = false;
          }
          swirl.update(now * 0.001, aberrationPass.uniforms.uAmount.value);
          composer.render();
          // Idle only once the shirt has stopped moving AND the aberration pass is back at
          // identity -- its uTime drives a live distortion, so a non-zero uAmount means the
          // picture is still changing even with the shirt still.
          const still =
            !crossfadeTween &&
            !dragging &&
            dragYaw === 0 &&
            Math.abs(pivot.rotation.y - before) < 1e-4 &&
            aberrationPass.uniforms.uAmount.value < 1e-3 &&
            // The sparks' exit outlasts the pass's own ease-down.
            !swirl.busy(now * 0.001);
          settled = still;
          if (!settled && onScreen) raf = requestAnimationFrame(animate);
        }
        wake();

        // Scrolling away stops it outright; coming back resumes from wherever it was, which is
        // correct -- nothing here is driven by wall-clock time.
        const io = new IntersectionObserver(
          entries => {
            onScreen = entries[0]?.isIntersecting ?? true;
            if (onScreen) wake();
            else if (raf) {
              cancelAnimationFrame(raf);
              raf = 0;
            }
          },
          { rootMargin: '80px' }
        );
        io.observe(mount);
        inputCleanups.push(() => io.disconnect());

        // Crossfades over the same span as setSheet's texture crossfade.
        const setSparkPalette = colors => swirl.setPalette(colors, DURATION_SLOW);
        stateRef.current.api = { setSheet, setAberration, setSparkPalette };
        // If a generate is already in flight when the scene comes up, join it mid-state.
        if (stateRef.current.waiting) setAberration(ABERRATION_PEAK, DURATION_FAST);
        // The white tee is already on the canvas -- show the shirt now. hasTexture is set
        // here (not on the first design commit) so that first commit crossfades from
        // white instead of applying instantly.
        stateRef.current.sceneReady = true;
        stateRef.current.revealShirt?.();
        commitStagedSheet();

        cleanup = () => {
          stateRef.current.wake = null;
          cancelAnimationFrame(raf);
          inputCleanups.forEach(fn => fn());
          crossfadeTween?.kill();
          aberrationTween?.kill();
          stateRef.current.api = null;
          texture.dispose();
          envMap.dispose(); // PMREM render target texture -- not owned by any material
          materials.forEach(mat => mat.dispose());
          swirl.dispose();
          composer.dispose?.();
          renderer.dispose();
          // dispose() frees three's resources but leaves the WebGL CONTEXT alive until the
          // browser garbage-collects the canvas -- measured, every visit to the homepage added a
          // context and none was ever released. On a phone, where GPU memory is shared and
          // small, that stacks up on top of whatever the last page decoded (a mockup's photos)
          // and is the leading suspect for the hero stuttering after a trip to a product page
          // (Aaron, 2026-09-25). Losing it explicitly returns the memory now.
          renderer.forceContextLoss();
          if (renderer.domElement.parentNode === mount) mount.removeChild(renderer.domElement);
        };
      } catch (err) {
        console.error('TshirtPreview init failed:', err);
        if (!disposed) setFailed(true);
      }
    })();

    return () => {
      disposed = true;
      cleanup?.();
    };
  }, [size]);

  // Re-render the texture whenever the design changes. renderDesignBlob needs nothing
  // preloaded now that both star shapes are drawn from code, so there is no readiness gate.
  useEffect(() => {
    if (failed) return undefined;
    let cancelled = false;
    (async () => {
      try {
        const [baseBlob, bodyBlob, sleeveBlob] = await Promise.all([
          renderDesignBlob(currentDesign, TEXTURE_SIZE, TEXTURE_SIZE),
          renderDesignBlob(currentDesign, BODY_RENDER.w, BODY_RENDER.h),
          renderDesignBlob(currentDesign, SLEEVE_RENDER.w, SLEEVE_RENDER.h)
        ]);
        const [base, body, sleeve] = await Promise.all(
          [baseBlob, bodyBlob, sleeveBlob].map(b => createImageBitmap(b))
        );
        if (cancelled) return;
        const canvas = document.createElement('canvas');
        canvas.width = TEXTURE_SIZE;
        canvas.height = TEXTURE_SIZE;
        const ctx = canvas.getContext('2d');
        const sc = TEXTURE_SIZE / ATLAS;
        ctx.drawImage(base, 0, 0, TEXTURE_SIZE, TEXTURE_SIZE);
        // ONE composition per island family, cut along the real garment seams (see
        // compositionSplit and STRIP_ISLANDS above): a panel takes the first
        // panel.h / (panel.h + trim.h) of the fitted composition, and the trim sewn to it
        // takes the remainder. So the design genuinely RUNS ACROSS the hem and cuff seams --
        // the trim is showing rows the panel never drew, at the panel's own scale, at the
        // panel's own horizontal registration, none of which needs forcing: it falls out of
        // both slices coming from a single cover-fit of the combined region.
        //
        // THREE EARLIER ATTEMPTS FAILED HERE, 2026-09-04, all reported against the running
        // component. Worth reading, because two of them looked convincing on their own
        // evidence and the third is only "correct" if you accept a smear:
        // (1) Aaron: "the lower strip at the bottom of the shirt is off a bit and you see the
        //     design repeat by a little bit". Fixed the trim's horizontal sample window to
        //     match its panel's crop. Real, necessary, and nowhere near sufficient.
        // (2) Aaron: "it doesn't appear that anything has changed". Diagnosed as a vertical
        //     SCALE mismatch (the old flat 6%-of-height band did compress ~1.9x harder than
        //     the body panel, and ~1.8x LESS on a cuff) and fixed by deriving the band from
        //     the panel's own rate. Verified on the real mesh with a ruler pattern, which is
        //     the one test that cannot see the actual bug: a ruler is uniform along x.
        // (3) Tested against a converging star with its apex at the seam: the trim showed the
        //     star fanning back OUT and re-converging to a SECOND, smaller apex. THE CAUSE,
        //     which no scale factor addresses: the panel was cover-fit to its OWN rect, so it
        //     consumed the whole composition, and every one of these attempts then had to
        //     invent trim content by re-sampling rows the panel had ALREADY drawn. Shrinking
        //     that band to a 3px sliver (attempt 3) does kill the repeat, but only by
        //     stretching one row flat -- Aaron: "the design appearing to melt across it".
        // The fix is to stop taking the whole composition for the panel in the first place.
        // Nothing is re-sampled, so nothing can repeat, and nothing is stretched, so nothing
        // melts.
        const drawPanels = (islands, flips, img, from) =>
          islands.forEach((r, i) => {
            const { sx, sy, sw, panelSh } = compositionSplit(img, r, continuationFor(from, i));
            drawSlice(ctx, img, sx, sy, sw, panelSh, r.x * sc, r.y * sc, r.w * sc, r.h * sc, {
              flipY: true,
              flipX: flips[i]
            });
          });
        // flipX per BODY_FLIP/SLEEVE_FLIP mirrors BODY_ISLANDS[1] (the back panel), matching
        // what a real order does by default (Aaron, 2026-08-02), and neither sleeve, matching
        // what a real order's identical sleeve_left/sleeve_right uploads produce once Printful
        // sews them (Aaron, 2026-09-04) -- see the long note below STRIP_ISLANDS.
        drawPanels(BODY_ISLANDS, BODY_FLIP, body, 'body');
        drawPanels(SLEEVE_ISLANDS, SLEEVE_FLIP, sleeve, 'sleeve');
        // A trim strip that `continues` its panel takes the leftover slice exactly; the
        // collars, whose seam is a curve rather than a rect edge (see STRIP_ISLANDS), keep a
        // thin edge slice, small enough that no 2D structure can show across it.
        const EDGE_SLICE_SRC_PX = 3;
        STRIP_ISLANDS.forEach(s => {
          const img = s.from === 'body' ? body : sleeve;
          const islands = s.from === 'body' ? BODY_ISLANDS : SLEEVE_ISLANDS;
          const flips = s.from === 'body' ? BODY_FLIP : SLEEVE_FLIP;
          const panel = islands[s.island];
          // The horizontal `flip` matches a strip to a panel that is itself drawn mirrored,
          // read from BODY_FLIP/SLEEVE_FLIP via `s.island` so it cannot go stale against its
          // panel's own flip the way a separately-hardcoded bool already did once. Measured
          // to be right rather than inherited: every hem/cuff seam runs its u-axis in the
          // SAME direction on both sides (fitted slope +1.00, r^2 = 1.00), so a mirrored
          // panel needs an equally mirrored trim to meet it.
          const flip = flips[s.island];
          const { sx, sy, sw, sh, panelSh } = compositionSplit(
            img,
            panel,
            continuationFor(s.from, s.island)
          );
          if (s.continues) {
            // Exactly the rows the panel did not draw. No overdraw on the seam edge: the
            // measured seam sits ~2px INSIDE both rects already, so the bbox is a hair
            // generous, and an exact edge is what keeps registration exact.
            drawSlice(
              ctx,
              img,
              sx,
              sy + panelSh,
              sw,
              sh - panelSh,
              s.x * sc - 2,
              s.y * sc,
              s.w * sc + 4,
              s.h * sc,
              { flipY: true, flipX: flip }
            );
            return;
          }
          // Collar: a thin slice off the composition's own top (the neckline end), stretched
          // over the band. flipY is NOT applied here -- measured, the collars are the one
          // family whose seam sits on their rect's TOP edge, so the seam-adjacent row has to
          // land at the top. Unobservable either way at a 3px slice, but correct costs
          // nothing. Overdraw stays on all four sides since this one is approximate anyway.
          drawSlice(
            ctx,
            img,
            sx,
            sy,
            sw,
            EDGE_SLICE_SRC_PX,
            s.x * sc - 2,
            s.y * sc - 2,
            s.w * sc + 4,
            s.h * sc + 4,
            { flipX: flip }
          );
        });
        [base, body, sleeve].forEach(b => b.close());
        stateRef.current.stagedSheet = canvas;
        stateRef.current.stagedPalette = resolvedPalette(currentDesign);
        commitStagedSheet();
      } catch {
        /* render assets mid-load or bitmap decode failure -- keep the previous texture */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [currentDesign, renderDesignBlob, failed]);

  if (failed) return null;

  // The shirt is a link to the shop -- the design carries over via StudioContext
  // (ProductPage's default artwork choice is the current studio design). The hover hint
  // label is the discoverability cue; the WebGL mount stays aria-hidden (decorative)
  // while the button carries the accessible name. The hover scale lives on the button,
  // not the mount div, because GSAP owns the mount's inline transform (entrance fade)
  // and inline styles would override a CSS hover transform there.
  return (
    <button
      type="button"
      onClick={() => {
        // A touch-drag spin ends in a click on release -- that's rotation, not a
        // navigation intent; only a clean tap/click goes to the shop.
        if (dragSuppressClickRef.current) {
          dragSuppressClickRef.current = false;
          return;
        }
        onShopClick?.();
      }}
      aria-label="Shop this design on merch"
      className="tshirt-preview-btn group relative shrink-0 cursor-pointer border-0 bg-transparent p-0 transition-transform duration-300 hover:scale-[1.04]"
      style={{ width: size, height: size, touchAction: 'pan-y' }}
    >
      <div
        ref={mountRef}
        aria-hidden
        className="tshirt-preview h-full w-full"
        style={{ opacity: 0 }}
      />
      <span className="tshirt-shop-hint" aria-hidden>
        Shop <ArrowIcon size={12} />
      </span>
    </button>
  );
}
