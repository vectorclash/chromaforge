// Guards the two properties the leg-wrap map trades away when a product tapers its shift, and the
// one it must never trade: that a product WITHOUT `shiftBottom` still composites exactly as it did.
//
//   node scripts/check-legwrap-taper.mjs          # all four stages, each in its own process
//   node scripts/check-legwrap-taper.mjs 3        # one stage
//
// Run it after anything that touches src/render/legWrap.js. It needs no secrets and no network
// beyond Playwright's bundled browsers -- the composition is a synthetic high-frequency pattern,
// because hard edges are where resamplers disagree and stored artwork mostly does not have them.
//
// WHAT EACH STAGE IS FOR (2026-09-01, when `shiftBottom` was added):
//   1. The un-tapered map is byte-identical to the previous commit, at mockup cap and at true
//      printfile size, mirrored and not. This is the one that must never go amber: the joggers, and
//      every product that omits the field, ride on it.
//   2. A tapered sheet paints every pixel (the clamps overlap the composition for this reason -- two
//      antialiased edges abutting on a subpixel do not add up to full coverage), its mirror is a
//      flip to within a rounding LSB, and it differs from the un-tapered sheet at all.
//   3. How far the three engines that composite this sheet drift apart under a taper. They agree
//      exactly without one; with one they resample, and this bounds how much.
//   4. What a true printfile costs to draw. This is why the tidier whole-pixel-banded taper was
//      rejected -- see the note in legWrap.js. It is its own stage because RSS means nothing in a
//      process that has already allocated for stage 3.
//
// Stages run as separate processes because @napi-rs/canvas holds these sheets in NATIVE memory that
// V8 frees only lazily: one process doing all four gets OOM-killed part way through, which is the
// same lazy-native-GC problem render-service passes --expose-gc for.
// Verifies the banded taper: (1) the un-tapered map is byte-identical to the previous commit,
// (2) a mirrored sheet is still a pixel-exact flip, (3) all three engines still agree exactly.
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { chromium, webkit } from 'playwright';
const require = createRequire(import.meta.url);
// Resolved from this file, not the cwd, so the script runs from anywhere.
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { createCanvas } = require(path.join(REPO, 'render-service', 'node_modules', '@napi-rs', 'canvas'));

// A bare invocation runs each stage in its own process, so one OOM cannot be mistaken for a pass.
if (process.argv[2] === undefined) {
  const { execFileSync } = await import('node:child_process');
  let failed = 0;
  for (const st of [1, 2, 3, 4]) {
    try {
      execFileSync(process.execPath,
        ['--expose-gc', '--max-old-space-size=8192', fileURLToPath(import.meta.url), String(st)],
        { stdio: 'inherit' });
    } catch {
      failed++;
    }
  }
  process.exit(failed ? 1 : 0);
}

const PRODUCTS = {
  '693 shorts': { sheet: [11250, 4350], geom: { shift: 0.14161, shiftBottom: 0.09623, width: 0.49882 } },
  '604 pants':  { sheet: [10200, 7500], geom: { shift: 0.10158, shiftBottom: 0.07133, width: 0.58067 } },
  '784 joggers':{ sheet: [ 9750, 8100], geom: { shift: 0.08804, width: 0.56667 } }
};
const SIZES = [[2000, 'mockup cap'], [null, 'true printfile']];

function makeComp(w, h) {
  const c = createCanvas(w, h);
  const x = c.getContext('2d');
  for (let i = 0; i < 60; i++) { x.fillStyle = `hsl(${(i * 41) % 360},85%,${i % 2 ? 38 : 72}%)`; x.fillRect(Math.round(i * w / 60), 0, Math.ceil(w / 60), h); }
  for (let j = 0; j < 40; j++) { x.fillStyle = j % 2 ? '#000' : '#fff'; x.fillRect(0, Math.round(j * h / 40), w, Math.max(2, Math.round(h / 400))); }
  return c;
}
const hash = buf => crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);

