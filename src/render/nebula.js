// The nebula layer -- replaces the radial gradient field on EVERY design (GENERATOR_VERSION 15).
// Aaron, 2026-10-18: he never liked the radial blobs and only used them because he didn't know how
// to make a real nebula. The look was approved over a long lab run (branch nebula-gpu-lab; the
// rounds are in the nebula memory note): the Blender Market "Nebula Generator" 2D recipe, its
// luminance turned into alpha by his own old Photoshop piece's tonal curve, filled with a colour
// gradient, drawn source-over in the radial field's old slot (behind stars and geometry).
//
// Two halves:
//   generateNebula(config) -- PURE, called from generateArtwork. How much nebula and which colours,
//     from side streams only (`${seed}-nebula-amount`, `-nebula-colour`, `-nebula-palette`), so it
//     consumes nothing from the shared rng sequence. The radial field is still GENERATED there, draws
//     and all, and simply never drawn -- removing its draws would re-roll every design's geometry
//     coin (the 2026-08-02 incident).
//   drawNebula(ctx, config) -- called from renderArtwork. Renders the field, turns it into an alpha
//     mask, tints it and composites it.
//
// Things worth not re-deriving:
// (1) THE FIELD IS RENDERED AT A FIXED PIXEL AREA, never at the output size (NEBULA_PIXELS, then
//     upscaled). A mockup renders through capMockupRenderSize while the print renders at the true
//     printfile size; at a fixed area both get the identical field, octaves, tone curve and pool
//     blur, so the preview a customer approves is the garment they get (the v14 rule). Area, not a
//     fixed long edge: the 11250x4350 shorts sheet would otherwise get 960x371 and go soft.
//     The field is a smooth, low-frequency thing, so the upscale costs very little (measured in the
//     lab: 1920 long edge = full-res, 960 slightly softer).
// (2) PLACEMENT IS PICKED WITH THE CPU RENDERER, ALWAYS. It is a re-roll loop against a cover
//     target, i.e. a chain of hard comparisons, and the GPU differs from the CPU by up to ~1.3/255
//     -- enough, near a threshold, to pick a different placement and show a customer a completely
//     different nebula from the one printed. On the CPU it is exact JS arithmetic in every engine.
//     It is 16 tiny 64x36 renders at most, ~0.1s, cached per seed.
// (3) The main field may come from either renderer (GPU in the studio, CPU in render-service or a
//     browser without WebGL2); everything after it is continuous, so their difference stays small.
// (4) The tone curve's knots are quantiles of the field ITSELF, at the fixed size above -- so they
//     are the same for a design at every output size. (In the lab they came from the output-size
//     render, which made studio, mockup and print three different curves.)
import tinycolor from 'tinycolor2';
import { makeRng, randomPalette } from './prng';
import { nebula2dRows } from './nebula2dCpu';
import { nebulaFieldGpu } from './nebulaGpu';
import LinearGradient from '../components/Canvas/LinearGradient';

export const NEBULA_PIXELS = 960 * 540;
export const NEBULA_OCTAVES = 9;

// How much nebula a design gets. Four tiers, smooth within each: none ~15%, faint ~20%, medium
// ~40%, full ~25% -- the radial field it replaces was absent on 40% of designs and varied wildly in
// strength, so the nebula needs that range too. Always three draws, whatever the tier.
export const AMOUNT_TIERS = [
  { name: 'none', share: 0.15 },
  // Floors raised 2026-10-19 (faint was 0.20-0.40, medium 0.45-0.75): on geometry-heavy designs
  // those vanished completely, and a nebula nobody can see is the 'none' tier in disguise.
  { name: 'faint', share: 0.2, cover: [0.1, 0.2], strength: [0.35, 0.55] },
  { name: 'medium', share: 0.4, cover: [0.2, 0.35], strength: [0.6, 0.85] },
  { name: 'full', share: 0.25, cover: [0.35, 0.55], strength: [0.8, 1.0] }
];
function nebulaAmount(seed) {
  const rng = makeRng(`${seed}-nebula-amount`);
  const u = rng(), v = rng(), w = rng();
  let acc = 0;
  for (const t of AMOUNT_TIERS) {
    acc += t.share;
    if (u < acc || t === AMOUNT_TIERS[AMOUNT_TIERS.length - 1]) {
      if (!t.cover) return { tier: t.name, cover: 0, strength: 0 };
      return { tier: t.name, cover: t.cover[0] + v * (t.cover[1] - t.cover[0]), strength: t.strength[0] + w * (t.strength[1] - t.strength[0]) };
    }
  }
}

