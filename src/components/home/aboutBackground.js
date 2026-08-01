// Procedural rebuild of the About section's hexagon backdrop.
//
// The original was a flat PNG exported from a PSD that has since been lost, so the artwork
// could never be edited again. This reconstructs it from the pixels that survived: the
// hexagons were fitted to the exported image's own ALPHA channel by coordinate descent on
// IoU (0.948 -- the remainder is star glow that isn't hexagon), and each one's gradient was
// recovered by least-squares fitting colour against position over its interior, with the
// shirt row excluded because it occluded the middle of the composition.
//
// Deliberately NOT filled with live generated artwork: at this size it reads as noise, and
// the shirts already carry the generative half. Gradients plus the project's own star
// sprites match the original's look and cost nothing per frame.
//
// Plain JS, not JSX, and it takes its sprites as arguments -- that lets a Node harness import
// this exact code to render a preview, so what gets checked is what ships.

import tinycolor from 'tinycolor2';
// Extensions are explicit here, unlike the rest of src/: this module is deliberately
// importable by a plain Node harness, whose ESM loader will not resolve Vite's
// extensionless style.
import { makeRng } from '../../render/prng.js';
import { valueNoise } from '../../render/valueNoise.js';

// Geometry in the artwork's own 650x366 space. Pointy-top hexagons (a vertex straight up),
// which the alpha channel's edge-angle histogram confirms: clusters at 0/90 degrees for the
// vertical sides and +-45-50 for the caps.
export const BOX_W = 650;
export const BOX_H = 366;

// ===========================================================================
// EDIT THE HEXAGON COLOURS AND GRADIENT ANGLES HERE.
//
// Per hexagon:
//   cx, cy, r  its geometry -- leave these alone unless the composition moves. They are
//              fitted to the original's alpha channel and the speckle field is placed inside
//              them, so they are not really colour decisions.
//   angle      which way that hexagon's gradient runs, in degrees, as a DIRECTION FROM THE
//              FIRST STOP TOWARD THE LAST. Screen convention, y down: 0 is left -> right,
//              90 is top -> bottom, -90 is bottom -> top, 180 is right -> left.
//   stops      the ramp along it. `at` is 0..1 ACROSS THE HEXAGON ITSELF -- 0 sits on the
//              edge the gradient starts from, 1 on the opposite edge, so the whole ramp is
//              always visible on the face. Add or remove stops freely; `at` must ascend and
//              the list must start at 0 and end at 1. `c` is any CSS colour string.
//
// These were recovered by least-squares fitting colour against position over each face's
// interior (with the shirt row excluded, since it occludes the middle of the composition),
// which produced an axis as a pair of far-off-canvas points plus three stops. That form was
// exact but unreadable and impossible to adjust -- the big hexagon's axis started at
// (159, -221), a point 220 units above the artwork. This is the same gradients re-expressed
// across each hexagon's own width, which renders identically (verified by pixel diff) and can
// be edited by hand.
//
// Note the stops are NOT evenly spaced on several faces, and that is not noise: the lime one
// really does hold its mid green until 41% of the way across and reach its final yellow-green
// by 81%, and flattening those to 0/0.5/1 changes its look.
export const HEXES = [
  {
    cx: 437.5, cy: 183.0, r: 181.0, angle: 125.8, // big one, indigo top-right -> green bottom-left
    stops: [
      { at: 0, c: '#290092' },
      { at: 0.5, c: '#453d8f' },
      { at: 1, c: '#98c270' }
    ]
  },
  {
    cx: 177.5, cy: 145.0, r: 99.0, angle: 149.3, // lime
    stops: [
      { at: 0, c: '#69918c' },
      { at: 0.406, c: '#99ca75' },
      { at: 0.809, c: '#c2fc5f' },
      { at: 1, c: '#c2fc5f' }
    ]
  },
  {
    cx: 88.5, cy: 60.5, r: 23.0, angle: -36.7, // small yellow
    stops: [
      { at: 0, c: '#e1fc19' },
      { at: 0.501, c: '#d5f837' },
      { at: 1, c: '#c3ed51' }
    ]
  },
  {
    cx: 40.5, cy: 170.0, r: 44.0, angle: -45.0, // orange
    stops: [
      { at: 0, c: '#f70f5a' },
      { at: 0.501, c: '#f95457' },
      { at: 1, c: '#fba142' }
    ]
  },
  {
    cx: 84.5, cy: 248.0, r: 44.0, angle: 126.9, // pink
    stops: [
      { at: 0, c: '#d13e62' },
      { at: 0.188, c: '#d13e62' },
      { at: 0.573, c: '#e50d5f' },
      { at: 0.958, c: '#f90f5a' },
      { at: 1, c: '#f90f5a' }
    ]
  }
];

