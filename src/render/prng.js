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

// Convenience: seeded integer in [min, max] inclusive.
export function randInt(rng, min, max) {
  return min + Math.floor(rng() * (max - min + 1));
}
