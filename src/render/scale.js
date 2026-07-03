// Shared reference resolution for the generators' size/count formulas (GenerateStarField,
// GenerateLargeRadialField, GenerateGeometricShape) -- the studio's actual default render
// size (see StudioPage.jsx: 3840x2160 desktop), since that's what these generators' original
// hardcoded counts were eyeballed against before they were made ratio-aware.
const REFERENCE_WIDTH = 3840;
const REFERENCE_HEIGHT = 2160;
const REFERENCE_AREA = REFERENCE_WIDTH * REFERENCE_HEIGHT;

// How much of a generated element set to KEEP, relative to the reference resolution, so
// density doesn't stay pinned to reference-tuned counts regardless of canvas size (the
// original bug: a 320x320 thumbnail got literally the same star counts as a 3840x2160
// canvas). Deliberately sqrt(area ratio), not the raw ratio -- tested against real renders
// and plain linear area scaling collapsed thumbnail-size (320x320) renders to almost
// nothing, since that's ~1.2% of the reference area but the old fixed counts already
// looked reasonable there (visually verified against the pre-fix algorithm at the same
// size) -- the actual bug is more visible at the size extremes (a print at 3150x5550 vs
// studio's 3840x2160 default) than in the everyday small-to-medium range. sqrt tempers the
// falloff at both ends while still scaling meaningfully for the extremes this was meant to
// fix.
//
// Callers must NOT use this to vary a generation loop's trip count directly -- always
// generate the full original fixed count first (so rng() consumption, and everything drawn
// downstream in the same seed's sequence, stays size-independent), then slice the result to
// `Math.max(1, Math.round(originalCount * getCountScale(...)))`. Confirmed live: varying
// trip counts directly let the same seed gain or lose an entire geometry-shape layer
// depending purely on render size, since it shifted every subsequent rng() draw
// (geometryChance, overlayChance, etc.) -- breaking the guarantee that a mockup and its
// print are the same underlying piece. See GenerateStarField.js for the reference pattern.
export function getCountScale(width, height) {
  return Math.sqrt((width * height) / REFERENCE_AREA);
}

// Sizes should scale off the smaller dimension, not width alone -- a tall/narrow canvas
// (e.g. a 3150x5550 print) previously sized elements off its narrow axis only, making them
// look tiny relative to the canvas's actual visual scale. Use this specifically where an
// element has a hard containment requirement tied to the short axis (currently only
// GenerateGeometricShape's coherentSize, which must fit inside the canvas with a fixed
// margin) -- for anything without that constraint, prefer getElementSizeScale below.
export function getSizeScale(width, height) {
  return Math.min(width, height);
}

// The studio's own default aspect ratio -- what getSizeScale's min(w,h) approach was
// originally eyeballed/tuned against before generators were made ratio-aware at all. Used
// below as the pivot point a canvas's own aspect ratio is compared against.
const REFERENCE_ASPECT = REFERENCE_WIDTH / REFERENCE_HEIGHT;

// Orientation-independent size anchor for elements with no containment requirement (see
// getSizeScale above for the ones that do): getSizeScale's own min(w,h) value, corrected by
// how far the canvas's aspect ratio sits from the reference's. min(w,h) already scales
// element size sensibly with absolute resolution (that's the part getSizeScale's own fix
// already proved out) -- what it doesn't account for is that min(w,h) is a much bigger
// fraction of a near-square/portrait canvas's own frame than it is of a wide landscape
// canvas's, so the *same* formula reads as "zoomed in" on one and "detailed" on the other.
//
// Two earlier attempts here were tried and rejected, both confirmed against real renders of
// the same seed at the same shirt-panel size (4200x5400, ratio 0.78, well short of
// REFERENCE_ASPECT's 1.78):
//   1. sqrt(width*height) (geometric mean) -- aspect-independent, but AM-GM guarantees it's
//      always >= min(w,h), so it could only grow elements, never shrink them. On a
//      near-square canvas, geometric mean sits close to min(w,h) anyway, so this barely
//      changed anything there -- the chaotic-geometry layer's few huge, overlapping
//      triangles (reading as flat color blocks, not a detailed mosaic) looked essentially
//      the same. It only meaningfully grew the *landscape* side.
//   2. REFERENCE_MIN_DIMENSION * getCountScale(w,h) (i.e. geometric mean rescaled by a
//      constant) -- correctly shrank the shirt panel this time (933px -> 794px, ~15%), but
//      the reduction was too mild to read as "more elements" at a glance; the render looked
//      nearly identical to unmodified.
//
//   3. The aspect ratio gap applied linearly (canvasAspect/REFERENCE_ASPECT, ~0.72 for the
//      shirt panel) -- directionally correct and a bigger effect than either attempt above,
//      but still confirmed live (a real freshly-generated design, shirt mockup vs its
//      landscape download side by side) to fall well short of the landscape side's richness
//      -- a handful of large triangles still dominated the panel instead of reading as a
//      detailed mosaic.
//
// This version squares the aspect ratio gap instead of applying it linearly, which pulls
// much harder in both directions: canvasAspect/REFERENCE_ASPECT of ~0.72 for the shirt panel
// becomes ~0.52 (a real ~48% reduction, not ~28%), while a 2.58-ratio landscape export's ~1.45
// becomes ~2.1 (correspondingly larger, matching how rich that side already read). Paired
// with raising RENDER_CAP in lib/printful.js (a separate, independent factor -- the capped
// preview was also keeping far fewer elements than the true print resolution will), both
// verified together against a real side-by-side render.
export function getElementSizeScale(width, height) {
  const canvasAspect = Math.max(width, height) / Math.min(width, height);
  return getSizeScale(width, height) * (canvasAspect / REFERENCE_ASPECT) ** 2;
}