// The haze over the faces. `x`, `y`, `r` are in the 650x366 space, `c` is any CSS colour and
// `a` is its opacity at the centre, falling to nothing at `r`. Add, move, recolour or delete
// freely -- they are clipped to the hexagons, so nothing here can spill onto the page.
//
// These exist because a linear gradient is demonstrably NOT what the original's faces are. Fit
// against the original the two-gradient model leaves an RMS error of 17.6 per channel, and the
// error is not noise: blurred hard enough to kill the dust it resolves into a handful of broad
// smooth lobes -- a magenta one across the top of the big hexagon, indigo above it, blue in its
// bottom-right, yellow-green low and centre. That is the "something back there" the flat
// version was missing, and it is also why the dust used to read as the only thing adding
// contrast on that face.
//
// Recovered by greedy fitting: take the strongest remaining lobe, size it by how far the
// residual holds above half its peak, re-render, repeat. Each entry's colour is what the glow
// itself must be for a 0.34-opacity draw to land on the measured value, not the colour you see
// there. Twelve of them take the RMS error from 17.6 to 12.7 (the first eight do most of it,
// 13.5). Deliberately fitted with the shirt row's whole band excluded -- the shirts' drop
// shadow is unmodelled darkening and a first pass spent seven of its first eight glows on it.
export const NEBULAE = [
  { x: 365, y: 86, r: 108, c: '#1d008d', a: 0.34 },
  { x: 428, y: 122, r: 72, c: '#99006d', a: 0.34 },
  { x: 509, y: 311, r: 72, c: '#0007b2', a: 0.34 },
  { x: 392, y: 338, r: 54, c: '#ccff66', a: 0.34 },
  { x: 284, y: 275, r: 45, c: '#ffff00', a: 0.34 },
  { x: 563, y: 293, r: 36, c: '#00009d', a: 0.34 },
  { x: 590, y: 275, r: 36, c: '#000097', a: 0.34 },
  { x: 329, y: 284, r: 27, c: '#e4ff48', a: 0.34 },
  { x: 149, y: 122, r: 18, c: '#ffff00', a: 0.34 },
  { x: 347, y: 311, r: 9, c: '#630088', a: 0.34 },
  { x: 338, y: 302, r: 9, c: '#7a1b75', a: 0.34 },
  { x: 293, y: 257, r: 9, c: '#6a4c5c', a: 0.34 }
];

// ===========================================================================

// A hexagon's gradient axis in canvas pixels: centred on the face and spanning its full width
// along `angle`, so a stop's `at` means the same thing on every hexagon regardless of size.
export function hexAxis(h, S) {
  const rad = (h.angle * Math.PI) / 180;
  const ux = Math.cos(rad);
  const uy = Math.sin(rad);
  const half = h.r * S;
  return {
    x0: h.cx * S - ux * half,
    y0: h.cy * S - uy * half,
    x1: h.cx * S + ux * half,
    y1: h.cy * S + uy * half
  };
}

// Colour at position t along a stop list. Shared by the fill and by the speckle field, which
// needs the colour under each speck.
export function rampAt(stops, t) {
  const c = Math.max(0, Math.min(1, t));
  for (let i = 1; i < stops.length; i++) {
    const a = stops[i - 1];
    const b = stops[i];
    if (c <= b.at) {
      const f = b.at === a.at ? 0 : (c - a.at) / (b.at - a.at);
      return tinycolor.mix(a.c, b.c, f * 100).toHexString();
    }
  }
  return stops[stops.length - 1].c;
}

// The named star flares, MEASURED off the original rather than scattered or eyeballed.
//
// How: the fitted hexagon gradients above were subtracted from the original, which cancels
// the background and leaves only what was painted on top; the shirt row was masked out (the
// dots on the shirts are part of those shirts' own artwork, not the backdrop). Every flare
// that survived is here -- there are eight -- with its centre taken from the residual's
// brightness centroid and its disc diameter read off a 4x crop.
//
// They ALL use the large sprite, which is the fix for the previous version's main defect:
// the small sprite is a crisp four-point diamond and the original contains no such shape
// anywhere, so the five entries that used it at 24-34px read as a different kind of star
// than the seven beside them. The small sprite now has exactly one job, the speckle field
// below.
//
// `size` is the sprite's draw box, not the visible orb. Calibrated by rendering the tinted
// sprite on black and measuring: the disc (50% of peak) comes out at 0.32 x size and the
// glow (12%) at 0.64 x size, so size = measured disc diameter / 0.32.
const DISC_FRACTION = 0.32;
const DISC_TO_SIZE = 1 / DISC_FRACTION;
const star = (x, y, disc, c, a) => ({
  x: x / BOX_W,
  y: y / BOX_H,
  size: Math.round(disc * DISC_TO_SIZE),
  c,
  a
});

