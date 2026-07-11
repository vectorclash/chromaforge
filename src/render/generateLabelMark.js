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
import { makeRng, randInt } from './prng';

export const LABEL_MARK_GENERATOR_VERSION = 3;

// Wide placements (label_inside is 375x150, 2.5:1) get a two-panel layout: a square dark
// panel holding the mark, and the remaining rectangle filled flat with the design's own
// chosen accent color -- ties the sewn-in tag to the artwork's palette instead of leaving
// the mark alone in a long dark field. Square-ish placements (label_outside, 450x450)
// keep the single centered layout; a split panel there would just crowd the mark.
const SPLIT_MIN_ASPECT = 1.6;

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

// width/height are the target placement's own printfile dims (e.g. 375x150 for
// label_inside, 450x450 for label_outside) -- the renderer scales/centers the mark to fit
// whichever aspect it's given.
export function generateLabelMark(design, width, height) {
  const rng = makeRng(`${design.seed}-label`);
  const colors = design.colors?.length ? design.colors : [DEFAULT_BASE_COLOR];
  const mainColorHex = legibleAccent(colors[randInt(rng, 0, colors.length - 1)]);

  // Matches Logo.jsx's animateLogo() exactly: each chord independently has a 60% chance to
  // show at all (alphaChance > 0.4); of the ones that show, ~80% render as a random light
  // greyscale value (100-255) and ~20% as a small hue-spin variant of the single chosen
  // accent (colorChance > 0.8, spin -15..+15) -- never one flat color for the whole mark.
  const lines = [];
  for (const [x1, y1, x2, y2] of LINES) {
    const alphaChance = rng();
    if (alphaChance <= 0.4) continue;

    const colorChance = rng();
    let color;
    if (colorChance > 0.8) {
      color = tinycolor(mainColorHex)
        .spin(-15 + rng() * 30)
        .toHexString();
    } else {
      const grey = Math.round(100 + rng() * 155);
      color = tinycolor({ r: grey, g: grey, b: grey }).toHexString();
    }
    lines.push({ x1, y1, x2, y2, color });
  }

  // The accent panel uses the un-spun chosen accent itself (the per-line spins above are
  // variations OF this color, so the flat panel reads as their common root). The mark
  // panel is square (width = the label's height) so the ring sits in a balanced field;
  // everything to its right is the accent fill. Kept as plain rects in the config so the
  // renderer stays layout-agnostic and QA harnesses can try other ratios through it.
  const aspect = width / height;
  const panels =
    aspect >= SPLIT_MIN_ASPECT
      ? {
          mark: { x: 0, y: 0, w: height, h: height },
          accent: { x: height, y: 0, w: width - height, h: height }
        }
      : {
          mark: { x: 0, y: 0, w: width, h: height },
          accent: null
        };

  return {
    generatorVersion: LABEL_MARK_GENERATOR_VERSION,
    width,
    height,
    backgroundColor: BACKGROUND_COLOR,
    ringColor: RING_COLOR,
    accentColor: mainColorHex,
    panels,
    bounds: BOUNDS,
    ring: { center: RING_CENTER, radius: RING_RADIUS },
    lines
  };
}
