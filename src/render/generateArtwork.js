// Pure generation orchestrator — no React, no DOM. Turns a seed + palette + target
// size into a fully-resolved (but not-yet-rasterised) composition config. Because it
// is a plain function of its arguments, it runs identically in the browser and in a
// Node/headless context (for server-side print rendering), and the same seed always
// produces the same config at a given size.

import tinycolor from 'tinycolor2';
import GenerateLinearGradient from '../components/Canvas/GenerateLinearGradient';
import GenerateLargeRadialField from '../components/Canvas/GenerateLargeRadialField';
import GenerateStarField from '../components/Canvas/GenerateStarField';
import GenerateGeometricShape from '../components/Canvas/GenerateGeometricShape';
import { makeRng, randomSeed, expandMonochromePalette} from './prng';
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
//
// v4: widened the xl/large star size ranges in GenerateStarField.js (Aaron's request --
// the big "star-large"-sprite tiers should be able to fill out with noticeably bigger
// stars). Same rng() draw count as before, just larger resulting sizes from the same
// draws, so it's a values-only change -- but that's still "alters output for a given
// seed," same standard v3 was bumped for. Old v3 designs render with the previous
// (smaller) star range until re-saved -- same accepted-not-blocking treatment as v2->v3.
//
// v5: replaced the ad hoc "no palette given" color fallback in GenerateLinearGradient.js
// (background/star-field-internal-bg/overlay) and GenerateLargeRadialField.js (radial
// glow blobs) with prng.js's new randomPalette -- the old logic had a 50% chance of
// picking a near-zero hue spread (colorDistance = rng()*50, no floor), which was the
// dominant cause of "fully random" designs occasionally rendering as flat/monochrome
// (Aaron's report). randomPalette guarantees real hue spread and healthy
// saturation/lightness instead. Different rng() draw count than the old branches, so
// this changes output for every existing `colors: []` design -- old v4 designs render
// with the previous palette logic until re-saved, same accepted-not-blocking treatment
// as prior bumps.
//
// v6: v5 always forced a wide hue spread, which fixed monochrome but also removed the
// possibility of a deliberately muted/close-to-monochrome look Aaron liked having
// available. randomPalette's spread is now redrawn per call (8-180 degrees, uniform) so
// the background/radial-field CAN roll close to monochrome again (never literally flat --
// 8 degree floor) -- but to keep the "never truly monochrome" guarantee, the star field's
// own internal gradient (see GenerateStarField.js -- it's a genuinely separate composited
// layer, not just tinted stars) is now always biased to the background's complementary
// hue at a wide spread, regardless of how muted the rest of the piece rolled. New rng()
// draws (the spread roll, the star hue-bias jitter) change output for every existing
// `colors: []` design -- old v5 designs render with the previous always-wide, unbiased
// logic until re-saved, same accepted-not-blocking treatment as prior bumps.
//
// v6 -> v7 (2026-07-20): GenerateGeometricShape.js's chaotic-shape keepCount no longer
// slices by getCountScale(width, height) -- found via a live customer order where the
// mockup preview (rendered client-side, capped at RENDER_CAP=2000) showed visibly fewer
// geometry shapes than the real print file at true printfile resolution, for the same
// seed. No new rng() draws (this only changes how much of the already-generated,
// size-independent shape list survives the slice), but it does change rendered PIXELS for
// any canvas whose countScale was < 1 -- confirmed this affects real print resolutions too,
// not just thumbnails/previews: the pillow (all sizes but 22x22), 257/261's sleeves, 274's
// pocket, and 744's crossbody bag all have printfiles small enough to be affected.
//
// IMPORTANT, and corrected 2026-07-24 (this comment previously claimed old designs "keep
// rendering with the old sliced-down geometry until re-saved" -- that is NOT true and never
// was): generateArtwork takes no version parameter and never branches on one. There is no
// code path anywhere that renders a previous generator version. A stored design is only
// { seed, colors, settings }; it is ALWAYS regenerated with whatever code is in the bundle,
// and this constant is stamped onto the result. So a bump changes how every existing design
// renders, immediately -- the stored generatorVersion is a record of what it was SAVED
// under, not a rendering instruction. Its one real consumer is render-service's mismatch
// check, which exists to catch a stale render-service DEPLOY (see
// compactDesign.js's withCurrentGeneratorVersion for why stored rows must be re-stamped
// before they reach it, and the live bug that rule fixed).
//
// v7 -> v8 (2026-07-29): getElementSizeScale's aspect term is CLAMPED at 1, so it can shrink
// elements but never enlarge them (see render/scale.js for the measurements and the real
// Printful mockups that drove it). Consumes no rng() -- element COUNTS are untouched, only
// sizes -- so a design's structure is identical and only two canvases in the entire
// catalogue move: the mesh shorts sheet and the bomber's "details" strip, the only two above
// 16:9. Everything at or below 16:9 already sat under the clamp, which includes the studio
// canvas, all three export ratios, every thumbnail, and every other product.
// NOTE, deliberately: this bump does NOT invalidate stored thumbnails, unlike v6 -> v7.
// Thumbnails render square (a 2000px density floor) and square is below the clamp, so they
// are byte-identical -- verified by hash before and after. No backfill run is needed.
// The same change also adds renderContext.sizeFrame, which is opt-in per product and cannot
// affect anything that does not pass it.
export const GENERATOR_VERSION = 8;

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
// (same rng() draws throughout), so absent-settings designs were unaffected and
// GENERATOR_VERSION did not bump for that change (it was 3 at the time; it is 7 now -- see
// the version history above the constant). Settings values must never vary rng() consumption BY SIZE
// (they're size-independent inputs, so they can't) -- see render/scale.js for why that
// matters. `renderContext` is deliberately NOT part of a design's identity/persistence --
// it's caller-supplied context about *this particular render*: includeGeometry, whether
// the geometry layer should appear at all on this specific placement -- see printful.js's
// renderAndUploadPrintFiles, the only caller that knows which merch placement is being
// rendered and which panels the customer chose at checkout via ProductPage.jsx's
// per-placement checkboxes; and geometryLayout ('single' | 'mirror', optional), the
// customer's choice for products whose front/back printfile is one flat canvas that gets
// physically cut into two garment legs (mesh shorts, joggers -- see
// GeometricShape.js/PRODUCT_MOCKUP_CONFIG's twoLegCanvas); and mirrorX (optional), which
// horizontally flips the finished raster so a garment's back panel continues its front's
// pattern across the side seams (see printful.js's mirrorPlacements). All three default to
// leaving existing behavior untouched so every other caller (studio canvas, thumbnails,
// share links) is unaffected.
export function generateArtwork(
  seed = randomSeed(),
  width,
  height,
  colorValues = [],
  settings = null,
  { includeGeometry = true, geometryLayout = null, mirrorX = false, sizeFrame = null } = {}
) {
  const rng = makeRng(seed);

  // A one-colour palette used to be special-cased inside three separate generators, each
  // improvising a random greyscale companion (see expandMonochromePalette for why that was
  // both wrong-looking and a hard crash on the print renderer). It's expanded ONCE here
  // instead, so every layer draws from the same derived set and the piece reads as one
  // coherent near-monochrome composition rather than each layer inventing its own companion.
  // Seeded off its OWN rng stream (`${seed}-palette`), not the main one, so this consumes
  // exactly zero draws from the sequence every other layer shares -- a multi-colour design
  // is byte-identical to before, and even a single-colour one keeps the same composition
  // structure it would have had, only recoloured. Same separate-stream discipline as
  // generateLabelMark.js.
  // NOTE the stored design keeps the customer's single colour (config.colors below) -- the
  // expansion is derived at render time, so it is not part of a design's identity and a
  // saved one-colour design stays a one-colour design.
  const paletteColors =
    colorValues.length === 1
      ? expandMonochromePalette(colorValues[0], makeRng(`${seed}-palette`))
      : colorValues;

  const config = {
    generatorVersion: GENERATOR_VERSION,
    seed,
    width,
    height,
    // Pure render-time flag, consumed by renderArtwork -- see its comment. Consumes no
    // rng() and touches no layer generation, so a mirrored render is byte-for-byte the
    // same composition as its unmirrored twin, just flipped.
    mirrorX,
    colors: colorValues.slice()
  };

  const compactedSettings = compactSettings(settings);
  if (compactedSettings) config.settings = compactedSettings;

  config.gradientBackgroundConfig = new GenerateLinearGradient(
    width,
    height,
    1,
    paletteColors.slice(),
    rng
  );

  let radialChance = rng();

  if (radialChance > 0.4) {
    config.firstBlend = randomBlendMode(rng);
    config.radialFieldConfig = new GenerateLargeRadialField(
      width,
      height,
      paletteColors.slice(),
      rng
    );
  }

  config.secondBlend = randomBlendMode(rng);

  // No rng() draw -- pure arithmetic on gradientBackgroundConfig's already-resolved
  // colors, so this can't desync consumption. Only meaningful with no user palette (see
  // GenerateStarField's own comment on why); a real user palette leaves this null and the
  // star field's internal gradient uses colorValues directly instead, unaffected.
  const backgroundHue =
    paletteColors.length === 0
      ? tinycolor(config.gradientBackgroundConfig.colors[0]).toHsl().h
      : null;
  config.starFieldConfig = new GenerateStarField(
    width,
    height,
    paletteColors.slice(),
    rng,
    backgroundHue,
    sizeFrame
  );

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
    // attached below) so a design rendered with includeGeometry=false on one placement
    // stays rng-aligned with its other placements -- same discipline as geometryChance's
    // unconditional draw above.
    const geometryConfig = new GenerateGeometricShape(
      width,
      height,
      shapeNum,
      paletteColors.slice(),
      rng,
      settings,
      geometryLayout,
      sizeFrame
    );
    if (includeGeometry) {
      config.geometryConfig = geometryConfig;
    }
  }

  let overlayChance = rng();

  if (overlayChance >= 0.7 && paletteColors.length > 0) {
    config.overlayBlend = randomBlendMode(rng);
    config.overlayAlpha = rng().toFixed(2);
    config.overlayConfig = new GenerateLinearGradient(
      width,
      height,
      Math.round(rng() * 2),
      paletteColors.slice(),
      rng
    );
  }

  return config;
}
