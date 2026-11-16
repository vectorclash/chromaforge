// Measures, pixel by pixel, how Printful's mockup generator turns print files into a product photo,
// so the browser can make that photo itself, instantly, for any artwork (src/lib/instantMockup.js).
//
//   node scripts/calibrate-instant-mockup.mjs --product 257 capture            # 9 mockup tasks
//   node scripts/calibrate-instant-mockup.mjs --product 257 --stitch black --shading-from v8850-white capture
//                                                                               # 4 tasks
//   node scripts/calibrate-instant-mockup.mjs --product 83 --variant 49854 capture
//   node scripts/calibrate-instant-mockup.mjs --product 693 --variant 17388 --underlay capture
//                                                                               # 5 tasks
//   node scripts/calibrate-instant-mockup.mjs --product 257 decode             # offline, no network
//   node scripts/calibrate-instant-mockup.mjs --product 257 verify             # 1 task
//
// Reads PRINTFUL_API_KEY, VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY
// from .env.local.
//
// WHY THIS AND NOT A HAND-PLACED OVERLAY. The July 2026 attempt (branch deleted) DERIVED where the
// artwork sits on each photo -- scale tables fitted from diffs, cover-fits, guessed sleeve regions --
// and never looked like the real thing. This derives nothing. It asks Printful's own renderer:
//
//   * WHITE, BLACK and GREY on every placement give, per photo pixel and channel, how the photo
//     responds to the artwork. Printful's compositing (shading multiply, highlight screen, alpha
//     over a background) is affine in the artwork value, so out = black + (white - black) * art.
//     Grey checks that, and corrects it where it is not quite true.
//   * An ID pattern (one solid colour per placement) says which print file each pixel shows.
//   * Phase-shifted sine patterns (structured light) give the exact print-file coordinate each
//     pixel samples: one period across the file for the coarse position, eight for precision, three
//     phases in R/G/B so the decode cancels the shading.
//
// So the instant mockup is Printful's photo with the artwork looked up through Printful's own
// mapping -- seams, folds, sleeves and all -- rather than our idea of where the shirt is.
//
// CONFIGURATIONS. A product's photos can differ by variant and by stitch colour. Each distinct
// photo set is one configuration, `v<variantId>[-<stitch>]`, applying to every variant that shares
// its photos (same colour, or -- on a product Printful photographs per variant, like the pillow --
// that one variant). A configuration whose photos only differ in SHADING from another's (a black
// stitch, a different bag colour) takes `--shading-from <config>`: 4 tasks (white, black, grey, the
// background) instead of 9, reusing the other's measured mapping. The first configuration captured
// for a product is its default (the shop card); `--default` makes another one so.
//
// TRANSPARENT LABELS (`--underlay`). A label_outside mark -- and the bucket hat's inside one -- is a
// transparent PNG printed OVER the artwork, so where the mark is clear Printful shows the print
// underneath. The capture above only learns the LABEL's coordinates at those pixels; drawn as is,
// the clear part came out black. `--underlay` re-runs the ID and coordinate patterns with every label
// left off (5 tasks), which measures exactly what lies under each label pixel; the compositor then
// lays the mark over that through its own alpha.
//
// `verify` is the non-circular check: it renders a real saved design's print files, asks Printful
// for a REAL mockup of them, composes the instant photo from the very same files, and reports the
// difference per view (and writes them side by side to .calib/<product>/<config>/verify/).
//
// COST: 9 mockup tasks per full configuration (4 for shading-only, 1 for verify), all style groups
// at once. They count against the store-wide 10/60s create limit shared with customers (paced
// below) and, like every mockup task, leave files in Printful's library permanently (no delete
// API). `capture` keeps its downloads in .calib/ and never re-runs a task whose photos are already
// there, so decoding can be retried for free.
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PRODUCT_MOCKUP_CONFIG } from '../src/lib/printfulMockupConfig.js';
import {
  MOCKUP_STYLE_GROUPS,
  MOCKUP_STYLE_VIEWS,
  MODEL_GROUPS_BY_PRODUCT,
  PER_VARIANT_MOCKUP_PRODUCTS
} from '../src/lib/printfulMockupStyleGroups.js';
import { chooseOptionGroups } from '../src/lib/printfulViewPolicy.js';
import { composeInstantMockup } from '../src/lib/instantMockup.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let canvasLib;
try {
  canvasLib = createRequire(import.meta.url)('../render-service/node_modules/@napi-rs/canvas');
} catch {
  console.error('Could not load @napi-rs/canvas. Run `npm install` inside render-service/ first.');
  process.exit(1);
}
const { createCanvas, loadImage } = canvasLib;

for (const line of fs.readFileSync(path.join(ROOT, '.env.local'), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}
const KEY = process.env.PRINTFUL_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY;

const args = process.argv.slice(2);
const arg = name => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? null : args[i + 1];
};
const productId = Number(arg('product'));
const mode = ['capture', 'decode', 'verify'].find(m => args.includes(m));
if (!productId || !mode) {
  console.error('usage: --product <id> [--variant <id>] [--stitch <colour>] [--shading-from <config>] capture|decode|verify');
  process.exit(1);
}
const PRODUCT_DIR = path.join(ROOT, '.calib', String(productId));
fs.mkdirSync(PRODUCT_DIR, { recursive: true });
// `--out <dir>` decodes somewhere else (an experiment) and leaves the app's index alone.
const OUT_ROOT = arg('out');
const PUBLIC_DIR = path.join(OUT_ROOT || path.join(ROOT, 'public', 'instant-mockups'), String(productId));

const PATTERN_LONG_EDGE = 2000;
const FINE_PERIODS = 8;
// The default design `verify` checks against (a saved public design with chaotic geometry, hard
// edges and stars -- the hardest kind to register).
const VERIFY_DESIGN = 'ce5e71e5-15f0-49cd-8714-e273b95f042b';

// The patterns, in capture order. `png` comes back with the background removed (alpha = the
// product), which is what the decode wants; one white task is also taken as JPG for the
// background the product sits on.
const PATTERNS = ['white', 'black', 'grey', 'id', 'x1', `x${FINE_PERIODS}`, 'y1', `y${FINE_PERIODS}`];
const FULL_TASKS = [...PATTERNS.map(p => ({ pattern: p, format: 'png' })), { pattern: 'white', format: 'jpg' }];
const SHADING_TASKS = ['white', 'black', 'grey'].map(p => ({ pattern: p, format: 'png' })).concat({ pattern: 'white', format: 'jpg' });
// What lies under a label: the mapping patterns with every label placement left off.
const UNDER_TASKS = ['id', 'x1', `x${FINE_PERIODS}`, 'y1', `y${FINE_PERIODS}`].map(p => ({ pattern: p, format: 'png' }));
const isLabel = key => key.startsWith('label_');

// Placement colours for the ID pattern: the non-black corners of the RGB cube, so any two are at
// least one full channel apart after the shading is divided out, and mid grey as an eighth for the
// products with eight print files (hoodies, windbreaker, track jacket).
const ID_COLOURS = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
  [1, 1, 0],
  [1, 0, 1],
  [0, 1, 1],
  [1, 1, 1],
  [128 / 255, 128 / 255, 128 / 255]
];

// The shop card is the on-model front where a product has one -- except where that photo hardly
// shows the artwork: the crossbody bag is a small pouch on a model in a dark jacket (2026-11-15).
const CARD_VIEW_OVERRIDES = {
  744: { group: 'Flat', name: 'Front' }
};

