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

  return canvas;
}
