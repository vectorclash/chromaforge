// Curated colour palettes, offered as the PALETTES strip in the studio's Color tab (which
// replaced the old ADD 🌈 button — that palette survives here as `Spectrum`, byte-identical).
//
// THIS FILE IS THE WHOLE EDITABLE SURFACE. Add, remove, reorder or rename freely; nothing
// else needs touching. Four rules the picker depends on, checked by `validatePalettePresets`
// in dev so a typo surfaces at once rather than as a silently wrong swatch:
//
//   1. At most MAX_PRESET_COLORS colours. The swatch panel caps at six (ADD COLOR hides above
//      five) and `studioPrefs` drops anything longer when it restores a session, so a seventh
//      entry would disappear somewhere between the click and the next page load.
//   2. Six-digit '#rrggbb' only. studioPrefs' validator also accepts 3-, 4- and 8-digit forms
//      and normalises none of them, so writing every stop the one way is what keeps what comes
//      back out of storage identical to what went in.
//   3. Names are what the chip shows (uppercased by CSS). There is no hard limit -- a name
//      never truncates and never overflows the page; it just makes its chip wider (measured:
//      ~91px + ~7px per character, plus 11px per swatch past four), and the strip scrolls.
//      What a long name costs is NEIGHBOURS. The visible strip is 326px on desktop and
//      300/270/230px at 390/360/320. So: 8 characters is the practical ceiling -- it still
//      shows two whole chips on a 390px phone, which is what makes the row read as a row
//      rather than one lone control beside a mysterious fade. Six keeps two chips at 360 as
//      well; past 11 a phone shows one chip, and past ~20 a single chip is wider than the
//      whole strip at 320px and can never be seen alongside anything.
//   4. Order is the order they appear, and the first is the one closest to hand on a phone.
//
// A palette is only ever the STARTING point: it lands in the six swatches as ordinary colours,
// editable and reorderable exactly as if they had been picked by hand. Nothing records which
// preset a design came from, so this list can change without touching a single stored design.

// The swatch panel's own ceiling. Mirrors MAX_COLORS in lib/studioPrefs.js and the
// `colors.length < 6` gate on DisplayCanvas's ADD COLOR button — all three describe the same
// limit and must move together.
export const MAX_PRESET_COLORS = 6;

export const PALETTE_PRESETS = [
  { name: 'Chromaforge', colors: ['#FF004A', '#008AFC', '#FFFFFF', '#67FF0E', '#202020'] },
  { name: 'Spectrum', colors: ['#ff0059', '#ffbb00', '#ccff00', '#00e5ff', '#4c00ff'] },
  { name: 'Nebula', colors: ['#12327E', '#FF048B', '#BFFF56', '#1FF177'] },
  { name: 'Solar', colors: ['#E8623C', '#E39A33', '#D02A9E', '#E23A6B', '#E2494F'] },
  { name: 'Glacial', colors: ['#752DFF', '#001784', '#0DD0FF', '#D3F292', '#CEE9FF'] },
];

// Deliberately stricter than studioPrefs' HEX: that one is lenient because it reads values the
// USER may have hand-set, while everything here is authored in this file and can simply be
// written correctly.
const STRICT_HEX = /^#[0-9a-fA-F]{6}$/;

// Dev-only. Returns the problems rather than throwing, so a bad entry warns and the rest of
// the strip still works — a mistyped palette should not take the whole Color tab down.
export function validatePalettePresets(presets = PALETTE_PRESETS) {
  const problems = [];
  const seen = new Set();
  presets.forEach((preset, i) => {
    const where = `PALETTE_PRESETS[${i}]${preset?.name ? ` (${preset.name})` : ''}`;
    if (!preset?.name) problems.push(`${where}: missing name`);
    else if (seen.has(preset.name)) problems.push(`${where}: duplicate name`);
    else seen.add(preset.name);

    const colors = preset?.colors;
    if (!Array.isArray(colors) || colors.length === 0) {
      problems.push(`${where}: needs at least one colour`);
      return;
    }
    if (colors.length > MAX_PRESET_COLORS) {
      problems.push(
        `${where}: ${colors.length} colours, but the swatch panel holds ${MAX_PRESET_COLORS}`
      );
    }
    colors.forEach(hex => {
      if (!STRICT_HEX.test(hex)) problems.push(`${where}: '${hex}' is not a #rrggbb value`);
    });
  });
  return problems;
}

if (import.meta.env?.DEV) {
  const problems = validatePalettePresets();
  if (problems.length) {
    console.warn(`[palettePresets] ${problems.length} problem(s):\n  ${problems.join('\n  ')}`);
  }
}

// Is this exactly the palette a preset hands out? Used only to light the chip you are
// currently on, so it is order- and length-sensitive on purpose: reordering two swatches
// really does make a different palette to this generator (the gradient walks them in order).
// Case-insensitive because the swatches come back through jscolor, which may re-case them.
export function isPresetPalette(preset, colors) {
  if (!preset || !Array.isArray(colors) || colors.length !== preset.colors.length) return false;
  return preset.colors.every((hex, i) => String(colors[i] ?? '').toLowerCase() === hex.toLowerCase());
}