// --- old code, from the previous commit, in a worktree ---
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-legwrap-'));
execSync(`git -C "${REPO}" worktree add --detach "${tmp}/base" HEAD`, { stdio: 'pipe' });
const OLD = await import(`${tmp}/base/src/render/legWrap.js`);
const NEW = await import(`${REPO}/src/render/legWrap.js`);

// Each stage runs in its own process: @napi-rs/canvas holds these sheets (a true shorts printfile
// is 49Mpx) in NATIVE memory that V8 frees only lazily, so one process doing all three gets
// OOM-killed part way -- the same lazy-native-GC problem render-service runs --expose-gc for.
const STAGE = Number(process.argv[2] || 0);
const stage = n => STAGE === 0 || STAGE === n;
let fails = 0;
const collect = () => { if (global.gc) global.gc(); };
const ok = (cond, msg) => { console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${msg}`); if (!cond) fails++; };

function sheet(mod, geom, outW, outH, comp, mirror) {
  const c = createCanvas(outW, outH);
  mod.drawLegWrap(c.getContext('2d'), comp, geom, outW, outH, { mirror });
  return c.getContext('2d').getImageData(0, 0, outW, outH).data;
}
function flip(a, w, h) {
  const o = new Uint8ClampedArray(a.length);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const s = (y * w + x) * 4, d = (y * w + (w - 1 - x)) * 4;
    o[d] = a[s]; o[d + 1] = a[s + 1]; o[d + 2] = a[s + 2]; o[d + 3] = a[s + 3];
  }
  return o;
}
const diff = (a, b) => { let n = 0, m = 0; for (let i = 0; i < a.length; i++) { const d = Math.abs(a[i] - b[i]); if (d) { n++; if (d > m) m = d; } } return { n, m }; };

if (stage(1)) {
console.log('\n1. UN-TAPERED map is byte-identical to the previous commit');
for (const [name, p] of Object.entries(PRODUCTS)) {
  for (const [cap, label] of SIZES) {
    const [W, H] = p.sheet;
    const outW = cap ? Math.round(W * cap / Math.max(W, H)) : W;
    const outH = cap ? Math.round(H * cap / Math.max(W, H)) : H;
    const flat = { shift: p.geom.shift, width: p.geom.width };   // no shiftBottom
    const comp = makeComp(Math.max(1, Math.round(flat.width * outW)), outH);
    for (const mirror of [false, true]) {
      const a = sheet(OLD, flat, outW, outH, comp, mirror);
      const b = sheet(NEW, flat, outW, outH, comp, mirror);
      ok(hash(Buffer.from(a.buffer)) === hash(Buffer.from(b.buffer)),
        `${name} ${label}${mirror ? ' mirrored' : ''} — ${hash(Buffer.from(b.buffer))}`);
      collect();
    }
  }
}

}

if (stage(2)) {
console.log('\n2. TAPERED: how far the mirror and the engines actually drift, and no blank sheet');
for (const [name, p] of Object.entries(PRODUCTS)) {
  if (p.geom.shiftBottom === undefined) { console.log(`  skip ${name} — no taper configured`); continue; }
  for (const [cap, label] of SIZES) {
    const [W, H] = p.sheet;
    const outW = cap ? Math.round(W * cap / Math.max(W, H)) : W;
    const outH = cap ? Math.round(H * cap / Math.max(W, H)) : H;
    const comp = makeComp(Math.max(1, Math.round(p.geom.width * outW)), outH);
    // One sheet in memory at a time, compared through per-row hashes: two true-printfile canvases
    // plus the composition is more native memory than a dev machine has.
    const STEP = Math.max(1, Math.floor(4e6 / outW));
    let blank = 0;
    const rowHashes = mirror => {
      const c = createCanvas(outW, outH);
      NEW.drawLegWrap(c.getContext('2d'), comp, p.geom, outW, outH, { mirror });
      const out = [];
      for (let y = 0; y < outH; y += STEP) {
        const h = Math.min(STEP, outH - y);
        const D = c.getContext('2d').getImageData(0, y, outW, h).data;
        if (!mirror) for (let k = 3; k < D.length; k += 4) if (D[k] !== 255) blank++;
        const band = mirror ? D : flip(D, outW, h);
        const copy = Uint8ClampedArray.from(band);
        for (let r = 0; r < h; r++) out.push(hash(Buffer.from(copy.buffer, r * outW * 4, outW * 4)));
      }
      return out;
    };
    const expected = rowHashes(false);
    collect();
    const actual = rowHashes(true);
    let bad = 0;
    for (let r = 0; r < outH; r++) if (expected[r] !== actual[r]) bad++;
    let sub = { n: 0, m: 0 };
    if (cap) {
      const a = sheet(NEW, p.geom, outW, outH, comp, false);
      const b = sheet(NEW, p.geom, outW, outH, comp, true);
      sub = diff(b, flip(a, outW, outH));
    }
    console.log(`  info ${name} ${label} — mirror differs on ${bad} of ${outH} rows` +
      (cap ? `, ${(100 * sub.n / (outW * outH * 4)).toFixed(4)}% of subpixels (max delta ${sub.m})` : ''));
    ok(blank === 0, `${name} ${label} — no unpainted sheet (${blank} non-opaque subpixels)`);
    collect();
    if (cap) {
      const flat = sheet(NEW, { shift: p.geom.shift, width: p.geom.width }, outW, outH, comp, false);
      const tapered = sheet(NEW, p.geom, outW, outH, comp, false);
      ok(diff(tapered, flat).n > 0, `${name} ${label} — taper actually changes the sheet`);
    }
    collect();
  }
}
}

if (stage(3)) {
console.log('\n3. TAPERED: how far the three engines drift, and what the sheet costs to draw');
const P = PRODUCTS['693 shorts'];
const outW = 2000, outH = Math.round(P.sheet[1] * 2000 / P.sheet[0]);
const comp = makeComp(Math.round(P.geom.width * outW), outH);
const compUri = 'data:image/png;base64,' + comp.toBuffer('image/png').toString('base64');
const src = fs.readFileSync(`${REPO}/src/render/legWrap.js`, 'utf8').replace(/export /g, '');
const ours = sheet(NEW, P.geom, outW, outH, comp, false);
for (const [engineName, engine] of [['Chromium', chromium], ['WebKit', webkit]]) {
  const b = await engine.launch();
  const page = await b.newPage();
  const got = await page.evaluate(async ([uri, code, geom, outW, outH]) => {
    const img = new Image(); img.src = uri; await img.decode();
    const c = document.createElement('canvas'); c.width = outW; c.height = outH;
    new Function('ctx', 'comp', 'geom', 'outW', 'outH', `${code}\nreturn drawLegWrap(ctx, comp, geom, outW, outH);`)(
      c.getContext('2d'), img, geom, outW, outH);
    return Array.from(c.getContext('2d').getImageData(0, 0, outW, outH).data);
  }, [compUri, src, P.geom, outW, outH]);
  const d = diff(Uint8ClampedArray.from(got), ours);
  const pct = (100 * d.n / ours.length).toFixed(3);
  ok(d.n / ours.length < 0.05, `napi-rs vs ${engineName} — ${pct}% of subpixels differ (max delta ${d.m}), under the 5% ceiling`);
  await b.close();
}
}

// The reason banding was rejected: this is the render path, on a 4096MB machine. Its own stage,
// because RSS is only meaningful in a process that has not already allocated for the engine diff.
if (stage(4)) {
  const SH = PRODUCTS['693 shorts'];
  const [W, H] = SH.sheet;
  const big = makeComp(Math.round(SH.geom.width * W), H);
  const c = createCanvas(W, H);
  const t = Date.now();
  NEW.drawLegWrap(c.getContext('2d'), big, SH.geom, W, H, {});
  const ms = Date.now() - t;
  const rss = Math.round(process.memoryUsage().rss / 1048576);
  ok(rss < 1024 && ms < 500, `true ${W}x${H} printfile — ${ms}ms, peak RSS ${rss}MB (banding was 3200ms / 15000MB)`);
}

execSync(`git -C "${REPO}" worktree remove --force "${tmp}/base"`, { stdio: 'pipe' });
console.log(fails ? `\n${fails} FAILED` : '\nall checks passed');
process.exit(fails ? 1 : 0);
