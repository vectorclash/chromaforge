// Auto colour occasionally lands on one of the curated palettes (Aaron, 2026-11-16).
//
// The roll happens only when NEW work is made with an empty palette -- the studio's Generate,
// the mini generators, a new 3D flight. The design that comes out carries the palette's colours
// like any other design (so every surface, a save and a print agree on them), plus a
// generation-context marker, `autoPalette`, saying those colours were rolled rather than chosen.
// The marker is what keeps the palette from sticking: the swatches stay on Auto, the remembered
// prefs stay empty, and the next Generate rolls again. Like geometryChance it is never
// persisted with a saved design -- a saved row simply has those colours.
//
// Nothing here runs when a stored design is reproduced, so no existing auto-colour design can
// change. The roll has its own stream and takes nothing from the shared sequence.
import { makeRng } from './prng';
import { PALETTE_PRESETS } from './palettePresets';

export const AUTO_PALETTE_CHANCE = 0.15;

// The curated palette a fresh auto-colour design with this seed lands on, or null (most seeds).
export function rollAutoPalette(seed) {
  const rng = makeRng(`${seed}-autopalette`);
  if (rng() >= AUTO_PALETTE_CHANCE || PALETTE_PRESETS.length === 0) return null;
  const preset = PALETTE_PRESETS[Math.floor(rng() * PALETTE_PRESETS.length)];
  return preset.colors.slice();
}

// The palette the USER chose for a design: empty when its colours were rolled. What the swatch
// panel, the remembered prefs and "generate more like this" should read instead of
// design.colors.
export function chosenColors(design) {
  return design?.autoPalette ? [] : design?.colors ?? [];
}

// For a caller about to make NEW work: the colours to generate with, and whether they were
// rolled. A chosen palette passes straight through.
export function colorsForNewWork(seed, chosen = []) {
  if (chosen.length > 0) return { colors: chosen, autoPalette: false };
  const rolled = rollAutoPalette(seed);
  return rolled ? { colors: rolled, autoPalette: true } : { colors: [], autoPalette: false };
}
