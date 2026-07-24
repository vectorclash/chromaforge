// Strips a generateArtwork() output (or a single animation frame, same shape) down to just
// the fields needed to regenerate it: { generatorVersion, seed, colors, settings? }.
// Everything else on the config (starFieldConfig, geometryConfig, gradientBackgroundConfig,
// radialFieldConfig, width, height, ...) is the *resolved* composition -- deterministically
// derivable from the seed alone, and large (a single starFieldConfig can be several MB), so
// it should never be persisted. `settings` (render/designSettings.js) is part of a design's
// identity like seed/colors, but only kept when non-default so pre-settings designs stay
// byte-identical. Idempotent: calling this on an already-compact object returns the same shape.
import { compactSettings } from './designSettings';
import { GENERATOR_VERSION } from './generateArtwork';

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

// Re-stamps a design loaded from storage (a `designs` row's `data`, whose generatorVersion
// records whatever GENERATOR_VERSION was current when it was SAVED) with the version this
// bundle actually renders. Apply this wherever a stored row is adopted into the live
// pipeline -- the gallery picker, the Gallery's "Print this" hand-off.
//
// REAL BUG this fixes (found 2026-07-24, live): the client renderer ignores the stored
// version entirely -- generateArtwork() regenerates from seed/colors/settings using whatever
// code is in the bundle and stamps its own GENERATOR_VERSION on the result. So a v6 row
// previewed as a perfectly good v7 mockup, but checkout forwarded the design object
// VERBATIM (see lib/printful.js's renderPrintFileStrategy) to render-service, which
// hard-fails a version mismatch with a 422 -- making 13 of the 38 public gallery designs
// (every one saved before the v6->v7 bump) mockup-able but unbuyable. The customer got the
// error only AFTER sitting through a 30-90s mockup round trip.
//
// This does NOT weaken the check it feeds. That check exists to catch a STALE RENDER-SERVICE
// DEPLOY -- a Fly machine running older code than the browser bundle (see CLAUDE.md's
// operational note about redeploying render-service on a GENERATOR_VERSION bump). Stamping
// here means the comparison is client-code-version vs. service-code-version, which is the
// drift that actually matters; comparing a stored row's AGE against the service never tested
// that in the first place. A genuinely stale service still mismatches and still fails loudly.
export function withCurrentGeneratorVersion(design) {
  if (!design) return design;
  return { ...design, generatorVersion: GENERATOR_VERSION };
}
