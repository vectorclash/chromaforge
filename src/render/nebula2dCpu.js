// LAB (branch nebula-gpu-lab): the 2D nebula recipe on the CPU, written for speed -- the same math
// as nebulaGpu.js's NEB2D_FS, statement for statement, so a print rendered without a GPU matches
// the studio's GPU render (checked: see the lab notes). No allocation in the hot path.
// Returns sRGB luminance per pixel, row 0 at the top, for a design placed at `loc`.

const OFF = [[186.03127584467438, 114.9559537682114, 154.44750347045425], [199.8400018782914, 162.2925926843408, 154.048234399885], [111.63384265071569, 157.36939531224067, 199.0881114730351], [165.44527757573996, 162.76821379148592, 193.4084041028769], [155.58091529076475, 177.15463090621742, 138.140034568063]].map((o) => o.map((v) => Math.fround(v)));

// Lattice hash: a classic shuffled permutation table (Perlin's own scheme) rather than Blender's
// Jenkins mix -- about 2.4x faster per noise on a CPU. The GPU shader uses the SAME table, so the
// two still agree; the nebula's shapes differ from Blender's file, its character does not.
export const PERM = [215,212,216,17,5,7,140,9,114,189,52,233,248,138,89,61,53,10,206,250,184,158,30,35,115,39,113,137,217,65,177,99,134,45,95,187,75,214,73,163,145,139,49,81,50,51,234,57,37,242,157,77,29,107,67,185,47,59,23,146,71,213,21,79,160,205,199,176,63,128,94,101,244,18,168,83,190,20,117,91,181,153,90,254,240,103,102,40,62,123,26,154,133,161,151,195,200,169,46,165,129,149,130,231,156,245,119,125,66,208,201,207,252,44,121,88,87,183,12,143,127,74,15,135,86,118,33,131,6,136,236,171,227,110,19,241,228,194,166,24,58,179,182,226,2,106,170,76,41,142,11,198,172,28,159,4,232,253,55,186,69,70,238,193,108,196,111,197,27,202,93,64,230,98,235,191,152,219,105,144,175,188,8,104,1,116,255,84,124,210,97,251,204,92,211,120,68,32,167,56,34,203,38,224,246,229,150,223,147,243,122,60,100,164,85,247,13,178,25,237,31,16,109,239,225,148,112,220,173,14,78,249,221,162,218,48,222,72,43,96,54,174,36,132,126,42,22,192,3,80,209,0,141,82,155,180];
const P = new Uint8Array(512); for (let i = 0; i < 512; i++) P[i] = PERM[i & 255];
function grad(h, x, y, z) {
  h &= 15;
  const u = h < 8 ? x : y, v = h < 4 ? y : (h === 12 || h === 14 ? x : z);
  return ((h & 1) ? -u : u) + ((h & 2) ? -v : v);
}
function perlin(x, y, z) {
  const X = Math.floor(x), Y = Math.floor(y), Z = Math.floor(z);
  const fx = x - X, fy = y - Y, fz = z - Z;
  const u = fx * fx * fx * (fx * (fx * 6 - 15) + 10), v = fy * fy * fy * (fy * (fy * 6 - 15) + 10), w = fz * fz * fz * (fz * (fz * 6 - 15) + 10);
  const xi = X & 255, yi = Y & 255, zi = Z & 255;
  const A = P[xi] + yi, AA = P[A] + zi, AB = P[A + 1] + zi, B = P[xi + 1] + yi, BA = P[B] + zi, BB = P[B + 1] + zi;
  const n000 = grad(P[AA], fx, fy, fz), n100 = grad(P[BA], fx - 1, fy, fz);
  const n010 = grad(P[AB], fx, fy - 1, fz), n110 = grad(P[BB], fx - 1, fy - 1, fz);
  const n001 = grad(P[AA + 1], fx, fy, fz - 1), n101 = grad(P[BA + 1], fx - 1, fy, fz - 1);
  const n011 = grad(P[AB + 1], fx, fy - 1, fz - 1), n111 = grad(P[BB + 1], fx - 1, fy - 1, fz - 1);
  const a0 = n000 + (n100 - n000) * u, a1 = n010 + (n110 - n010) * u, a2 = n001 + (n101 - n001) * u, a3 = n011 + (n111 - n011) * u;
  const b0 = a0 + (a1 - a0) * v, b1 = a2 + (a3 - a2) * v;
  return 0.982 * (b0 + (b1 - b0) * w);
}
function fbm(x, y, z, oct) {
  let fs = 1, amp = 1, maxamp = 0, sum = 0;
  for (let i = 0; i < oct; i++) { sum += perlin(fs * x, fs * y, fs * z) * amp; maxamp += amp; amp *= 0.5; fs *= 2; }
  return 0.5 * sum / maxamp + 0.5;
}
// scratch for the warped coordinate (avoids returning arrays)
let WX = 0, WY = 0, WZ = 0;
function warp(x, y, z, scale, distortion) {
  WX = x * scale; WY = y * scale; WZ = z * scale;
  if (distortion !== 0) {
    const dx = perlin(WX + OFF[0][0], WY + OFF[0][1], WZ + OFF[0][2]) * distortion;
    const dy = perlin(WX + OFF[1][0], WY + OFF[1][1], WZ + OFF[1][2]) * distortion;
    const dz = perlin(WX + OFF[2][0], WY + OFF[2][1], WZ + OFF[2][2]) * distortion;
    WX += dx; WY += dy; WZ += dz;
  }
}
// warpOct: octaves for the noises that only WARP (the overlay that sets the distortion amount, and
// the vector offset); fine detail in a warp barely shows, so these can be cheaper than `oct`.
function cloud(x, y, z, scale, distortion, ovScale, ovDist, oct, warpOct) {
  warp(x, y, z, ovScale, ovDist * 0.5);
  const m = distortion + fbm(WX, WY, WZ, warpOct);
  warp(x, y, z, scale, m * 0.5);
  const c0 = fbm(WX, WY, WZ, warpOct), c1 = fbm(WX + OFF[3][0], WY + OFF[3][1], WZ + OFF[3][2], warpOct), c2 = fbm(WX + OFF[4][0], WY + OFF[4][1], WZ + OFF[4][2], warpOct);
  warp(x + c0 - 0.5, y + c1 - 0.5, z + c2 - 0.5, scale, m * 0.5);
  return fbm(WX, WY, WZ, oct);
}
const clamp01 = (t) => (t < 0 ? 0 : t > 1 ? 1 : t);
const band = (t, p0, p1, p2) => (t <= p0 || t >= p2 ? 0 : t < p1 ? (t - p0) / (p1 - p0) : 1 - (t - p1) / (p2 - p1));
const gray = (r, g, b) => 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
const dodge1 = (x, b, t) => { if (x === 0) return 0; const d = 1 - t * b; return d <= 0 ? 1 : Math.min(1, x / d); };
const CX = [0, 0.352, 0.573, 1], CY = [0, 0.157, 0.814, 1], CM = [0.4460227273, 1.4205933682, 1.3009259259, 0.4355971897];
function curveS(x) {
  if (x <= 0) return 0; if (x >= 1) return 1;
  const i = x < CX[1] ? 0 : x < CX[2] ? 1 : 2;
  const h = CX[i + 1] - CX[i], t = (x - CX[i]) / h, t2 = t * t, t3 = t2 * t;
  return (2 * t3 - 3 * t2 + 1) * CY[i] + (t3 - 2 * t2 + t) * h * CM[i] + (-2 * t3 + 3 * t2) * CY[i + 1] + (t3 - t2) * h * CM[i + 1];
}
const srgb = (c) => { c = clamp01(c); return c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055; };