// Encodings shared with src/lib/instantMockup.js -- change both together.
const GAMMA_MIN = 0.5;
const GAMMA_SPAN = 4.5;
const UV_LEVELS = 4096;
// Decode cleaning (measureMapping): a coordinate step between neighbouring pixels larger than
// CUT_JUMP is a cut, not a slope; neighbours within AGREE of each other agree; a print file's patch
// smaller than ISLAND pixels is a misreading.
const CUT_JUMP = 0.03;
const AGREE = 0.008;
const ISLAND = 24;
// How far around a label the label-free capture is used (see --underlay).
const LABEL_RING = 3;

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function printful(urlPath, init) {
  for (let i = 0; i < 8; i++) {
    const res = await fetch(`https://api.printful.com${urlPath}`, {
      ...init,
      headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }
    });
    const body = await res.json().catch(() => null);
    if (body?.result && typeof body.result === 'object') return body.result;
    if (body?.data) return body;
    console.log(`  waiting on Printful (${res.status} ${JSON.stringify(body).slice(0, 90)})`);
    await sleep(12000);
  }
  throw new Error(`Printful call failed: ${urlPath}`);
}

function patternCanvas(w, h, pattern, placementIndex) {
  const c = createCanvas(w, h);
  const ctx = c.getContext('2d');
  const solid = rgb => {
    ctx.fillStyle = `rgb(${rgb.map(v => Math.round(v * 255)).join(',')})`;
    ctx.fillRect(0, 0, w, h);
  };
  if (pattern === 'white') solid([1, 1, 1]);
  else if (pattern === 'black') solid([0, 0, 0]);
  else if (pattern === 'grey') solid([128 / 255, 128 / 255, 128 / 255]);
  else if (pattern === 'id') solid(ID_COLOURS[placementIndex]);
  else {
    const axis = pattern[0];
    const periods = Number(pattern.slice(1));
    const img = ctx.createImageData(w, h);
    const d = img.data;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const t = axis === 'x' ? (x + 0.5) / w : (y + 0.5) / h;
        const phi = 2 * Math.PI * periods * t;
        const o = (y * w + x) * 4;
        d[o] = Math.round(127.5 + 127.5 * Math.cos(phi));
        d[o + 1] = Math.round(127.5 + 127.5 * Math.cos(phi - (2 * Math.PI) / 3));
        d[o + 2] = Math.round(127.5 + 127.5 * Math.cos(phi + (2 * Math.PI) / 3));
        d[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
  }
  return c.toBuffer('image/png');
}

// Content-hashed: Printful caches a fetched file BY URL, so a name must never be reused for
// different bytes (CLAUDE.md, the hoodie-pocket calibration).
async function upload(buffer, name, type = 'image/png') {
  const hash = createHash('sha256').update(buffer).digest('hex').slice(0, 16);
  const ext = type === 'image/png' ? 'png' : 'jpg';
  const objectPath = `instant-mockup-calibration/${productId}/${name}-${hash}.${ext}`;
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/design-mockups/${objectPath}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': type, 'x-upsert': 'true' },
    body: buffer
  });
  if (!res.ok) throw new Error(`upload failed: ${res.status} ${await res.text()}`);
  return `${SUPABASE_URL}/storage/v1/object/public/design-mockups/${objectPath}`;
}

// Runs one mockup task and saves every photo it returns, by generator_mockup_id.
async function runTask({ variantId, format, files, groups, options }, dir) {
  const task = await printful(`/mockup-generator/create-task/${productId}`, {
    method: 'POST',
    body: JSON.stringify({
      variant_ids: [variantId],
      format,
      files,
      ...(groups.length ? { option_groups: groups } : {}),
      ...(Object.keys(options).length ? { product_options: options } : {})
    })
  });
  let result = null;
  for (let i = 0; i < 90 && !result; i++) {
    await sleep(3000);
    process.stdout.write('.');
    const polled = await printful(`/mockup-generator/task?task_key=${task.task_key}`);
    if (polled.status !== 'pending') result = polled;
  }
  console.log('');
  if (result?.status !== 'completed') throw new Error(`task ${result?.status}: ${JSON.stringify(result?.error)}`);
  const photos = {};
  for (const m of result.mockups ?? []) {
    const all = [
      { id: m.generator_mockup_id, url: m.mockup_url, title: m.placement },
      ...(m.extra ?? []).map(e => ({ id: e.generator_mockup_id, url: e.url, title: e.title }))
    ];
    for (const e of all) if (e.id && e.url && !photos[e.id]) photos[e.id] = e;
  }
  fs.mkdirSync(dir, { recursive: true });
  for (const [id, e] of Object.entries(photos)) {
    const res = await fetch(e.url);
    fs.writeFileSync(path.join(dir, `${id}.${format}`), Buffer.from(await res.arrayBuffer()));
  }
  // Pace the store-wide create limit (10 per 60s, shared with customers): at most ~4 a minute.
  await sleep(8000);
  return { taskKey: task.task_key, photos: Object.fromEntries(Object.entries(photos).map(([id, e]) => [id, e.title])) };
}

const position = p => ({ area_width: p.width, area_height: p.height, width: p.width, height: p.height, top: 0, left: 0 });

async function productFacts() {
  const specs = await printful(`/mockup-generator/printfiles/${productId}`);
  const product = await printful(`/products/${productId}`);
  const styles = await printful(`/v2/catalog-products/${productId}/mockup-styles`);
  const names = new Set();
  for (const e of styles?.data ?? []) for (const st of e?.mockup_styles ?? []) if (st?.category_name) names.add(st.category_name);
  return { specs, variants: product.variants, groups: chooseOptionGroups([...names], productId) };
}

