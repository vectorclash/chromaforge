// Instant mockups: how close the composed photos are to REAL Printful photos, offline and free.
// Uses the real mockups `calibrate-instant-mockup.mjs verify` already downloaded
// (.calib/<pid>/<cfg>/verify/<view>.jpg, gitignored, so this runs on the machine that captured
// them), re-renders that verify design's print files exactly as verify did (render-service, long
// edge 1500), composes each view with the maps + compositor given, and reports per view: mean
// error over print pixels, over SEAM pixels (within 2px of another print file), the p99, and
// `bad` -- pixels off by more than 40 levels, per thousand.
//
//   node scripts/check-instant-accuracy.mjs [pids...] [--maps-root <dir>] [--compositor <file>]
//        [--tag name] [--save]      # --save writes diff images to .calib/_accuracy/<tag>/
//
// Baseline after the 2026-11-15 quality pass (all 133 verified views): mean 4.45, seam 8.19,
// p99 14.65, bad 0.73 per thousand. Run before and after any change to the decode or compositor.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(ROOT, 'package.json'));
const { createCanvas, loadImage } = require('./render-service/node_modules/@napi-rs/canvas');
const args = process.argv.slice(2);
const opt = n => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : null);
const VALUED = ['--maps-root', '--compositor', '--tag'];
const pids = args.filter((a, i) => /^\d+$/.test(a) && !VALUED.includes(args[i - 1])).map(Number);
const HERE = path.join(ROOT, '.calib', '_accuracy');
const mapsRoot = opt('maps-root') || path.join(ROOT, 'public/instant-mockups');
const { composeInstantMockup } = await import(opt('compositor') || path.join(ROOT, 'src/lib/instantMockup.js'));
const tag = opt('tag') || 'run';
const saveDiff = args.includes('--save');

for (const line of fs.readFileSync(path.join(ROOT, '.env.local'), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}
const DESIGN = 'ce5e71e5-15f0-49cd-8714-e273b95f042b';
const cacheDir = path.join(HERE, 'verify-src');
fs.mkdirSync(cacheDir, { recursive: true });
let design = null;
let renderDesign = null;

const data = async buf => {
  const img = await loadImage(buf);
  const c = createCanvas(img.width, img.height);
  c.getContext('2d').drawImage(img, 0, 0);
  return { width: img.width, height: img.height, data: c.getContext('2d').getImageData(0, 0, img.width, img.height).data };
};

async function source(p) {
  const s = Math.min(1, 1500 / Math.max(p.width, p.height));
  const w = Math.max(1, Math.round(p.width * s));
  const h = Math.max(1, Math.round(p.height * s));
  const file = path.join(cacheDir, `${w}x${h}.png`);
  if (!fs.existsSync(file)) {
    if (!design) {
      const rows = await (await fetch(`${process.env.VITE_SUPABASE_URL}/rest/v1/designs?select=data&id=eq.${DESIGN}`, { headers: { apikey: process.env.VITE_SUPABASE_ANON_KEY } })).json();
      design = rows[0].data;
      ({ renderDesign } = await import(path.join(ROOT, 'render-service/render.js')));
    }
    fs.writeFileSync(file, await renderDesign({ seed: design.seed, colors: design.colors || [], settings: design.settings || null, width: w, height: h }));
  }
  return data(fs.readFileSync(file));
}

const rows = [];
const all = fs.readdirSync(path.join(ROOT, '.calib')).map(Number).filter(p => !pids.length || pids.includes(p));
for (const pid of all) {
  const manifestFile = path.join(mapsRoot, String(pid), 'manifest.json');
  if (!fs.existsSync(manifestFile)) continue;
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  for (const [configId, config] of Object.entries(manifest.configs)) {
    const vdir = path.join(ROOT, '.calib', String(pid), configId, 'verify');
    if (!fs.existsSync(vdir)) continue;
    const sources = [];
    for (const p of config.placements) sources.push(await source(p));
    for (const [viewId, meta] of Object.entries(config.views)) {
      const realFile = path.join(vdir, `${viewId}.jpg`);
      if (!fs.existsSync(realFile)) continue;
      const view = { ...meta };
      for (const k of ['base', 'gain', 'gamma', 'place', 'uv', 'uvplace', 'underplace', 'underuv', 'edge']) {
        if (meta.files[k]) view[k] = await data(fs.readFileSync(path.join(mapsRoot, String(pid), meta.files[k])));
      }
      const mine = composeInstantMockup(view, sources);
      const real = await data(fs.readFileSync(realFile));
      const [cx, cy, cw, ch] = view.crop;
      const pl = (x, y) => (x < 0 || y < 0 || x >= cw || y >= ch ? -1 : view.place.data[(y * cw + x) * 4]);
      let sum = 0, n = 0, ssum = 0, sn = 0;
      const errs = [];
      const diff = saveDiff ? new Uint8ClampedArray(view.width * view.height * 4) : null;
      for (let y = 0; y < ch; y++) {
        for (let x = 0; x < cw; x++) {
          const p0 = pl(x, y);
          if (!p0) continue;
          let seam = false;
          for (let dy = -2; dy <= 2 && !seam; dy++) for (let dx = -2; dx <= 2; dx++) {
            const q = pl(x + dx, y + dy);
            if (q > 0 && q !== p0) { seam = true; break; }
          }
          const o = ((cy + y) * view.width + cx + x) * 4;
          let e = 0;
          for (let c = 0; c < 3; c++) e += Math.abs(mine[o + c] - real.data[o + c]);
          e /= 3;
          sum += e; n++;
          if (seam) { ssum += e; sn++; }
          errs.push(e);
          if (diff) { const v = Math.min(255, e * 4); diff[o] = diff[o + 1] = diff[o + 2] = v; diff[o + 3] = 255; }
        }
      }
      errs.sort((a, b) => a - b);
      rows.push({ pid, view: `${meta.group} ${meta.name}`.slice(0, 26), id: viewId, mean: +(sum / n).toFixed(2), seam: sn ? +(ssum / sn).toFixed(2) : '-', p99: +errs[Math.floor(errs.length * 0.99)].toFixed(1), bad: +(errs.filter(e => e > 40).length / errs.length * 1000).toFixed(2) });
      if (diff) {
        const c = createCanvas(view.width, view.height);
        const id = c.getContext('2d').createImageData(view.width, view.height);
        id.data.set(diff);
        c.getContext('2d').putImageData(id, 0, 0);
        fs.mkdirSync(path.join(HERE, 'diff', tag), { recursive: true });
        fs.writeFileSync(path.join(HERE, 'diff', tag, `${pid}-${viewId}.png`), c.toBuffer('image/png'));
        const m2 = c.getContext('2d').createImageData(view.width, view.height);
        m2.data.set(mine);
        c.getContext('2d').putImageData(m2, 0, 0);
        fs.writeFileSync(path.join(HERE, 'diff', tag, `${pid}-${viewId}-mine.png`), c.toBuffer('image/png'));
      }
    }
  }
}
console.table(rows);
const avg = k => (rows.reduce((s, r) => s + (typeof r[k] === 'number' ? r[k] : 0), 0) / rows.filter(r => typeof r[k] === 'number').length).toFixed(3);
console.log(`${tag}: views ${rows.length}, mean ${avg('mean')}, seam ${avg('seam')}, p99 ${avg('p99')}, bad‰ ${avg('bad')}`);
fs.mkdirSync(HERE, { recursive: true });
fs.writeFileSync(path.join(HERE, `${tag}.json`), JSON.stringify(rows, null, 1));