// The last four entries are additions rather than measurements (Aaron, 2026-08-01). The two
// anchors are 50% larger than the original's, and three small warm flares sit in the red haze
// across the top of the big hexagon -- the area NEBULAE below now fills, which had dust and
// nothing else in it. Their positions are checked to fall inside that face and to clear every
// existing flare by at least 80 units, so no two crosses overlap.
export const STARS = [
  star(521, 257, 57, '#cbfc5e', 0.8), // the big lime one low-right, the composition's anchor
  star(97, 106, 51, '#8ff7c0', 0.75),
  star(380, 290, 26, '#45dbe8', 0.75),
  star(209, 82, 22, '#f2e21a', 0.8),
  star(303, 126, 18, '#6fe0dc', 0.7),
  star(490, 205, 14, '#cffe4f', 0.7),
  star(245, 314, 10, '#6ef5e7', 0.85),
  star(298, 341, 10, '#99ffc2', 0.85),
  star(398, 72, 13, '#ff6f9c', 0.8), // the three in the red haze
  star(476, 74, 9, '#ff8d8d', 0.75),
  star(462, 108, 11, '#ff5f86', 0.8)
];

// The speckle field: the fine dusting of tiny stars the original scatters across its hexagon
// faces (clearly visible in the gradient-subtracted residual, and the main thing the rebuild
// was still missing). Clipped to the hexagons -- outside them the original is bare page.
//
// Colour is a COMPLEMENT of whatever the hexagon's own gradient is doing underneath -- each
// hexagon's three stops are hue-rotated 180 degrees, forced to a fixed saturation and
// lightness, and sampled along that hexagon's own gradient axis at the speck's position, so
// the dust shifts hue across a face exactly as the face does but always against it.
//
// With one correction, which is MEASURED rather than invented: the original's dust only ever
// lives on a narrow blue-through-magenta-to-red arc, and a straight 180 degree rotation
// leaves that arc on two of the five faces. Clamping the complement into the arc predicts
// every hue the original actually uses:
//
//   face              bg hue   complement   clamped   observed
//   big hex, indigo      257           77       350        348
//   big hex, green        91          271       271        275
//   lime hex              95          275       275        275
//   red hex              341          161       245        245
//   red hex, orange end   31          211       245        245
//
// Read off 9x crops. The uncorrected rule put yellow-green dust over the big hexagon's
// indigo, where the original is unmistakably red -- which is the whole reason the arc is
// here.
export const DUST_ARC = { from: 245, to: 350 };

export const SPECKLE = {
  seed: 'about-speckle',
  // Dense, and the number is measured rather than picked by eye. Running the same detector
  // over both images -- a pixel counts as dust when it differs from a local median by enough
  // that gradient-model error cannot explain it -- the original covers 3.4 / 3.7 / 4.5 / 5.4%
  // across four sample windows. This sits deliberately UNDER that -- matching the original's
  // count exactly read as too busy once the specks were also clustered, since clustering
  // concentrates them and makes the same number feel like more.
  //
  // This is a count per unit of AREA, so it fixes the mean and CLUSTER below only decides how
  // that same amount is distributed; the per-window spread is what the clustering costs, not
  // a density error. Retune this if the overall amount looks wrong, CLUSTER if the clumping
  // does.
  perPx: 1 / 42, // specks per square unit of hexagon area, in the 650x366 space
  // Small. The sprite is a four-point diamond, and anything above roughly 8 units here stops
  // reading as dust and starts reading as a star in its own right, competing with the eight
  // named flares -- which is the mistake the previous version made with this sprite.
  sizeMin: 1.5,
  sizeMax: 5.5,
  alphaMin: 0.25,
  alphaMax: 0.7,
  sat: 0.85,
  // A single mid lightness, not one tuned per face. It is what makes the dust read brighter
  // than the big hexagon's dark indigo (l 0.28) and darker than the lime faces (l 0.58) with
  // no special-casing -- which is exactly what the original does.
  light: 0.52,
  // Colour is quantised into this many bands along each gradient so the tint cache stays
  // small (bands x sizes canvases, not one per speck).
  bands: 24,
  // Each speck samples the complement gradient a little off its true position. A field that
  // samples exactly reads as flat bands of one hue at a time; scattering ALONG the gradient
  // axis rather than jittering hue directly buys that variety without widening the tint
  // cache at all, since the jittered value quantises into the same 24 bands.
  bandJitter: 0.18,
  // Draw the dust with the LARGE (soft, round) sprite instead of the small crisp diamond.
  // Off, so the field is unchanged from before -- but worth knowing it is here: the original's
  // specks are round soft dots and ours are four-point diamonds, which is why a like-for-like
  // speck count can say our field is the sparser one while it still reads as the busier, more
  // contrasty of the two. Flipping this is a mild change (measured: 145k subpixels of a 3.8M
  // canvas move, max 62) because at 1-5 units the two sprites are not far apart.
  soft: false
};

