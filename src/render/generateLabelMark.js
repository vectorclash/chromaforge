// Pure generator for the small brand mark used on Printful's dedicated label placements
// (label_inside/label_outside -- see CLAUDE.md's merch-pipeline notes). Reuses the
// vectorclash logo's line geometry AND its actual per-line color logic from Logo.jsx's
// animateLogo(), but is a from-scratch redraw of those coordinates rather than a port of
// that component: Logo.jsx is GSAP/DOM/SVG-driven (for its homepage hover animation) and
// can't run headless in render-service, so this stays plain data + Canvas2D like every
// other generator in this directory.
//
// Deliberately its own tiny generator, not a mode of generateArtwork -- it shares no
// layers with the main composition and must never draw from the same rng stream (see
// prng.js): a '-label' seed suffix keeps its randomness independent of the main artwork's,
// so changing a design's geometry settings can't shift which logo lines happen to survive
// on its label.

import tinycolor from 'tinycolor2';
import { makeRng } from './prng';
import { resolveDesignPalette } from './resolvedPalette';

// v5 (2026-07-30): the split-panel aspect threshold was removed -- see the layout-rule
// comment below. Only the bucket hat's `label_inside` changes output; every other label in
// the catalogue is byte-identical (verified by PNG hash across all six real sizes).
//
// v6 (2026-08-12): the accent is taken from the design's RESOLVED palette instead of its
// stored `colors` -- see generateMarkLines. Before this, every auto-palette design (the
// majority) printed the same yellow-green mark, on the tag AND in the animation overlay.
// User-palette designs are byte-identical; auto-palette and monochrome ones are recoloured.
//
// v7 (2026-08-13): the accent is the MOST SATURATED stop of the resolved palette rather than a
// random one -- see pickAccentSource. Which chords survive and the greys on the ~80% that
// aren't accented are untouched.
// v8 (2026-08-29): `lightInk` decouples "no background panel" from "dark ink". label_outside now
// picks its ink from the artwork it is printed over (see src/render/labelBackdrop.js) instead of
// always inverting, which was correct only on light artwork -- four of six real designs measured
// dark where the shorts' label lands. The light ink is not a new treatment: it is exactly what the
// inside tag already prints, minus the tag's own dark panel.
// v9 (2026-08-29): the reversible bucket hat's `label_inside` renders transparent over the artwork
// like its `label_outside`, instead of painting an opaque dark panel plus an accent block. It is the
// only product whose inside label is a visible printed patch rather than a sewn tag, and the two
// faces read as different marks when the hat is reversed. Driven by PRODUCT_MOCKUP_CONFIG's
// `labelInsideRegion`, so every other product's inside tag is byte-identical.
export const LABEL_MARK_GENERATOR_VERSION = 9;

// Layout rule (Aaron, 2026-07-30): **the mark gets a square, and whatever is left over is
// accent.** A square dark panel holds the mark; the remaining rectangle is filled flat with
// the design's own chosen accent color, tying the sewn-in tag to the artwork's palette
// instead of leaving the mark alone in a long dark field.
//
// There is deliberately NO aspect threshold. The accent's share is already a smooth,
// continuous function of the label's shape -- `1 - 1/aspect`, i.e. 60% at 2.5:1, 43% at
// 1.75:1, 33% at 1.5:1 -- and it reaches exactly 0 on its own at a square. An earlier
// `SPLIT_MIN_ASPECT = 1.6` cliff snapped everything below it to no accent at all, which
// zeroed the bucket hat's natural 33% for no reason (its labels are 450x300, aspect 1.50).
// Removing the threshold changed exactly one label in the whole catalogue -- that one; the
// square marks were already at 0 by the arithmetic, and every transparent variant forces
// `accent` to null regardless (see the `transparent` handling below).
//
// A portrait label (taller than wide) would leave nothing over, so it correctly falls to the
// single centered panel. Nothing in the catalogue is portrait today.

