// Strips a generateArtwork() output down to just { generatorVersion, seed, colors } before
// it's persisted -- mirrors src/render/compactDesign.js on the frontend (a separate runtime/
// build, not literally shared code, just the same fix applied on both sides). Found via a
// live audit after the frontend version of this bug (MiniGenerator saving raw, uncompacted
// design data) drove 93.6% of daily Supabase egress: order_items.design_data had the exact
// same problem -- checking out with "Current studio design" (StudioContext's currentDesign,
// always the raw generateArtwork() output, never compacted) sent it straight through to this
// insert, uncompacted. design_data is write-only (nothing reads it back -- it's an audit
// trail of what was ordered), so the compact form loses nothing that matters.
export function toCompactDesign(design: Record<string, unknown>) {
  return {
    generatorVersion: design.generatorVersion,
    seed: design.seed,
    colors: design.colors
  };
}