async function capture() {
  if (!KEY || !SUPABASE_URL || !SERVICE_KEY) throw new Error('PRINTFUL_API_KEY, VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY');
  const { specs, variants, groups } = await productFacts();
  const variantId = Number(arg('variant')) || specs.variant_printfiles[0].variant_id;
  const vpf = specs.variant_printfiles.find(v => v.variant_id === variantId);
  if (!vpf) throw new Error(`variant ${variantId} has no printfiles`);
  const placements = Object.entries(vpf.placements);
  const dims = Object.fromEntries(specs.printfiles.map(p => [p.printfile_id, p]));
  const cfg = PRODUCT_MOCKUP_CONFIG[productId] || {};
  const defaultStitch = cfg.productOptions?.find(o => o.name === 'stitch_color')?.value ?? null;
  const stitch = arg('stitch') || defaultStitch;
  const options = stitch ? { stitch_color: stitch } : {};
  const configId = `v${variantId}${stitch ? `-${stitch}` : ''}`;
  const shadingFrom = arg('shading-from');
  if (placements.length > ID_COLOURS.length) throw new Error(`${placements.length} placements; the ID pattern holds ${ID_COLOURS.length}`);
  // Which variants show these photos: just this one where Printful photographs each variant, else
  // every variant of the same colour (sizes share a photo).
  const perVariant = PER_VARIANT_MOCKUP_PRODUCTS.map(String).includes(String(productId));
  const colour = variants.find(v => v.id === variantId)?.color ?? null;
  const covered = perVariant ? [variantId] : variants.filter(v => v.color === colour).map(v => v.id);

  const dir = path.join(PRODUCT_DIR, configId);
  const metaPath = path.join(dir, 'capture.json');
  const isFirst = !fs.readdirSync(PRODUCT_DIR).some(d => fs.existsSync(path.join(PRODUCT_DIR, d, 'capture.json')));
  const meta = fs.existsSync(metaPath)
    ? JSON.parse(fs.readFileSync(metaPath, 'utf8'))
    : {
        productId,
        configId,
        variantId,
        variants: covered,
        stitch,
        options,
        groups,
        shadingFrom,
        default: isFirst || args.includes('--default'),
        placements: placements.map(([key, printfileId]) => ({ key, printfileId, width: dims[printfileId].width, height: dims[printfileId].height })),
        finePeriods: FINE_PERIODS,
        idColours: ID_COLOURS.slice(0, placements.length),
        tasks: {}
      };
  fs.mkdirSync(dir, { recursive: true });
  console.log(`product ${productId} config ${configId}: variant ${variantId} (covers ${covered.length}), groups ${groups.join(' + ') || '(default)'}${shadingFrom ? `, shading from ${shadingFrom}` : ''}`);
  console.log(`placements: ${meta.placements.map(p => `${p.key} ${p.width}x${p.height}`).join(', ')}`);
  const underlay = args.includes('--underlay');
  if (underlay && meta.shadingFrom) throw new Error('--underlay is for a full configuration');
  meta.underTasks = meta.underTasks || {};
  for (const { pattern, format } of underlay ? UNDER_TASKS : shadingFrom ? SHADING_TASKS : FULL_TASKS) {
    const taskName = `${pattern}.${format}`;
    if ((underlay ? meta.underTasks : meta.tasks)[taskName]) continue;
    const files = [];
    for (const [i, p] of meta.placements.entries()) {
      if (underlay && isLabel(p.key)) continue;
      const scale = Math.min(1, PATTERN_LONG_EDGE / Math.max(p.width, p.height));
      const w = Math.round(p.width * scale);
      const h = Math.round(p.height * scale);
      const url = await upload(patternCanvas(w, h, pattern, i), `${pattern}-${p.key}-${w}x${h}`);
      files.push({ placement: p.key, image_url: url, position: position(p) });
    }
    process.stdout.write(`${underlay ? 'under/' : ''}${taskName}: generating`);
    const result = await runTask({ variantId, format, files, groups, options }, path.join(dir, underlay ? 'under' : '', taskName));
    (underlay ? meta.underTasks : meta.tasks)[taskName] = result;
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
    console.log(`  ${Object.entries(result.photos).map(([id, t]) => `${id} ${t}`).join(', ')}`);
  }
}

async function pixels(file) {
  const img = await loadImage(fs.readFileSync(file));
  const c = createCanvas(img.width, img.height);
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0);
  return { w: img.width, h: img.height, d: ctx.getImageData(0, 0, img.width, img.height).data };
}