// The vectorclash mark's 37 chords, copied directly from Logo.jsx's <line> coordinates.
const LINES = [
  [306, 252, 306, 108],
  [180, 36, 306, 108],
  [54, 108, 180, 36],
  [54, 252, 54, 108],
  [306, 252, 180, 324],
  [54, 252, 180, 324],
  [180, 36, 180, 324],
  [306, 108, 54, 252],
  [306, 252, 54, 108],
  [180, 36, 243, 144],
  [243, 216, 243, 144],
  [180, 36, 117, 144],
  [243, 216, 180, 252],
  [117, 144, 117, 216],
  [180, 252, 117, 216],
  [243, 144, 180, 108],
  [117, 144, 180, 108],
  [117, 216, 180, 324],
  [243, 216, 180, 324],
  [180, 108, 54, 108],
  [306, 108, 180, 108],
  [306, 252, 180, 252],
  [54, 252, 180, 252],
  [117, 216, 54, 108],
  [54, 252, 117, 144],
  [306, 108, 243, 216],
  [306, 252, 243, 144],
  [180, 324, 243, 144],
  [117, 144, 180, 324],
  [180, 36, 117, 216],
  [243, 216, 180, 36],
  [306, 252, 117, 216],
  [180, 108, 306, 252],
  [306, 108, 117, 144],
  [180, 252, 306, 108],
  [54, 108, 243, 144],
  [54, 252, 243, 216],
  [180, 108, 54, 252],
  [54, 108, 180, 252]
];

// Logo.jsx's <path> (the ring) is never touched by animateLogo()'s per-line randomization
// -- Logo.scss hardcodes it white and it always renders fully. Same here: fixed, not
// derived from the design at all.
const RING_CENTER = [180, 180];
const RING_RADIUS = 145;
const RING_COLOR = '#f5f5f5';

// The app's own dark ink/purple base tone (--color-ink-900 in tailwind.css), same family
// used behind the studio -- picked so the near-white ring and pale greyscale chords (see
// below) actually read, instead of the light-grey background this used to have (wrong:
// Logo.jsx's ring is white, which would nearly vanish on a light background).
const BACKGROUND_COLOR = '#181520';

// Logo.jsx's own fallback base hue, used only if a design somehow has no colors at all.
const DEFAULT_BASE_COLOR = '#ccff00';

// True geometric bounds of the mark (ring union lines) -- NOT the same as Logo.jsx's own
// SVG viewBox (0 0 313.4 303.4), which doesn't actually center this geometry (the ring
// alone spans x:[35,325] -- wider than that viewBox). Centering against the declared
// viewBox is what made earlier renders look off-center; this computes the mark's real
// bounding box directly from its coordinates so centering is exact.
function computeBounds() {
  let minX = RING_CENTER[0] - RING_RADIUS;
  let maxX = RING_CENTER[0] + RING_RADIUS;
  let minY = RING_CENTER[1] - RING_RADIUS;
  let maxY = RING_CENTER[1] + RING_RADIUS;
  for (const [x1, y1, x2, y2] of LINES) {
    minX = Math.min(minX, x1, x2);
    maxX = Math.max(maxX, x1, x2);
    minY = Math.min(minY, y1, y2);
    maxY = Math.max(maxY, y1, y2);
  }
  return { minX, maxX, minY, maxY, width: maxX - minX, height: maxY - minY };
}

const BOUNDS = computeBounds();

// Forces a minimum lightness/saturation so the chosen accent stays visible against the
// fixed dark background regardless of how dark or muted the source palette color
// originally was -- "a contrast OF the chosen color," not the color itself.
function legibleAccent(hex) {
  const hsl = tinycolor(hex).toHsl();
  hsl.l = Math.max(hsl.l, 0.55);
  hsl.s = Math.max(hsl.s, 0.5);
  return tinycolor(hsl).toHexString();
}

