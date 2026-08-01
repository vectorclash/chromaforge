// The single image the About section's shirt row is a mask over.
//
// The row used to render six separate artworks through the real generator and cycle them,
// one per shirt. Replaced (2026-07-31, Aaron's design) by ONE fixed image that every shirt is
// a moving aperture onto. Two reasons, and the second is the real one:
//
//   1. It costs one cached canvas instead of six synchronous generateArtwork renders, and
//      drops this component's dependency on the studio render queue entirely.
//   2. It looks far more like the 2021 illustration. Measured off that file at 3x, every
//      shirt there is the same three ingredients -- a smooth gradient, two to five large flat
//      translucent facets, and star flares plus fine speckle. A full generated composition
//      squeezed into a 540x422 box is a different kind of image: busy where the original is
//      simple, and sparse on top of that (getCountScale sits at ~0.17 at that size, so each
//      shirt got a thin slice of a dense composition rather than a deliberately simple one).
//
// The original's four shirts are NOT one field -- shirt 2's pale white butts straight against
// shirt 1's saturated violet, which no shared gradient can do. But their colours are one
// continuous hue sweep, so a wide gradient lands each shirt on a different part of it and
// arrives at the same place by a different route.
//
// Plain JS taking its sprites as arguments, same as aboutBackground.js, so a Node harness can
// render exactly what ships.

import tinycolor from 'tinycolor2';
import { makeRng, randomSeed } from '../../render/prng.js';

// ===========================================================================
// THE TWO THINGS TO EDIT ARE RIGHT HERE: the angle, then the colours.
// Everything after this block is machinery and needs no touching.
// ===========================================================================

// Which way the gradient runs, in degrees, as a DIRECTION FROM THE FIRST STOP TOWARD THE LAST.
// Screen convention, so y points down:
//
//     0    straight left -> right
//   -34    left -> right, tilted 34 degrees UPWARD (what the original does)
//   -90    bottom -> top
//    90    top -> bottom
//
// This was previously wrong in a specific way worth recording: it was derived as the big
// hexagon's axis "mirrored horizontally" (180 - 125.8 = 54.2), but mirroring flips the
// HORIZONTAL component and leaves the vertical one alone, so the row ran downward to the right
// where the original runs upward -- the opposite tilt, at roughly the same steepness.
//
// The -34 is measured off the original, on fabric pixels only (each shirt's own silhouette,
// eroded so no outline or hexagon behind it leaks in). Worth knowing if it is ever remeasured:
// shirts 1 and 4 are flat plateaus -- h251-264 and h341-342 right across their area, because
// there is nothing past violet or past pink for their hue to run to -- so the tilt is only
// observable through shirts 2 and 3, and any estimator that includes the flat ones gets
// dragged toward horizontal (a whole-image fit says -19). On shirt 3 alone, hue runs h73 at
// its bottom-left corner to h341 at its top-right, which is where -34 comes from.
export const FILL_ANGLE = -34;

// The colour ramp along that direction. `at` is 0..1 from one end of the axis to the other and
// `c` is any CSS colour string -- paste hex straight in. Add or remove stops freely; the only
// rule is that `at` runs ascending and the list starts at 0 and ends at 1.
//
// The four inner stops sit on the four shirt centres as the original composes them. Those
// positions depend on the angle: at -34 the row projects onto t 0.308 / 0.467 / 0.626 / 0.785,
// while at 0 degrees the same four centres land on 0.235 / 0.455 / 0.674 / 0.893 -- so if you
// change FILL_ANGLE much and the colours stop lining up with the shirts, this is why. The 0
// and 1 stops sit beyond the outermost shirts: the row scrolls through the full width, so the
// ends need to be a run-out rather than a flat cap.
//
// The colours are each shirt's BASE -- the darkest, most chromatic quintile of its fabric, not
// its median. That distinction is the one real trap here: a median already contains all the
// white facet fill, so a gradient built from medians and then covered in facets and stars
// double-counts the lightness and the whole row renders as pale cream. When sampling in
// Affinity, take the deepest part of a shirt rather than an average of it.
export const FILL_STOPS = [
  { at: 0.0, c: '#6a43d1' }, // run-out before shirt 1, deeper violet
  { at: 0.308, c: '#835bed' }, // shirt 1, violet   h257 s0.80 l0.64
  { at: 0.467, c: '#8ddeff' }, // shirt 2, cyan     h197 s1.00 l0.78
  { at: 0.626, c: '#d9bb01' }, // shirt 3, yellow   h 52 s0.99 l0.43
  { at: 0.785, c: '#ff4e84' }, // shirt 4, pink     h342 s1.00 l0.65
  { at: 1.0, c: '#d40142' } // run-out past shirt 4, deeper pink
];

// ===========================================================================