function encode(w, h, fill, type, quality) {
  const c = createCanvas(w, h);
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(w, h);
  for (let i = 0; i < w * h; i++) {
    const [r, g, b] = fill(i);
    img.data[i * 4] = r;
    img.data[i * 4 + 1] = g;
    img.data[i * 4 + 2] = b;
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  if (type === 'png') return c.toBuffer('image/png');
  if (type === 'webp') return c.toBuffer('image/webp', quality);
  return c.toBuffer('image/jpeg', quality);
}

// Per pixel: alpha, gain (white - black; achromatic in every capture so far, so the channel mean),
// and gamma -- the curve through black, grey and white. Printful's compositing is close to affine in
// the artwork but not exactly: deep folds bend mid-tones down (gamma up to ~4).
function shading(W, K, G) {
  const n = W.w * W.h;
  const alpha = new Float32Array(n);
  const gain = new Float32Array(n);
  const gamma = new Float32Array(n).fill(1);
  for (let p = 0; p < n; p++) {
    alpha[p] = W.d[p * 4 + 3] / 255;
    let g = 0;
    let gn = 0;
    for (let c = 0; c < 3; c++) {
      const k = K.d[p * 4 + c];
      g += W.d[p * 4 + c] - k;
      gn += G.d[p * 4 + c] - k;
    }
    g /= 3;
    gain[p] = Math.max(0, g);
    if (g > 12) {
      const ratio = Math.min(0.98, Math.max(0.02, gn / 3 / g));
      gamma[p] = Math.min(GAMMA_MIN + GAMMA_SPAN, Math.max(GAMMA_MIN, Math.log(ratio) / Math.log(128 / 255)));
    }
  }
  return { alpha, gain, gamma };
}

// The photo with BLACK artwork over its own background, from the white PNG (alpha), the black PNG
// and the white JPG (which carries the background): out = base + gain * art^gamma.
function basePixel(W, K, J, alpha) {
  return p => {
    const a = alpha[p];
    const bg = c => (a >= 0.98 ? 255 : Math.min(255, Math.max(0, (J.d[p * 4 + c] - a * W.d[p * 4 + c]) / (1 - a))));
    return [0, 1, 2].map(c => Math.round(a * K.d[p * 4 + c] + (1 - a) * bg(c)));
  };
}

// Measures one full configuration's view: which print file and where, per pixel.
function measureMapping(meta, W, K, I, X1, XF, Y1, YF, sh) {
  const { w, h } = W;
  const n = w * h;
  const P = meta.finePeriods;
  const { alpha, gain, gamma } = sh;
  const art = (img, p, c) => {
    const k = K.d[p * 4 + c];
    const g = W.d[p * 4 + c] - k;
    const x = Math.min(1, Math.max(0, (img.d[p * 4 + c] - k) / g));
    return Math.pow(x, 1 / gamma[p]);
  };
  // Three phases in R, G, B -> phase in [0,1) and modulation (1 = full-contrast sine).
  const phase = (img, p) => {
    const r = art(img, p, 0);
    const g = art(img, p, 1);
    const b = art(img, p, 2);
    const sx = Math.sqrt(3) * (g - b);
    const cx = 2 * r - g - b;
    const t = Math.atan2(sx, cx) / (2 * Math.PI);
    return [t - Math.floor(t), Math.hypot(sx, cx) / 1.5];
  };
  const u = new Float32Array(n).fill(NaN);
  const v = new Float32Array(n).fill(NaN);
  const place = new Int8Array(n).fill(-1);
  let coarseOnly = 0;
  const solve = (coarseImg, fineImg, p) => {
    const [c, cm] = phase(coarseImg, p);
    const [f, fm] = phase(fineImg, p);
    if (cm < 0.35) return NaN;
    const k = Math.round(c * P - f);
    const fine = (k + f) / P;
    // A blurred or folded spot (the fine sine compressed past what the photo can resolve) shows as
    // low modulation or as a fine reading that disagrees with the coarse one; the coarse reading is
    // noisier but cannot jump a whole period, so it wins there.
    if (fm < 0.35 || Math.abs(fine - c) > 0.3 / P) {
      coarseOnly++;
      return c;
    }
    return fine;
  };
  // Accept an ID reading within half the closest pair of colours' distance.
  let minPair = Infinity;
  for (let i = 0; i < meta.idColours.length; i++) {
    for (let j = i + 1; j < meta.idColours.length; j++) {
      const a = meta.idColours[i];
      const b = meta.idColours[j];
      minPair = Math.min(minPair, (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);
    }
  }
  const idLimit = Math.min(0.2, minPair / 4);
  for (let p = 0; p < n; p++) {
    if (alpha[p] < 0.5 || gain[p] < 24) continue;
    let best = -1;
    let bestD = Infinity;
    const rgb = [art(I, p, 0), art(I, p, 1), art(I, p, 2)];
    meta.idColours.forEach((col, i) => {
      const dd = (rgb[0] - col[0]) ** 2 + (rgb[1] - col[1]) ** 2 + (rgb[2] - col[2]) ** 2;
      if (dd < bestD) {
        bestD = dd;
        best = i;
      }
    });
    if (bestD > idLimit) continue;
    const uu = solve(X1, XF, p);
    const vv = solve(Y1, YF, p);
    if (Number.isNaN(uu) || Number.isNaN(vv)) continue;
    place[p] = best;
    u[p] = uu;
    v[p] = vv;
  }
  const decoded = place.reduce((s, x) => s + (x >= 0), 0);

  // SEAMS. A pixel on the line between two print files -- or across a cut inside one, where the
  // coordinate jumps (a collar cut from elsewhere in the front's file, the shorts' two legs) --
  // sees a blend of both sides' patterns, and decodes to a coordinate belonging to neither: a
  // column of wrong colours along every seam. Those pixels are cleared and refilled from inside
  // their own side below.
  // The thresholds are per print file, scaled by how far ITS coordinate moves from one photo pixel
  // to the next (the median over the view): a label drawn 90px wide moves 5% of itself per pixel,
  // a jacket's front panel a tenth of a percent.
  const stepOf = new Map();
  {
    const steps = new Map();
    for (let y = 0; y < h; y++) {
      for (let x = 0; x + 1 < w; x += 2) {
        const p = y * w + x;
        if (place[p] < 0 || place[p + 1] !== place[p]) continue;
        if (!steps.has(place[p])) steps.set(place[p], []);
        steps.get(place[p]).push(Math.max(Math.abs(u[p + 1] - u[p]), Math.abs(v[p + 1] - v[p])));
      }
    }
    for (const [pl, list] of steps) {
      list.sort((a, b) => a - b);
      stepOf.set(pl, list[list.length >> 1]);
    }
  }
  const cutOf = pl => Math.max(CUT_JUMP, 8 * (stepOf.get(pl) || 0));
  const agreeOf = pl => Math.max(AGREE, 3 * (stepOf.get(pl) || 0));
  let seam = 0;
  {
    const clear = new Uint8Array(n);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const p = y * w + x;
        if (place[p] < 0) continue;
        for (let dy = -1; dy <= 1 && !clear[p]; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            const yy = y + dy;
            if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
            const q = yy * w + xx;
            if (place[q] < 0 || q === p) continue;
            const cut = cutOf(place[p]);
            if (place[q] !== place[p] || Math.abs(u[q] - u[p]) > cut || Math.abs(v[q] - v[p]) > cut) {
              clear[p] = 1;
              break;
            }
          }
        }
      }
    }
    for (let p = 0; p < n; p++) {
      if (!clear[p]) continue;
      place[p] = -1;
      seam++;
    }
  }

  // 3x3 median within one placement: removes single-pixel decode speckle without blurring seams.
  const med = (arr, x, y, pl) => {
    const vals = [];
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx;
        const yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        const q = yy * w + xx;
        if (place[q] === pl) vals.push(arr[q]);
      }
    }
    vals.sort((a, b) => a - b);
    return vals[vals.length >> 1];
  };
  const u2 = new Float32Array(u);
  const v2 = new Float32Array(v);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      if (place[p] < 0) continue;
      u2[p] = med(u, x, y, place[p]);
      v2[p] = med(v, x, y, place[p]);
    }
  }
  u.set(u2);
  v.set(v2);

  // A pixel that agrees with fewer than three of its neighbours is noise the median left (a
  // cluster of two or three bad readings); and a patch of a print file smaller than ISLAND pixels
  // is a misreading of the ID pattern (a stray label pixel on the back of a jacket). Both are
  // cleared and refilled from their surroundings.
  let noise = 0;
  {
    const clear = new Uint8Array(n);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const p = y * w + x;
        if (place[p] < 0) continue;
        const tol = agreeOf(place[p]);
        let agree = 0;
        let same = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            const yy = y + dy;
            if ((!dx && !dy) || xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
            const q = yy * w + xx;
            if (place[q] !== place[p]) continue;
            same++;
            if (Math.abs(u[q] - u[p]) < tol && Math.abs(v[q] - v[p]) < tol) agree++;
          }
        }
        if (same >= 3 && agree < 3) clear[p] = 1;
      }
    }
    const seen = new Uint8Array(n);
    const stack = [];
    for (let p0 = 0; p0 < n; p0++) {
      if (place[p0] < 0 || seen[p0]) continue;
      const comp = [];
      seen[p0] = 1;
      stack.push(p0);
      while (stack.length) {
        const p = stack.pop();
        comp.push(p);
        const x = p % w;
        const y = (p - x) / w;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          const q = yy * w + xx;
          if (seen[q] || place[q] !== place[p0]) continue;
          seen[q] = 1;
          stack.push(q);
        }
      }
      if (comp.length < ISLAND) for (const p of comp) clear[p] = 1;
    }
    for (let p = 0; p < n; p++) {
      if (!clear[p]) continue;
      place[p] = -1;
      noise++;
    }
  }

  // Every pixel the artwork visibly reaches but that could not be decoded (deep shadow, a seam's
  // antialiased edge, partial alpha) takes its nearest decoded neighbour, breadth first.
  const affected = p => alpha[p] > 0 && gain[p] * alpha[p] >= 3;
  let frontier = [];
  for (let p = 0; p < n; p++) if (place[p] >= 0) frontier.push(p);
  let filled = 0;
  for (let ring = 0; ring < 40 && frontier.length; ring++) {
    const next = [];
    for (const p of frontier) {
      const x = p % w;
      const y = (p - x) / w;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const xx = x + dx;
        const yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        const q = yy * w + xx;
        if (place[q] >= 0 || !affected(q)) continue;
        place[q] = place[p];
        u[q] = u[p];
        v[q] = v[p];
        next.push(q);
        filled++;
      }
    }
    frontier = next;
  }
  let orphan = 0;
  for (let p = 0; p < n; p++) if (affected(p) && place[p] < 0) orphan++;

  // COVERAGE. A pixel on a seam shows some of each side, and the photo blends them; drawn as one
  // side or the other the seam is a hard, stair-stepped edge where Printful's is smooth. Every
  // pattern says how much of each: the pixel's reading is a mix of what its own side would show
  // and what the side across the seam would show (the sines at each side's coordinate, and the
  // two ID colours), and the mix that fits best is its coverage. `cover` is this pixel's weight
  // of its OWN side, `across` the neighbour whose coordinate stands for the other.
  const cover = new Float32Array(n).fill(1);
  const across = new Int32Array(n).fill(-1);
  const SHIFT = [0, (-2 * Math.PI) / 3, (2 * Math.PI) / 3];
  const patterns = [[X1, 1, 'u'], [XF, P, 'u'], [Y1, 1, 'v'], [YF, P, 'v']];
  let blended = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      const a = place[p];
      if (a < 0 || gain[p] < 24 || alpha[p] < 0.5) continue;
      let q = -1;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
        const xx = x + dx;
        const yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        const r = yy * w + xx;
        if (place[r] < 0) continue;
        const cut = cutOf(a);
        if (place[r] !== a || Math.abs(u[r] - u[p]) > cut || Math.abs(v[r] - v[p]) > cut) {
          q = r;
          break;
        }
      }
      if (q < 0) continue;
      const b = place[q];
      let num = 0;
      let den = 0;
      for (const [img, per, axis] of patterns) {
        const ta = axis === 'u' ? u[p] : v[p];
        const tb = axis === 'u' ? u[q] : v[q];
        for (let c = 0; c < 3; c++) {
          const pa = 0.5 + 0.5 * Math.cos(2 * Math.PI * per * ta + SHIFT[c]);
          const pb = 0.5 + 0.5 * Math.cos(2 * Math.PI * per * tb + SHIFT[c]);
          const o = art(img, p, c);
          num += (o - pb) * (pa - pb);
          den += (pa - pb) ** 2;
        }
      }
      if (a !== b) {
        for (let c = 0; c < 3; c++) {
          const pa = meta.idColours[a][c];
          const pb = meta.idColours[b][c];
          num += (art(I, p, c) - pb) * (pa - pb);
          den += (pa - pb) ** 2;
        }
      }
      // Sides that look alike in every pattern cannot be told apart, and do not need to be.
      if (den < 0.5) continue;
      const k = Math.min(1, Math.max(0, num / den));
      if (k > 0.96) continue;
      cover[p] = k;
      across[p] = q;
      blended++;
    }
  }
  return { place, u, v, cover, across, cutOf, stats: { decoded, coarseOnly, seam, noise, filled, orphan, blended } };
}

