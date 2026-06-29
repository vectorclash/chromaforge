// Pure generator for profile avatars -- reuses two pieces of the main artwork generator
// (the linear-gradient background, and GeometricShape's triangle-fill renderer) but skips
// the star field, radial field, and overlay layers entirely, and replaces
// GenerateGeometricShape's full-canvas-scaled shape field (10-40 triangles across several
// concentric rings, sized for a 1000px+ canvas) with a single small N-gon fan sized to
// stay inside a square avatar frame.

import GenerateLinearGradient from '../components/Canvas/GenerateLinearGradient';
import { makeRng, randomColorHex } from './prng';

export const AVATAR_GENERATOR_VERSION = 1;

// A handful of triangle slices sharing the center point, like a simple pinwheel -- one
// clean shape rather than a busy field, at a radius that leaves a margin inside the frame.
function generateAvatarGeometry(size, rng) {
  const vertices = 3 + Math.floor(rng() * 4); // 3-6 slices
  const radius = size * (0.28 + rng() * 0.12);
  const rotation = rng() * Math.PI * 2;
  const angleStep = (Math.PI * 2) / vertices;

  const ring = [];
  for (let i = 0; i < vertices; i++) {
    const angle = rotation + i * angleStep;
    ring.push([Math.round(radius * Math.cos(angle)), Math.round(radius * Math.sin(angle))]);
  }

  // GeometricShape's renderer centers/rotates the whole container itself (see
  // GeometricShape.js), so points here stay relative to the origin, matching
  // GenerateGeometricShape's own convention.
  const shapes = ring.map((point, i) => ({
    points: [[0, 0], point, ring[(i + 1) % vertices]],
    colors: [randomColorHex(rng), randomColorHex(rng), randomColorHex(rng)]
  }));

  return { width: size, height: size, shapes };
}

export function generateAvatar(seed, size = 256) {
  const rng = makeRng(seed);
  return {
    generatorVersion: AVATAR_GENERATOR_VERSION,
    seed,
    size,
    gradientBackgroundConfig: new GenerateLinearGradient(size, size, 1, [], rng),
    geometryConfig: generateAvatarGeometry(size, rng)
  };
}