// Neither layer uses a single blend mode, because the original doesn't: shirt 1 carries
// near-white facet panels AND a darker violet one, and shirt 3 has genuinely dark dots (one
// almost black) sitting among bright glows. A single mode can only ever lighten or only ever
// darken, which is what made the first version read as one flat wash.
//
// Which mode an element gets is biased by the LIGHTNESS UNDER IT rather than picked at random:
// a white overlay disappears on the pale yellow end and a dark dot disappears on the violet
// end, so the choice leans toward whichever direction has contrast to spend where the element
// happens to land. `darkBias` is the probability of the darkening mode at full lightness; the
// floor and ceiling keep both modes present everywhere so neither end becomes uniform.
export const FILL = {
  facetCount: [8, 14],
  // 'screen' with a near-white tint is the white overlay; 'multiply' with a deepened tint is
  // the shaded facet; 'overlay' in between keeps some facets reading as the material itself
  // rather than as light or shadow on it. NOT 'hard-light', which the real generator's
  // GeometricShape uses -- over a light fully-saturated gradient that blows straight to white,
  // the same failure the 3D scene's additive panels hit.
  facetModes: { light: 'screen', mid: 'overlay', dark: 'multiply' },
  facetMidShare: 0.3, // taken before the light/dark split below
  facetDarkBias: [0.15, 0.8], // at lightness 0 -> 1
  // Alphas per mode: screen and multiply bite far harder than overlay, so one shared range
  // either left the overlay facets invisible or blew the other two out.
  facetAlpha: { light: [0.14, 0.34], mid: [0.12, 0.32], dark: [0.1, 0.26] },
  // Span as a fraction of the canvas HEIGHT, not width: the row is very wide, and sizing to
  // width made every facet span several shirts at once so no single shirt showed an edge.
  facetSpan: [0.45, 1.5],
  // A facet's colour comes from the gradient under its own centroid, spun off-hue -- so it
  // reads as the same material catching light differently rather than as an unrelated shape
  // dropped on top, which is what a random palette colour looked like.
  facetSpin: 42,
  facetLighten: 34, // toward white, for the 'screen' facets
  facetDarken: 26, // for the 'multiply' ones
  starModes: { light: 'screen', dark: 'multiply' },
  starDarkBias: [0.1, 0.62],
  starLighten: 18,
  // Dark stars are pushed much harder than light ones. 'multiply' by a colour only a little
  // darker than the pixel under it does almost nothing, and the original's dark dots are
  // emphatic -- one on shirt 3 is nearly black.
  starDarken: 52,
  starDarkAlphaBoost: 1.35,
  largeStars: [5, 9],
  largeSize: [0.1, 0.26], // fraction of canvas height
  largeAlpha: [0.28, 0.55],
  smallStars: [70, 120],
  smallSize: [0.012, 0.045],
  smallAlpha: [0.2, 0.5],
  // Everything is placed into the strip the shirts actually occupy, with this much of the
  // strip's own height of overhang on each side. The fill is ONLY ever seen through the
  // shirts, and they sit in a band about 30% of the canvas tall -- scattering uniformly meant
  // roughly two thirds of every star landed where nothing could show it, which is why the
  // first pass looked almost starless on the garments despite the counts. The overhang lets a
  // star be clipped by a hem or shoulder rather than every one sitting fully inside.
  bandOverhang: 0.35
};

const lerp = (a, b, t) => a + (b - a) * t;

// Picks 'light' | 'mid' | 'dark' for one element, leaning toward whichever direction has
// contrast to spend against the lightness underneath it: a white overlay is invisible on the
// pale yellow end of the gradient and a dark dot is invisible on the violet end. `bias` is
// [probability of dark at lightness 0, at lightness 1], so neither mode ever reaches 0 or 1
// and both keep appearing across the whole row.
function chooseKind(rng, lightness, bias, midShare) {
  if (midShare && rng() < midShare) return 'mid';
  return rng() < lerp(bias[0], bias[1], Math.max(0, Math.min(1, lightness))) ? 'dark' : 'light';
}
const pick = (rng, [lo, hi]) => lerp(lo, hi, rng());
const pickInt = (rng, [lo, hi]) => Math.round(pick(rng, [lo, hi]));

// Where a point falls along the gradient axis, 0..1 -- so a facet can be tinted with the
// colour actually underneath it.
function axisT(x, y, W, H) {
  const rad = (FILL_ANGLE * Math.PI) / 180;
  const dx = Math.cos(rad);
  const dy = Math.sin(rad);
  const len = Math.abs(W * dx) + Math.abs(H * dy);
  const t = ((x - W / 2) * dx + (y - H / 2) * dy) / len + 0.5;
  return Math.max(0, Math.min(1, t));
}

function colourAt(t) {
  for (let i = 1; i < FILL_STOPS.length; i++) {
    const a = FILL_STOPS[i - 1];
    const b = FILL_STOPS[i];
    if (t <= b.at) {
      const f = (t - a.at) / (b.at - a.at || 1);
      return tinycolor.mix(a.c, b.c, f * 100).toHexString();
    }
  }
  return FILL_STOPS[FILL_STOPS.length - 1].c;
}

const tintCache = new Map();
function tinted(makeCanvas, sprite, color, size) {
  const key = `${color}:${size}:${sprite.width}`;
  let c = tintCache.get(key);
  if (c) return c;
  c = makeCanvas(size, size);
  const g = c.getContext('2d');
  g.drawImage(sprite, 0, 0, size, size);
  g.globalCompositeOperation = 'source-in';
  g.fillStyle = color;
  g.fillRect(0, 0, size, size);
  tintCache.set(key, c);
  return c;
}

