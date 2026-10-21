// Pure compositor for generateAvatar() configs -- the gradient background, a few tinted
// four-point stars, and the pinwheel with a soft shadow. Synchronous and self-contained.

import LinearGradient from '../components/Canvas/LinearGradient';
import GeometricShape from '../components/Canvas/GeometricShape';
import { buildSmallStarSprite } from './starSprite';

const makeCanvas = (w, h) => {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
};

// White stars on their own layer, then the star gradient filled through their alpha -- the
// same trick StarField uses to tint the artwork's stars.
function drawStars(config) {
  const { size, starConfig } = config;
  const layer = makeCanvas(size, size);
  const ctx = layer.getContext('2d');
  const sprite = buildSmallStarSprite(256, makeCanvas);
  for (const star of starConfig.stars) {
    const s = star.size * size;
    ctx.drawImage(sprite, star.x * size - s / 2, star.y * size - s / 2, s, s);
  }
  clearElement(sprite);
  ctx.globalCompositeOperation = 'source-in';
  const gradient = LinearGradient(starConfig.gradientConfig);
  ctx.drawImage(gradient, 0, 0);
  clearElement(gradient);
  return layer;
}

function clearElement(el) {
  el.width = 0;
  el.height = 0;
}

export default function renderAvatar(config) {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  canvas.width = config.size;
  canvas.height = config.size;

  const gradientBackground = LinearGradient(config.gradientBackgroundConfig);
  ctx.drawImage(gradientBackground, 0, 0);
  clearElement(gradientBackground);

  if (config.starConfig) {
    const stars = drawStars(config);
    ctx.drawImage(stars, 0, 0);
    clearElement(stars);
  }

  // The shadow lifts the pinwheel off the gradient behind it.
  const geometry = GeometricShape(config.geometryConfig);
  ctx.save();
  ctx.shadowColor = 'rgba(10, 6, 20, 0.45)';
  ctx.shadowBlur = config.size * 0.05;
  ctx.shadowOffsetY = config.size * 0.015;
  ctx.drawImage(geometry, 0, 0);
  ctx.restore();
  clearElement(geometry);

  return canvas;
}