// Which palette stop becomes the mark's accent (v7, Aaron's call 2026-08-13). Deterministic:
// the most saturated stop wins, first one on a tie.
//
// This was a uniform random pick, and the honest reason it changed is small: measured through
// the real generator over 300 auto-palette seeds, EVERY stop is already vivid (mean HSL
// saturation 0.72, mean lightness 0.53) and legibleAccent above never once had to rescue a
// pick -- so this is not a fix for washed-out marks, it just stops preferring a duller stop
// when a more chromatic one is sitting right beside it in the same palette. It differs from the
// random pick on roughly two thirds of designs. A palette of greys still yields a grey-derived
// accent, which is the intended answer: the mark follows the design rather than inventing a
// colour for it.
//
// It is NOT the fix for a mark reading mostly grey -- that is the ~80/20 grey/accent split in
// generateMarkLines below (mean 4.6 accented chords of 23.5), which is Logo.jsx's own behaviour
// and was deliberately left alone.
//
// HSL saturation, not chroma or luminance: it is the measure the decision was actually made
// against, and legibleAccent's own floors are HSL too, so the two can't disagree about what
// "dull" means.
function pickAccentSource(colors) {
  let best = colors[0];
  let bestSaturation = -1;
  for (const color of colors) {
    const saturation = tinycolor(color).toHsl().s;
    if (saturation > bestSaturation) {
      bestSaturation = saturation;
      best = color;
    }
  }
  return best;
}

// width/height are the target placement's own printfile dims (e.g. 375x150 for
// label_inside, 450x450 for label_outside) -- the renderer scales/centers the mark to fit
// whichever aspect it's given.
//
// `transparent` (v4, Aaron-approved from real track-jacket draft mockups, order
// 166999659): no panel fills at all -- the mark prints directly over whatever the
// placement sits on. Printful composites label placements OVER the garment's own print
// (confirmed on a real mockup, not bare fabric), so the dark-panel look isn't needed for
// contrast there. Ink colors invert to survive without the dark field: the ring becomes
// the dark ink itself, and the light greyscale chords flip to their dark complements;
// the colored accent spins stay as-is. Used for label_outside; label_inside keeps the
// dark split-panel (it's a sewn-in tag -- the panel IS the look there).
// The seeded mark itself -- which chords survive and what ink each carries -- with no
// layout attached. Extracted so the animation's logo overlay (generateLogoMark.js) is
// literally the same code rather than a parallel copy that could drift: a design's video
// mark and its printed label mark are the same mark, because they run this function
// against the same '-label' stream.
//
// Matches Logo.jsx's animateLogo() exactly: each chord independently has a 60% chance to
// show at all (alphaChance > 0.4); of the ones that show, ~80% render as a random light
// greyscale value (100-255) and ~20% as a small hue-spin variant of the single chosen
// accent (colorChance > 0.8, spin -15..+15) -- never one flat color for the whole mark.
//
// THE ACCENT COMES FROM THE DESIGN'S RESOLVED PALETTE, NOT `design.colors` (v6, 2026-08-12,
// Aaron: the shorts he ordered came back with the same yellow tag). `design.colors` is a
// design's stored IDENTITY, and it is EMPTY for every auto-palette design and a single entry
// for a monochrome one (see resolvedPalette.js) -- so reading it directly sent the most common
// case straight to DEFAULT_BASE_COLOR, and every auto-palette design in the catalogue printed
// the identical yellow-green (#d1ff1a after legibleAccent) mark. resolveDesignPalette
// regenerates the real palette when handed a compact design, which is the shape the whole
// merch pipeline works in.
//
// `palette` is an explicit override for a caller whose palette this function cannot derive --
// the 3D animation overlay, whose tunnel scene invents its own (see animation3d/scenePalette).
//
// Either route consumes the SAME single rng() draw, and v7's deterministic pick still burns it
// (see below). So WHICH chords survive, and the greyscale ink on the ~80% of them that aren't
// accented, are byte-identical all the way back to v5 -- only the accented chords and the
// accent panel have ever moved.
export function generateMarkLines(design, { transparent = false, palette = null, lightInk = false } = {}) {
  const rng = makeRng(`${design.seed}-label`);
  const source = palette?.length ? palette : resolveDesignPalette(design);
  const colors = source?.length ? source : [DEFAULT_BASE_COLOR];
  // The accent no longer needs a random draw (see pickAccentSource), but this stream also
  // decides which chords survive and what grey each unaccented one carries -- so the draw is
  // kept deliberately. Dropping it would shift the entire sequence and restructure every
  // existing design's mark, print and animation alike, instead of only recolouring its accent.
  rng();
  const accentColor = legibleAccent(pickAccentSource(colors));

  const lines = [];
  for (const [x1, y1, x2, y2] of LINES) {
    const alphaChance = rng();
    if (alphaChance <= 0.4) continue;

    const colorChance = rng();
    let color;
    if (colorChance > 0.8) {
      color = tinycolor(accentColor)
        .spin(-15 + rng() * 30)
        .toHexString();
    } else {
      // Same rng draw either way (transparency must never shift which chords survive);
      // only the mapping of the drawn value to ink changes. Light greys read against the
      // dark panel; their inverses read against the print/fabric when there's no panel.
      const grey = Math.round(100 + rng() * 155);
      // `transparent` alone used to decide this, which welded "no background panel" to "dark ink"
      // -- correct only while the artwork underneath is light. It is dark under the patch on most
      // designs (measured: 4 of 6 real saved designs, mean sRGB luminance 0.15-0.25 where the
      // shorts' label_outside actually lands), which is why the mark kept disappearing on real
      // garments. `lightInk` decouples the two so the caller can choose from what is underneath.
      const g = transparent && !lightInk ? 255 - grey : grey;
      color = tinycolor({ r: g, g: g, b: g }).toHexString();
    }
    lines.push({ x1, y1, x2, y2, color });
  }

  return { lines, accentColor };
}

