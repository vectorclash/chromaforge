// Shared reference resolution for the generators' size/count formulas (GenerateStarField,
// GenerateLargeRadialField, GenerateGeometricShape) -- the studio's actual default render
// size (see StudioPage.jsx: 3840x2160 desktop), since that's what these generators' original
// hardcoded counts were eyeballed against before they were made ratio-aware.
const REFERENCE_WIDTH = 3840;
const REFERENCE_HEIGHT = 2160;
const REFERENCE_AREA = REFERENCE_WIDTH * REFERENCE_HEIGHT;

// How much to scale element counts relative to the reference resolution, so density doesn't
// stay pinned to reference-tuned counts regardless of canvas size (the original bug: a
// 320x320 thumbnail got literally the same star counts as a 3840x2160 canvas). Deliberately
// sqrt(area ratio), not the raw ratio -- tested against real renders (see
// render-service/ratio-test.mjs) and plain linear area scaling collapsed thumbnail-size
// (320x320) renders to almost nothing, since that's ~1.2% of the reference area but the old
// fixed counts already looked reasonable there (visually verified against the pre-fix
// algorithm at the same size) -- the actual bug is more visible at the size extremes (a
// print at 3150x5550 vs studio's 3840x2160 default) than in the everyday small-to-medium
// range. sqrt tempers the falloff at both ends while still scaling meaningfully for the
// extremes this was meant to fix. `Math.max(1, Math.round(baseCount * scale))` at each call
// site keeps a count from vanishing to 0 at very small sizes.
export function getCountScale(width, height) {
  return Math.sqrt((width * height) / REFERENCE_AREA);
}

// Sizes should scale off the smaller dimension, not width alone -- a tall/narrow canvas
// (e.g. a 3150x5550 print) previously sized elements off its narrow axis only, making them
// look tiny relative to the canvas's actual visual scale.
export function getSizeScale(width, height) {
  return Math.min(width, height);
}
