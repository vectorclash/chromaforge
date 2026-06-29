// Pure compositor for generateAvatar() configs -- draws just the gradient background and
// the geometry layer. Unlike renderArtwork, there's no star field, so no image-sprite
// queue dependency: this is synchronous and self-contained.

import LinearGradient from '../components/Canvas/LinearGradient';
import GeometricShape from '../components/Canvas/GeometricShape';

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

  const geometry = GeometricShape(config.geometryConfig);
  ctx.drawImage(geometry, 0, 0);
  clearElement(geometry);

  return canvas;
}
