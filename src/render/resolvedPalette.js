// The colours a design ACTUALLY renders with -- which is NOT `design.colors`. That field is
// the stored identity of a design, and it is empty for every auto-palette design (the seeded
// rng picks the palette at generation time) and a single entry for a monochrome one (expanded
// at render time by expandMonochromePalette). Reading it directly would leave the most common
// case -- an auto-palette design -- with no colours at all.
//
// The background gradient's own resolved stops are the honest answer for all three cases: they
// are the colours generateArtwork settled on, whichever route it took to them, and they are
// what the piece's ground is literally painted with. Falls back to the stored palette only if a
// caller hands over something that isn't full generateArtwork output.
export function resolvedPalette(design) {
  const resolved = design?.gradientBackgroundConfig?.colors;
  if (Array.isArray(resolved) && resolved.length) return resolved.slice();
  const stored = design?.colors;
  return Array.isArray(stored) && stored.length ? stored.slice() : [];
}