function cropOf(place, w, h) {
  let x0 = w;
  let y0 = h;
  let x1 = -1;
  let y1 = -1;
  for (let p = 0; p < place.length; p++) {
    if (place[p] < 0) continue;
    const x = p % w;
    const y = (p - x) / w;
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  return [x0, y0, x1 - x0 + 1, y1 - y0 + 1];
}

// Half-resolution cells: each takes the placement most of its four pixels show and the mean
// coordinate of those pixels, plus the mean gamma of all four.
function halfGrid(crop, w, place, u, v, gamma, cutOf = null) {
  const [x0, y0, bw, bh] = crop;
  const hw = Math.ceil(bw / 2);
  const hh = Math.ceil(bh / 2);
  const cells = new Array(hw * hh);
  for (let j = 0; j < hh; j++) {
    for (let i = 0; i < hw; i++) {
      const counts = new Map();
      let g = 0;
      let gn = 0;
      for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
        const x = 2 * i + dx;
        const y = 2 * j + dy;
        if (x >= bw || y >= bh) continue;
        const p = (y0 + y) * w + x0 + x;
        g += gamma[p];
        gn++;
        if (!place || place[p] < 0) continue;
        // Grouped by print file AND side of any cut inside it: averaging across a cut gives a
        // coordinate on neither side.
        const half = cutOf ? cutOf(place[p]) / 2 : Infinity;
        let c = null;
        for (const [key, g] of counts) {
          if (g.pl === place[p] && Math.abs(g.u0 - u[p]) < half && Math.abs(g.v0 - v[p]) < half) {
            c = g;
            break;
          }
        }
        if (!c) {
          c = { pl: place[p], u0: u[p], v0: v[p], n: 0, u: 0, v: 0 };
          counts.set(counts.size, c);
        }
        c.n++;
        c.u += u[p];
        c.v += v[p];
      }
      let best = null;
      for (const c of counts.values()) if (!best || c.n > best.c.n) best = { pl: c.pl, c };
      cells[j * hw + i] = best
        ? { pl: best.pl, u: best.c.u / best.c.n, v: best.c.v / best.c.n, gamma: g / gn }
        : { pl: -1, u: 0, v: 0, gamma: g / gn };
    }
  }
  return { hw, hh, cells };
}

function writer(files, viewId) {
  return (name, ext, buffer) => {
    const hash = createHash('sha256').update(buffer).digest('hex').slice(0, 10);
    files[name] = `${viewId}-${name}-${hash}.${ext}`;
    fs.writeFileSync(path.join(PUBLIC_DIR, files[name]), buffer);
  };
}

// The render size each print file needs in this view: the long edge at which one print-file pixel
// covers no more than one photo pixel over 90% of what the view shows of it (close-ups enlarge a
// print file several times; at the app's usual 1000px they came out soft and blocky). Only the
// sizes above 1000 are recorded, capped at NEED_CAP; labels are always drawn at full size.
const NEED_CAP = 2500;
function needOf(half, placements, cutOf) {
  const { hw, hh, cells } = half;
  const rhos = placements.map(() => []);
  for (let j = 0; j + 1 < hh; j++) {
    for (let i = 0; i + 1 < hw; i++) {
      const c = cells[j * hw + i];
      if (c.pl < 0 || isLabel(placements[c.pl].key)) continue;
      const r = cells[j * hw + i + 1];
      const d = cells[(j + 1) * hw + i];
      if (r.pl !== c.pl || d.pl !== c.pl) continue;
      const cut = cutOf(c.pl);
      if (Math.abs(r.u - c.u) > cut || Math.abs(r.v - c.v) > cut || Math.abs(d.u - c.u) > cut || Math.abs(d.v - c.v) > cut) continue;
      // Print-file pixels per photo pixel at a 1000px long edge (cells are two photo pixels apart).
      const p = placements[c.pl];
      const s = 1000 / Math.max(p.width, p.height);
      const sw = p.width * s;
      const sh = p.height * s;
      const fx = Math.hypot((r.u - c.u) * sw, (r.v - c.v) * sh) / 2;
      const fy = Math.hypot((d.u - c.u) * sw, (d.v - c.v) * sh) / 2;
      rhos[c.pl].push(Math.max(fx, fy));
    }
  }
  const need = {};
  rhos.forEach((list, pl) => {
    if (list.length < 50) return;
    list.sort((a, b) => a - b);
    const rho = list[Math.floor(list.length * 0.1)];
    const p = placements[pl];
    const edge = Math.min(NEED_CAP, Math.max(p.width, p.height), Math.ceil(1000 / Math.max(rho, 0.05) / 100) * 100);
    if (edge > 1000) need[pl] = edge;
  });
  return need;
}