// A handful of GRAINS: specks an order of magnitude bigger than the dust, sitting between it
// and the eight named flares. Measured rather than added by feel -- running one detector over
// both images inside the big hexagon (local contrast against a blurred copy of the same image,
// so neither gets special treatment), the original carries four blobs of 4-10px there and the
// rebuild carried none. The same comparison is why the dust reads fainter than the original's
// overall: at a contrast threshold of 8 the original covers 3.85% of that face against our
// 2.06%, and the gap widens as the threshold rises, so its specks are brighter as well as more
// numerous. That density is SPECKLE.perPx above and was deliberately set low; this tier is the
// narrower fix for what was actually missing.
//
// They use the LARGE sprite, unlike the dust. The small one is a crisp four-point diamond that
// starts reading as a star in its own right above about 8 units -- fine for something meant to
// be a grain, wrong for something meant to be dust, which is the distinction this tier exists
// on either side of. Placed from the same seeded stream AFTER every face's dust, so the
// existing speckle field is byte-identical with this on or off.
export const GRAINS = {
  perPx: 1 / 9000, // per square unit of hexagon area, in the 650x366 space
  sizeMin: 7,
  sizeMax: 14,
  alphaMin: 0.3,
  alphaMax: 0.62
};

// Where the dust clumps. Uniformly random placement puts the right NUMBER of specks down but
// spreads them evenly, which reads as noise rather than as a star field -- real dust has
// drifts and voids. This is the same construction the 3D tunnel uses for its stars (three
// octaves of value noise as a density field, then rejection sampling against it), in two
// dimensions and sampled in the illustration's own 650x366 space.
//
// The field is continuous across the WHOLE image rather than per hexagon, so a drift can run
// from the lime hexagon into the big one and the five faces read as one dust cloud they all
// sit under, not five separately-seeded patches.
//
// `contrast` is the exponent the density is raised to and `fill` scales it back up: together
// they set how hard the clumping bites. Higher contrast = emptier voids and tighter cores.
// Picked off contact sheets rendered at full frame, not guessed: below about 4 the field
// still read as evenly scattered, and at 7 the middle of the big hexagon and the right of the
// lime one went bare. Worth knowing if these are ever retuned -- the clumping here is
// DELIBERATELY stronger than the original's. Measured over four sample windows the original
// varies only 1.58x, which is within what uniformly random placement gives anyway (1.69x on
// the same windows), so it has essentially no clustering; this sits at 2.6x.
export const CLUSTER = {
  // Cell sizes of roughly 165, 60 and 20 units -- the coarsest drift spans a quarter of the
  // image, which is what makes the clumping read at a glance rather than as texture.
  freqLarge: 0.006,
  freqMid: 0.017,
  freqFine: 0.05,
  ampLarge: 0.6,
  ampMid: 0.28,
  ampFine: 0.12,
  contrast: 5,
  fill: 4,
  // How much a speck's opacity follows the local density. Placement alone gives clumps that
  // are denser but no brighter, which still reads flat; carrying a little of the field into
  // alpha is what makes a core glow and an edge trail off.
  alphaFollow: 0.55
};

function clusterDensity(x, y) {
  const n = freq => valueNoise(x * freq, y * freq, 0);
  return (
    n(CLUSTER.freqLarge) * CLUSTER.ampLarge +
    n(CLUSTER.freqMid) * CLUSTER.ampMid +
    n(CLUSTER.freqFine) * CLUSTER.ampFine
  );
}

function hexVertices(cx, cy, r) {
  const v = [];
  for (let k = 0; k < 6; k++) {
    const a = (Math.PI / 180) * (90 + 60 * k);
    v.push([cx + r * Math.cos(a), cy - r * Math.sin(a)]);
  }
  return v;
}

