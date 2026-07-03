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
  // unfilled); 1 = a clean regular polygon, every lattice cell filled, sized to sit fully
  // inside the canvas with clearance on all sides.
  coherence: 0
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
