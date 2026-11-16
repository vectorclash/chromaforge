// Instant mockups: is every option a customer can pick covered by a calibrated photo set?
// Every product in the shop x every variant x every stitch colour Printful offers (read live from
// Printful), matched with the app's own instantConfigFor rule against src/lib/instantMockupIndex.js.
// A captured set not yet decoded counts as "in flight". Exits 1 if anything is missing.
//
//   node scripts/check-instant-coverage.mjs        # needs PRINTFUL_API_KEY in .env.local
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
for (const line of fs.readFileSync(`${ROOT}/.env.local`, 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}
const { INSTANT_MOCKUPS } = await import(`${ROOT}/src/lib/instantMockupIndex.js`);
const src = fs.readFileSync(`${ROOT}/src/lib/printful.js`, 'utf8');
const ids = [...src.slice(src.indexOf('STARTER_PRODUCT_IDS = ['), src.indexOf('];', src.indexOf('STARTER_PRODUCT_IDS = ['))).matchAll(/\n\s*(\d+),/g)].map(m => Number(m[1]));
const rows = [];
for (const pid of ids) {
  const r = (await (await fetch(`https://api.printful.com/products/${pid}`, { headers: { Authorization: `Bearer ${process.env.PRINTFUL_API_KEY}` } })).json()).result;
  const stitchOpt = (r.product.options || []).find(o => o.id === 'stitch_color');
  const stitches = stitchOpt ? Object.keys(stitchOpt.values || {}) : [null];
  const configs = INSTANT_MOCKUPS[String(pid)]?.configs || [];
  // Captured but not yet decoded (in flight).
  const calibDir = `${ROOT}/.calib/${pid}`;
  const pending = fs.existsSync(calibDir)
    ? fs.readdirSync(calibDir).filter(d => !configs.some(c => c.id === d)).map(d => JSON.parse(fs.readFileSync(`${calibDir}/${d}/capture.json`, 'utf8')))
    : [];
  const missing = [];
  const inFlight = [];
  for (const v of r.variants) {
    for (const st of stitches) {
      const hit = configs.find(c => c.variants.includes(v.id) && (!st || !c.stitch || c.stitch === st));
      if (hit) continue;
      const label = `${v.size || ''}${v.color ? ' ' + v.color : ''}${st ? ' / ' + st : ''}`.trim();
      if (pending.some(p => p.variants.includes(v.id) && (!st || p.stitch === st))) inFlight.push(label);
      else missing.push(label);
    }
  }
  rows.push({ pid, product: r.product.title.slice(0, 34), variants: r.variants.length, stitches: stitches.filter(Boolean).join('/') || '-', missing: missing.length, inFlight: inFlight.length, sample: missing.slice(0, 4).join('; ') });
}
console.table(rows);
const missing = rows.reduce((s, r) => s + r.missing, 0);
console.log(missing ? `${missing} option(s) have no instant mockup -- they fall back to the Printful flow.` : 'Every option of every product has an instant mockup.');
process.exit(missing ? 1 : 0);
