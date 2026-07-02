// Strips a generateArtwork() output (or a single animation frame, same shape) down to just
// the fields needed to regenerate it: { generatorVersion, seed, colors }. Everything else on
// the config (starFieldConfig, geometryConfig, gradientBackgroundConfig, radialFieldConfig,
// width, height, ...) is the *resolved* composition -- deterministically derivable from the
// seed alone, and large (a single starFieldConfig can be several MB), so it should never be
// persisted. Idempotent: calling this on an already-compact object returns the same shape.
export function toCompactDesign(config) {
  return { generatorVersion: config.generatorVersion, seed: config.seed, colors: config.colors };
}
