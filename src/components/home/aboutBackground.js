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

export const HEXES = [
  { cx: 437.5, cy: 183.0, r: 181.0, x0: 159.4, y0: -220.9, x1: -33.4, y1: 46.3, stops: ['#290092', '#453d8f', '#98c270'] },
  { cx: 177.5, cy: 145.0, r: 99.0, x0: 151.9, y0: -90.3, x1: 14.9, y1: -8.8, stops: ['#69918c', '#99ca75', '#c2fc5f'] },
  { cx: 88.5, cy: 60.5, r: 23.0, x0: 9.9, y0: -7.4, x1: 46.0, y1: -34.3, stops: ['#e1fc19', '#d5f837', '#c3ed51'] },
  { cx: 40.5, cy: 170.0, r: 44.0, x0: -94.5, y0: 94.6, x1: -35.0, y1: 35.0, stops: ['#f70f5a', '#f95457', '#fba142'] },
  { cx: 84.5, cy: 248.0, r: 44.0, x0: -72.1, y0: 96.1, x1: -112.8, y1: 150.3, stops: ['#d13e62', '#e50d5f', '#f90f5a'] }
];

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

export const STARS = [
  star(521, 257, 38, '#cbfc5e', 0.8), // the big lime one low-right, the composition's anchor
  star(97, 106, 34, '#8ff7c0', 0.75),
  star(380, 290, 26, '#45dbe8', 0.75),
  star(209, 82, 22, '#f2e21a', 0.8),
  star(303, 126, 18, '#6fe0dc', 0.7),
  star(490, 205, 14, '#cffe4f', 0.7),
  star(245, 314, 10, '#6ef5e7', 0.85),
  star(298, 341, 10, '#99ffc2', 0.85)
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
  bandJitter: 0.18
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
  return stops.map(s =>
    tinycolor({ h: dustHue(tinycolor(s).toHsl().h), s: SPECKLE.sat, l: SPECKLE.light }).toHexString()
  );
}

function lerpHex(a, b, t) {
  const A = tinycolor(a).toRgb();
  const B = tinycolor(b).toRgb();
  const m = (p, q) => Math.round(p + (q - p) * t);
  return tinycolor({ r: m(A.r, B.r), g: m(A.g, B.g), b: m(A.b, B.b) }).toHexString();
}

// Where a point falls along a hexagon's gradient axis, 0..1 -- the same projection
// createLinearGradient does internally, so a speck's colour tracks the pixel under it.
function gradientT(h, x, y) {
  const dx = h.x1 - h.x0;
  const dy = h.y1 - h.y0;
  const len2 = dx * dx + dy * dy;
  if (!len2) return 0;
  const t = ((x - h.x0) * dx + (y - h.y0) * dy) / len2;
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
      return q < 0.5 ? lerpHex(comp[0], comp[1], q * 2) : lerpHex(comp[1], comp[2], (q - 0.5) * 2);
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

function paint(ctx, W, H, sprites, makeCanvas) {
  const S = W / BOX_W;
  ctx.clearRect(0, 0, W, H);

  for (const h of HEXES) {
    const g = ctx.createLinearGradient(h.x0 * S, h.y0 * S, h.x1 * S, h.y1 * S);
    // Three stops, sampled as the MEDIAN colour of real pixels in bands along the gradient
    // axis. A two-stop least-squares fit was tried first and collapsed toward each region's
    // mean -- the big hexagon came out flat olive instead of indigo to green.
    g.addColorStop(0, h.stops[0]);
    g.addColorStop(0.5, h.stops[1]);
    g.addColorStop(1, h.stops[2]);
    ctx.fillStyle = g;
    hexPath(ctx, h.cx * S, h.cy * S, h.r * S);
    ctx.fill();
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
    ctx.drawImage(tinted(makeCanvas, sprites.small, s.c, size), s.x * W - size / 2, s.y * H - size / 2);
  }
  ctx.restore();

  for (const s of STARS) {
    const size = Math.round(s.size * S);
    if (size < 2) continue;
    const cx = s.x * W;
    const cy = s.y * H;
    ctx.save();
    // Cross first, disc over it: the spike runs through the flare's centre, and the centre
    // should read as the brightest thing there rather than as a seam between two half-spikes.
    ctx.globalAlpha = s.a * SPIKE_ALPHA;
    drawSpikes(ctx, makeCanvas, cx, cy, size * DISC_FRACTION, s.c);
    ctx.globalAlpha = s.a;
    ctx.drawImage(tinted(makeCanvas, sprites.large, s.c, size), cx - size / 2, cy - size / 2);
    ctx.restore();
  }
}

// Nothing in the backdrop animates -- only the shirt row does -- so it is painted once per
// size and blitted thereafter. Without this the speckle field would cost several hundred
// tinted sprite draws on every frame of the carousel.
let frameCache = null;

// `sprites` = { large, small }, `makeCanvas(w,h)` so this works in the browser and in Node.
//
// `band` is an optional { y, h } in canvas pixels: repaint only that horizontal strip. The
// backdrop never changes, so a caller animating something over part of it (the shirt row)
// only has to restore the strip that thing moves through -- which at supersampled sizes is
// the difference between clearing and blitting 1.8 megapixels every frame and about a third
// of that. Pass nothing for a full repaint, which is what a resize needs.
export function drawAboutBackground(ctx, W, H, sprites, makeCanvas, band = null) {
  const ready = !!(sprites?.large && sprites?.small);
  if (!frameCache || frameCache.w !== W || frameCache.h !== H || frameCache.ready !== ready) {
    const c = makeCanvas(W, H);
    paint(c.getContext('2d'), W, H, sprites, makeCanvas);
    frameCache = { w: W, h: H, ready, canvas: c };
  }
  const y = band ? Math.max(0, Math.floor(band.y)) : 0;
  const h = band ? Math.min(H - y, Math.ceil(band.h)) : H;
  if (h <= 0) return;
  ctx.clearRect(0, y, W, h);
  ctx.drawImage(frameCache.canvas, 0, y, W, h, 0, y, W, h);
}
