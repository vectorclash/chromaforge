// Finds where a product's `label_outside` lands on its FRONT sheet, so the mark can sample the
// artwork underneath and choose light or dark ink (see src/render/labelBackdrop.js). The result is
// a `labelOutsideRegion` for PRODUCT_MOCKUP_CONFIG.
//
//   PRINTFUL_API_KEY=... SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
//     node scripts/calibrate-label-outside.mjs --product 693
//   ... --product 693 --predict 0.749,0.749       # round two, refine
//
// RUN THIS FOR ANY NEW PRODUCT THAT HAS A `label_outside` PLACEMENT. Without a region the mark
// keeps its dark ink unconditionally, which is wrong on most artwork -- measured across the five
// calibrated products, every one wanted light ink on a typical vivid design (luminance 0.08-0.27).
// Products with only `label_inside` need nothing: a sewn tag has no camera angle, it paints its own
// dark panel, and it is legible by construction.
//
// WHY IT TAKES TWO ROUNDS AND A HUMAN EYE. Round one prints a lettered grid on the front and a
// marker on the label, and you read off which cell the marker lands in. Round two draws hollow 1x
// and 2x boxes at your prediction, and you measure the label against them. Both rounds need a
// person to look at a photo; that is not laziness, it is the only non-circular instrument available.
// Printful places the label from its own manufacturing geometry, so a preview built from our own
// numbers cannot test them -- the same circularity that wasted a round on the hoodie pocket.
//
// AUTOMATING THE GRID READ WAS TRIED AND THROWN AWAY (2026-08-29). Classifying mockup pixels back
// to their source cell by colour fails: with a couple of hundred cells the hue formula repeats, so
// pixels land in the wrong cells and a least-squares fit came back with residuals of 4-6 CELLS --
// worse than reading the printed labels by eye. If you want to automate it, the grid needs
// machine-identifiable cells (a per-cell binary dot code, say), not a better classifier.
//
// THE SIZE MUST BE MEASURED, NOT DERIVED, and this is the trap. The obvious `labelPx / frontPx`
// ratio is right on the shorts and the crossbody and 1.21x out on the track jacket, because the
// front file is cover-fitted to its print area and so is not at 1:1 scale with it. On the bucket hat
// the height is ~1.8x out again, since the crown's curvature maps the sheet non-linearly. That is
// what round two's 2x box is for: the label can never fully occlude it, so both the offset and the
// scale are readable from one photo.
import { createRequire } from 'node:module';

// @napi-rs/canvas is a render-service dependency, not a root one -- every other script in here is
// pure data and draws nothing. Resolved through render-service's own node_modules rather than added
// to the root package.json for one occasional tool.
let createCanvas;
try {
  ({ createCanvas } = createRequire(import.meta.url)('../render-service/node_modules/@napi-rs/canvas'));
} catch {
  console.error('Could not load @napi-rs/canvas. Run `npm install` inside render-service/ first.');
  process.exit(1);
}

const KEY = process.env.PRINTFUL_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!KEY || !SUPABASE_URL || !SERVICE_KEY) {
  console.error('PRINTFUL_API_KEY, SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
  process.exit(1);
}
const args = process.argv.slice(2);
const arg = name => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? null : args[i + 1];
};
const productId = Number(arg('product'));
if (!productId) {
  console.error('--product <id> is required');
  process.exit(1);
}
const predict = arg('predict')?.split(',').map(Number);
const COLS = Number(arg('cols') || 18);
const ROWS = Number(arg('rows') || 14);

const H = { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function printful(path, init) {
  for (let i = 0; i < 6; i++) {
    const res = await fetch(`https://api.printful.com${path}`, { ...init, headers: H });
    const body = await res.json();
    if (body?.result && typeof body.result === 'object') return body.result;
    // A drained rate-limit bucket returns `result` as a STRING, which reads as a 404 if you only
    // check res.ok -- retry rather than dying on it.
    console.log(`  waiting on Printful (${JSON.stringify(body).slice(0, 70)})`);
    await sleep(10000);
  }
  throw new Error(`Printful read failed: ${path}`);
}

async function upload(buffer, name) {
  const path = `label-calibration/${productId}-${name}-${Date.now()}.png`;
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/design-mockups/${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'image/png', 'x-upsert': 'true' },
    body: buffer
  });
  if (!res.ok) throw new Error(`upload failed: ${res.status} ${await res.text()}`);
  return `${SUPABASE_URL}/storage/v1/object/public/design-mockups/${path}`;
}

