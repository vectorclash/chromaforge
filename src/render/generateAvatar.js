// Pure generator for profile avatars -- reuses two pieces of the main artwork generator
// (the linear-gradient background, and GeometricShape's triangle-fill renderer) but skips
// the star field, radial field, and overlay layers entirely, and replaces
// GenerateGeometricShape's full-canvas-scaled shape field (10-40 triangles across several
// concentric rings, sized for a 1000px+ canvas) with a single small N-gon fan sized to
// stay inside a square avatar frame. A few four-point stars sit behind it.

import tinycolor from 'tinycolor2';
import GenerateLinearGradient from '../components/Canvas/GenerateLinearGradient';
import { makeRng, randomPalette } from './prng';

// v2: GenerateLinearGradient's "no palette given" fallback now uses prng.js's
// randomPalette (guaranteed hue spread) instead of the old ad hoc coin-flip logic -- see
// generateArtwork.js's GENERATOR_VERSION v5 note. Different rng() draw count, so this
// shifts the background gradient's values and the subsequent generateAvatarGeometry
// draws for every existing avatar. Same accepted-not-blocking treatment as that bump.
//
// v3: randomPalette's hue spread is now redrawn per call instead of always wide -- see
// generateArtwork.js's GENERATOR_VERSION v6 note. Avatars don't have a star field to
// carry a guaranteed accent, so an avatar's background can now roll closer to monochrome
// than before; one extra rng() draw either way, shifting output the same as v6.
//
// v4 (2026-10-21, Aaron picked it from rendered options): the pinwheel's corners were each a
// fully random colour, which often blended into the background or clashed with it. They now
// come from a palette built opposite the background's mean hue (slicePalette), and five to
// eight four-point stars sit behind the pinwheel, tinted by the background gradient with each
// stop swapped for its complement, so every star is the opposite colour of what is directly
// behind it. Both draw from their own rng streams; the background and the pinwheel's shape
// (vertex count, radius, rotation) are drawn exactly as before.
// Nothing stored changes: an avatar is saved as a JPEG, never re-rendered from its seed.
export const AVATAR_GENERATOR_VERSION = 4;

// The slice colours: five stops spread around the hue opposite the background's mean hue,
// plus one near-white and one deep stop of that hue so each slice's gradient has a highlight
// and a shadow in it.
function slicePalette(backgroundColors, rng) {
  // Hues are averaged on the circle, not as numbers: 350 and 10 average to 0, not 180.
  let x = 0;
  let y = 0;
  for (const c of backgroundColors) {
    const h = (tinycolor(c).toHsl().h * Math.PI) / 180;
    x += Math.cos(h);
    y += Math.sin(h);
  }
  const hue = ((Math.atan2(y, x) * 180) / Math.PI + 180 + 360) % 360;
  const palette = randomPalette(rng, 5, { baseHue: hue, centered: true, minSpread: 60, maxSpread: 160 });
  palette.push(
    tinycolor({ h: hue, s: 30, l: 92 }).toHexString(),
    tinycolor({ h: hue, s: 70, l: 18 }).toHexString()
  );
  return palette;
}

// Star positions and sizes are fractions of the avatar, so the layout is the same at any size.
function generateAvatarStars(backgroundConfig, rng) {
  const count = 5 + Math.floor(rng() * 4);
  const stars = [];
  for (let i = 0; i < count; i++) {
    const size = 0.07 + rng() ** 2 * 0.15;
    stars.push({ size, x: rng(), y: rng() });
  }
  return {
    stars,
    // The background gradient itself (same direction, same stop positions), every stop
    // replaced by its complement.
    gradientConfig: {
      ...backgroundConfig,
      colors: backgroundConfig.colors.map(c => tinycolor(c).complement().toHexString())
    }
  };
}

// A handful of triangle slices sharing the center point, like a simple pinwheel -- one
// clean shape rather than a busy field, at a radius that leaves a margin inside the frame.
function generateAvatarGeometry(size, rng, palette, paletteRng) {
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
  const pick = () => palette[Math.floor(paletteRng() * palette.length)];
  const shapes = ring.map((point, i) => ({
    points: [[0, 0], point, ring[(i + 1) % vertices]],
    colors: [pick(), pick(), pick()]
  }));

  return { width: size, height: size, shapes };
}

export function generateAvatar(seed, size = 256) {
  const rng = makeRng(seed);
  /** @type {any} -- a plain config object; its fields are assigned in the constructor */
  const gradientBackgroundConfig = new GenerateLinearGradient(size, size, 1, [], rng);
  const paletteRng = makeRng(`${seed}-avatar`);
  const palette = slicePalette(gradientBackgroundConfig.colors, paletteRng);
  return {
    generatorVersion: AVATAR_GENERATOR_VERSION,
    seed,
    size,
    gradientBackgroundConfig,
    starConfig: generateAvatarStars(gradientBackgroundConfig, makeRng(`${seed}-avatar-stars`)),
    geometryConfig: generateAvatarGeometry(size, rng, palette, paletteRng)
  };
}