// The EDGE map, full resolution over the crop, for the pixels the half-resolution coordinate grid
// cannot describe on its own (zero everywhere else):
//   B: bit 4 set = only the cells in bits 0-3 are on this pixel's side (of the four cells the
//      compositor reads around it, a cell on the far side of a cut inside the same print file
//      would otherwise be taken as the nearest -- which put every such seam on a 2px staircase)
//   R: low 4 bits = the print file across a seam + 1, high 4 bits = the cells on THAT side
//   G: this pixel's weight of its own side (0-255) when it blends with the side across
function edgeMap(crop, w, place, m, half) {
  const [x0, y0, bw, bh] = crop;
  const { hw, hh, cells } = half;
  let used = 0;
  let sided = 0;
  const out = new Uint8Array(bw * bh * 3);
  const cellAt = (i, j) => cells[j * hw + i];
  for (let y = 0; y < bh; y++) {
    let hfy = (y + 0.5) / 2 - 0.5;
    if (hfy < 0) hfy = 0;
    else if (hfy > hh - 1) hfy = hh - 1;
    const hy0 = hfy | 0;
    const hy1 = hy0 + 1 < hh ? hy0 + 1 : hy0;
    for (let x = 0; x < bw; x++) {
      const p = (y0 + y) * w + x0 + x;
      const a = place[p];
      if (a < 0) continue;
      let hfx = (x + 0.5) / 2 - 0.5;
      if (hfx < 0) hfx = 0;
      else if (hfx > hw - 1) hfx = hw - 1;
      const hx0 = hfx | 0;
      const hx1 = hx0 + 1 < hw ? hx0 + 1 : hx0;
      const four = [cellAt(hx0, hy0), cellAt(hx1, hy0), cellAt(hx0, hy1), cellAt(hx1, hy1)];
      const sideMask = (pl, uu, vv) => {
        const tol = m.cutOf(pl) / 2;
        let mask = 0;
        four.forEach((c, k) => {
          if (c.pl === pl && Math.abs(c.u - uu) < tol && Math.abs(c.v - vv) < tol) mask |= 1 << k;
        });
        return mask;
      };
      const own = sideMask(a, m.u[p], m.v[p]);
      // Only where a cell of the same print file is on the other side of a cut.
      const sameFile = four.reduce((mk, c, k) => mk | (c.pl === a ? 1 << k : 0), 0);
      let r = 0;
      let g = 0;
      let b = 0;
      if (own && own !== sameFile) {
        b = 16 | own;
        sided++;
      }
      const q = m.across[p];
      if (q >= 0) {
        const other = sideMask(place[q], m.u[q], m.v[q]);
        if (other && own) {
          r = (place[q] + 1) | (other << 4);
          g = Math.round(m.cover[p] * 255);
          b = 16 | own;
        }
      }
      if (r || b) {
        const o = (y * bw + x) * 3;
        out[o] = r;
        out[o + 1] = g;
        out[o + 2] = b;
        used++;
      }
    }
  }
  return { used, sided, png: encode(bw, bh, i => [out[i * 3], out[i * 3 + 1], out[i * 3 + 2]], 'png') };
}

// The label-free capture's photo of view `id`. Printful usually keeps a photo's id when the labels
// are left off, but not always: on the track jacket, the crossbody and the joggers the on-model and
// close-up shots come back as a DIFFERENT template (57252 -> 57253) of the same camera. So a
// missing id is matched by silhouette instead (the product's alpha, which the label does not move).
async function underPhotoFor(meta, dir, id, W) {
  const photos = meta.underTasks?.['id.png']?.photos;
  if (!photos || !UNDER_TASKS.every(t => meta.underTasks?.[`${t.pattern}.${t.format}`])) return null;
  const complete = pid => UNDER_TASKS.every(t => meta.underTasks[`${t.pattern}.${t.format}`].photos?.[pid]);
  if (photos[id]) return complete(id) ? id : null;
  const main = new Set(Object.keys(meta.tasks['white.png'].photos));
  let best = null;
  for (const cand of Object.keys(photos)) {
    if (main.has(cand) || !complete(cand)) continue;
    const U = await pixels(path.join(dir, 'under', 'id.png', `${cand}.png`));
    if (U.w !== W.w || U.h !== W.h) continue;
    let inter = 0;
    let union = 0;
    for (let p = 0; p < W.w * W.h; p++) {
      const a = W.d[p * 4 + 3] > 127;
      const b = U.d[p * 4 + 3] > 127;
      if (a && b) inter++;
      if (a || b) union++;
    }
    const iou = union ? inter / union : 0;
    if (!best || iou > best.iou) best = { cand, iou };
  }
  return best && best.iou > 0.97 ? best.cand : null;
}

// What lies under each label pixel, from PRODUCT_MOCKUP_CONFIG's label region (where the label
// sits on the sheet beneath it, as fractions of that sheet): the label's own coordinate mapped
// into that rectangle. Null when the product states no region.
function synthUnder(meta, place, u, v, n) {
  const cfg = PRODUCT_MOCKUP_CONFIG[productId] || {};
  const keys = meta.placements.map(p => p.key);
  const front = keys.findIndex(k => ['front', 'default', 'outside_front'].includes(k));
  const inside = cfg.secondaryDesign?.placements?.length ? keys.indexOf(cfg.secondaryDesign.placements[0]) : -1;
  const rules = new Map();
  if (cfg.labelOutsideRegion && front >= 0 && keys.includes('label_outside')) rules.set(keys.indexOf('label_outside'), [front, cfg.labelOutsideRegion]);
  if (cfg.labelInsideRegion && inside >= 0 && keys.includes('label_inside')) rules.set(keys.indexOf('label_inside'), [inside, cfg.labelInsideRegion]);
  if (!rules.size) return null;
  const up = new Int8Array(n).fill(-1);
  const uu = new Float32Array(n);
  const vv = new Float32Array(n);
  let covered = 0;
  for (let q = 0; q < n; q++) {
    const rule = rules.get(place[q]);
    if (!rule) continue;
    const [target, r] = rule;
    up[q] = target;
    uu[q] = r.x + u[q] * r.w;
    vv[q] = r.y + v[q] * r.h;
    covered++;
  }
  return covered ? { place: up, u: uu, v: vv, covered } : null;
}

