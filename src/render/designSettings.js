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
  // How large the CHAOTIC shapes tend to be -- the exact counterpart of `size` above, which
  // only ever governed the coherent lattice. 0.5 is today's behaviour exactly; higher values
  // make a design's shapes bigger on average AND make small ones rare, because the slider's
  // upper half both SKEWS the size draw's distribution and raises its ceiling.
  //
  // Added 2026-09-17 at Aaron's request ("the average geometry size fills the artwork and
  // smaller geometric shapes are much more rare", then "it can definitely go much larger"). The chaotic size draw was a flat
  // `rng() / 3` -- uniform, so the bottom of its range was exactly as likely as the top, and
  // a design that happened to draw low rendered as a small cluster marooned in the middle of
  // the canvas. That low tail is the whole complaint: measured over 400 seeds at the studio's
  // own 3840x2160, the per-design median shape spanned 1.81 short-edges at the 90th percentile
  // but only 0.43 at the 10th -- a 4x spread, entirely down to one uniform draw.
  //
  // It is deliberately a SEPARATE key from `size` rather than an extension of it, and that is
  // a correctness requirement, not tidiness: `size` is already stored on designs in the
  // gallery, so widening its meaning would re-render every one of those that carries a
  // non-default value at less than full coherence. A key that did not exist until now cannot
  // appear in any stored row, so every existing design resolves to the 0.5 default and is
  // byte-identical by construction -- which is the only way to make this change without
  // rewriting artwork customers have already saved (see check-render-regression.mjs).
  //
  // Consumes the SAME single rng() draw in the same position (the skew is arithmetic applied
  // to the value, not an extra draw), so no downstream layer shifts and no GENERATOR_VERSION
  // bump is needed -- same reasoning as `density` above. Verified by PNG hash across seeds
  // and sizes. Like `density` it is size-INDEPENDENT, so it cannot reintroduce the v7
  // mockup/print divergence.
  spread: 0.5,
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

// `geometry.chance` is deliberately NOT in the block above, because it is not a property of
// the artwork at all -- it is the odds of a coin flip, and it reads differently depending on
// which direction it is travelling.
//
// Going IN to generateArtwork it is a PROBABILITY: the odds the geometry layer appears, which
// is what the studio's slider sets. Coming back OUT on a generated design it is a resolved
// FACT -- exactly 1 (this design has geometry) or 0 (it does not) -- because the coin has been
// flipped and a design that already exists cannot un-flip it. Odds are never persisted.
//
// Hence two separate constants, neither of them a "default" for the block above:

// What an ABSENT chance means, and nothing else. It reproduces the original hardcoded
// `rng() >= 0.6` for a design blob that predates the resolved-fact change -- an old share
// link, an order's audit copy in order_items.design_data, a stale localStorage entry. Every
// row in the designs table states its own `present` instead (scripts/backfill-geometry-
// presence.mjs), so nothing in the gallery depends on this any more.
// It is a compatibility constant, not a tunable: changing it re-rolls the coin for every
// legacy blob still in circulation, which is exactly the class of change
// check-render-regression.mjs exists to block.
export const LEGACY_GEOMETRY_CHANCE = 0.4;

// The odds the studio's slider starts a fresh session (or a RESET) on. Free to move: a
// generated design records `present`, never the odds, so changing this cannot reach anything
// already made.
//
// 0.9 rather than the historical 0.4 (Aaron, 2026-08-26 raised it to 0.7, 2026-09-17 to 0.9):
// the geometry layer is the most distinctive thing the generator does, and below this a
// noticeable share of fresh generates still arrived without it. Deliberately not 1 -- an
// occasional design with no geometry at all is part of the range, and `chance` still means
// odds, so pinning it would make the slider's top end indistinguishable from "always".
export const STUDIO_DEFAULT_GEOMETRY_CHANCE = 0.9;

// The chaotic-shape size the studio's slider starts a fresh session (or a RESET) on. Free to
// move for exactly the same reason the chance default is: a stored design carries its own
// `spread`, and one saved before the key existed resolves to DEFAULT_GEOMETRY_SETTINGS.spread
// (0.5, today's behaviour), so nothing already made can be reached from here.
//
// 0.7 rather than the 0.5 that reproduces the original generator: picked from rendered sheets
// of real seeds rather than from the arithmetic, and deliberately well short of the ceiling,
// which the upper half of the slider now raises steeply (see GenerateGeometricShape's
// SPREAD_MAX_GAIN).
//
// It was 0.85 for a few hours, against a slider whose top end only SKEWED the old range. Once
// the ceiling was raised (Aaron, 2026-09-17: "it can definitely go much larger") the same
// number meant something much bigger, so the default was re-picked against the new curve
// rather than left to drift up with it. 0.7 lands on exactly the figure the original request
// was measured by -- 3.8% of designs whose typical shape covers less than half the canvas's
// short edge, against 18.5% for the original generator -- while the median such shape spans
// 1.69 short edges. ~0.6 reproduces the pre-ceiling default's own look if it is ever wanted
// back.
export const STUDIO_DEFAULT_GEOMETRY_SPREAD = 0.7;