// The mark's fixed geometry, exported for non-label consumers (the animation overlay).
// BOUNDS in particular must not be re-derived from Logo.jsx's viewBox -- see computeBounds.
export const MARK_BOUNDS = BOUNDS;
export const MARK_RING = { center: RING_CENTER, radius: RING_RADIUS };
export const MARK_RING_COLOR = RING_COLOR;

export function generateLabelMark(design, width, height, { transparent = false, lightInk = false } = {}) {
  const { lines, accentColor: mainColorHex } = generateMarkLines(design, { transparent, lightInk });

  // The accent panel uses the un-spun chosen accent itself (the per-line spins above are
  // variations OF this color, so the flat panel reads as their common root). The mark
  // panel is square (width = the label's height) so the ring sits in a balanced field;
  // everything to its right is the accent fill. Kept as plain rects in the config so the
  // renderer stays layout-agnostic and QA harnesses can try other ratios through it.
  const markSide = Math.min(width, height);
  const accentWidth = width - markSide;
  const panels =
    accentWidth > 0
      ? {
          mark: { x: 0, y: 0, w: markSide, h: height },
          accent: { x: markSide, y: 0, w: accentWidth, h: height }
        }
      : {
          mark: { x: 0, y: 0, w: width, h: height },
          accent: null
        };

  return {
    generatorVersion: LABEL_MARK_GENERATOR_VERSION,
    width,
    height,
    transparent,
    // null background = the renderer paints no fills at all (transparent canvas); the
    // ring flips from white-on-dark to the dark ink itself.
    backgroundColor: transparent ? null : BACKGROUND_COLOR,
    // The ring follows the ink: dark on light artwork, white on dark. A panelled label keeps its
    // white ring, since it paints its own dark background to sit on.
    ringColor: transparent && !lightInk ? BACKGROUND_COLOR : RING_COLOR,
    accentColor: mainColorHex,
    // A transparent label has no panels to speak of, so the mark takes the whole canvas.
    // NOT `{ ...panels, accent: null }` -- that nulls the accent but keeps the SQUARE mark
    // panel, which shrinks the mark and shoves it to the left edge on any non-square
    // transparent label (caught by hash-diffing the bucket hat's 450x300 `label_outside`
    // when the aspect threshold was removed).
    panels: transparent
      ? { mark: { x: 0, y: 0, w: width, h: height }, accent: null }
      : panels,
    bounds: BOUNDS,
    ring: { center: RING_CENTER, radius: RING_RADIUS },
    lines
  };
}