// Round one: a lettered grid, read the cell the marker lands in.
function gridSheet(w, h) {
  const c = createCanvas(w, h);
  const x = c.getContext('2d');
  const cw = w / COLS;
  const ch = h / ROWS;
  for (let i = 0; i < COLS; i++) {
    for (let j = 0; j < ROWS; j++) {
      x.fillStyle = `hsl(${(i * 37 + j * 11) % 360},70%,${(i + j) % 2 ? 62 : 86}%)`;
      x.fillRect(i * cw, j * ch, cw, ch);
      x.fillStyle = '#000';
      x.font = `bold ${Math.round(Math.min(cw, ch) * 0.34)}px sans-serif`;
      x.textAlign = 'center';
      x.textBaseline = 'middle';
      x.fillText(`${String.fromCharCode(65 + i)}${j + 1}`, i * cw + cw / 2, j * ch + ch / 2);
      x.strokeStyle = '#0008';
      x.lineWidth = 2;
      x.strokeRect(i * cw, j * ch, cw, ch);
    }
  }
  return c.toBuffer('image/png');
}

// Round two: hollow boxes at the prediction, so the label cannot hide the reference.
function targetSheet(w, h, region) {
  const c = createCanvas(w, h);
  const x = c.getContext('2d');
  x.fillStyle = '#1b1b22';
  x.fillRect(0, 0, w, h);
  const cx = region.x + region.w / 2;
  const cy = region.y + region.h / 2;
  x.lineWidth = 5;
  x.strokeStyle = '#ff00aa';
  x.strokeRect(region.x * w, region.y * h, region.w * w, region.h * h);
  x.strokeStyle = '#ffd400';
  x.strokeRect((cx - region.w) * w, (cy - region.h) * h, region.w * 2 * w, region.h * 2 * h);
  x.strokeStyle = '#00ffcc';
  x.lineWidth = 6;
  x.beginPath();
  x.moveTo(0, cy * h);
  x.lineTo(w, cy * h);
  x.moveTo(cx * w, 0);
  x.lineTo(cx * w, h);
  x.stroke();
  return c.toBuffer('image/png');
}

function markerFile(w, h, hollow) {
  const c = createCanvas(w, h);
  const x = c.getContext('2d');
  if (hollow) {
    // Round two: an outline, so the boxes underneath stay readable through it.
    x.strokeStyle = '#ffffff';
    x.lineWidth = Math.round(w * 0.1);
    x.strokeRect(x.lineWidth / 2, x.lineWidth / 2, w - x.lineWidth, h - x.lineWidth);
    x.lineWidth = Math.round(w * 0.05);
    x.beginPath();
    x.moveTo(0, 0);
    x.lineTo(w, h);
    x.moveTo(w, 0);
    x.lineTo(0, h);
    x.stroke();
  } else {
    x.fillStyle = '#000';
    x.fillRect(0, 0, w, h);
    x.fillStyle = '#00ff88';
    x.fillRect(w * 0.08, h * 0.08, w * 0.84, h * 0.84);
    x.strokeStyle = '#ff0000';
    x.lineWidth = w * 0.06;
    x.beginPath();
    x.moveTo(0, 0);
    x.lineTo(w, h);
    x.moveTo(w, 0);
    x.lineTo(0, h);
    x.stroke();
  }
  return c.toBuffer('image/png');
}