function hexPath(ctx, cx, cy, r) {
  const v = hexVertices(cx, cy, r);
  ctx.beginPath();
  v.forEach(([x, y], k) => (k === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
  ctx.closePath();
}

function inPolygon(px, py, v) {
  let inside = false;
  for (let i = 0, j = v.length - 1; i < v.length; j = i++) {
    const [xi, yi] = v[i];
    const [xj, yj] = v[j];
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// The complement of a hexagon's gradient, as three hex strings. Hue is rotated; saturation
// and lightness are REPLACED rather than nudged, because the source stops range from a very
// dark indigo to a pale yellow-green and a relative shift would leave half the specks
// invisible.
function hueGap(a, b) {
  const d = Math.abs(a - b) % 360;
  return Math.min(d, 360 - d);
}

// The complement, pulled onto the dust arc by whichever end is nearer. See DUST_ARC.
function dustHue(h) {
  const c = (h + 180) % 360;
  if (c >= DUST_ARC.from && c <= DUST_ARC.to) return c;
  return hueGap(c, DUST_ARC.from) < hueGap(c, DUST_ARC.to) ? DUST_ARC.from : DUST_ARC.to;
}

function complementStops(stops) {
  return stops.map(s => ({
    at: s.at,
    c: tinycolor({ h: dustHue(tinycolor(s.c).toHsl().h), s: SPECKLE.sat, l: SPECKLE.light }).toHexString()
  }));
}

// Where a point falls along a hexagon's gradient axis, 0..1 -- the same projection
// createLinearGradient does internally, so a speck's colour tracks the pixel under it.
function gradientT(h, x, y) {
  const a = hexAxis(h, 1);
  const dx = a.x1 - a.x0;
  const dy = a.y1 - a.y0;
  const len2 = dx * dx + dy * dy;
  if (!len2) return 0;
  const t = ((x - a.x0) * dx + (y - a.y0) * dy) / len2;
  return Math.max(0, Math.min(1, t));
}

// Built once, in the 650x366 space, and scaled at draw time. Deterministic: same seed, same
// field, every reload -- this is a rebuild of a fixed illustration, not a generative surface.
let speckleCache = null;
export function buildSpeckles() {
  if (speckleCache) return speckleCache;
  const rng = makeRng(SPECKLE.seed);
  const out = [];
  for (const h of HEXES) {
    const comp = complementStops(h.stops);
    const band = t => {
      const clamped = Math.max(0, Math.min(1, t));
      const q = Math.round(clamped * (SPECKLE.bands - 1)) / (SPECKLE.bands - 1);
      return rampAt(comp, q);
    };
    const area = 2.598076 * h.r * h.r; // regular hexagon, circumradius r
    const n = Math.round(area * SPECKLE.perPx);
    const v = hexVertices(h.cx, h.cy, h.r);
    let placed = 0;
    // The target count is held fixed and only the DISTRIBUTION is shaped, so turning the
    // clumping up or down never changes how much dust a face carries -- the measured
    // coverage above stays valid. The guard is an escape hatch, not the normal exit.
    let guard = n * 400;
    while (placed < n && guard-- > 0) {
      const x = h.cx + (rng() * 2 - 1) * h.r;
      const y = h.cy + (rng() * 2 - 1) * h.r;
      if (!inPolygon(x, y, v)) continue;
      const d = clusterDensity(x, y);
      if (rng() > Math.pow(d, CLUSTER.contrast) * CLUSTER.fill) continue;
      placed++;
      // rng() squared skews toward the small end, so the field reads as dust with a few
      // brighter grains rather than a uniform stipple.
      const k = rng() * rng();
      // Density runs roughly 0..1 about a mean near 0.5; normalising against that mean keeps
      // alphaFollow 0 exactly equal to the unweighted field instead of dimming everything.
      const lift = 1 + CLUSTER.alphaFollow * (d / 0.5 - 1);
      out.push({
        x: x / BOX_W,
        y: y / BOX_H,
        size: SPECKLE.sizeMin + k * (SPECKLE.sizeMax - SPECKLE.sizeMin),
        c: band(gradientT(h, x, y) + (rng() * 2 - 1) * SPECKLE.bandJitter),
        a: Math.max(
          0.04,
          Math.min(1, (SPECKLE.alphaMin + rng() * (SPECKLE.alphaMax - SPECKLE.alphaMin)) * lift)
        )
      });
    }
  }
  // Grains, after every face's dust so the dust's own draws from this stream are untouched.
  // Same placement rule, including the clustering, so a grain sits in a drift rather than in
  // one of the field's voids.
  for (const h of HEXES) {
    const comp = complementStops(h.stops);
    const area = 2.598076 * h.r * h.r;
    const n = Math.round(area * GRAINS.perPx);
    const v = hexVertices(h.cx, h.cy, h.r);
    let placed = 0;
    let guard = n * 400;
    while (placed < n && guard-- > 0) {
      const x = h.cx + (rng() * 2 - 1) * h.r;
      const y = h.cy + (rng() * 2 - 1) * h.r;
      if (!inPolygon(x, y, v)) continue;
      const d = clusterDensity(x, y);
      if (rng() > Math.pow(d, CLUSTER.contrast) * CLUSTER.fill) continue;
      placed++;
      const k = rng() * rng();
      const q = Math.round(Math.max(0, Math.min(1, gradientT(h, x, y))) * (SPECKLE.bands - 1)) / (SPECKLE.bands - 1);
      out.push({
        x: x / BOX_W,
        y: y / BOX_H,
        size: GRAINS.sizeMin + k * (GRAINS.sizeMax - GRAINS.sizeMin),
        c: rampAt(comp, q),
        a: GRAINS.alphaMin + rng() * (GRAINS.alphaMax - GRAINS.alphaMin),
        grain: true
      });
    }
  }
  speckleCache = out;
  return out;
}

// Every flare in the original throws a long, fine diffraction cross -- on the big lime one it
// runs most of the way across the hexagon. The star sprite has a cross of its own but it dies
// out within about half a sprite width, so at these sizes the flares rendered as bare discs.
// The cross is therefore drawn separately rather than by scaling the sprite up, which would
// have inflated the disc along with it.
//
// Both numbers are measured off the original as multiples of the DISC, and they hold across
// flares an order of magnitude apart in size: the yellow one at (209,82) spans ~120 units on
// a 22 disc and the big lime one at (521,257) spans ~220 on a 38 disc, i.e. 5.5x and 5.8x.
const SPIKE_LENGTH = 5.6; // tip to tip, in disc diameters
const SPIKE_THICKNESS = 0.1; // at the centre, in disc diameters
const SPIKE_ALPHA = 0.75; // relative to the flare's own alpha; the cross is the fainter part

// A smooth two-way taper: a horizontal transparent-colour-transparent gradient masked by a
// vertical one. Multiplying the two is what gives a fine centre line that fades out along its
// length AND across its width -- a plain gradient-filled rect would end in a hard edge.
const spikeCache = new Map();
function spikeSprite(makeCanvas, color, len, thick) {
  const key = `${color}:${len}:${thick}`;
  let c = spikeCache.get(key);
  if (c) return c;
  c = makeCanvas(len, thick);
  const g = c.getContext('2d');
  const along = g.createLinearGradient(0, 0, len, 0);
  along.addColorStop(0, 'rgba(0,0,0,0)');
  along.addColorStop(0.5, color);
  along.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = along;
  g.fillRect(0, 0, len, thick);
  const across = g.createLinearGradient(0, 0, 0, thick);
  across.addColorStop(0, 'rgba(0,0,0,0)');
  across.addColorStop(0.5, '#fff');
  across.addColorStop(1, 'rgba(0,0,0,0)');
  g.globalCompositeOperation = 'destination-in';
  g.fillStyle = across;
  g.fillRect(0, 0, len, thick);
  spikeCache.set(key, c);
  return c;
}

function drawSpikes(ctx, makeCanvas, cx, cy, disc, color) {
  const len = Math.round(disc * SPIKE_LENGTH);
  const thick = Math.max(2, Math.round(disc * SPIKE_THICKNESS));
  if (len < 6) return;
  const s = spikeSprite(makeCanvas, color, len, thick);
  ctx.drawImage(s, cx - len / 2, cy - thick / 2);
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(Math.PI / 2);
  ctx.drawImage(s, -len / 2, -thick / 2);
  ctx.restore();
}

// Tints a sprite through its own alpha, the way StarField.js does -- the sprites are
// dark-with-alpha masks, not coloured art.
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

// The soft edge every hexagon in the original has, and the rebuild did not.
//
// It reads as a semi-transparent inner stroke, and MEASURED it is exactly that -- but made of
// alpha, not ink. Sampling perpendicular profiles across unoccluded edges of all five
// hexagons: the RGB does not change at all on the way out (the big hexagon holds 41,0,146
// flat to the boundary), while alpha ramps 255 -> ~200 -> ~130 -> ~45 over the last three
// units. Against the near-black page that reads as a darker rim of the face's own colour;
// where two hexagons overlap it reads as the one underneath showing through, which is what
// the original does at the lime/yellow join and is why this cannot be a painted dark line.
//
// Reproduced by punching alpha back out along the inside of the border. `w` is in the
// illustration's own 650-unit space and is a full stroke width, so the band it leaves is half
// of it. Tuned against the original's own numbers rather than by eye -- at these values the
// rebuilt yellow hexagon's profile runs 86 / 131 / 131 / 233 / 255 against the original's
// 73 / 141 / 125 / 251 / 255 on the same edge. Note `a` is not the resulting transparency: 0.7
// here measures out as a band at 51% alpha, so retune from a rendered profile, not arithmetic.
// A list, because a multi-pass ramp was tried first (it read as a blur rather than an edge --
// the original's falloff is only about two units wide); the mechanism is kept in case a
// future face wants one.
const HEX_RIM = [{ w: 2.6, a: 0.7 }];

// Each hexagon is composited from its OWN layer, which is the whole reason the rim can be
// see-through: punching alpha straight into the shared canvas would erase whatever hexagon is
// already beneath it and expose the page instead. Sized to the hexagon's box rather than the
// full canvas -- five full-size scratch layers at the supersampled render size is real memory
// for no benefit.
// The apothem/circumradius ratio: how far a hexagon's radius has to shrink to move its EDGES
// inward by one unit.
const HEX_APOTHEM = Math.cos(Math.PI / 6);

function paintHex(ctx, h, S, makeCanvas) {
  const r = h.r * S;
  const pad = Math.ceil(HEX_RIM[0].w * S) + 2;
  const x0 = Math.floor(h.cx * S - r - pad);
  const y0 = Math.floor(h.cy * S - r - pad);
  const size = Math.ceil(2 * (r + pad)) + 1;
  const layer = makeCanvas(size, size);
  const g = layer.getContext('2d');
  // Everything below is written in the layer's OWN coordinates -- x0/y0 are subtracted from
  // each point rather than set up as a ctx.translate. That is not a style choice: measured
  // under @napi-rs/canvas (the Node harness this module is deliberately importable by), a
  // destination-out stroke is silently dropped when a transform is active, while the exact
  // same calls with pre-offset coordinates composite correctly. Browsers do the transform
  // case fine, so this would have shipped looking right and been unverifiable offline.
  const cx = h.cx * S - x0;
  const cy = h.cy * S - y0;

  const a = hexAxis(h, S);
  const grad = g.createLinearGradient(a.x0 - x0, a.y0 - y0, a.x1 - x0, a.y1 - y0);
  for (const s of h.stops) grad.addColorStop(s.at, s.c);
  g.fillStyle = grad;
  hexPath(g, cx, cy, r);
  g.fill();

  // Each pass strokes a hexagon shrunk by half its own line width, so the whole stroke lands
  // INSIDE the face and none of it needs clipping away.
  g.globalCompositeOperation = 'destination-out';
  for (const pass of HEX_RIM) {
    const w = pass.w * S;
    hexPath(g, cx, cy, r - w / 2 / HEX_APOTHEM);
    g.lineWidth = w;
    g.strokeStyle = `rgba(0,0,0,${pass.a})`;
    g.stroke();
  }

  ctx.drawImage(layer, x0, y0);
}

function paint(ctx, W, H, sprites, makeCanvas) {
  const S = W / BOX_W;
  ctx.clearRect(0, 0, W, H);

  for (const h of HEXES) paintHex(ctx, h, S, makeCanvas);

  // Haze over the faces, under everything else. Clipped to the hexagons as one region for the
  // same reason the speckles are: a glow straddling the join between two touching faces should
  // carry across it rather than stop at a seam.
  if (NEBULAE.length) {
    ctx.save();
    ctx.beginPath();
    for (const h of HEXES) {
      const v = hexVertices(h.cx * S, h.cy * S, h.r * S);
      v.forEach(([x, y], k) => (k === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
      ctx.closePath();
    }
    ctx.clip();
    for (const n of NEBULAE) {
      const cx = n.x * S;
      const cy = n.y * S;
      const r = n.r * S;
      const { r: cr, g: cg, b: cb } = tinycolor(n.c).toRgb();
      const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
      // Three stops, not two: a plain linear falloff reads as a disc with a visible edge at
      // about half its radius, where this holds the core and lets the tail go long.
      grad.addColorStop(0, `rgba(${cr},${cg},${cb},${n.a})`);
      grad.addColorStop(0.55, `rgba(${cr},${cg},${cb},${n.a * 0.45})`);
      grad.addColorStop(1, `rgba(${cr},${cg},${cb},0)`);
      ctx.fillStyle = grad;
      ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
    }
    ctx.restore();
  }

  if (!sprites?.large || !sprites?.small) return;

  // Speckles first, so a named flare that lands on one sits over it rather than under.
  // Clipped to the hexagons as one region: specks straddling the seam between two touching
  // hexagons stay whole, which a per-hexagon clip would cut.
  ctx.save();
  ctx.beginPath();
  for (const h of HEXES) {
    const v = hexVertices(h.cx * S, h.cy * S, h.r * S);
    v.forEach(([x, y], k) => (k === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
    ctx.closePath();
  }
  ctx.clip();
  for (const s of buildSpeckles()) {
    const size = Math.max(1, Math.round(s.size * S));
    ctx.globalAlpha = s.a;
    // Grains take the large (soft) sprite; see GRAINS for why the dust's crisp diamond is
    // wrong at this size.
    const sprite = s.grain || SPECKLE.soft ? sprites.large : sprites.small;
    ctx.drawImage(tinted(makeCanvas, sprite, s.c, size), s.x * W - size / 2, s.y * H - size / 2);
  }
  ctx.restore();

  // The flares' CROSSES are baked in here, at rest, while their glows are drawn per frame (see
  // drawStars). They are split that way for cost, not for looks: a cross reaches 5.6 disc
  // diameters and its arms dominate the area that has to be restored from this cache every
  // frame, so animating them made the backdrop 33x more expensive per frame than the plain
  // band restore it replaced (measured: 0.4ms -> 13.2ms at a retina laptop's real canvas
  // size). Held still, their pixels never change and never need restoring.
  //
  // Order is unchanged: cross first, glow over it -- the centre should read as the brightest
  // thing there rather than as a seam between two half-spikes.
  for (const s of STARS) {
    const size = Math.round(s.size * S);
    if (size < 2) continue;
    ctx.save();
    ctx.globalAlpha = s.a * SPIKE_ALPHA;
    drawSpikes(ctx, makeCanvas, s.x * W, s.y * H, size * DISC_FRACTION, s.c);
    ctx.restore();
  }
}

// The named flares breathe, so the illustration is not entirely still between shirts.
//
// Each star runs on its own period and phase, drawn from one fixed seed -- shared periods make
// eight stars read as one blinking group, which is the thing that would look mechanical. The
// periods are deliberately not multiples of each other, so the field never returns to a pose
// it has held before within any watch a person would give it.
//
// What moves is the GLOW only -- its alpha and its drawn size. The cross is baked into the
// cached backdrop at rest (see paint), and the flare never moves; one that changed position
// would read as the composition shifting.
//
// The cross used to twinkle too, harder than anything else, and it was the most expensive thing
// on the page: its arms reach 5.6 disc diameters, so restoring them from the cache every frame
// took the backdrop from 0.4ms to 13.2ms a frame at a retina laptop's real canvas size. Holding
// them still costs one dimension of the effect and removes most of the per-frame area. If the
// twinkle ever needs to read stronger, raise `alpha` -- do not put the cross back on a timer.
const TWINKLE = {
  seed: 'about-twinkle',
  periodMin: 3.4,
  periodMax: 7.1,
  alpha: 0.3, // +-, as a fraction of the star's own alpha
  size: 0.07 // +-, as a fraction of the sprite's draw box
};

let twinklePhases = null;
function phases() {
  if (twinklePhases) return twinklePhases;
  const rng = makeRng(TWINKLE.seed);
  twinklePhases = STARS.map(() => ({
    phase: rng(),
    period: TWINKLE.periodMin + rng() * (TWINKLE.periodMax - TWINKLE.periodMin)
  }));
  return twinklePhases;
}

// -1..1, a plain sine: the brightening and the dimming should take the same time as each other
// (a real star's scintillation has no attack/decay shape to reproduce) and a sine is the one
// curve with no corner at either end, so nothing ticks.
function wave(i, t) {
  const p = phases()[i];
  return Math.sin(2 * Math.PI * (t / p.period + p.phase));
}

// The canvas the caller has to restore before redrawing one star. Only the glow's own box: the
// cross does not animate, so its pixels in the cache are already correct and rewriting them
// would cost more area than everything else here put together. Sized for the LARGEST the glow
// ever gets, not its resting size, or the twinkle leaves a trail at its extremes.
function starRects(s, W, H, S) {
  const size = Math.round(s.size * S) * (1 + TWINKLE.size);
  const cx = s.x * W;
  const cy = s.y * H;
  return [{
    x: Math.floor(cx - size / 2 - 2),
    y: Math.floor(cy - size / 2 - 2),
    w: Math.ceil(size + 4) + 1,
    h: Math.ceil(size + 4) + 1
  }];
}

function drawStars(ctx, W, H, sprites, makeCanvas, t) {
  const S = W / BOX_W;
  STARS.forEach((s, i) => {
    const base = Math.round(s.size * S);
    if (base < 2) return;
    const w = wave(i, t);
    const size = base * (1 + TWINKLE.size * w);
    const cx = s.x * W;
    const cy = s.y * H;
    ctx.save();
    ctx.globalAlpha = Math.min(1, s.a * (1 + TWINKLE.alpha * w));
    // The tinted sprite is cached at the RESTING size and scaled on the way out, so a
    // continuously changing size doesn't mint a new cached canvas every frame.
    ctx.drawImage(tinted(makeCanvas, sprites.large, s.c, base), cx - size / 2, cy - size / 2, size, size);
    ctx.restore();
  });
}

// The backdrop is painted once per size and blitted thereafter -- without this the speckle
// field would cost several hundred tinted sprite draws on every frame of the carousel. The
// eight named flares are NOT in it (they twinkle); everything else is fixed.
let frameCache = null;

// `sprites` = { large, small }, `makeCanvas(w,h)` so this works in the browser and in Node.
//
// `band` is an optional { y, h } in canvas pixels: repaint only that horizontal strip. The
// backdrop never changes, so a caller animating something over part of it (the shirt row)
// only has to restore the strip that thing moves through -- which at supersampled sizes is
// the difference between clearing and blitting 1.8 megapixels every frame and about a third
// of that. Pass nothing for a full repaint, which is what a resize needs.
// `t` is the animation clock in seconds, driving the flares' twinkle. Pass 0 for a still
// frame -- that is what a reduced-motion render does, and it is the resting pose.
export function drawAboutBackground(ctx, W, H, sprites, makeCanvas, band = null, t = 0) {
  const ready = !!(sprites?.large && sprites?.small);
  if (!frameCache || frameCache.w !== W || frameCache.h !== H || frameCache.ready !== ready) {
    const c = makeCanvas(W, H);
    paint(c.getContext('2d'), W, H, sprites, makeCanvas);
    frameCache = { w: W, h: H, ready, canvas: c };
  }
  const y = band ? Math.max(0, Math.floor(band.y)) : 0;
  const h = band ? Math.min(H - y, Math.ceil(band.h)) : H;
  if (h > 0) {
    ctx.clearRect(0, y, W, h);
    ctx.drawImage(frameCache.canvas, 0, y, W, h, 0, y, W, h);
  }
  if (!ready) return;
  // A star's own box has to be restored too, and only when a band was given: the full-canvas
  // path above has already cleared everything, but a band leaves last frame's flares standing
  // wherever they sit outside it. Restoring per box (rather than widening the band to cover
  // them, or giving up and repainting the canvas) keeps the per-frame cost proportional to the
  // stars themselves -- eight small blits.
  const S = W / BOX_W;
  if (band) {
    for (const s of STARS) {
      for (const b of starRects(s, W, H, S)) {
        const bx = Math.max(0, b.x);
        const by = Math.max(0, b.y);
        const bw = Math.min(W - bx, b.w - (bx - b.x));
        const bh = Math.min(H - by, b.h - (by - b.y));
        if (bw <= 0 || bh <= 0) continue;
        ctx.clearRect(bx, by, bw, bh);
        ctx.drawImage(frameCache.canvas, bx, by, bw, bh, bx, by, bw, bh);
      }
    }
  }
  drawStars(ctx, W, H, sprites, makeCanvas, t);
}
