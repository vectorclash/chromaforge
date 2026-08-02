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

// `centered` (default false) changes what `baseHue` MEANS: stops are spaced symmetrically
// AROUND it (baseHue - spread/2 .. baseHue + spread/2) rather than walking forward from it.
// This is what makes a wide spread safe for a complement-anchored palette, and it removes a
// constraint that used to be taken as inherent. Walking forward, a 180 spread puts the last
// stop 180 degrees past the complement -- i.e. back on the ORIGINAL hue being complemented
// against, destroying the guarantee (confirmed live once: the star field's last stop landed
// within ~10 degrees of the background's own hue). Centred, the furthest any stop can get from
// the complement is spread/2, so even a 260-degree sweep keeps every stop at least 50 degrees
// off the background hue while spanning most of the wheel. See GenerateStarField's spectrum
// roll, which is the reason this exists.
export function randomPalette(
  rng,
  count,
  { minSpread = 8, maxSpread = 180, baseHue = null, centered = false } = {}
) {
  const spread = minSpread + rng() * (maxSpread - minSpread);
  const anchor = baseHue === null ? rng() * 360 : baseHue;
  const hueStart = centered ? anchor - spread / 2 : anchor;
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

// Drives a palette toward SATURATED COLOUR that separates from the background, so the star
// field reads as a vivid accent instead of dissolving into what's behind it (Aaron's report,
// 2026-08-02: the stars "fade into the background too much and never really pop"). The cause
// it addresses: the star field's internal gradient -- which is what actually tints the
// sprites, see StarField's destination-atop -- was built from the SAME palette as the
// background whenever a user palette was set, so the stars were the same hue AND the same
// lightness family as the pixels directly underneath. The blend half of the fix is in
// generateArtwork's starBlendMode.
//
// CHROMA IS THE POINT, NOT LIGHTNESS, and getting that backwards is the trap -- the first
// version of this pushed lightness hard toward a target of 82 and Aaron rejected the result
// immediately ("the star colors look silly and washed out... now they just look near white
// and boring"). It was right about the diagnosis and wrong about the lever: driving lightness
// up necessarily drains a colour toward white, and a lightening blend on top of an
// already-pale source finishes the job. The reference this generator came from is a Hubble
// plate gradient-mapped against the background's own gradient running the other way, i.e.
// fully saturated yellow-green / cyan / magenta at MID lightness -- those pop against a dark
// field because of hue and chroma, not because they are bright.
//
// So: saturation is pushed hard (SAT_TARGET), and lightness moves only far enough to clear
// the backdrop -- a fixed offset away from `backgroundLightness`, clamped to a band that
// never approaches white or black. `backgroundLightness` (0-1, the mean of the background
// gradient's own stops) picks the direction, so a pale design gets deep vivid stars rather
// than the paler-still ones an unconditional lift would have given it.
//
// `strength` (0-1) scales how far it goes, so the effect varies design to design instead of
// clamping every star field to one look. Hue is preserved exactly -- a user's chosen colours
// stay their colours.
const SAT_TARGET = 96;
// The band a star's lightness is confined to. The ceiling is what stops "vibrant" collapsing
// into "white", which is the whole lesson above; the floor stops it collapsing into black on
// a pale design. Both targets sit INSIDE the band rather than at its edge.
const LIGHT_MIN = 30;
const LIGHT_MAX = 56;
const LIGHT_TARGET_DARK = 34;
const LIGHT_TARGET_LIGHT = 52;
// Above this PERCEIVED luminance (not HSL lightness -- see meanLuminance) the backdrop is
// treated as bright and the stars go deep instead of light.
export const BRIGHT_BACKDROP = 0.42;

export function contrastPalette(colors, backgroundLuminance, strength = 1) {
  const goDark = backgroundLuminance > BRIGHT_BACKDROP;
  const targetL = goDark ? LIGHT_TARGET_DARK : LIGHT_TARGET_LIGHT;
  return colors.map(c => {
    const { h, s, l } = tinycolor(c).toHsl();
    const l100 = l * 100;
    const s100 = s * 100;
    // Lightness is LERPED toward the target from wherever the stop already sits, in both
    // directions -- unlike saturation, a stop that is already past the target is pulled back,
    // because "past" here means closer to white/black, which is exactly what we don't want.
    const nextL = l100 + (targetL - l100) * strength;
    // Saturation only ever goes up. A stop that is already fully saturated is left alone.
    const nextS = Math.max(s100, s100 + (SAT_TARGET - s100) * strength);
    return tinycolor({
      h,
      s: clamp(nextS, 0, 100),
      l: clamp(nextL, LIGHT_MIN, LIGHT_MAX)
    }).toHexString();
  });
}

// Mean PERCEIVED luminance (0-1) of a set of colours -- how bright the thing a later layer
// will sit on top of actually looks. Pure arithmetic on already-resolved colours, so it
// consumes no rng() and cannot desync anything.
//
// Deliberately sRGB relative luminance, NOT the HSL lightness this used to be, and the
// difference is not academic: HSL puts pure green (#00ff00) at exactly 0.50, the same as a
// mid grey, so a searingly bright green backdrop was classed as "mid" and got light stars
// laid over it -- which is precisely the washed-out case Aaron rejected. By luminance that
// same green is 0.72 and correctly routes to deep, saturated stars. Green carries most of
// the eye's sensitivity and blue almost none, which is what the coefficients below encode
// and what HSL throws away.
export function meanLuminance(colors) {
  if (!colors || colors.length === 0) return 0.5;
  let sum = 0;
  for (const c of colors) {
    const { r, g, b } = tinycolor(c).toRgb();
    // Gamma-expand each channel to linear light before weighting -- averaging gamma-encoded
    // values overstates dark colours.
    const lin = v => {
      const x = v / 255;
      return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
    };
    sum += 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  }
  return sum / colors.length;
}

// Convenience: seeded integer in [min, max] inclusive.
export function randInt(rng, min, max) {
  return min + Math.floor(rng() * (max - min + 1));
}
