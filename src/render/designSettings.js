// Studio-adjustable generation settings. A design's JSON is { generatorVersion, seed,
// colors, settings? } -- `settings` is optional and only ever stored when something is
// non-default, so every design saved before settings existed keeps its exact original
// meaning (absent settings == these defaults).
//
// The defaults are not arbitrary: each one reproduces the pre-settings generator behaviour
// EXACTLY, down to the same rng() draws (chance 0.4 is the old hardcoded `rng() >= 0.6`
// threshold; 3..12 is the old `3 + Math.round(rng() * 9)` vertex range; coherence 0 skips
// every new code path). That byte-identical-at-defaults property is why introducing
// settings did not require a GENERATOR_VERSION bump.
//
// This lives in its own module (not generateArtwork.js) because the Generate* classes need
// it too, and generateArtwork imports those -- putting it there would be a circular import.

export const DEFAULT_GEOMETRY_SETTINGS = {
  // Probability the geometry layer appears at all: 0 = never, 1 = always.
  chance: 0.4,
  // Lattice vertex-count range (a "points" value of 6 makes hexagonal lattices). Equal
  // min/max pins the shape: min = max = 6 means every design gets a hexagon.
  pointsMin: 3,
  pointsMax: 12,
  // 0 = fully chaotic (unbounded size, random unrecognizable triangles, panels mostly
  // unfilled); 1 = a clean regular polygon, every lattice cell filled, sized per `size`
  // below.
  coherence: 0,
  // How large the coherent polygon is: 0 = fairly small (a third of the canvas's half-
  // dimension), 1 = a dramatic overflow well past the canvas edge. Only takes effect at
  // coherence > 0 -- see GenerateGeometricShape's shapeSize blend, which already
  // interpolates the coherent size in proportion to coherence, so this setting naturally
  // gains influence as coherence rises and has zero effect at coherence 0 (chaotic mode
  // has never had a size dial). Default 0.5 is deliberately the exact midpoint of
  // GenerateGeometricShape's ORIGINAL [0.15, 0.6] size-factor range (0 to 0.5 is still that
  // same line -- the high end was later extended further, size=1 now reaching 1.8, but
  // 0.5 stays the fixed boundary between the two so this default is untouched), reproducing
  // the original fixed 0.375 "12.5% margin, fits exactly" full-coherence look byte-for-byte.
  size: 0.5,
  // What fraction of the generated chaotic shapes actually get drawn: 1 = all of them
  // (today's behaviour), lower = a sparser, brighter composition. Only affects the chaotic
  // triangles, not the coherent lattice cells (those are a complete figure -- slicing them
  // would leave a broken polygon; see the lattice path in GenerateGeometricShape).
  //
  // Added 2026-07-24 at Aaron's request, and it exists because of a genuinely useful
  // accident: before v7, keepCount was sliced by getCountScale(width, height), so SMALL
  // placements (a 3000x1800 t-shirt sleeve, countScale 0.807) silently dropped ~19% of the
  // shapes -- and that sparser version read dramatically brighter and more vivid than the
  // full-density front panel, because the shapes dropped are large translucent ones that
  // blend everything beneath them darker. v7 correctly removed that (density must not vary
  // by resolution, or a mockup lies about the print), which also removed the only way to
  // GET that look. This setting brings it back as a deliberate, size-INDEPENDENT choice:
  // every placement on a garment gets the same density, which is exactly what the v7 fix
  // guarantees and what the accident never could.
  //
  // Default 1 keeps output byte-identical to pre-density designs -- buildShape() already
  // runs shapeNum times unconditionally regardless of this value, so rng() consumption is
  // untouched and no GENERATOR_VERSION bump is needed (same reasoning as the original
  // settings block; verified by PNG hash across several seeds and sizes).
  density: 1,
  // Whether the star field composites ABOVE the geometry layer instead of below it.
  // false (default) keeps the original order: background -> radial field -> stars ->
  // geometry -> overlay. true swaps the middle pair only; the overlay stays on top either
  // way.
  //
  // Added 2026-08-18 at Aaron's request. The default order looks right while the geometry
  // is small, but a large or high-coherence figure covers most of the canvas -- the lattice
  // at coherence 1 is a near-complete fill of overlapping cells, not a sparse scatter -- so
  // the stars underneath are lost entirely. That is worst when the layer's own blend
  // (config.thirdBlend, still a uniform pick from all eight modes) happens to be a
  // darkening one, which is exactly the failure starBlendMode was introduced to fix for the
  // star layer itself and has never been applied to the layer sitting on top of it.
  //
  // Purely a compositing order, consumed by renderArtwork -- it consumes ZERO rng() and
  // touches no layer generation, so every layer's geometry, colours and blend modes are
  // byte-identical either way and default false is byte-identical to pre-setting output.
  // Hence no GENERATOR_VERSION bump. Unlike mirrorX/legSymmetry (render context, per-order)
  // this IS part of a design's identity: it changes how the design itself reads, so it is
  // persisted and compared by isSameDesign.
  starsOnTop: false
  // A `frontOnly` field used to live here (whether the geometry layer was suppressed on
  // non-front merch placements) but was removed 2026-07 -- baking that choice into the
  // saved design meant it was permanent for every product the design was ever printed on.
  // It's now a per-order choice instead: ProductPage.jsx's placement checkboxes, threaded
  // through as `includeGeometry` render context (see generateArtwork's renderContext
  // param) rather than a design setting. Old saved designs may still carry a stray
  // `settings.geometry.frontOnly` key; it's simply never read anymore.
};

// Resolve a design's stored `settings` (possibly missing/partial) to a full geometry
// settings object.
export function getGeometrySettings(settings) {
  return { ...DEFAULT_GEOMETRY_SETTINGS, ...(settings?.geometry || null) };
}

// Normalize `settings` for persistence: undefined when everything is at its default (so
// compact designs stay minimal and old-format designs stay old-format), otherwise the full
// resolved geometry block. Idempotent.
export function compactSettings(settings) {
  const geometry = getGeometrySettings(settings);
  const isDefault = Object.keys(DEFAULT_GEOMETRY_SETTINGS).every(
    key => geometry[key] === DEFAULT_GEOMETRY_SETTINGS[key]
  );
  return isDefault ? undefined : { geometry };
}

// Two settings objects mean the same design if they resolve to the same values.
export function isSameSettings(a, b) {
  const ga = getGeometrySettings(a);
  const gb = getGeometrySettings(b);
  return Object.keys(DEFAULT_GEOMETRY_SETTINGS).every(key => ga[key] === gb[key]);
}

// Two designs are "the same" if they'd regenerate identical artwork -- same seed, same
// palette, same generation settings -- regardless of whether they're literally the same
// object in memory (a saved design is always a distinct compacted object from whatever full
// generateArtwork() output produced it). Lives here (not StudioContext.jsx, where it
// originated) because mixing a plain function export in with a file that also exports a
// React hook (useStudio) breaks Vite's Fast Refresh boundary for that file -- confirmed live
// via the dev server's "Could not Fast Refresh" HMR warning once both were exported
// together. This file already has no React exports, so it's a clean, correct home.
export function isSameDesign(a, b) {
  if (!a || !b || a.seed !== b.seed) return false;
  const ac = a.colors || [];
  const bc = b.colors || [];
  if (!(ac.length === bc.length && ac.every((c, i) => c === bc[i]))) return false;
  return isSameSettings(a.settings, b.settings);
}