// The nebula's colours. Either a gradient of its OWN plus colour pools (the default -- the radial
// field gave every blob its own random palette on auto-palette designs and that was much of their
// colour; own gradients plus pools are what Aaron picked as making "everything pop", 2026-10-18), or
// the star field's gradient so gas and stars read as one. Which one is the design setting
// settings.geometry.nebulaLinked (the studio's Color tab), not a roll.
// Own: the user's palette from a new starting stop if there is one, else hues centred opposite the
// background's mean hue, sweeping 120-220deg, so the nebula adds colours the design lacks.
// Colour pools: a heavily blurred copy of the gas laid under it as a broad glow (own gradient only),
// so the nebula puts down colour the way the radial blobs did, but shaped by the nebula.
const POOL_STRENGTH = 0.6;
export function nebulaColour(config, linked) {
  const rng = makeRng(`${config.seed}-nebula-colour`);
  // The first draw used to roll own vs stars. It is still taken so the angle and palette size
  // that follow are the ones the approved comparison pages showed.
  rng();
  const angle = rng() * Math.PI * 2, count = 2 + Math.floor(rng() * 4);
  if (linked) return { mode: 'stars', gradient: null };
  const palRng = makeRng(`${config.seed}-nebula-palette`);
  const user = (config.colors || []).filter(Boolean);
  let colors;
  if (user.length >= 2) {
    const off = Math.floor(palRng() * user.length);
    colors = user.map((_, i) => user[(i + off) % user.length]);
  } else {
    const bg = config.gradientBackgroundConfig.colors.map((c) => tinycolor(c).toHsl());
    let sx = 0, sy = 0;
    for (const c of bg) { sx += Math.cos((c.h * Math.PI) / 180) * c.s; sy += Math.sin((c.h * Math.PI) / 180) * c.s; }
    const bgHue = (Math.atan2(sy, sx) * 180) / Math.PI;
    const base = (bgHue + 180 + (palRng() - 0.5) * 100 + 360) % 360;
    colors = randomPalette(palRng, count, { minSpread: 120, maxSpread: 220, baseHue: base, centered: true });
  }
  const W = config.width, H = config.height, r = Math.hypot(W, H) / 2;
  const dx = Math.cos(angle) * r, dy = Math.sin(angle) * r;
  return {
    mode: 'own',
    gradient: { width: W, height: H, colors: [...colors, colors[colors.length - 1]], gradientDirection: { x1: W / 2 - dx, y1: H / 2 - dy, x2: W / 2 + dx, y2: H / 2 + dy } }
  };
}

/** Pure: the design's nebula plan, for config.nebulaConfig. No shared-rng draws. */
export function generateNebula(config, { linked = false } = {}) {
  const amount = nebulaAmount(config.seed);
  if (amount.strength === 0) return { ...amount, colour: null };
  return { ...amount, colour: nebulaColour(config, linked) };
}

// ---- rendering ----

function fieldCpu(loc, w, h, oct) {
  return nebula2dRows(loc, w, h, oct, 0, h, new Float32Array(w * h));
}

// Placement re-rolled until the gas covers about the tier's target share of the frame. CPU only --
// see (2) above. The preview is a fixed 64x36 whatever the output's shape, so it is per seed.
const PLACEMENTS = new Map();
function placement(seed, target) {
  const key = `${seed}:${target}`;
  if (PLACEMENTS.has(key)) return PLACEMENTS.get(key);
  let best = null;
  for (let i = 0; i < 16; i++) {
    const rng = makeRng(`${seed}-nebula-${i}`);
    const loc = [rng() * 400 - 200, rng() * 400 - 200, rng() * 400 - 200];
    const m = fieldCpu(loc, 64, 36, 6);
    let lit = 0;
    for (const v of m) if (v > 0.3) lit++;
    const score = Math.abs(lit / m.length - target);
    if (!best || score < best.score) best = { loc, score };
    if (score < 0.06) break;
  }
  if (PLACEMENTS.size > 64) PLACEMENTS.delete(PLACEMENTS.keys().next().value);
  PLACEMENTS.set(key, best.loc);
  return best.loc;
}

// His alpha's tonal curve: 33 quantiles of the alpha channel of his old Photoshop piece, applied to
// the field by rank.
const ALPHAQ = [0, 0.031, 0.043, 0.055, 0.063, 0.075, 0.082, 0.094, 0.11, 0.125, 0.149, 0.173, 0.2, 0.227, 0.255,
  0.282, 0.306, 0.333, 0.357, 0.384, 0.412, 0.439, 0.467, 0.498, 0.522, 0.549, 0.584, 0.62, 0.655, 0.698, 0.737, 0.792, 1];