// `rng` is injected rather than seeded in here so the caller controls how often the field
// changes -- AboutShirts draws one seed per mount, giving a slightly different set of facets
// and stars on every page load while staying fixed for as long as anyone is looking at it.
export function paintShirtFill(
  ctx,
  W,
  H,
  sprites,
  makeCanvas,
  rng = makeRng(randomSeed()),
  band = null
) {
  // Where the shirts will be, in canvas pixels. Passed in rather than derived here so
  // AboutShirts stays the single source of the row's geometry.
  const bandY = band ? band.y * H : 0;
  const bandH = band ? band.h * H : H;
  const over = bandH * FILL.bandOverhang;
  const inBand = () => bandY - over + rng() * (bandH + over * 2);
  const rad = (FILL_ANGLE * Math.PI) / 180;
  const dx = Math.cos(rad);
  const dy = Math.sin(rad);
  const len = Math.abs(W * dx) + Math.abs(H * dy);
  const g = ctx.createLinearGradient(
    W / 2 - (dx * len) / 2,
    H / 2 - (dy * len) / 2,
    W / 2 + (dx * len) / 2,
    H / 2 + (dy * len) / 2
  );
  for (const s of FILL_STOPS) g.addColorStop(s.at, s.c);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);

  // Facets. Triangles specifically -- the original's are all straight-edged and mostly
  // three-sided, and a triangle is the only polygon that cannot come out concave from random
  // vertices, which quads did about a third of the time and read as folded paper.
  //
  // Each is drawn in its own save/restore because the blend mode varies per facet, which is
  // the whole point -- one shared mode over the group is what this replaced.
  const facets = pickInt(rng, FILL.facetCount);
  for (let i = 0; i < facets; i++) {
    const cx = rng() * W;
    // Facets are large enough to cross the band from outside it, but their CENTROID is what
    // samples the gradient colour -- placing that outside the visible strip tinted them from
    // a region nobody sees.
    const cy = inBand();
    const span = pick(rng, FILL.facetSpan) * H;
    const rot = rng() * Math.PI * 2;
    const base = tinycolor(colourAt(axisT(cx, cy, W, H)));
    const kind = chooseKind(rng, base.toHsl().l, FILL.facetDarkBias, FILL.facetMidShare);
    ctx.save();
    ctx.globalCompositeOperation = FILL.facetModes[kind];
    ctx.beginPath();
    for (let k = 0; k < 3; k++) {
      // Uneven vertex radii, so facets are irregular slivers and wedges rather than a field
      // of near-equilateral triangles.
      const a = rot + (k * 2 * Math.PI) / 3 + (rng() - 0.5) * 0.9;
      const r = span * (0.35 + rng() * 0.65);
      const x = cx + Math.cos(a) * r;
      const y = cy + Math.sin(a) * r;
      k === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.closePath();
    let c = base.clone().spin((rng() - 0.5) * 2 * FILL.facetSpin);
    if (kind === 'light') c = c.lighten(FILL.facetLighten).desaturate(22);
    if (kind === 'dark') c = c.darken(FILL.facetDarken).saturate(12);
    ctx.globalAlpha = pick(rng, FILL.facetAlpha[kind]);
    ctx.fillStyle = c.toHexString();
    ctx.fill();
    ctx.restore();
  }
  ctx.restore();

  if (!sprites?.large || !sprites?.small) return;

  // Stars, each on its own mode. 'screen' lifts the gradient toward white where it sits
  // rather than pasting an opaque disc over it; 'multiply' is the dark dot the original has on
  // its warmer shirts, and the sprite's soft alpha falloff is what stops it reading as a hole.
  // Tinted from the gradient under each one, same as the facets.
  const put = (sprite, sizeRange, alphaRange, count) => {
    for (let i = 0; i < count; i++) {
      const x = rng() * W;
      const y = inBand();
      const size = Math.max(2, Math.round(pick(rng, sizeRange) * H));
      const base = tinycolor(colourAt(axisT(x, y, W, H)));
      const kind = chooseKind(rng, base.toHsl().l, FILL.starDarkBias, 0);
      const c = base.clone().spin((rng() - 0.5) * 40);
      ctx.save();
      ctx.globalCompositeOperation = FILL.starModes[kind];
      ctx.globalAlpha = Math.min(1, pick(rng, alphaRange) * (kind === 'dark' ? FILL.starDarkAlphaBoost : 1));
      ctx.drawImage(
        tinted(
          makeCanvas,
          sprite,
          (kind === 'dark' ? c.darken(FILL.starDarken).saturate(18) : c.lighten(FILL.starLighten)).toHexString(),
          size
        ),
        x - size / 2,
        y - size / 2
      );
      ctx.restore();
    }
  };
  put(sprites.small, FILL.smallSize, FILL.smallAlpha, pickInt(rng, FILL.smallStars));
  put(sprites.large, FILL.largeSize, FILL.largeAlpha, pickInt(rng, FILL.largeStars));
}