async function decode() {
  const configs = fs
    .readdirSync(PRODUCT_DIR)
    .filter(d => fs.existsSync(path.join(PRODUCT_DIR, d, 'capture.json')))
    .map(d => JSON.parse(fs.readFileSync(path.join(PRODUCT_DIR, d, 'capture.json'), 'utf8')))
    // Full configurations first: a shading-only one reuses another's mapping.
    .sort((a, b) => Number(!!a.shadingFrom) - Number(!!b.shadingFrom));
  if (!configs.length) throw new Error(`nothing captured for ${productId}`);
  fs.rmSync(PUBLIC_DIR, { recursive: true, force: true });
  fs.mkdirSync(PUBLIC_DIR, { recursive: true });
  const manifest = { productId, configs: {} };
  const mappings = {}; // configId -> viewId -> { place, crop, half, shown, files }
  const report = [];
  for (const meta of configs) {
    const dir = path.join(PRODUCT_DIR, meta.configId);
    const expected = meta.shadingFrom ? SHADING_TASKS : FULL_TASKS;
    if (expected.some(t => !meta.tasks[`${t.pattern}.${t.format}`])) {
      console.log(`${meta.configId}: capture incomplete, skipped`);
      continue;
    }
    const from = meta.shadingFrom ? mappings[meta.shadingFrom] : null;
    if (meta.shadingFrom && !from) {
      console.log(`${meta.configId}: ${meta.shadingFrom} not decoded, skipped`);
      continue;
    }
    const entry = {
      variantId: meta.variantId,
      variants: meta.variants,
      stitch: meta.stitch,
      default: !!meta.default,
      placements: meta.placements,
      views: {}
    };
    mappings[meta.configId] = {};
    for (const id of Object.keys(meta.tasks['white.png'].photos)) {
      if (from && !from[id]) continue;
      const load = name => pixels(path.join(dir, name, `${id}.${name.endsWith('jpg') ? 'jpg' : 'png'}`));
      const [W, K, G, J] = await Promise.all(['white.png', 'black.png', 'grey.png', 'white.jpg'].map(load));
      const { w, h } = W;
      const sh = shading(W, K, G);
      const files = {};
      const write = writer(files, `${meta.configId}-${id}`);
      let place;
      let crop;
      let half;
      let shown;
      let stats = {};
      let need = {};
      if (from) {
        // The other configuration's mapping, this one's shading.
        ({ place, crop, shown, need } = from[id]);
        const h2 = halfGrid(crop, w, null, null, null, sh.gamma);
        half = h2;
        for (const k of ['place', 'uv', 'uvplace', 'underplace', 'underuv', 'edge']) if (from[id].files[k]) files[k] = from[id].files[k];
      } else {
        const P = meta.finePeriods;
        const [I, X1, XF, Y1, YF] = await Promise.all(['id.png', 'x1.png', `x${P}.png`, 'y1.png', `y${P}.png`].map(load));
        const m = measureMapping(meta, W, K, I, X1, XF, Y1, YF, sh);
        place = m.place;
        stats = m.stats;
        // What lies under the labels, where that was measured (see --underlay).
        const labelIdx = new Set(meta.placements.map((pl, i) => (isLabel(pl.key) ? i : -1)).filter(i => i >= 0));
        const underId = labelIdx.size ? await underPhotoFor(meta, dir, id, W) : null;
        let under = null;
        const n = w * h;
        // The label's pixels, and LABEL_RING pixels around them.
        const nearLabel = new Uint8Array(n);
        if (labelIdx.size) {
          for (let p = 0; p < n; p++) {
            if (!labelIdx.has(place[p])) continue;
            const x = p % w;
            const y = (p - x) / w;
            for (let dy = -LABEL_RING; dy <= LABEL_RING; dy++) {
              for (let dx = -LABEL_RING; dx <= LABEL_RING; dx++) {
                const xx = x + dx;
                const yy = y + dy;
                if (xx >= 0 && yy >= 0 && xx < w && yy < h) nearLabel[yy * w + xx] = 1;
              }
            }
          }
        }
        if (underId) {
          const loadUnder = name => pixels(path.join(dir, 'under', name, `${underId}.png`));
          const [Iu, X1u, XFu, Y1u, YFu] = await Promise.all(['id.png', 'x1.png', `x${P}.png`, 'y1.png', `y${P}.png`].map(loadUnder));
          const mu = measureMapping(meta, W, K, Iu, X1u, XFu, Y1u, YFu, sh);
          const up = new Int8Array(n).fill(-1);
          let covered = 0;
          for (let q = 0; q < n; q++) {
            if (!nearLabel[q] || mu.place[q] < 0 || labelIdx.has(mu.place[q])) continue;
            // Under the label and in a ring around it, so a cell on the label's edge always has
            // a measured neighbour to read from.
            up[q] = mu.place[q];
            covered++;
            // Beside the label, the label-free capture is also the cleaner reading of the print
            // itself: the main one there is the label's edge blurred into the fabric's pattern
            // (a phantom outline of the label's square).
            if (!labelIdx.has(place[q]) && (place[q] < 0 || place[q] === mu.place[q])) {
              place[q] = mu.place[q];
              m.u[q] = mu.u[q];
              m.v[q] = mu.v[q];
            }
          }
          if (covered) under = { place: up, u: mu.u, v: mu.v };
          stats.under = covered;
          // How well the label's measured placement matches the product config's label region
          // (what the fallback below would use): mean distance in print-file pixels.
          const check = synthUnder(meta, place, m.u, m.v, n);
          if (check) {
            let d = 0;
            let c = 0;
            for (let q = 0; q < n; q++) {
              if (check.place[q] < 0 || up[q] !== check.place[q]) continue;
              const pf = meta.placements[up[q]];
              d += Math.hypot((check.u[q] - mu.u[q]) * pf.width, (check.v[q] - mu.v[q]) * pf.height);
              c++;
            }
            if (c) stats.regionErr = Math.round(d / c);
          }
        } else if (labelIdx.size) {
          // No label-free photo of this view (Printful only shoots it WITH the label): what lies
          // under the label from where the product config says the label sits on its sheet.
          under = synthUnder(meta, place, m.u, m.v, n);
          if (under) stats.under = `region ${under.covered}`;
        }
        crop = cropOf(place, w, h);
        half = halfGrid(crop, w, place, m.u, m.v, sh.gamma, m.cutOf);
        shown = [...new Set(Array.from(place).filter(x => x >= 0))].sort((a, b) => a - b);
        const [, , bw, bh] = crop;
        const at = i => (crop[1] + Math.floor(i / bw)) * w + crop[0] + (i % bw);
        write('place', 'png', encode(bw, bh, i => {
          const pl = place[at(i)] + 1;
          return [pl, pl, pl];
        }, 'png'));
        write('uvplace', 'png', encode(half.hw, half.hh, i => {
          const pl = half.cells[i].pl + 1;
          return [pl, pl, pl];
        }, 'png'));
        const packUV = cells => i => {
          const c = cells[i];
          if (c.pl < 0) return [0, 0, 0];
          const uq = Math.min(UV_LEVELS - 1, Math.max(0, Math.round(c.u * (UV_LEVELS - 1))));
          const vq = Math.min(UV_LEVELS - 1, Math.max(0, Math.round(c.v * (UV_LEVELS - 1))));
          return [uq >> 4, vq >> 4, ((uq & 15) << 4) | (vq & 15)];
        };
        write('uv', 'png', encode(half.hw, half.hh, packUV(half.cells), 'png'));
        need = needOf(half, meta.placements, m.cutOf);
        const edge = edgeMap(crop, w, place, m, half);
        stats.sided = edge.sided;
        if (edge.used) write('edge', 'png', edge.png);
        if (under) {
          const uh = halfGrid(crop, w, under.place, under.u, under.v, sh.gamma, m.cutOf);
          write('underplace', 'png', encode(uh.hw, uh.hh, i => {
            const pl = uh.cells[i].pl + 1;
            return [pl, pl, pl];
          }, 'png'));
          write('underuv', 'png', encode(uh.hw, uh.hh, packUV(uh.cells), 'png'));
        }
      }
      const [, , bw, bh] = crop;
      const at = i => (crop[1] + Math.floor(i / bw)) * w + crop[0] + (i % bw);
      // Photos (base, gain) as lossy WebP, about half the bytes of JPEG at the same quality; gamma
      // and coordinates at half resolution (smooth fields, and the coordinates were most of a
      // view's weight). The fabric map stays full resolution: it is the edge of the print.
      write('base', 'webp', encode(w, h, basePixel(W, K, J, sh.alpha), 'webp', 90));
      write('gain', 'webp', encode(bw, bh, i => {
        const p = at(i);
        const g = place[p] >= 0 ? Math.round(sh.gain[p] * sh.alpha[p]) : 0;
        return [g, g, g];
      }, 'webp', 92));
      write('gamma', 'webp', encode(half.hw, half.hh, i => {
        const g = Math.round(((half.cells[i].gamma - GAMMA_MIN) / GAMMA_SPAN) * 255);
        return [g, g, g];
      }, 'webp', 92));
      const group = MOCKUP_STYLE_GROUPS[String(productId)]?.[id] ?? null;
      const name = MOCKUP_STYLE_VIEWS[String(productId)]?.[id] ?? meta.tasks['white.png'].photos[id];
      entry.views[id] = { name, group, width: w, height: h, crop, half: [half.hw, half.hh], shown, files };
      if (Object.keys(need).length) entry.views[id].need = need;
      mappings[meta.configId][id] = { place, crop, shown, files, need };
      const kB = Math.round(Object.values(files).reduce((s, f) => s + fs.statSync(path.join(PUBLIC_DIR, f)).size, 0) / 1024);
      report.push({ config: meta.configId, id, group, name, ...stats, need: Object.values(need).join(' '), crop: `${bw}x${bh}`, kB });
    }
    manifest.configs[meta.configId] = entry;
  }
  fs.writeFileSync(path.join(PUBLIC_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.table(report);

  // The index the app reads to know which products have instant mockups, which configuration
  // covers which variant and stitch colour, and which view each surface shows. Merged, so
  // calibrating one product never drops another.
  if (OUT_ROOT) return;
  const indexPath = path.join(ROOT, 'src', 'lib', 'instantMockupIndex.js');
  let index = {};
  if (fs.existsSync(indexPath)) {
    const m = fs.readFileSync(indexPath, 'utf8').match(/INSTANT_MOCKUPS = (\{[\s\S]*\});/);
    if (m) index = JSON.parse(m[1]);
  }
  const modelGroup = MODEL_GROUPS_BY_PRODUCT[String(productId)];
  const cardOverride = CARD_VIEW_OVERRIDES[String(productId)];
  index[String(productId)] = {
    configs: Object.entries(manifest.configs).map(([configId, c]) => {
      const entries = Object.entries(c.views);
      const front = group => entries.find(([, v]) => v.group === group && v.name === 'Front')?.[0];
      const flat = entries.find(([, v]) => v.group === 'Flat' || v.group === 'Default')?.[0];
      return {
        id: configId,
        default: c.default,
        variants: c.variants,
        stitch: c.stitch,
        placements: c.placements.map(p => p.key),
        // The shop card: the on-model front where there is one (the stock photo it replaces is
        // usually that same model), else the first flat front.
        card:
          (cardOverride && entries.find(([, v]) => v.group === cardOverride.group && v.name === cardOverride.name)?.[0]) ||
          (modelGroup && front(modelGroup)) ||
          front('Flat') ||
          front('Default') ||
          flat ||
          entries[0][0],
        // Every calibrated view, for the product page's filmstrip (ordered at runtime by
        // printfulViewPolicy, the same rule Printful's photos were ordered by).
        views: entries.map(([id, v]) => ({ id, name: v.name, group: v.group }))
      };
    })
  };
  fs.writeFileSync(
    indexPath,
    '// GENERATED by scripts/calibrate-instant-mockup.mjs (decode) -- do not edit by hand.\n' +
      '// Products with an instant mockup (public/instant-mockups/<id>/): each configuration (a variant\n' +
      '// and stitch colour with its own photos), the variants it covers, and the view each surface shows.\n' +
      `export const INSTANT_MOCKUPS = ${JSON.stringify(index, null, 2)};\n`
  );
}

// The non-circular check: a REAL Printful mockup of a saved design's print files, against the
// instant photo composed from those same files.
async function verify() {
  const manifest = JSON.parse(fs.readFileSync(path.join(PUBLIC_DIR, 'manifest.json'), 'utf8'));
  const configId = arg('config') || Object.entries(manifest.configs).find(([, c]) => c.default)?.[0];
  const config = manifest.configs[configId];
  const captured = JSON.parse(fs.readFileSync(path.join(PRODUCT_DIR, configId, 'capture.json'), 'utf8'));
  const designId = arg('design') || VERIFY_DESIGN;
  const rows = await (await fetch(`${SUPABASE_URL}/rest/v1/designs?select=data&id=eq.${designId}`, { headers: { apikey: ANON_KEY } })).json();
  const design = rows[0].data;
  const { renderDesign } = await import('../render-service/render.js');
  // One plain render per print file, at the size a mockup would get it (the long edge capped).
  const rendered = new Map();
  const files = [];
  const sourceOf = {};
  for (const p of config.placements) {
    if (!rendered.has(p.printfileId)) {
      const s = Math.min(1, 1500 / Math.max(p.width, p.height));
      const w = Math.max(1, Math.round(p.width * s));
      const h = Math.max(1, Math.round(p.height * s));
      const png = await renderDesign({ seed: design.seed, colors: design.colors || [], settings: design.settings || null, width: w, height: h });
      rendered.set(p.printfileId, { png, url: await upload(png, `verify-${p.printfileId}-${w}x${h}`) });
    }
    files.push({ placement: p.key, image_url: rendered.get(p.printfileId).url, position: position(p) });
    sourceOf[p.key] = rendered.get(p.printfileId).png;
  }
  const out = path.join(PRODUCT_DIR, configId, 'verify');
  process.stdout.write('real mockup: generating');
  const task = await runTask(
    { variantId: config.variantId, format: 'jpg', files, groups: captured.groups, options: captured.options },
    out
  );
  const decoded = new Map();
  const sources = await Promise.all(
    config.placements.map(async p => {
      if (!decoded.has(p.printfileId)) {
        const img = await loadImage(sourceOf[p.key]);
        const c = createCanvas(img.width, img.height);
        c.getContext('2d').drawImage(img, 0, 0);
        decoded.set(p.printfileId, { width: img.width, height: img.height, data: c.getContext('2d').getImageData(0, 0, img.width, img.height).data });
      }
      return decoded.get(p.printfileId);
    })
  );
  const asData = async file => {
    const img = await loadImage(fs.readFileSync(file));
    const c = createCanvas(img.width, img.height);
    c.getContext('2d').drawImage(img, 0, 0);
    return { width: img.width, height: img.height, data: c.getContext('2d').getImageData(0, 0, img.width, img.height).data };
  };
  const report = [];
  for (const [viewId, meta] of Object.entries(config.views)) {
    const realFile = path.join(out, `${viewId}.jpg`);
    if (!fs.existsSync(realFile)) continue;
    const view = { ...meta };
    for (const k of ['base', 'gain', 'gamma', 'place', 'uv', 'uvplace', 'underplace', 'underuv', 'edge']) {
      if (meta.files[k]) view[k] = await asData(path.join(PUBLIC_DIR, meta.files[k]));
    }
    const mine = composeInstantMockup(view, sources);
    const real = await asData(realFile);
    let sum = 0;
    let count = 0;
    const sample = [];
    const [cx, cy, cw, ch] = view.crop;
    for (let y = 0; y < ch; y++) {
      for (let x = 0; x < cw; x++) {
        if (!view.place.data[(y * cw + x) * 4]) continue;
        const o = ((cy + y) * view.width + cx + x) * 4;
        for (let c = 0; c < 3; c++) {
          const e = Math.abs(mine[o + c] - real.data[o + c]);
          sum += e;
          count++;
          if (count % 7 === 0) sample.push(e);
        }
      }
    }
    sample.sort((a, b) => a - b);
    const side = createCanvas(view.width * 2, view.height);
    const sctx = side.getContext('2d');
    const a = sctx.createImageData(view.width, view.height);
    a.data.set(mine);
    sctx.putImageData(a, 0, 0);
    const b = sctx.createImageData(view.width, view.height);
    b.data.set(real.data);
    sctx.putImageData(b, view.width, 0);
    fs.writeFileSync(path.join(out, `${viewId}-instant-vs-real.jpg`), side.toBuffer('image/jpeg', 85));
    report.push({ view: `${meta.group} ${meta.name}`, id: viewId, mean: count ? (sum / count).toFixed(2) : '-', p95: sample[Math.floor(sample.length * 0.95)] ?? '-' });
  }
  console.log(`task ${task.taskKey}, design ${designId}, config ${configId}`);
  console.table(report);
}

if (mode === 'capture') await capture();
else if (mode === 'decode') await decode();
else await verify();
