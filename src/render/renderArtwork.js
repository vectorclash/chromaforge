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
