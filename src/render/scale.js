// Shared reference resolution for the generators' size/count formulas (GenerateStarField,
// GenerateLargeRadialField, GenerateGeometricShape) -- the studio's actual default render
// size (see StudioPage.jsx: 3840x2160 desktop), since that's what these generators' original
// hardcoded counts were eyeballed against before they were made ratio-aware.
const REFERENCE_WIDTH = 3840;
const REFERENCE_HEIGHT = 2160;
const REFERENCE_AREA = REFERENCE_WIDTH * REFERENCE_HEIGHT;

// The reference canvas's own element-size scale -- i.e. what getElementSizeScale returns for
// the studio default (min(w,h) = 2160, aspect term exactly 1 since this IS the reference
// aspect). Exported so a generator that used to carry an ABSOLUTE pixel constant can express
// the same value as a FRACTION of the size scale instead, reproducing its old number exactly
// at the reference resolution while scaling correctly everywhere else. See
// GenerateGeometricShape's CHAOTIC_MIN_FRACTION -- an absolute pixel floor in a
// resolution-relative formula is a real bug (it made capped mockup previews render shapes up
// to 65% larger than the print they were previewing), not a harmless minimum.
export const REFERENCE_ELEMENT_SIZE_SCALE = Math.min(REFERENCE_WIDTH, REFERENCE_HEIGHT);

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

// Same cap-and-scale tradeoff as lib/printful.js's RENDER_CAP (mobile canvas-area limits vs.
// getCountScale density -- see that constant's own comment for the full reasoning), reused
// here for renders that aren't tied to any specific Printful printfile: gallery/preview
// thumbnails, which are generated once (at save time, or on-demand when a modal opens) and
// then displayed small, not printed. A THUMBNAIL_SIZE=320 gallery thumbnail rendered
// DIRECTLY at 320x320 sits at getCountScale(320,320) ≈ 0.11 -- an accurate small render of a
// genuinely sparse composition, not a bug in the scaling math itself, but it means the saved
// thumbnail JPEG doesn't actually depict the same density of stars/geometry the design shows
// at any size a person would call "the real image" (found via the same kind of side-by-side
// comparison that caught TshirtPreview's identical issue -- see that component's header
// comment). Fix is the same shape: generate at a DENSER size (long edge >= DISPLAY_RENDER_CAP)
// and let the caller downscale into the small output canvas, so the thumbnail is a true
// downsample of a rich composition instead of a small, independently-sparse one.
export const DISPLAY_RENDER_CAP = 2000;

// Scales (width, height) UP so its long edge reaches `cap`, preserving aspect exactly --
// never shrinks (a request already >= cap is returned unchanged, since it's already dense
// enough). Deliberately one-directional: unlike lib/printful.js's capMockupRenderSize (which
// always scales to a printfile's real dimensions, functionally always shrinking in practice),
// this must never shrink a caller's requested size out from under it.
export function densityFloorSize(width, height, cap = DISPLAY_RENDER_CAP) {
  const maxDim = Math.max(width, height);
  if (maxDim >= cap) return { width, height };
  const scale = cap / maxDim;
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
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

// Resolves the FRAME element sizes are measured against. Normally that is the canvas itself,
// but a printfile that gets physically cut into several separately-visible panels is never
// seen whole (mesh shorts, joggers -- see PRODUCT_MOCKUP_CONFIG's legPanel), and sizing to
// the sheet makes each panel show a small, hugely magnified fraction of the composition.
// `frame` is FRACTIONS of the canvas, not pixels, on purpose: a mockup preview renders at
// capMockupRenderSize's capped dimensions while the real print file renders at the
// printfile's true dimensions, and only a relative frame gives both the same composition.
function resolveFrame(width, height, frame) {
  if (!frame) return [width, height];
  return [width * frame.width, height * frame.height];
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
// The aspect term is CLAMPED at 1 (2026-07-29): it may shrink elements but never enlarge
// them. Squaring the gap was tuned on portrait shirt panels (0.72 -> 0.52) and pulls just as
// hard the other way, which nothing validated -- the wide side was only ever checked against
// an export you view as a single whole frame. On a real product it was badly wrong: the mesh
// shorts sheet (11250x4350, aspect 2.59, the widest canvas in the catalogue) came out at
// 2.12, sizing elements 2.78x its own leg panel's width where a t-shirt front sits at 0.52x
// -- confirmed against real Printful mockups, which also showed the knock-on effect that
// oversized translucent shapes stack and wash the whole garment out toward white.
// The clamp binds on exactly two canvases in the catalogue (mesh shorts, and the bomber's
// 7950x2700 "details" strip); every other product, the 16:9 studio canvas, and all three
// export ratios already sat at or below 1, so none of them move.
//
// `frame` (optional, fractions of the canvas -- see resolveFrame) measures against one
// visible panel instead of the whole sheet. The clamp applies either way, which is what
// keeps a tall narrow panel honest: a joggers leg is 2730x8009 (aspect 2.93), so uncapped
// the panel route would reintroduce the exact blow-up it exists to fix.
export function getElementSizeScale(width, height, frame = null) {
  const [w, h] = resolveFrame(width, height, frame);
  const canvasAspect = Math.max(w, h) / Math.min(w, h);
  return getSizeScale(w, h) * Math.min(1, (canvasAspect / REFERENCE_ASPECT) ** 2);
}

// getSizeScale against a visible panel rather than the canvas -- for the one element with a
// hard containment requirement (GenerateGeometricShape's coherentSize). Without this, the
// panel option would be a no-op for high-coherence designs: their lattice IS the design, and
// it would keep spanning the whole sheet while everything around it shrank.
export function getFrameSizeScale(width, height, frame = null) {
  const [w, h] = resolveFrame(width, height, frame);
  return getSizeScale(w, h);
}
