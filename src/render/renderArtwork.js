// Pure compositor — rasterises a composition config (from generateArtwork) into a single
// canvas at config.width x config.height. The lone browser dependency is `document`
// (createElement) and the layer renderers; isolating it here means the same pipeline can
// be pointed at a screen-size, a thumbnail, or a 4200x5400 print canvas with no other
// changes. `images` supplies the star sprites via getResult(id) (a createjs LoadQueue in
// the app, or any { getResult } shim).

import LinearGradient from '../components/Canvas/LinearGradient';
import LargeRadialField from '../components/Canvas/LargeRadialField';
import StarField from '../components/Canvas/StarField';
import GeometricShape from '../components/Canvas/GeometricShape';

function clearElement(el) {
  el.width = 0;
  el.height = 0;
}

export default function renderArtwork(config, images) {
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
  ctx.drawImage(gradientBackground, 0, 0);
  clearElement(gradientBackground);

  if (config.radialFieldConfig) {
    ctx.globalCompositeOperation = config.firstBlend;
    const radialField = LargeRadialField(config.radialFieldConfig);
    ctx.drawImage(radialField, 0, 0);
    clearElement(radialField);
  }

  ctx.globalCompositeOperation = config.secondBlend;
  const starField = StarField(config.starFieldConfig, images);
  ctx.drawImage(starField, 0, 0);
  clearElement(starField);

  if (config.geometryConfig) {
    ctx.globalCompositeOperation = config.thirdBlend;
    const geometry = GeometricShape(config.geometryConfig);
    ctx.drawImage(geometry, 0, 0);
    clearElement(geometry);
  }

  if (config.overlayConfig) {
    ctx.globalCompositeOperation = config.overlayBlend;
    ctx.globalAlpha = Number(config.overlayAlpha);
    const gradientOverlay = LinearGradient(config.overlayConfig);
    ctx.drawImage(gradientOverlay, 0, 0);
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
