import React, { useEffect, useRef, useState } from 'react';
import { gsap } from 'gsap/all';
import ArrowIcon from './buttons/ArrowIcon';
import { useStudio } from '../context/StudioContext';
import { DURATION_FAST, DURATION_SLOW } from '../utils/motionTokens';
import { capMockupRenderSize } from '../lib/printful';
import { resolvedPalette } from '../render/resolvedPalette';
import { PRIORITY_SHIRT } from '../render/renderOffThread';
import { NEBULA_PIXELS_LITE } from '../render/nebula';

// The shirt's texture renders: ahead of the hero in the render worker, so the sheet is ready on
// the hero's reveal beat (render/renderOffThread.js PRIORITY_SHIRT), with the decorative nebula
// area (render/nebula.js NEBULA_PIXELS_LITE) -- the shirt is drawn about 190px tall.
const SHIRT_RENDER = { priority: PRIORITY_SHIRT, nebulaPixels: NEBULA_PIXELS_LITE };
import { createTshirtSwirl } from './tshirtSwirl';
import { addStudioLighting, makeFabricTexture, applyFabricToShells } from './shirtStudio';

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
// 4717KB across 5 requests (scene.gltf + scene.bin + 3 textures) -> 713KB in one. The
// source asset is scan-density -- 154,048 triangles -- so it is welded, simplified to 30%
// (46,211 tris), and meshopt-compressed (which quantizes too), with the textures embedded.
// Rebuild with:
//   gltf-transform dedup  in.gltf p1.glb   &&  gltf-transform weld     p1.glb p2.glb
//   gltf-transform simplify p2.glb p3.glb --ratio 0.3 --error 0.001
//   gltf-transform meshopt  p3.glb tshirt.glb --level medium
// NO prune after meshopt: prune decodes the compression and writes the file back out at full
// size. The unmodified original is kept at src/assets/models/tshirt/ as the archival source.
//
// It was simplified to 10% until 2026-10-26, which looked fine at a glance and broke the
// SLEEVE OPENINGS and HEM into sharp fragments (Aaron: "visibly broken with sharp bits"). The
// shards are the inside of the cuff seen through the opening, not the edge itself, so locking
// the mesh border does not help (tried at 10%, 15% and 20%); they are gone from 30% up,
// compared against full detail. Meshopt is what pays for it: 30% compressed is smaller than
// 10% was uncompressed (713KB against 726KB).
//
// Two properties this pipeline had to preserve, since everything below depends on them:
// the UV LAYOUT (island rects are measured in atlas space -- simplification must not move
// them; verified identical bounds before/after, modulo ~0.0002 of int16 quantization
// rounding, i.e. sub-pixel on a 2048 sheet) and the MATERIAL NAMES/mesh split, which the
// traverse below relies on. Both checked on the 30% build: the same two meshes and material,
// and the texture lands where it did. EXT_meshopt_compression needs three's decoder
// (setMeshoptDecoder, ~8KB gzipped, loaded in the same lazy chunk as three itself) -- skipped
// for the 10% build as not worth it for one small model, worth it once it bought the edges.
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
export const TEXTURE_SIZE = 1024;
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
export const BODY_RENDER = { w: bodyCap.width, h: bodyCap.height };
export const SLEEVE_RENDER = { w: sleeveCap.width, h: sleeveCap.height };

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
export const SWIRL_ROOM = 1.5;
const PULSE_RATE = 0.45; // pulse cycles per second, shared by the ambient and struck pulses
export const AberrationShader = {
  uniforms: {
    tDiffuse: { value: null },
    uAmount: { value: 0 },
    uTime: { value: 0 },
    // uTime at the last strike; far in the past until the first one, so it never fires.
    uStrike: { value: -1e4 },
    // The struck pulse's random draws, made in JS per strike: origin/lobe phases (x, y),
    // reach (z) and strength (w). Same roles as an ambient pulse's h1/h2/h3.
    uStrikeShape: { value: [0.5, 0.5, 0.5, 0.5] },
    // Where the struck pulse starts, in the shirt's box (0..1, y up). Negative means "derive it
    // from uStrikeShape like an ambient pulse", which is what a generate strike and the explainer
    // Reel use; the press-and-hold release sets it to the finger.
    uStrikeOrigin: { value: [-1, -1] },
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
    uniform vec2 uStrikeOrigin;
    uniform float uScale;
    uniform sampler2D tSparks;
    varying vec2 vUv;

    const float PULSE_RATE = ${PULSE_RATE.toFixed(4)};

    float hash(float n) { return fract(sin(n * 78.233) * 43758.5453); }

    // One expanding wavefront at phase (0..1 through its life). h1..h3 are its random
    // draws: origin and lobe phases, width, reach.
    vec2 pulseAt(vec2 uv, vec2 origin, float phase, float h1, float h2, float h3, float amp) {
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
    vec2 pulse(vec2 uv, float phase, float h1, float h2, float h3, float amp) {
      return pulseAt(uv, vec2(0.5) + (vec2(h1, h2) - 0.5) * 0.34, phase, h1, h2, h3, amp);
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
        vec2 so = uStrikeOrigin.x < 0.0
          ? vec2(0.5) + (uStrikeShape.xy - 0.5) * 0.34
          : uStrikeOrigin;
        push += pulseAt(uv, so, sp, uStrikeShape.x, uStrikeShape.y, uStrikeShape.z,
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

// The texture sheet for one design: its three renders (`base` at `size` square, `body` at
// BODY_RENDER, `sleeve` at SLEEVE_RENDER) composited into the model's atlas, `size` square.
// Exported for the ad builder's explainer (adBuilder/explainShirt.js), which wears a design on
// this same model at a larger sheet size.
export function composeShirtSheet(base, body, sleeve, size = TEXTURE_SIZE) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const sc = size / ATLAS;
  ctx.drawImage(base, 0, 0, size, size);
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
  return canvas;
}

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
  // Set the moment a press turns into a drag or a real charge (see PLAY), so the click that
  // fires on release doesn't ALSO navigate to the shop (see the button's onClick).
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
        const [
          THREE,
          { GLTFLoader },
          { MeshoptDecoder },
          { EffectComposer },
          { RenderPass },
          { ShaderPass },
          { Pass }
        ] = await Promise.all([
          import('three'),
          import('three/examples/jsm/loaders/GLTFLoader.js'),
          import('three/examples/jsm/libs/meshopt_decoder.module.js'),
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
        // there has an edge -- the shirt renders into the composer's target (multisampled
        // itself, see below) and only the aberration pass's full-screen quad reaches the
        // canvas. So it bought nothing (verified pixel-identical without it) while costing
        // ~10MB of GPU memory per context at a phone's pixel ratio.
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
        const scene = new THREE.Scene();
        // 28deg across the shirt's own box, widened to the whole canvas (see SWIRL_ROOM).
        const fov =
          (2 * Math.atan((canvasSize / size) * Math.tan((14 * Math.PI) / 180)) * 180) / Math.PI;
        const camera = new THREE.PerspectiveCamera(fov, 1, 0.05, 50);
        // The explainer Reel's studio lighting and jersey fabric, shared with it (2026-10-27,
        // Aaron: "the shirt just looks so good in the video it would be nice to match that
        // lighting and texture"). This replaced a calibration that matched every texel to the
        // wall behind it; see shirtStudio.js for the trade.
        const disposeLighting = addStudioLighting(THREE, scene, renderer);

        const gltf = await new GLTFLoader()
          .setMeshoptDecoder(MeshoptDecoder)
          .loadAsync('/models/tshirt/tshirt.glb');
        if (disposed) {
          disposeLighting();
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

        // The model ships a Physical outer shell and a Standard lining; applyFabric promotes the
        // Standard one, since sheen exists only on MeshPhysicalMaterial. Only the outer shell
        // wears the design (`printed`); the lining keeps its own blank sheet.
        const fabric = makeFabricTexture(THREE, renderer);
        const { materials, printed } = applyFabricToShells(THREE, gltf.scene, fabric);

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
        const originalImage = printed.find(mat => mat.map?.image)?.map?.image;
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
        printed.forEach(mat => {
          const old = mat.map;
          mat.map = texture;
          // The press-and-hold charge makes the shirt glow with its own artwork. Set up here,
          // at zero, so the program is compiled with the emissive map from the start (a first
          // charge would otherwise recompile mid-gesture) -- white x 0 adds exactly nothing.
          mat.emissive.set(0xffffff);
          mat.emissiveMap = texture;
          mat.emissiveIntensity = 0;
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

        // No idle spin -- the shirt faces forward and turns slowly toward the mouse on a
        // desktop, capped at ±25° of yaw either way. Static under prefers-reduced-motion.
        // Phones have no hover and no ambient motion: they play with it directly (see PLAY).
        // (An Android-only follow of the phone's left/right tilt was removed 2026-11-24 --
        // iOS needs a permission prompt for it, so it never reached most visitors, and it
        // was never tested on a real device.)
        const MAX_YAW = (25 * Math.PI) / 180;
        const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        const isTouch = window.matchMedia('(pointer: coarse)').matches;
        let targetYaw = 0;
        const inputCleanups = [];

        const onMouseMove = e => {
          // A held mouse button is a drag or a charge; the hover follow sits it out.
          if (pressed) return;
          const rect = renderer.domElement.getBoundingClientRect();
          const centerX = rect.left + rect.width / 2;
          // Normalize by half the viewport so the cap is only reached at the screen edges.
          const t = (e.clientX - centerX) / (window.innerWidth / 2);
          targetYaw = Math.max(-1, Math.min(1, t)) * MAX_YAW;
          stateRef.current.wake?.();
        };

        // PLAY (2026-11-24, Aaron: "make it more fun to play with"). Mouse and touch share one
        // model, all of it stepped per frame in stepPlay() below:
        //  - DRAG spins the shirt freely, with no limit, and vertical movement during a drag
        //    tips it forward or back (up to MAX_PITCH), springing level on release.
        //  - A FLICK keeps it spinning. Friction slows it, and a spring settles it onto the
        //    nearer side -- front or back -- with a little overshoot.
        //  - SPEED shows: the glitch pass rises with it, and a fast spin throws off a spark
        //    swarm orbiting the way the shirt turns.
        //  - PRESS AND HOLD still for HOLD_DELAY charges it: it squashes, trembles and glows
        //    with its own artwork. Letting go sends a shockwave out from the finger and flings
        //    the shirt into a spin away from the side that was pressed.
        // The shirt is still a shop link, so a press that becomes neither a drag nor a real
        // charge is a click. On touch a press becomes a drag only past DRAG_THRESHOLD of mostly
        // HORIZONTAL movement, so a vertical swipe still scrolls the page (touch-action: pan-y
        // on the button); once a drag or a charge owns the gesture its touchmoves are cancelled,
        // so the page cannot start scrolling under it. Under prefers-reduced-motion, dragging
        // and tilting still work (direct manipulation) but nothing coasts, bounces, charges or
        // glitches: a release snaps to the nearer side.
        const DRAG_THRESHOLD = 8;
        const SPIN_PER_PX = 0.012; // ~0.7deg of spin per pixel
        const PITCH_PER_PX = 0.006;
        const MAX_PITCH = (15 * Math.PI) / 180;
        const MAX_FLICK = 40; // rad/s, ~6 turns a second
        // A flick is the speed of the last moves; a finger that stopped before lifting has none.
        const FLICK_STALE_MS = 90;
        const FRICTION = 1.1; // per second: a hard flick coasts about two turns
        // The settle spring takes over below ~6 rad/s, slightly underdamped so it overshoots
        // the face once and comes back.
        const SETTLE_K = 40;
        const SETTLE_C = 7.5;
        const PITCH_K = 140;
        const PITCH_C = 13;
        const HOLD_DELAY = 220; // ms still before a press starts charging
        const CHARGE_TIME = 1.1; // s to full charge
        const CHARGE_DECAY = 0.35; // s to empty after release
        // A press shorter than this much charge is still a click (a slow mouse click charges a
        // touch before the button comes up; it must still reach the shop).
        const CHARGE_COMMIT = 0.12;
        const SQUASH_K = 220;
        const SQUASH_C = 9;
        const GLOW_MAX = 0.4;
        // Spin speed (rad/s) to glitch strength, and its ceiling: well under a generate's peak.
        const SPIN_FX_LOW = 5;
        const SPIN_FX_HIGH = 22;
        const SPIN_FX_MAX = 0.55;
        const SPARK_SPIN_SPEED = 1.6; // a spin's swarm orbits faster than a generate's

        const button = /** @type {HTMLElement} */ (mount.parentElement);
        const smoothstep = (a, b, x) => {
          const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
          return t * t * (3 - 2 * t);
        };
        const nearestFace = a => Math.round(a / Math.PI) * Math.PI;

        let pressed = false;
        let dragging = false;
        let charging = false;
        let pointerKind = '';
        let startX = 0;
        let startY = 0;
        let lastX = 0;
        let lastY = 0;
        let pressAt = 0;
        let pressU = 0.5;
        let pressV = 0.5;
        let lastMoveAt = 0;
        let moveVel = 0; // rad/s, measured from the finger while dragging
        let spin = 0;
        let spinTarget = 0;
        let spinVel = 0;
        let pitch = 0;
        let pitchVel = 0;
        let pitchTarget = 0;
        let charge = 0;
        let squash = 0;
        let squashVel = 0;
        let ambientYaw = 0;
        // Spark swarms launched by play rather than by a generate (see stepPlay).
        let spinSwarm = false;
        let spinArmed = true;

        const onPointerDown = e => {
          if (e.button !== 0) return; // primary only; a right-click keeps its menu
          pressed = true;
          dragging = false;
          charging = false;
          // A new press: whatever the last one suppressed is over, even if its click never came.
          dragSuppressClickRef.current = false;
          pointerKind = e.pointerType;
          startX = lastX = e.clientX;
          startY = lastY = e.clientY;
          pressAt = lastMoveAt = performance.now();
          moveVel = 0;
          const r = mount.getBoundingClientRect();
          pressU = (e.clientX - r.left) / r.width;
          pressV = 1 - (e.clientY - r.top) / r.height;
          stateRef.current.wake?.();
        };
        const onPointerMove = e => {
          if (!pressed) return;
          if (!dragging) {
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;
            const far =
              pointerKind === 'mouse'
                ? Math.hypot(dx, dy) >= DRAG_THRESHOLD
                : Math.abs(dx) >= DRAG_THRESHOLD && Math.abs(dx) >= Math.abs(dy);
            if (!far) return;
            dragging = true;
            charging = false; // a charge that starts moving becomes a drag; it just drains
            dragSuppressClickRef.current = true;
            mount.setPointerCapture?.(e.pointerId);
            spinTarget = spin;
            spinVel = 0;
            lastX = e.clientX;
            lastY = e.clientY;
            lastMoveAt = performance.now();
            if (pointerKind === 'mouse') button.style.cursor = 'grabbing';
            return;
          }
          const now = performance.now();
          const dYaw = (e.clientX - lastX) * SPIN_PER_PX;
          spinTarget += dYaw;
          pitchTarget = Math.max(
            -MAX_PITCH,
            Math.min(MAX_PITCH, pitchTarget + (e.clientY - lastY) * PITCH_PER_PX)
          );
          const dt = Math.max(now - lastMoveAt, 1) / 1000;
          moveVel = Math.max(-MAX_FLICK, Math.min(MAX_FLICK, moveVel * 0.6 + (dYaw / dt) * 0.4));
          lastMoveAt = now;
          lastX = e.clientX;
          lastY = e.clientY;
          stateRef.current.wake?.();
        };
        const endPress = released => {
          if (!pressed) return;
          pressed = false;
          if (dragging) {
            dragging = false;
            const stale = performance.now() - lastMoveAt > FLICK_STALE_MS;
            spinVel = stale ? 0 : moveVel;
            pitchTarget = 0;
            if (reducedMotion) {
              spin = spinTarget = nearestFace(spinTarget);
              spinVel = 0;
              pitch = pitchVel = 0;
            }
          } else if (charging) {
            charging = false;
            if (released && charge >= CHARGE_COMMIT) burst();
          }
          button.style.cursor = '';
          stateRef.current.wake?.();
        };
        const onPointerUp = () => endPress(true);
        const onPointerCancel = () => endPress(false);
        // Keeps the page from scrolling under a gesture the shirt already owns (non-passive).
        const onTouchMove = e => {
          if (dragging || charging) e.preventDefault();
        };
        // Android raises the context menu on a long press -- which is a charge here.
        const onContextMenu = e => {
          if (pressed) e.preventDefault();
        };
        mount.addEventListener('pointerdown', onPointerDown);
        mount.addEventListener('pointermove', onPointerMove);
        mount.addEventListener('pointerup', onPointerUp);
        mount.addEventListener('pointercancel', onPointerCancel);
        mount.addEventListener('touchmove', onTouchMove, { passive: false });
        mount.addEventListener('contextmenu', onContextMenu);
        inputCleanups.push(() => {
          mount.removeEventListener('pointerdown', onPointerDown);
          mount.removeEventListener('pointermove', onPointerMove);
          mount.removeEventListener('pointerup', onPointerUp);
          mount.removeEventListener('pointercancel', onPointerCancel);
          mount.removeEventListener('touchmove', onTouchMove);
          mount.removeEventListener('contextmenu', onContextMenu);
        });

        // Not on touch screens: a tap there sends emulated mouse events, which would jerk the
        // follow toward wherever the finger landed.
        if (!reducedMotion && !isTouch) {
          window.addEventListener('mousemove', onMouseMove);
          inputCleanups.push(() => window.removeEventListener('mousemove', onMouseMove));
        }

        // Postprocessing chain for the generate-transition chromatic aberration. The
        // pass stays in the chain at uAmount 0 (visually identity) -- swapping between
        // composer/direct rendering per state isn't worth the branching at this size.
        //
        // The scene target carries a depth texture so the spark layer can test itself against
        // the garment (resolved from the multisampled depth, which three does by default).
        //
        // It is MULTISAMPLED (2026-10-20, Aaron: the shirt "feels a bit low res" next to the
        // rest of the site on a desktop). Nothing else antialiases the garment, so its outline
        // was stair-stepped -- collar, shoulders, sleeves -- most visibly at 1x, beside an
        // artwork downscaled from 4K. Only this one target ever holds the scene: the last pass
        // below does not swap, so the composer's second buffer (a clone) is never drawn into,
        // and three never allocates GPU memory for it.
        const targetPx = canvasSize * renderer.getPixelRatio();
        const composer = new EffectComposer(
          renderer,
          new THREE.WebGLRenderTarget(targetPx, targetPx, {
            type: THREE.HalfFloatType,
            samples: 4,
            depthTexture: new THREE.DepthTexture(targetPx, targetPx)
          })
        );
        composer.setPixelRatio(renderer.getPixelRatio());
        composer.setSize(canvasSize, canvasSize);
        composer.addPass(new RenderPass(scene, camera));
        composer.addPass(swirl.pass);
        const aberrationPass = new ShaderPass(AberrationShader);
        // It draws to the screen, so there is nothing to swap (see the scene target above).
        aberrationPass.needsSwap = false;
        aberrationPass.uniforms.uScale.value = canvasSize / size;
        aberrationPass.uniforms.tSparks.value = swirl.texture;
        composer.addPass(aberrationPass);
        let aberrationTween = null;
        let strikePending = false;
        // The pass's strength is the largest of what wants it: a generate (genFx, tweened here),
        // the shirt's own spin speed, a press-and-hold charge, and the burst its release fires.
        // Each frame writes the max into uAmount, so play never fights a generate for it.
        const genFx = { value: 0 };
        const burstFx = { value: 0 };
        let burstTween = null;
        let genActive = false;
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
          genActive = value > 0;
          if (value > 0 || from !== undefined) {
            aberrationPass.uniforms.uStrikeOrigin.value = [-1, -1];
            aberrationPass.uniforms.uStrikeShape.value = [
              Math.random(),
              Math.random(),
              Math.random(),
              Math.random()
            ];
            strikePending = true;
            swirl.strike();
            // The generate owns the swarm now; play's release must not end it.
            spinSwarm = false;
          }
          if (from !== undefined) genFx.value = from;
          // Easing down flings the sparks outward as they fade, over the same span.
          if (value === 0) swirl.release();
          aberrationTween = gsap.to(genFx, {
            value,
            duration,
            ease: value > 0 ? 'power2.out' : 'power2.inOut'
          });
        };

        // The release of a charged press: a shockwave from the finger, a spin away from the side
        // that was pressed (pushing the shirt's right edge turns it the way a push would), and a
        // spark swarm unless a generate already has one going.
        const burst = () => {
          const c = charge;
          const side = pressU - 0.5;
          const dir = Math.abs(side) < 0.08 ? (Math.random() < 0.5 ? -1 : 1) : Math.sign(side);
          spinVel = dir * (6 + 18 * c);
          const u = aberrationPass.uniforms;
          u.uStrikeOrigin.value = [Math.min(1, Math.max(0, pressU)), Math.min(1, Math.max(0, pressV))];
          u.uStrikeShape.value = [Math.random(), Math.random(), 0.5 + 0.5 * c, Math.random()];
          strikePending = true;
          burstTween?.kill();
          burstFx.value = 0.25 + 0.55 * c;
          burstTween = gsap.to(burstFx, { value: 0, duration: 1.4, ease: 'power2.out' });
          if (!genActive) {
            swirl.strike(-dir, SPARK_SPIN_SPEED);
            spinSwarm = true;
            spinArmed = false;
          }
        };

        // One frame of play (see PLAY above). Returns true while anything is still moving.
        let spinFx = 0;
        let swarmReleasing = false;
        const stepPlay = (now, dt) => {
          const t = now * 0.001;
          // Press and hold.
          if (pressed && !dragging && !charging && !reducedMotion && now - pressAt >= HOLD_DELAY) {
            charging = true;
          }
          if (charging) {
            charge = Math.min(1, charge + dt / CHARGE_TIME);
            if (charge >= CHARGE_COMMIT) dragSuppressClickRef.current = true;
          } else if (charge > 0) charge = Math.max(0, charge - dt / CHARGE_DECAY);
          const squashTarget = charging ? charge : 0;
          squashVel += (SQUASH_K * (squashTarget - squash) - SQUASH_C * squashVel) * dt;
          squash += squashVel * dt;
          if (!charging && Math.abs(squash) < 1e-4 && Math.abs(squashVel) < 1e-3) squash = squashVel = 0;

          // Spin: the finger while dragging; afterwards coast, then settle onto a face.
          if (dragging) {
            spin += (spinTarget - spin) * (1 - Math.exp(-26 * dt));
          } else if (spinVel !== 0 || spin !== nearestFace(spin)) {
            spinVel *= Math.exp(-FRICTION * dt);
            const settle = 1 - smoothstep(2.5, 6, Math.abs(spinVel));
            if (settle > 0) {
              spinVel += settle * (-SETTLE_K * (spin - nearestFace(spin)) - SETTLE_C * spinVel) * dt;
            }
            spin += spinVel * dt;
            if (Math.abs(spinVel) < 0.002 && Math.abs(spin - nearestFace(spin)) < 5e-4) {
              // Back to 0 or PI: whole turns are invisible, and the numbers stay small.
              spin = (Math.abs(Math.round(spin / Math.PI)) % 2) * Math.PI;
              spinVel = 0;
            }
          }

          // Tilt.
          pitchVel += (PITCH_K * (pitchTarget - pitch) - PITCH_C * pitchVel) * dt;
          pitch += pitchVel * dt;
          if (!dragging && Math.abs(pitch) < 1e-4 && Math.abs(pitchVel) < 1e-3) pitch = pitchVel = 0;

          // The ambient follow (mouse or phone tilt) stays lazy.
          ambientYaw += (targetYaw - ambientYaw) * (1 - Math.exp(-2.45 * dt));
          if (Math.abs(targetYaw - ambientYaw) < 1e-4) ambientYaw = targetYaw;

          pivot.rotation.y = spin + ambientYaw;
          pivot.rotation.x = pitch;
          // A charge trembles, harder as it fills.
          pivot.rotation.z = charge > 0 ? Math.sin(t * 47) * 0.014 * charge * charge : 0;
          pivot.scale.set(1 + 0.04 * squash, 1 - 0.08 * squash, 1 + 0.04 * squash);
          const glow = GLOW_MAX * charge * charge;
          printed.forEach(mat => {
            mat.emissiveIntensity = glow;
          });

          // Speed -> glitch and sparks.
          const speed = dragging
            ? now - lastMoveAt > FLICK_STALE_MS
              ? 0
              : Math.abs(moveVel)
            : Math.abs(spinVel);
          const dir = (dragging ? moveVel : spinVel) > 0 ? -1 : 1;
          spinFx = reducedMotion ? 0 : SPIN_FX_MAX * smoothstep(SPIN_FX_LOW, SPIN_FX_HIGH, speed);
          swarmReleasing = false;
          if (!reducedMotion) {
            if (spinSwarm && speed < SPIN_FX_LOW) {
              swirl.release();
              spinSwarm = false;
              swarmReleasing = true;
            } else if (!spinSwarm && !genActive && spinArmed && spinFx > SPIN_FX_MAX * 0.5) {
              swirl.strike(dir, SPARK_SPIN_SPEED);
              spinSwarm = true;
              spinArmed = false;
            }
            // Re-arms only once the spin has properly slowed, so a swarm a generate just let go
            // of is not replaced on the spot by a new one.
            if (!spinSwarm && spinFx < SPIN_FX_MAX * 0.15) spinArmed = true;
          }

          return (
            pressed ||
            dragging ||
            charge > 0 ||
            squash !== 0 ||
            spinVel !== 0 ||
            spin !== nearestFace(spin) ||
            pitch !== 0 ||
            pitchVel !== 0 ||
            ambientYaw !== targetYaw ||
            spinFx > 0 ||
            swarmReleasing
          );
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

        // The physics steps by real time (so a 120Hz phone plays like a 60Hz one), clamped so a
        // frame after a stall or a sleep cannot fling anything.
        let lastFrame = 0;
        function animate(now) {
          raf = 0;
          const dt = lastFrame ? Math.min(0.05, Math.max(0, (now - lastFrame) / 1000)) : 1 / 60;
          lastFrame = now;
          const playing = stepPlay(now, dt);
          const amount = Math.max(
            genFx.value,
            spinFx,
            burstFx.value,
            reducedMotion ? 0 : 0.3 * charge * charge
          );
          aberrationPass.uniforms.uAmount.value = amount;
          aberrationPass.uniforms.uTime.value = now * 0.001;
          if (strikePending) {
            aberrationPass.uniforms.uStrike.value = now * 0.001;
            strikePending = false;
          }
          // A play swarm's release is never "an effect that ended off screen" (see update()).
          swirl.update(now * 0.001, swarmReleasing ? 1 : amount);
          composer.render();
          // Idle only once the shirt has stopped moving AND the aberration pass is back at
          // identity -- its uTime drives a live distortion, so a non-zero uAmount means the
          // picture is still changing even with the shirt still.
          const still =
            !crossfadeTween &&
            !playing &&
            amount < 1e-3 &&
            // The sparks' exit outlasts the pass's own ease-down.
            !swirl.busy(now * 0.001);
          settled = still;
          if (settled) lastFrame = 0;
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
              lastFrame = 0;
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
          burstTween?.kill();
          stateRef.current.api = null;
          texture.dispose();
          disposeLighting();
          fabric.dispose();
          materials.forEach(mat => {
            if (mat.map !== texture) mat.map?.dispose(); // the lining's own sheet
            mat.dispose();
          });
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
    // Cancelled with the effect: a shirt that has unmounted (the visitor left the homepage) or
    // moved on to a newer design takes its three renders out of the queue.
    const abort = new AbortController();
    const opts = { ...SHIRT_RENDER, signal: abort.signal };
    (async () => {
      try {
        const [baseBlob, bodyBlob, sleeveBlob] = await Promise.all([
          renderDesignBlob(currentDesign, TEXTURE_SIZE, TEXTURE_SIZE, opts),
          renderDesignBlob(currentDesign, BODY_RENDER.w, BODY_RENDER.h, opts),
          renderDesignBlob(currentDesign, SLEEVE_RENDER.w, SLEEVE_RENDER.h, opts)
        ]);
        const [base, body, sleeve] = await Promise.all(
          [baseBlob, bodyBlob, sleeveBlob].map(b => createImageBitmap(b))
        );
        if (cancelled) return;
        const canvas = composeShirtSheet(base, body, sleeve);
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
      abort.abort();
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
        // A drag or a charged press ends in a click on release -- that's play, not a
        // navigation intent; only a clean tap/click goes to the shop.
        if (dragSuppressClickRef.current) {
          dragSuppressClickRef.current = false;
          return;
        }
        onShopClick?.();
      }}
      aria-label="Shop this design on merch"
      className="tshirt-preview-btn group relative shrink-0 cursor-pointer border-0 bg-transparent p-0 transition-transform duration-300 hover:scale-[1.04]"
      style={{
        width: size,
        height: size,
        touchAction: 'pan-y',
        // A long press is a charge (see PLAY), not a text selection or a callout.
        userSelect: 'none',
        WebkitUserSelect: 'none',
        WebkitTouchCallout: 'none'
      }}
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
