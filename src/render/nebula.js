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
import { nebulaFieldGpu, nebulaFieldGpuBanded } from './nebulaGpu';
import LinearGradient from '../components/Canvas/LinearGradient';

export const NEBULA_PIXELS = 960 * 540;
// The field's area for a DECORATIVE render -- one shown small and never compared against a print
// (the mini generator, footer band, mobile nav, the homepage shirt and About blob): a quarter, so
// a quarter of the GPU work, which is most of what a render costs (2026-10-19, measured: the
// nebula 55-110ms of each render on a desktop GPU, drawing 2-8ms; a phone is several times that).
// Set per render through generateArtwork's renderContext.nebulaPixels; never on anything a
// customer approves as a print, so (1) above still holds for every mockup and print file.
export const NEBULA_PIXELS_LITE = NEBULA_PIXELS / 4;
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
const POOL_DOWNSAMPLE = 4;
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
export function placement(seed, target) {
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
export const ALPHAQ = [0, 0.031, 0.043, 0.055, 0.063, 0.075, 0.082, 0.094, 0.11, 0.125, 0.149, 0.173, 0.2, 0.227, 0.255,
  0.282, 0.306, 0.333, 0.357, 0.384, 0.412, 0.439, 0.467, 0.498, 0.522, 0.549, 0.584, 0.62, 0.655, 0.698, 0.737, 0.792, 1];
// Split in two so the 3D flight (animation3d/nebula3d.js) can take knots from one field and
// apply them to another; toHisCurve is the 2D path, unchanged.
export function hisCurveKnots(L) {
  const step = Math.max(1, Math.floor(L.length / 20000)), sample = [];
  for (let k = 0; k < L.length; k += step) sample.push(L[k]);
  sample.sort((a, b) => a - b);
  const q = (r) => sample[Math.min(sample.length - 1, Math.floor(r * (sample.length - 1)))];
  return Array.from({ length: 33 }, (_, i) => q(i / 32));
}
function toHisCurve(L) {
  return applyHisCurve(L, hisCurveKnots(L));
}
export function applyHisCurve(L, knots) {
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
export function nebulaRenderSize(width, height, pixels = NEBULA_PIXELS) {
  const aspect = width / height;
  const w = Math.max(16, Math.round(Math.sqrt((pixels || NEBULA_PIXELS) * aspect)));
  const h = Math.max(16, Math.round(w / aspect));
  return { w, h };
}

/** Alpha mask (0..1, row 0 at the top) at the fixed render size. Exported for checks. */
export function nebulaMask(config, { gpu = true, info = null } = {}) {
  const plan = config.nebulaConfig;
  const { w, h } = nebulaRenderSize(config.width, config.height, config.nebulaConfig?.pixels);
  const loc = placement(config.seed, plan.cover);
  let field = gpu ? nebulaFieldGpu(loc, w, h, NEBULA_OCTAVES) : null;
  if (info) info.gpu = !!field;
  if (!field) field = fieldCpu(loc, w, h, NEBULA_OCTAVES);
  return maskFromField(field, w, h, plan);
}

/** nebulaMask with the GPU field drawn in bands (nebulaGpu.js), for the worker. Same result. */
export async function nebulaMaskBanded(config, { gpu = true, info = null } = {}) {
  const plan = config.nebulaConfig;
  const { w, h } = nebulaRenderSize(config.width, config.height, config.nebulaConfig?.pixels);
  const loc = placement(config.seed, plan.cover);
  let field = gpu ? await nebulaFieldGpuBanded(loc, w, h, NEBULA_OCTAVES, undefined, undefined, info) : null;
  if (info) info.gpu = !!field;
  if (!field) field = fieldCpu(loc, w, h, NEBULA_OCTAVES);
  return maskFromField(field, w, h, plan);
}

function maskFromField(field, w, h, plan) {
  const a = toHisCurve(field);
  if (plan.colour.mode === 'own') {
    // Pools are a very wide blur (~1/24 of the long edge), so they are computed on a 4x-reduced
    // grid and sampled back bilinearly: the same soft glow for ~1/16 of the work (it was ~30ms of
    // every render at full size).
    const D = POOL_DOWNSAMPLE, sw = Math.ceil(w / D), sh = Math.ceil(h / D);
    const small = new Float32Array(sw * sh);
    for (let y = 0; y < sh; y++)
      for (let x = 0; x < sw; x++) {
        let sum = 0, n = 0;
        for (let yy = y * D; yy < Math.min(h, y * D + D); yy++)
          for (let xx = x * D; xx < Math.min(w, x * D + D); xx++) { sum += a[yy * w + xx]; n++; }
        small[y * sw + x] = sum / n;
      }
    const pools = blurField(small, sw, sh, Math.max(1, Math.round(Math.max(w, h) / 24 / D)));
    let mx = 1e-6;
    for (const v of pools) mx = Math.max(mx, v);
    const k0 = POOL_STRENGTH / mx;
    for (let y = 0; y < h; y++) {
      const fy = Math.min(sh - 1, Math.max(0, (y + 0.5) / D - 0.5)), y0 = Math.floor(fy), y1 = Math.min(sh - 1, y0 + 1), ty = fy - y0;
      for (let x = 0; x < w; x++) {
        const fx = Math.min(sw - 1, Math.max(0, (x + 0.5) / D - 0.5)), x0 = Math.floor(fx), x1 = Math.min(sw - 1, x0 + 1), tx = fx - x0;
        const top = pools[y0 * sw + x0] + (pools[y0 * sw + x1] - pools[y0 * sw + x0]) * tx;
        const bot = pools[y1 * sw + x0] + (pools[y1 * sw + x1] - pools[y1 * sw + x0]) * tx;
        const k = y * w + x;
        a[k] = Math.max(a[k], (top + (bot - top) * ty) * k0);
      }
    }
  }
  for (let k = 0; k < a.length; k++) a[k] *= plan.strength;
  return { a, w, h };
}

// The mask as RGBA pixels (white, alpha = the mask), ready for putImageData. Pure: runs in the page
// or in the nebula's worker.
export function nebulaRGBA(config, opts) {
  return maskToRGBA(nebulaMask(config, opts));
}
export async function nebulaRGBABanded(config, opts) {
  return maskToRGBA(await nebulaMaskBanded(config, opts));
}
function maskToRGBA(m) {
  const rgba = new Uint8ClampedArray(m.w * m.h * 4);
  for (let k = 0; k < m.a.length; k++) {
    const o = k * 4;
    rgba[o] = 255;
    rgba[o + 1] = 255;
    rgba[o + 2] = 255;
    rgba[o + 3] = Math.round(m.a[k] * 255);
  }
  return { rgba, w: m.w, h: m.h };
}

// The studio re-renders the same design often (sliders, palette edits, thumbnails, label
// backdrops), so masks are cached per seed + render size + plan.
const MASKS = new Map();
function maskKey(config) {
  const plan = config.nebulaConfig;
  const { w, h } = nebulaRenderSize(config.width, config.height, config.nebulaConfig?.pixels);
  return `${config.seed}:${w}x${h}:${plan.cover}:${plan.strength}:${plan.colour.mode}`;
}
function storeMask(key, rgba, w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  // createImageData rather than new ImageData(): render-service's Node canvas has no global
  // ImageData constructor
  const x = c.getContext('2d');
  const id = x.createImageData(w, h);
  id.data.set(rgba);
  x.putImageData(id, 0, 0);
  if (MASKS.size > 12) MASKS.delete(MASKS.keys().next().value);
  MASKS.set(key, c);
  return c;
}
function maskCanvas(config) {
  const key = maskKey(config);
  if (MASKS.has(key)) return MASKS.get(key);
  // Not prepared (render-service, or a caller that never asked): computed here, synchronously.
  const { rgba, w, h } = nebulaRGBA(config);
  return storeMask(key, rgba, w, h);
}

// ─── Off the main thread ───────────────────────────────────────────────────────────────
// Computing a mask is hundreds of ms on a phone (placement, the GPU field and its read-back, the
// tone curve, the pools), and renderArtwork is synchronous: done inline it froze the page,
// loader included, on every Generate (Aaron, 2026-10-19: "a massive pause that reads as being
// broken"). prepareNebula(config) computes the mask in a worker (render/nebulaWorker.js; the GPU
// field through an OffscreenCanvas there, else the CPU) and caches it, so the render that follows
// finds it ready. Same code, same result as the synchronous path. Every surface that renders on a
// user action awaits it first; anything that does not still gets the right mask, synchronously.
let WORKER = null;
let workerFailed = false;
let jobId = 0;
const JOBS = new Map();
const PENDING = new Map();
function nebulaWorker() {
  if (WORKER || workerFailed) return WORKER;
  if (typeof window === 'undefined' || typeof Worker === 'undefined') return null;
  try {
    WORKER = new Worker(new URL('./nebulaWorker.js', import.meta.url), { type: 'module' });
    WORKER.onmessage = e => {
      const job = JOBS.get(e.data.id);
      JOBS.delete(e.data.id);
      job?.(e.data);
    };
    WORKER.onerror = err => {
      console.warn('[nebula] worker failed, computing in the page:', err.message);
      workerFailed = true;
      WORKER = null;
      for (const done of JOBS.values()) done({ error: 'worker failed' });
      JOBS.clear();
    };
  } catch (err) {
    workerFailed = true;
    WORKER = null;
  }
  return WORKER;
}

/** Sends `payload` to the nebula's worker; resolves with its reply, or null without a worker. */
export function askNebulaWorker(payload) {
  const w = nebulaWorker();
  if (!w) return Promise.resolve(null);
  return new Promise(resolve => {
    const id = ++jobId;
    JOBS.set(id, msg => resolve(msg.error ? null : msg));
    w.postMessage({ id, ...payload });
  });
}

/** Resolves with a design's nebula placement, computed in the worker (the 3D flight needs it too). */
export function placementAsync(seed, cover) {
  const key = `${seed}:${cover}`;
  if (PLACEMENTS.has(key)) return Promise.resolve(PLACEMENTS.get(key));
  const w = nebulaWorker();
  if (!w) return Promise.resolve(placement(seed, cover));
  return new Promise(resolve => {
    const id = ++jobId;
    JOBS.set(id, msg => {
      if (msg.error) return resolve(placement(seed, cover));
      if (!PLACEMENTS.has(key)) PLACEMENTS.set(key, msg.loc);
      resolve(PLACEMENTS.get(key));
    });
    w.postMessage({ id, placement: { seed, cover } });
  });
}

/** Resolves once `config`'s nebula mask is cached (computed off the main thread where possible). */
export function prepareNebula(config) {
  const plan = config?.nebulaConfig;
  if (!plan || !plan.strength) return Promise.resolve();
  const key = maskKey(config);
  if (MASKS.has(key)) return Promise.resolve();
  if (PENDING.has(key)) return PENDING.get(key);
  const w = nebulaWorker();
  if (!w) return Promise.resolve();
  const p = new Promise(resolve => {
    const id = ++jobId;
    JOBS.set(id, msg => {
      if (!msg.error && !MASKS.has(key)) storeMask(key, msg.rgba, msg.w, msg.h);
      else if (msg.error) console.warn('[nebula] worker job failed:', msg.error);
      if (import.meta.env?.DEV && !msg.error) console.info(`[nebula] ${msg.w}x${msg.h} in the worker, ${msg.gpu ? `GPU, ${msg.bands} bands, worst ${msg.maxBandMs}ms` : 'CPU'}, ${msg.ms}ms`);
      PENDING.delete(key);
      resolve();
    });
    w.postMessage({
      id,
      job: { seed: config.seed, width: config.width, height: config.height, nebulaConfig: plan },
      // dev only: localStorage cf-lab:nebula-cpu = 1 forces the worker's CPU path, to time the
      // fallback a browser without WebGL2 in workers would take
      cpu: !!(import.meta.env?.DEV && localStorage.getItem('cf-lab:nebula-cpu'))
    });
  });
  PENDING.set(key, p);
  return p;
}

/** Computes and caches `config`'s mask on THIS thread, drawing the GPU field in bands. For the
 * render worker (render/renderWorker.js), which is already off the page's thread. */
export async function prepareNebulaHere(config) {
  const plan = config?.nebulaConfig;
  if (!plan || !plan.strength) return;
  const key = maskKey(config);
  if (MASKS.has(key)) return;
  const { rgba, w, h } = await nebulaRGBABanded(config);
  if (!MASKS.has(key)) storeMask(key, rgba, w, h);
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
