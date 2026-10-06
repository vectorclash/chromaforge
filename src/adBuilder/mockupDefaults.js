import {
  getMockupConfigForProduct,
  getGeometryPlacementOptions,
  getMirrorPlacements,
  hasTwoLegCanvas,
  getLegWrap,
  getLabelOutsideRegion,
  getLabelInsideRegion
} from '../lib/printful';

// The print options a product page STARTS with -- every one of ProductPage's per-order choices
// at its default -- in the shape useMockup.generate takes. Mirrored from ProductPage's initial
// state rather than shared with it (those defaults live in React state there), so if a default
// changes on the product page it should change here too. Matching exactly is also what lets a
// mockup already generated on a product page come straight out of useMockup's cache here.
export function defaultMockupOptions(productId) {
  const cfg = getMockupConfigForProduct(productId);
  const twoLeg = hasTwoLegCanvas(cfg);
  // Two-leg products default to "Across the front" (the leg wrap).
  const legWrap = twoLeg ? getLegWrap(cfg) : null;
  const stitchColor = cfg.productOptions?.[0]?.value ?? null;
  return {
    geometryPlacements: new Set(getGeometryPlacementOptions(cfg).map(o => o.key)),
    geometryLayout: twoLeg && !legWrap ? 'mirror' : null,
    sizeFrame: null,
    legSymmetry: false,
    legWrap,
    labelOutsideRegion: getLabelOutsideRegion(cfg),
    labelInsideRegion: getLabelInsideRegion(cfg),
    // "Back panel: Flipped" is on by default.
    mirrorPlacements: getMirrorPlacements(cfg),
    productOptions: stitchColor ? [{ name: 'stitch_color', value: stitchColor }] : null,
    secondaryDesign: null
  };
}