export const UNITS_PER_SHORT_EDGE = 0.81;
export function octavesFor(w, h) { return Math.max(6, Math.min(12, Math.round(Math.log2(Math.max(w, h)) + 0.5))); }

/** Rows y0..y1 of a w x h nebula into out (Float32Array of (y1-y0)*w). */
export function nebula2dRows(loc, w, h, oct, y0, y1, out, { warpOct = Math.min(oct, 6), fineOct = Math.min(oct, 6) } = {}) {
  const k = UNITS_PER_SHORT_EDGE / Math.min(w, h);
  for (let py = y0; py < y1; py++) {
    const dz = (h * 0.5 - py - 0.5) * k; // GL's y runs up; row 0 is the top
    for (let px = 0; px < w; px++) {
      const dx = (px + 0.5 - w * 0.5) * k, dy = 1;
      const bx = loc[0] + dx, by = loc[1] + dy, bz = loc[2] + dz;
      let t = clamp01((cloud(bx, by, bz, 1.64, 0.18, 0.76, -2.88, oct, warpOct) - 0.535) / (0.704 - 0.535));
      const c1r = 0.019 * t, c1g = 0.047 * t, c1b = 0.107 * t;
      t = clamp01((cloud(bx, by, bz, 0.82, 0.33, 3.18, 0.36, oct, warpOct) - 0.49) / (0.533 - 0.49));
      const c2r = 0.103 * t, c2g = 0.19 * t, c2b = 0.265 * t;
      t = clamp01((cloud(bx, by, bz - 0.08, 1.09, 0, 1.9, 11, oct, warpOct) - 0.474) / (0.689 - 0.474));
      const c3r = 0.161 * t, c3g = 0.011 * t, c3b = 0;
      // screen(screen(screen(0, c1), c2), c3)
      let nr = 1 - (1 - c2r) * (1 - c1r), ng = 1 - (1 - c2g) * (1 - c1g), nb = 1 - (1 - c2b) * (1 - c1b);
      nr = 1 - (1 - c3r) * (1 - nr); ng = 1 - (1 - c3g) * (1 - ng); nb = 1 - (1 - c3b) * (1 - nb);
      warp(dx, dy, dz - 0.3, 1.96, 0);
      const amb = clamp01((fbm(WX, WY, WZ, 1) - 0.125) / (0.792 - 0.125));
      const f7 = band(gray(nr, ng, nb), 0.005, 0.167, 0.257);
      const m7r = dodge1(nr, amb, f7), m7g = dodge1(ng, amb, f7), m7b = dodge1(nb, amb, f7);
      warp(dx, dy, dz, 5, 0);
      const g0 = fbm(WX, WY, WZ, fineOct), g1 = fbm(WX + OFF[3][0], WY + OFF[3][1], WZ + OFF[3][2], fineOct), g2 = fbm(WX + OFF[4][0], WY + OFF[4][1], WZ + OFF[4][2], fineOct);
      const ft = clamp01((gray(g0, g1, g2) - 0.148) / (0.816 - 0.148));
      const f5 = band(gray(m7r, m7g, m7b), 0.002, 0.264, 0.68);
      const m5r = dodge1(m7r, 0.692 * ft, f5), m5g = dodge1(m7g, 0.173 * ft, f5), m5b = dodge1(m7b, 0.007 * ft, f5);
      out[(py - y0) * w + px] = srgb(gray(curveS(m5r), curveS(m5g), curveS(m5b)));
    }
  }
  return out;
}
