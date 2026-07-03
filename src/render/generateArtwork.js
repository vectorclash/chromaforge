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
import { getGeometrySettings, compactSettings } from './designSettings';

// Bump when the generation algorithm changes in a way that alters output for a given
// seed, so old designs can be detected and (re)rendered with matching behaviour.
//
// v3: made the generators ratio-aware -- sizes off min(width, height) instead of width
// alone, counts off canvas area instead of fixed constants (see render/scale.js). This
// changes output for every existing seed (the count changes shift how many rng() calls
// each generator makes, desyncing the whole sequence downstream) -- old v2 saved designs
// render differently now and will fail render-service's version check for printing until
// re-saved. Accepted deliberately, same as how pre-seed (v1) designs are already treated
// as best-effort-only, not a blocker -- nothing is live to real customers yet.
export const GENERATOR_VERSION = 3;

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

// generateArtwork(seed, width, height, colorValues, settings, renderContext) -> composition
// config. The stored design is just { generatorVersion, seed, colors, settings? };
// everything else here is derived deterministically and can be regenerated at any
// (width, height). `settings` (see render/designSettings.js) is part of a design's identity
// the same way seed/colors are -- the same seed with different settings is a different
// design. At the default settings, output is byte-identical to the pre-settings generator
// (same rng() draws throughout), so absent-settings designs are unaffected and
// GENERATOR_VERSION stays at 3. Settings values must never vary rng() consumption BY SIZE
// (they're size-independent inputs, so they can't) -- see render/scale.js for why that
// matters. `renderContext` is deliberately NOT part of a design's identity/persistence --
// it's caller-supplied context about *this particular render* (currently just
// isFrontPlacement, for settings.geometry.frontOnly -- see printful.js's
// renderAndUploadPrintFiles, the only caller that knows which merch placement is being
// rendered). Defaults to front so every other caller (studio canvas, thumbnails, share
// links) is unaffected.
export function generateArtwork(
  seed = randomSeed(),
  width,
  height,
  colorValues = [],
  settings = null,
  { isFrontPlacement = true } = {}
) {
  const rng = makeRng(seed);

  const config = {
    generatorVersion: GENERATOR_VERSION,
    seed,
    width,
    height,
    colors: colorValues.slice()
  };

  const compactedSettings = compactSettings(settings);
  if (compactedSettings) config.settings = compactedSettings;

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

  // Always exactly one draw regardless of the chance setting, so the rest of the sequence
  // (overlay draws below) stays aligned whether or not geometry appears. The default
  // chance of 0.4 makes the threshold 0.6 -- the exact pre-settings `>= 0.6` comparison.
  // chance 1 -> threshold 0 (always passes); chance 0 -> threshold 1 (never passes, since
  // the PRNG's range is [0, 1)).
  let geometryChance = rng();
  const geometry = getGeometrySettings(settings);

  if (geometryChance >= 1 - geometry.chance) {
    config.thirdBlend = randomBlendMode(rng);
    // Unscaled -- exactly one rng() draw, matching pre-fix behavior. GenerateGeometricShape
    // itself builds this many shapes (fixed, size-independent rng() consumption) and only
    // keeps a size-scaled subset -- see its own comment for why the trip count can't vary
    // by size directly.
    let shapeNum = 10 + Math.round(rng() * 30);
    // Constructed unconditionally (same rng() consumption whether or not it ends up
    // attached below) so a frontOnly design's front and non-front placements stay
    // rng-aligned with each other -- same discipline as geometryChance's unconditional
    // draw above.
    const geometryConfig = new GenerateGeometricShape(
      width,
      height,
      shapeNum,
      colorValues.slice(),
      rng,
      settings
    );
    if (!(geometry.frontOnly && !isFrontPlacement)) {
      config.geometryConfig = geometryConfig;
    }
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