// Whether the studio starts a fresh session (or a RESET) with the stars composited ON TOP of
// the geometry layer. True since 2026-09-17, and it is the direct consequence of the Spread
// default above: STUDIO_DEFAULT_GEOMETRY_SPREAD makes a typical fresh design's shapes span
// well over a whole short edge, and a figure that large is exactly the case the starsOnTop
// toggle was added for in the first place (see DEFAULT_GEOMETRY_SETTINGS.starsOnTop -- "a
// large or high-coherence figure covers most of the canvas, so the stars underneath are lost
// entirely"). Raising Spread without this would have made the star field invisible on most
// new work, which is the opposite of what v10's whole contrast rework was for.
//
// This is a STUDIO default, NOT a change to DEFAULT_GEOMETRY_SETTINGS.starsOnTop, and the
// distinction is a correctness requirement rather than a matter of taste. starsOnTop is part
// of a design's IDENTITY -- persisted, compared by isSameDesign -- so an absent key on a
// stored row resolves through the DNA default, and flipping THAT would re-composite every
// design already in the gallery. A studio default cannot reach anything already made, the
// same property that makes `chance` and `spread` free to move.
//
// Deliberately not derived from the live Spread value at generate time, which is the tempting
// version: the panel's settings are the input to the NEXT generate, so a toggle that moved
// itself would both surprise the user and make the studio's state depend on its own output.
// It is an ordinary default that a single click undoes.
export const STUDIO_DEFAULT_GEOMETRY_STARS_ON_TOP = true;

// What a surface making NEW work starts from: the DNA defaults plus the studio's odds. Read
// by StudioContext's first design of a session, DisplayCanvas's panel when nothing is stored,
// and RESET. Every path that reproduces a STORED design resolves through
// getGeometrySettings instead.
export const STUDIO_DEFAULT_GEOMETRY_SETTINGS = {
  ...DEFAULT_GEOMETRY_SETTINGS,
  chance: STUDIO_DEFAULT_GEOMETRY_CHANCE,
  spread: STUDIO_DEFAULT_GEOMETRY_SPREAD,
  starsOnTop: STUDIO_DEFAULT_GEOMETRY_STARS_ON_TOP
};

// Resolve a design's stored `settings` (possibly missing/partial) to a full geometry
// settings object.
export function getGeometrySettings(settings) {
  const resolved = { ...DEFAULT_GEOMETRY_SETTINGS, chance: LEGACY_GEOMETRY_CHANCE };
  const stored = settings?.geometry;
  // A whitelist, not a spread, and that is load-bearing rather than fastidious. This object
  // becomes DisplayCanvas's slider state, and slider state is the input to the NEXT generate
  // -- so anything that rides through here on a loaded design silently governs every design
  // made after it. A spread carried `present` through exactly that way (caught in a real
  // browser): opening a saved design put its stated geometry into the panel, and every
  // Generate from then on inherited it instead of flipping its own coin. The fact belongs to
  // one design; only the knobs below belong to the studio. It also drops the stray legacy
  // `frontOnly` key some old rows still carry, which nothing has read since 2026-07.
  if (stored) {
    for (const key of Object.keys(resolved)) {
      if (stored[key] !== undefined) resolved[key] = stored[key];
    }
  }
  return resolved;
}

// The same resolution for a surface that is about to make NEW work rather than reproduce
// stored work: an absent/partial block falls back to the studio defaults instead of the
// legacy ones. Never use this to render a stored design -- see the note above.
export function getStudioGeometrySettings(settings) {
  const resolved = getGeometrySettings(settings);
  // Same whitelist (it is built on the resolver above, deliberately, so the two cannot drift
  // and neither can carry a design's `present` into the panel), differing only in what an
  // absent chance means: the studio's odds for new work rather than the legacy value.
  if (settings?.geometry?.chance === undefined) resolved.chance = STUDIO_DEFAULT_GEOMETRY_CHANCE;
  // And the same for spread, for the same reason plus one specific to it being new: a
  // returning visitor's stored prefs were written before this key existed, so an absent value
  // there means "never chose one", not "chose the old generator's 0.5". Falling back to the
  // resolution default instead would pin every existing browser to the old small-shape look
  // permanently, which is the one outcome this change exists to avoid.
  if (settings?.geometry?.spread === undefined) resolved.spread = STUDIO_DEFAULT_GEOMETRY_SPREAD;
  // Same again for the layer order. Tested for `undefined` specifically, never for
  // falsiness: a user who has turned the toggle OFF has stored a real `false`, and that has
  // to survive -- coercing it would make the control impossible to switch off across a
  // reload. (studioPrefs' sanitiser carries the same distinction, for the same reason.)
  if (settings?.geometry?.starsOnTop === undefined)
    resolved.starsOnTop = STUDIO_DEFAULT_GEOMETRY_STARS_ON_TOP;
  return resolved;
}

