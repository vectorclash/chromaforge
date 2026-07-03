// Strips a generateArtwork() output down to just { generatorVersion, seed, colors } before
// it's persisted -- mirrors src/render/compactDesign.js on the frontend (a separate runtime/
// build, not literally shared code, just the same fix applied on both sides). Found via a
// live audit after the frontend version of this bug (MiniGenerator saving raw, uncompacted
// design data) drove 93.6% of daily Supabase egress: order_items.design_data had the exact
// same problem -- checking out with "Current studio design" (StudioContext's currentDesign,
// always the raw generateArtwork() output, never compacted) sent it straight through to this
// insert, uncompacted. design_data is write-only (nothing reads it back -- it's an audit
// trail of what was ordered), so the compact form loses nothing that matters.
//
// `settings` (the studio's generation settings, e.g. the geometry sliders -- see the
// frontend's src/render/designSettings.js) is part of a design's identity like seed/colors:
// the frontend only attaches it when non-default, so passing it through as-is (no
// re-normalization here) keeps this an accurate audit copy without bloat.
export function toCompactDesign(design: Record<string, unknown>) {
  return {
    generatorVersion: design.generatorVersion,
    seed: design.seed,
    colors: design.colors,
    ...(design.settings ? { settings: design.settings } : {})
  };
}