const specs = await printful(`/mockup-generator/printfiles/${productId}`);
const variant = specs.variant_printfiles[0];
const dims = Object.fromEntries(specs.printfiles.map(p => [p.printfile_id, p]));
if (!variant.placements.label_outside) {
  console.log(`Product ${productId} has no label_outside placement — nothing to calibrate.`);
  process.exit(0);
}
// The bucket hat calls its front `outside_front`; everything else uses `front`.
const frontKey = variant.placements.front ? 'front' : 'outside_front';
const front = dims[variant.placements[frontKey]];
const label = dims[variant.placements.label_outside];
const naive = { w: label.width / front.width, h: label.height / front.height };
console.log(`product ${productId}: front ${front.width}x${front.height} (${frontKey}), label ${label.width}x${label.height}`);
console.log(`naive size fractions: ${naive.w.toFixed(4)} x ${naive.h.toFixed(4)}  (a STARTING POINT — verify in round two)`);

const region = predict ? { x: predict[0], y: predict[1], w: naive.w, h: naive.h } : null;
const sheetW = Math.min(4000, front.width);
const sheetH = Math.round((sheetW * front.height) / front.width);
const sheet = region ? targetSheet(sheetW, sheetH, region) : gridSheet(sheetW, sheetH);
const frontUrl = await upload(sheet, region ? 'target' : 'grid');
const labelUrl = await upload(markerFile(label.width, label.height, !!region), 'marker');

const position = p => ({ area_width: p.width, area_height: p.height, width: p.width, height: p.height, top: 0, left: 0 });
// The grid goes on EVERY non-label placement: submitting only the front leaves the other panels
// blank white, and the task can come back showing one of those instead.
const files = Object.keys(variant.placements)
  .filter(k => !k.startsWith('label_'))
  .map(k => ({ placement: k, image_url: frontUrl, position: position(dims[variant.placements[k]]) }));
files.push({ placement: 'label_outside', image_url: labelUrl, position: position(label) });

const task = await printful(`/mockup-generator/create-task/${productId}`, {
  method: 'POST',
  body: JSON.stringify({ variant_ids: [variant.variant_id], format: 'jpg', files, option_groups: ['Flat'] })
});
process.stdout.write('generating');
let result = null;
for (let i = 0; i < 60 && !result; i++) {
  await sleep(4000);
  process.stdout.write('.');
  const polled = await printful(`/mockup-generator/task?task_key=${task.task_key}`);
  if (polled.status !== 'pending') result = polled;
}
console.log('');
if (result?.status !== 'completed') throw new Error(`task ${result?.status}: ${JSON.stringify(result?.error)}`);

const seen = new Set();
for (const m of result.mockups ?? []) {
  for (const entry of [{ t: m.placement, u: m.mockup_url }, ...(m.extra ?? []).map(e => ({ t: e.title, u: e.url }))]) {
    if (entry.u && !seen.has(entry.u)) {
      seen.add(entry.u);
      console.log(`  ${String(entry.t).padEnd(24)} ${entry.u}`);
    }
  }
}

console.log(
  region
    ? `
ROUND TWO — open the photo showing the label and measure, in image pixels:
  * the MAGENTA box is your predicted patch; the YELLOW box is exactly 2x it about the same centre
  * scale   = (label width) / (magenta box width). Multiply ${naive.w.toFixed(4)} x ${naive.h.toFixed(4)} by it.
  * offset  = (label centre) - (magenta centre), converted through the magenta box's known size.
Re-run with the corrected --predict until only hairlines of magenta show, then write the region into
PRODUCT_MOCKUP_CONFIG as { x, y, w, h } — x,y being the TOP-LEFT, not the centre.`
    : `
ROUND ONE — open the photo showing the marker and read which lettered cell it sits in.
  column letter -> index (A=0), row number -> index (1 = 0). Centre fractions are
  (colIndex + 0.5) / ${COLS} and (rowIndex + 0.5) / ${ROWS}; interpolate against neighbouring cells.
Then convert that CENTRE to a TOP-LEFT by subtracting half of ${naive.w.toFixed(4)} x ${naive.h.toFixed(4)}
and re-run with --predict <x>,<y> to refine and to measure the true size.`
);
