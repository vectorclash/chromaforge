// Pure compositor — rasterises a composition config (from generateArtwork) into a single
// canvas at config.width x config.height. The lone browser dependency is `document`
// (createElement) and the layer renderers; isolating it here means the same pipeline can
// be pointed at a screen-size, a thumbnail, or a 4200x5400 print canvas with no other
// changes. It takes no assets: both star shapes are drawn from code (render/starSprite.js),
// so a render needs nothing preloaded and can run the instant a config exists. This used to
// take an `images` argument carrying the two star PNGs through a createjs LoadQueue.

import LinearGradient from '../components/Canvas/LinearGradient';
import { largeRadialFieldSteps } from '../components/Canvas/LargeRadialField';
import StarField from '../components/Canvas/StarField';
import GeometricShape from '../components/Canvas/GeometricShape';

function clearElement(el) {
  el.width = 0;
  el.height = 0;
}

// The compositor is written ONCE, as a sequence of steps with a `yield` between each layer, and
// both entry points below drive that same sequence -- so the stepwise version cannot drift from
// the synchronous one: same draw calls, same order, same state, only with pauses in between.
// (A layer's own work -- building it and compositing it -- is never split: the pauses fall
// strictly between layers, where the context holds no half-finished state.)
// Composites a finished layer. With `bands` of 1 this is exactly the plain drawImage(el, 0, 0)
// the compositor has always made -- which is what the synchronous path always passes, so print
// files are unchanged by construction. The stepwise path passes more on a large canvas and draws
// the layer as horizontal strips with a pause after each: one full-canvas composite of the
// geometry layer at 3840x2160 was still ~170ms of unbroken work. The strips are 1:1 copies at
// integer rows and every blend mode here is per-pixel, so they produce the same pixels as one
// draw (verified byte-for-byte in Chromium). The canvas transform (mirrorX) applies to each strip
// exactly as it did to the whole.
function* drawLayer(ctx, el, bands) {
  if (bands <= 1) {
    ctx.drawImage(el, 0, 0);
    return;
  }
  for (let i = 0; i < bands; i++) {
    const y0 = Math.round((i * el.height) / bands);
    const y1 = Math.round(((i + 1) * el.height) / bands);
    ctx.drawImage(el, 0, y0, el.width, y1 - y0, 0, y0, el.width, y1 - y0);
    if (i < bands - 1) yield;
  }
}