function toHisCurve(L) {
  const step = Math.max(1, Math.floor(L.length / 20000)), sample = [];
  for (let k = 0; k < L.length; k += step) sample.push(L[k]);
  sample.sort((a, b) => a - b);
  const q = (r) => sample[Math.min(sample.length - 1, Math.floor(r * (sample.length - 1)))];
  const knots = Array.from({ length: 33 }, (_, i) => q(i / 32));
  const out = new Float32Array(L.length);
  for (let k = 0; k < L.length; k++) {
    const v = L[k];
    let lo = 0, hi = 32;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (knots[m] <= v) lo = m; else hi = m; }
    const span = knots[hi] - knots[lo], f = span > 0 ? Math.min(1, Math.max(0, (v - knots[lo]) / span)) : 0;
    out[k] = ALPHAQ[lo] + (ALPHAQ[hi] - ALPHAQ[lo]) * f;
  }
  return out;
}

function blurField(a, w, h, r) { // three box passes ~ a gaussian
  const tmp = new Float32Array(a.length), out = Float32Array.from(a);
  for (let it = 0; it < 3; it++) {
    for (let y = 0; y < h; y++) {
      let acc = 0, n = 0;
      for (let x = -r; x < w; x++) {
        if (x + r < w) { acc += out[y * w + x + r]; n++; }
        if (x - r - 1 >= 0) { acc -= out[y * w + x - r - 1]; n--; }
        if (x >= 0) tmp[y * w + x] = acc / n;
      }
    }
    for (let x = 0; x < w; x++) {
      let acc = 0, n = 0;
      for (let y = -r; y < h; y++) {
        if (y + r < h) { acc += tmp[(y + r) * w + x]; n++; }
        if (y - r - 1 >= 0) { acc -= tmp[(y - r - 1) * w + x]; n--; }
        if (y >= 0) out[y * w + x] = acc / n;
      }
    }
  }
  return out;
}

/** The fixed render size for an output of width x height (see (1) above). */
export function nebulaRenderSize(width, height) {
  const aspect = width / height;
  const w = Math.max(16, Math.round(Math.sqrt(NEBULA_PIXELS * aspect)));
  const h = Math.max(16, Math.round(w / aspect));
  return { w, h };
}

/** Alpha mask (0..1, row 0 at the top) at the fixed render size. Exported for checks. */
export function nebulaMask(config, { gpu = true } = {}) {
  const plan = config.nebulaConfig;
  const { w, h } = nebulaRenderSize(config.width, config.height);
  const loc = placement(config.seed, plan.cover);
  const field = (gpu && nebulaFieldGpu(loc, w, h, NEBULA_OCTAVES)) || fieldCpu(loc, w, h, NEBULA_OCTAVES);
  const a = toHisCurve(field);
  if (plan.colour.mode === 'own') {
    const pools = blurField(a, w, h, Math.round(Math.max(w, h) / 24));
    let mx = 1e-6;
    for (const v of pools) mx = Math.max(mx, v);
    for (let k = 0; k < a.length; k++) a[k] = Math.max(a[k], (pools[k] / mx) * POOL_STRENGTH);
  }
  for (let k = 0; k < a.length; k++) a[k] *= plan.strength;
  return { a, w, h };
}

// The studio re-renders the same design often (sliders, palette edits, thumbnails, label
// backdrops), so masks are cached per seed + render size + plan.
const MASKS = new Map();
function maskCanvas(config) {
  const plan = config.nebulaConfig;
  const { w, h } = nebulaRenderSize(config.width, config.height);
  const key = `${config.seed}:${w}x${h}:${plan.cover}:${plan.strength}:${plan.colour.mode}`;
  if (MASKS.has(key)) return MASKS.get(key);
  const m = nebulaMask(config);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const x = c.getContext('2d');
  const id = x.createImageData(w, h);
  for (let k = 0; k < m.a.length; k++) {
    id.data[k * 4] = 255;
    id.data[k * 4 + 1] = 255;
    id.data[k * 4 + 2] = 255;
    id.data[k * 4 + 3] = Math.round(m.a[k] * 255);
  }
  x.putImageData(id, 0, 0);
  if (MASKS.size > 12) MASKS.delete(MASKS.keys().next().value);
  MASKS.set(key, c);
  return c;
}

/** Composite the design's nebula onto ctx (the radial field's old slot). */
export function drawNebula(ctx, config) {
  const plan = config.nebulaConfig;
  if (!plan || plan.strength === 0) return;
  const mask = maskCanvas(config);
  const tinted = document.createElement('canvas');
  tinted.width = config.width;
  tinted.height = config.height;
  const tx = tinted.getContext('2d');
  tx.imageSmoothingEnabled = true;
  tx.imageSmoothingQuality = 'high';
  tx.drawImage(mask, 0, 0, config.width, config.height);
  tx.globalCompositeOperation = 'source-in';
  const gradient = LinearGradient(plan.colour.gradient || config.starFieldConfig.gradientConfig);
  tx.drawImage(gradient, 0, 0);
  gradient.width = 0;
  gradient.height = 0;
  ctx.globalCompositeOperation = 'source-over';
  ctx.drawImage(tinted, 0, 0);
  tinted.width = 0;
  tinted.height = 0;
}
