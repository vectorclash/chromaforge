import tinycolor from 'tinycolor2';

// Seeded pseudo-random number generator for deterministic, reproducible art.
//
// The whole render pipeline is a pure function of (seed, colors, settings, width, height).
// Every place that previously called Math.random() / tinycolor.random() now draws from a
// seeded stream instead, so the same seed always reconstructs the same composition — at any
// resolution or aspect ratio. This is what makes method-4 "recompose per ratio" reproducible
// and lets a tiny JSON ({ seed, colors, settings }) stand in for the full artwork.

// xmur3: hash an arbitrary string into a well-mixed 32-bit seed.
function xmur3(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return function () {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return h >>> 0;
  };
}

// mulberry32: small, fast, well-distributed PRNG. Returns floats in [0, 1).
function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// makeRng(seed) -> () => [0, 1). Accepts a string seed (preferred) or a number.
// Drop-in replacement for Math.random, but deterministic for a given seed.
export function makeRng(seed) {
  const seedStr = typeof seed === 'number' ? String(seed) : String(seed ?? '');
  const next = xmur3(seedStr);
  return mulberry32(next());
}

// Generate a fresh, URL-safe seed string for a brand-new design.
export function randomSeed() {
  // 8 base36 chars from the platform RNG — only used at creation time, never at render time.
  let s = '';
  for (let i = 0; i < 8; i++) {
    s += Math.floor(Math.random() * 36).toString(36);
  }
  return s;
}

// Seeded replacement for tinycolor.random(): an even random RGB hex string.
export function randomColorHex(rng) {
  const c = () => Math.floor(rng() * 256);
  const hex = n => n.toString(16).padStart(2, '0');
  return `#${hex(c())}${hex(c())}${hex(c())}`;
}

// Seeded palette with a controllable hue spread (default: varies per call, uniformly
// from near-monochrome up to fully vivid) and healthy saturation/lightness, so it can
// never degenerate to *literally* single-hue (monochrome) or near-gray/washed-out output
// the way independent random draws occasionally could, while still allowing a
// deliberately muted result. Hues are spaced evenly across `spread` degrees from a start
// hue, with jitter capped below the gap between stops so ordering (and the floor
// guarantee) can't collide.
//
// `minSpread`/`maxSpread` (degrees, default 8-180): the total hue range the stops are
// spaced across is redrawn each call, uniformly in this range -- 8 is tight enough to
// read as "one hue, faintly varied" (never fully flat) without ever being 0; 180 is the
// widest a spread can mean anything (opposite ends of the wheel), matching the old
// always-wide behavior at the top end. `baseHue` (default: random) lets a caller anchor
// the palette to a specific hue instead of picking its own -- see GenerateStarField's use
// of this to bias its own gradient toward the *complement* of the main background's hue,
// so a muted background still gets a guaranteed contrasting accent elsewhere.
// Expands a ONE-colour palette into a small set that still reads as that colour: the base
// kept exactly, plus companions bracketing it lighter and darker within a narrow analogous
// hue window. A single-colour design is a real thing a customer can make (nothing in the
// studio's colour list stops you removing down to one), and before this the three
// generators that special-cased it each improvised their own companion -- usually a RANDOM
// GREYSCALE value, which is neither similar to the chosen colour nor monochromatic, and
// which each layer picked differently so the piece didn't even hold together.
// Companions alternate lighter/darker rather than all drifting one way, so the set brackets
// the base instead of sliding away from it. A greyscale base deliberately stays greyscale
// (spinning the hue of a zero-saturation colour does nothing anyway, and quietly injecting
// saturation into someone's black-and-white choice is not "similar").
// Returns hex STRINGS, like randomPalette -- not tinycolor objects. That distinction is not
// cosmetic: the old greyscale branches pushed raw tinycolor objects, which browsers accept
// because addColorStop stringifies them via toString(), but @napi-rs/canvas rejects outright
// ("Failed to convert JavaScript value ... into rust type String"). So every single-colour
// design rendered fine on screen and crashed the print pipeline -- the same browsers-are-
// lenient trap as GenerateLargeRadialField's alpha-as-a-string bug.
function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

export function expandMonochromePalette(baseColor, rng, count = 3) {
  const base = tinycolor(baseColor);
  const { h, s, l } = base.toHsl();
  const isGrey = s === 0;
  const colors = [base.toHexString()];
  for (let i = 1; i < count; i++) {
    const dir = i % 2 === 1 ? 1 : -1;
    const step = Math.ceil(i / 2);
    const hue = isGrey ? h : (h + dir * (8 + rng() * 14) * step + 360) % 360;
    // Clamped away from pure black/white so a companion never collapses into an invisible
    // or blown-out stop, however extreme the chosen base is.
    const lightness = clamp(l * 100 + dir * (10 + rng() * 14) * step, 12, 88);
    const saturation = isGrey ? 0 : clamp(s * 100 + (rng() - 0.5) * 20, 20, 95);
    colors.push(tinycolor({ h: hue, s: saturation, l: lightness }).toHexString());
  }
  return colors;
}

export function randomPalette(rng, count, { minSpread = 8, maxSpread = 180, baseHue = null } = {}) {
  const spread = minSpread + rng() * (maxSpread - minSpread);
  const hueStart = baseHue === null ? rng() * 360 : baseHue;
  const step = count > 1 ? spread / (count - 1) : 0;
  const colors = [];
  for (let i = 0; i < count; i++) {
    const jitter = (rng() - 0.5) * step * 0.3;
    const hue = (hueStart + step * i + jitter + 360) % 360;
    const saturation = 55 + rng() * 35; // 55-90%
    const lightness = 40 + rng() * 25; // 40-65%
    colors.push(tinycolor({ h: hue, s: saturation, l: lightness }).toHexString());
  }
  return colors;
}

// Convenience: seeded integer in [min, max] inclusive.
export function randInt(rng, min, max) {
  return min + Math.floor(rng() * (max - min + 1));
}
