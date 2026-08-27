import ScrollStrip from './ScrollStrip';
import { PALETTE_PRESETS, isPresetPalette } from '../../render/palettePresets';

// The curated-palette strip at the foot of the studio's Color tab, in place of the old
// ADD 🌈 button (whose palette is still here, as `Spectrum`).
//
// One scrolling row of named swatch clusters, chosen over the three alternatives that were
// mocked at the panel's real metrics first:
//
//   - A drill-in list behind a PALETTES button. Free at rest and it scales to any number, but
//     browsing means leaving the swatches -- and picking a preset then nudging one stop is the
//     whole point, so making that two screens is the wrong trade while the list is this short.
//   - A popover grid. Same zero resting height, plus the swatches stay visible behind it, but
//     it wants outside-click/Escape/focus-return handling that nothing else in this panel has.
//   - An arrows-and-APPLY stepper. Smallest of all, and no new component, but one palette at a
//     time stops being browsing at about eight.
//
// The cost is height, which is the scarce axis in this panel -- but the Color tab is the
// shortest of the three by a wide margin (the 2D Video tab needs 584px against an iPhone's
// ~636px, and this one sits ~200px below that even with six swatches), so it is the one tab
// that can afford a strip.
//
// The cluster is GalleryModal's palette chip, deliberately: overlapping the swatches makes a
// palette read as one object rather than four dots competing with the chip's own label.
export default function PalettePicker({ colors, onApply }) {
  // `colors` is the live swatch list. It lags the DOM by up to the 350ms debounce after a
  // jscolor edit (see DisplayCanvas.onColorSwatchEdit, which reads the inputs back into state
  // there rather than on every input event) -- so a chip can stay lit for that beat after a
  // stop has been nudged off the preset. Worth knowing, not worth a second source of truth:
  // it settles on its own, and this only drives a highlight.
  const activeName = PALETTE_PRESETS.find(preset => isPresetPalette(preset, colors))?.name;

  return (
    <div className="palette-picker">
      <div className="palette-picker-label">
        <span className="settings-label">Palettes</span>
        <span className="settings-label-note">{activeName || `${PALETTE_PRESETS.length}`}</span>
      </div>
      {/* dragToScroll for the desktop half: the chips look like buttons, so without it the
          4px scrollbar is the only thing on screen that suggests the row moves at all. Touch
          swipes the row natively, and the rail's own `overscroll-behavior-x: none` keeps that
          swipe from chaining out to the page at either end. */}
      <ScrollStrip className="palette-strip" railClassName="palette-strip-rail" dragToScroll>
        {PALETTE_PRESETS.map(preset => (
          <button
            key={preset.name}
            type="button"
            className="palette-chip"
            aria-pressed={preset.name === activeName}
            // The swatches are decorative here -- the name is the accessible label, and the
            // colours are what the sighted user reads instead of it.
            aria-label={`Use the ${preset.name} palette`}
            onClick={() => onApply(preset.colors)}
          >
            <span className="palette-chip-cluster" aria-hidden="true">
              {preset.colors.map((hex, i) => (
                <span key={hex + i} style={{ backgroundColor: hex }} />
              ))}
            </span>
            <span className="palette-chip-name">{preset.name}</span>
          </button>
        ))}
      </ScrollStrip>
    </div>
  );
}
