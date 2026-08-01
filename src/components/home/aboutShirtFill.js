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

// Sampled from the original, masked to each shirt's own silhouette so the hexagons behind it
// are excluded, and positioned at that shirt's own centre across the row.
//
// These are the BASE colour under the facets -- the darkest, most chromatic quintile of each
// shirt's fabric pixels, not the median. Sampling the median first was a real mistake and it
// showed immediately: the median already contains all the white facet fill, so building a
// gradient from it and then layering facets and stars on top double-counts the lightness and
// the whole row rendered as pale cream. The p20 base is what those light layers are sitting
// ON, which is what this gradient has to be.
//
// It is also a better sweep than the medians suggested: violet -> cyan -> pure YELLOW -> pink,
// where the medians read violet -> pale blue -> peach -> pink. Shirt 3's base is h59 s0.89
// l0.51, confirming the green/yellow that the hue run 256 -> -19 has to pass through is
// really there rather than something to interpolate around.
// The four sampled colours, and where each shirt's centre sits across the row as a fraction
// of the illustration's width -- (first + i * pitch + w/2) / 650, matching AboutShirts' own
// geometry.
const SHIRT_COLOURS = [
  { x: 0.2354, c: '#855cee' }, // shirt 1, violet  (h257 s0.81 l0.65)
  { x: 0.4546, c: '#95dffb' }, // shirt 2, cyan    (h196 s0.93 l0.78)
  { x: 0.6738, c: '#f1ee12' }, // shirt 3, yellow  (h 59 s0.89 l0.51)
  { x: 0.893, c: '#ff5c8d' } // shirt 4, pink      (h342 s1.00 l0.68)
];

// The big hexagon's own gradient axis runs at 125.8 degrees (indigo top-right to green
// bottom-left). This is that mirrored horizontally, which is what puts violet at the row's
// left where the original has it. Derived rather than picked, so the two layers stay related
// if the hexagon is ever re-angled.
export const FILL_ANGLE = 180 - 125.8;

// The illustration's own proportions, which the stop positions below are solved against.
const REF_W = 650;
const REF_H = 366;

// Stop positions are SOLVED from the shirt centres, not written as x-fractions, and getting
// this wrong is the trap worth recording. The gradient runs at an angle, so distance along its
// axis is compressed relative to x: across the full width the shirt row (which sits at exactly
// the canvas's vertical centre) only covers t 0.22..0.78. A first version placed the stops at
// plain x-fractions, which put the violet start and the pink end outside that band entirely --
// they landed in the canvas corners above and below the row, and the rightmost shirt rendered
// yellow with no pink anywhere in the composition.
//
// The 0 and 1 stops continue past the outermost shirts so the row's ends are a run-out rather
// than a flat cap, since shirts scroll through the full width.
export const FILL_STOPS = (() => {
  const rad = (FILL_ANGLE * Math.PI) / 180;
  const len = Math.abs(REF_W * Math.cos(rad)) + Math.abs(REF_H * Math.sin(rad));
  const at = xFrac => ((xFrac - 0.5) * REF_W * Math.cos(rad)) / len + 0.5;
  const inner = SHIRT_COLOURS.map(s => ({ at: at(s.x), c: s.c }));
  return [
    { at: 0, c: tinycolor(inner[0].c).spin(-8).darken(6).toHexString() },
    ...inner,
    { at: 1, c: tinycolor(inner[inner.length - 1].c).spin(8).lighten(6).toHexString() }
  ];
})();

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
