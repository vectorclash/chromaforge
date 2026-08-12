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

import { generateArtwork } from './generateArtwork';

const PALETTE_PROBE_SIZE = 320;

export function resolvedPalette(design) {
  const resolved = design?.gradientBackgroundConfig?.colors;
  if (Array.isArray(resolved) && resolved.length) return resolved.slice();
  const stored = design?.colors;
  return Array.isArray(stored) && stored.length ? stored.slice() : [];
}

// A COMPACT design ({ generatorVersion, seed, colors, settings }) carries no
// gradientBackgroundConfig, so resolvedPalette above can only hand back its stored `colors` --
// which is exactly nothing for an auto-palette design. That is the shape most of the merch
// pipeline works in (ProductPage's picked design, checkout's payload), so anything there
// needing the real colours has to regenerate them.
//
// The size is arbitrary and deliberately tiny: the resolved palette is INDEPENDENT of both the
// canvas dimensions and the renderContext, verified across 9 sizes (320² through the 11250×4350
// shorts sheet) x 8 seeds x auto/user/monochrome palettes -- 216/216 identical -- and across
// includeGeometry/mirrorX/legSymmetry/geometryLayout/sizeFrame, 45/45 identical. Which follows
// from how it's built: the palette is drawn before any size-dependent work, and every generator
// here is size-invariant in its rng consumption by design (see render/scale.js). 320² keeps the
// probe cheap; it only ever runs when the caller has no full config to read.
export function resolveDesignPalette(design) {
  // Deliberately NOT `resolvedPalette(design)` -- that falls back to the stored `colors`, which
  // for a MONOCHROME design is the one colour the customer picked, not the three the artwork
  // actually renders with after expandMonochromePalette. Taking the shortcut would leave the
  // printed tag on the base colour while the animation's mark (which reads a full config, and
  // so gets the expansion) used a companion, and the two are supposed to be the same mark.
  // Only a real resolved gradient is trusted here; anything else regenerates.
  const direct = design?.gradientBackgroundConfig?.colors;
  if (Array.isArray(direct) && direct.length) return direct.slice();
  if (!design?.seed) return [];
  return resolvedPalette(
    generateArtwork(design.seed, PALETTE_PROBE_SIZE, PALETTE_PROBE_SIZE, design.colors || [], design.settings ?? null)
  );
}
