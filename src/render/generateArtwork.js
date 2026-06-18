// Pure generation orchestrator — no React, no DOM. Turns a seed + palette + target
// size into a fully-resolved (but not-yet-rasterised) composition config. Because it
// is a plain function of its arguments, it runs identically in the browser and in a
// Node/headless context (for server-side print rendering), and the same seed always
// produces the same config at a given size.

import GenerateLinearGradient from '../components/Canvas/GenerateLinearGradient';
import GenerateLargeRadialField from '../components/Canvas/GenerateLargeRadialField';
import GenerateStarField from '../components/Canvas/GenerateStarField';
import GenerateGeometricShape from '../components/Canvas/GenerateGeometricShape';
import { makeRng, randomSeed } from './prng';

// Bump when the generation algorithm changes in a way that alters output for a given
// seed, so old designs can be detected and (re)rendered with matching behaviour.
export const GENERATOR_VERSION = 2;

const BLEND_MODES = [
  'screen',
  'overlay',
  'multiply',
  'hard-light',
  'lighten',
  'darken',
  'soft-light',
  'source-over'
];

function randomBlendMode(rng) {
  return BLEND_MODES[Math.floor(rng() * BLEND_MODES.length)];
}

// generateArtwork(seed, width, height, colorValues) -> composition config.
// The stored design is just { generatorVersion, seed, colors }; everything else here
// is derived deterministically and can be regenerated at any (width, height).
export function generateArtwork(seed = randomSeed(), width, height, colorValues = []) {
  const rng = makeRng(seed);

  const config = {
    generatorVersion: GENERATOR_VERSION,
    seed,
    width,
    height,
    colors: colorValues.slice()
  };

  config.gradientBackgroundConfig = new GenerateLinearGradient(
    width,
    height,
    1,
    colorValues.slice(),
    rng
  );

  let radialChance = rng();

  if (radialChance > 0.4) {
    config.firstBlend = randomBlendMode(rng);
    config.radialFieldConfig = new GenerateLargeRadialField(
      width,
      height,
      colorValues.slice(),
      rng
    );
  }

  config.secondBlend = randomBlendMode(rng);

  config.starFieldConfig = new GenerateStarField(width, height, colorValues.slice(), rng);

  let geometryChance = rng();

  if (geometryChance >= 0.6) {
    config.thirdBlend = randomBlendMode(rng);
    config.geometryConfig = new GenerateGeometricShape(
      width,
      height,
      10 + Math.round(rng() * 30),
      colorValues.slice(),
      rng
    );
  }

  let overlayChance = rng();

  if (overlayChance >= 0.7 && colorValues.length > 0) {
    config.overlayBlend = randomBlendMode(rng);
    config.overlayAlpha = rng().toFixed(2);
    config.overlayConfig = new GenerateLinearGradient(
      width,
      height,
      Math.round(rng() * 2),
      colorValues.slice(),
      rng
    );
  }

  return config;
}