/** @returns {Generator<undefined, HTMLCanvasElement, unknown>} */
function* renderSteps(config, bands = 1) {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  canvas.width = config.width;
  canvas.height = config.height;

  // config.mirrorX (set from generateArtwork's renderContext -- never part of a design's
  // identity) horizontally flips the whole composition. Used for the back half of a garment
  // whose front and back panels meet at visible side seams: printing the back mirrored makes
  // the pattern continue across BOTH seams instead of restarting at each (see
  // printful.js's mirrorPlacements). Deliberately a raster flip applied here, at the one
  // point every layer is composited, rather than a transform pushed into each layer
  // generator -- it's guaranteed to be a true mirror of exactly what would otherwise have
  // been drawn, it can't perturb any rng() draw or layer geometry, and because this file is
  // the SHARED compositor (render-service bundles and runs it verbatim) the browser mockup
  // and the real print file mirror identically with one implementation, not two kept in
  // sync. Every layer below is a drawImage(el, 0, 0), and nothing resets the transform, so
  // setting it once here covers all of them.
  if (config.mirrorX) {
    ctx.translate(config.width, 0);
    ctx.scale(-1, 1);
  }

  const gradientBackground = LinearGradient(config.gradientBackgroundConfig);
  yield* drawLayer(ctx, gradientBackground, bands);
  clearElement(gradientBackground);
  yield;

  if (config.radialFieldConfig) {
    ctx.globalCompositeOperation = config.firstBlend;
    const radialField = yield* largeRadialFieldSteps(config.radialFieldConfig);
    yield* drawLayer(ctx, radialField, bands);
    clearElement(radialField);
    yield;
  }

  // config.starsOnTop (a design SETTING -- see designSettings.js -- unlike mirrorX above,
  // which is per-render context) swaps these two layers' compositing order. The default
  // false draws stars first and geometry over them; true puts the star field above the
  // geometry so a large or high-coherence figure doesn't bury it. The overlay stays on top
  // either way, and nothing else moves: both layers are generated identically and keep
  // their own blend modes, so this is purely the order they are composited in.
  //
  // Worth knowing if the star treatment is ever revisited: starBlendMode picks
  // config.secondBlend from the BACKGROUND gradient's mean luminance, on the assumption the
  // backdrop the stars land on is that gradient. Under starsOnTop the stars composite
  // against the geometry layer instead, so that assumption no longer strictly holds. It
  // survives in practice because 'source-over' takes three of the four biased slots and is
  // backdrop-agnostic, but the 10% unbiased tail and the lighten/darken slot are reasoning
  // about a backdrop that is no longer directly underneath.
  function* drawStars() {
    ctx.globalCompositeOperation = config.secondBlend;
    const starField = StarField(config.starFieldConfig);
    yield* drawLayer(ctx, starField, bands);
    clearElement(starField);
  }

  function* drawGeometry() {
    if (!config.geometryConfig) return;
    ctx.globalCompositeOperation = config.thirdBlend;
    const geometry = GeometricShape(config.geometryConfig);
    yield* drawLayer(ctx, geometry, bands);
    clearElement(geometry);
  }

  if (config.starsOnTop) {
    yield* drawGeometry();
    yield;
    yield* drawStars();
  } else {
    yield* drawStars();
    yield;
    yield* drawGeometry();
  }
  yield;

  if (config.overlayConfig) {
    ctx.globalCompositeOperation = config.overlayBlend;
    ctx.globalAlpha = Number(config.overlayAlpha);
    const gradientOverlay = LinearGradient(config.overlayConfig);
    yield* drawLayer(ctx, gradientOverlay, bands);
    clearElement(gradientOverlay);
  }

  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';

  // config.legSymmetry (render context, like mirrorX above): reflects the finished raster's
  // LEFT half onto its right, so the two leg panels of a cut-in-half printfile become mirror
  // images and the pattern meets itself at the centre-front seam instead of restarting.
  // Applied last, after every layer is down, so it covers all of them -- the geometry layer
  // already mirrored itself (GeometricShape's legLayout), but the star field, radial field,
  // gradient and overlay run straight across the sheet and were the visible discontinuity.
  // It only lands a matching seam because the two leg panels are SYMMETRIC ABOUT THE SHEET
  // CENTRE -- flood-measured off Printful's CAD templates at 0.158-0.408 and 0.592-0.842 on
  // the shorts (exact reflections about 0.5), and inner edges 0.468/0.532 on the joggers. A
  // product without that symmetry would need a different transform, so this is gated on
  // twoLegCanvas rather than offered everywhere.
  // NOTE, and this was assumed wrong once before being measured: legLayout still MATTERS
  // when this is on. The reasoning that it wouldn't -- only the left half survives, and both
  // 'single' and 'mirror' put a copy at width/4 inside it -- misses that these shapes are
  // large enough to cross the centre line. 'mirror' adds a second copy at 3*width/4 whose
  // own extent bleeds back LEFT past width/2, so it changes the surviving half too.
  // Verified: 'single' and 'mirror' render differently under legSymmetry on all three test
  // designs, so ProductPage keeps that control visible.
  if (config.legSymmetry) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const half = Math.ceil(config.width / 2);
    ctx.save();
    ctx.translate(config.width, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(canvas, 0, 0, half, config.height, 0, 0, half, config.height);
    ctx.restore();
  }

  return canvas;
}

// Synchronous: runs every step back to back. What render-service, print files and every
// non-interactive caller use -- byte-identical to the compositor before it was split into steps.
export default function renderArtwork(config) {
  const steps = renderSteps(config);
  let step = steps.next();
  while (!step.done) step = steps.next();
  return step.value;
}

// Stepwise: awaits `pause()` between layers, so an interactive page can paint -- and keep its
// animations running -- while a large render is underway. A single 3840x2160 render measured
// ~370ms of unbroken main-thread work, which froze every JS-driven animation on screen (the
// hero loader, the mini generator's spinner, the 3D shirt's shader pass) and read as a glitch.
// See render/renderQueue.js for the pause and for who calls this.
// About how much of a canvas one composite strip covers in the stepwise path -- sized so a strip
// of the heaviest layer stays well under a frame's worth of a busy page. 3840x2160 -> 5 strips;
// anything up to ~2Mpx (every preview, the mini generator) stays a single draw.
const STRIP_PIXELS = 2_000_000;

/**
 * @param {object} config
 * @param {() => Promise<unknown>} pause
 * @returns {Promise<HTMLCanvasElement>}
 */
export async function renderArtworkInSteps(config, pause) {
  const bands = Math.max(1, Math.round((config.width * config.height) / STRIP_PIXELS));
  const steps = renderSteps(config, bands);
  let step = steps.next();
  while (!step.done) {
    await pause();
    step = steps.next();
  }
  return step.value;
}
