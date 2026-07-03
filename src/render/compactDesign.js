// Strips a generateArtwork() output (or a single animation frame, same shape) down to just
// the fields needed to regenerate it: { generatorVersion, seed, colors, settings? }.
// Everything else on the config (starFieldConfig, geometryConfig, gradientBackgroundConfig,
// radialFieldConfig, width, height, ...) is the *resolved* composition -- deterministically
// derivable from the seed alone, and large (a single starFieldConfig can be several MB), so
// it should never be persisted. `settings` (render/designSettings.js) is part of a design's
// identity like seed/colors, but only kept when non-default so pre-settings designs stay
// byte-identical. Idempotent: calling this on an already-compact object returns the same shape.
import { compactSettings } from './designSettings';

export function toCompactDesign(config) {
  const compact = {
    generatorVersion: config.generatorVersion,
    seed: config.seed,
    colors: config.colors
  };
  const settings = compactSettings(config.settings);
  if (settings) compact.settings = settings;
  return compact;
}