// The settings to make MORE work in the style of a design already on screen -- what the
// mini-generator's Generate and the remembered studio prefs both want. Its DNA (points,
// coherence, size, density, layer order) carries over as-is, but `chance` is deliberately
// NOT taken from the design: a design states its geometry through `present` and stores no
// odds at all, so the only sensible source for the next roll is the user's own setting (and
// `present` itself is stripped by the resolver above, so it cannot ride along). Those odds
// come from the
// generation-context field generateArtwork hands back (config.geometryChance), falling back
// to the studio default for anything that did not come from a generate -- a raw stored
// gallery row, say.
export function getGenerationSettings(config) {
  const { chance: _resolved, ...dna } = getGeometrySettings(config?.settings);
  return {
    geometry: {
      ...dna,
      chance:
        typeof config?.geometryChance === 'number'
          ? config.geometryChance
          : STUDIO_DEFAULT_GEOMETRY_CHANCE
    }
  };
}

// Whether a design STATES that it has the geometry layer: true, false, or null for a design
// that states nothing and must therefore fall back to flipping the coin (see generateArtwork).
//
// Deliberately read straight off the raw settings rather than being folded into
// getGeometrySettings' resolved object, and that is a correctness requirement, not a style
// choice: that object becomes DisplayCanvas's slider state, and slider state is the input to
// the NEXT generate. A `present` riding along in there would force every subsequent design
// off the same panel to the same answer, which is the opposite of what this field is for.
// The fact belongs to a design; the odds belong to the studio.
export function getGeometryPresence(settings) {
  const stated = settings?.geometry?.present;
  if (typeof stated === 'boolean') return stated;
  // A legacy blob written before `present` existed still states the fact when its odds are
  // absolute: chance 1 could only ever mean "this design has geometry" (threshold 0, the draw
  // always passes) and 0 only "it does not". Reading them as statements rather than odds is
  // not a courtesy -- it renders identically either way, but it makes those designs immune to
  // a shift in the shared rng sequence immediately, and it lets isSameDesign recognise such a
  // row and its own regenerated form as the same design (they differ only in which field
  // carries the answer). Anything strictly between stays real odds and falls through to the
  // coin, because nothing else can be recovered from a probability.
  const chance = settings?.geometry?.chance;
  if (chance === 1) return true;
  if (chance === 0) return false;
  return null;
}

// Normalize `settings` for persistence: undefined when everything is at its default (so
// compact designs stay minimal and old-format designs stay old-format), otherwise the full
// resolved geometry block. Idempotent.
export function compactSettings(settings) {
  const geometry = getGeometrySettings(settings);
  const { chance, ...dna } = geometry;
  const dnaIsDefault = Object.keys(DEFAULT_GEOMETRY_SETTINGS).every(
    key => dna[key] === DEFAULT_GEOMETRY_SETTINGS[key]
  );
  const present = getGeometryPresence(settings);

  // A design that states its geometry stores THAT and nothing about odds -- `chance` is
  // dropped outright, because a probability has no meaning on a piece that already exists.
  // Every design generated by this bundle takes this branch (generateArtwork always states
  // the resolved outcome), so odds cannot reach storage at all.
  if (present !== null) return { geometry: { ...dna, present } };

  // Legacy blob: it states nothing, so its `chance` is still the only signal of how the coin
  // would fall and has to be preserved exactly. Dropped only when it is the absent-value,
  // where it carries no information and keeping it would just bloat an old-format design.
  if (chance === LEGACY_GEOMETRY_CHANCE) return dnaIsDefault ? undefined : { geometry: dna };
  return { geometry: { ...dna, chance } };
}

// Two settings objects mean the same design if they resolve to the same values.
export function isSameSettings(a, b) {
  const ga = getGeometrySettings(a);
  const gb = getGeometrySettings(b);
  // Presence first: it is the statement of fact, and two designs that disagree about whether
  // they have a geometry layer are different designs whatever else matches. `chance` is only
  // consulted for legacy blobs that state nothing, where it is still the deciding input.
  if (getGeometryPresence(a) !== getGeometryPresence(b)) return false;
  if (getGeometryPresence(a) === null && ga.chance !== gb.chance) return false;
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
