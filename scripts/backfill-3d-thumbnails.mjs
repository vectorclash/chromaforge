// Re-renders the gallery thumbnail of every saved 3D animation, the way Save makes it.
//
// render-service/backfill-thumbnails.mjs re-renders every other row's thumbnail, but it SKIPS 3D
// rows on purpose: their thumbnail is a real WebGL frame of the flight (its seam frame), and that
// script runs in plain Node with no WebGL. So whenever the 3D scene changes how a flight looks --
// the nebula volume replacing the radial blobs (2026-10-19, Aaron: "some of the old animation
// thumbnails have radial gradients still") -- those cards keep showing the old flight until this
// runs.
//
// It renders with the app's OWN code: a Vite dev server serves src/, a GPU-backed Chromium page
// imports animation3d/renderStill.js and calls render3DStill with each row's stored duration and
// speed-ramp setting at the save path's THUMBNAIL_SIZE -- exactly StudioContext's call. Nothing is
// ported or approximated.
//
// Usage (from the repo root; reads VITE_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY from .env.local):
//   node scripts/backfill-3d-thumbnails.mjs --dry-run   # renders into .thumb3d-backfill/preview/
//   node scripts/backfill-3d-thumbnails.mjs             # uploads; saves each OLD thumbnail first
//   ... --id=<design id>                                # just that row (e.g. a save whose upload failed)
//
// READ-ONLY on the designs table. It overwrites only the derived thumbnail JPEG at its existing
// path (`${user_id}/${design_id}.jpg` in design-thumbnails), and copies the previous file to
// .thumb3d-backfill/previous-<timestamp>/ before replacing it, so a run can be put back by hand.
// Needs a GPU: headless Chromium is launched with ANGLE on Metal, as the repo's timing checks are.

import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'vite';
import { chromium } from 'playwright';

const ROOT = new URL('..', import.meta.url).pathname;
const DRY_RUN = process.argv.includes('--dry-run');
const ONLY_ID = process.argv.find(a => a.startsWith('--id='))?.slice(5);
const THUMBNAIL_SIZE = 640; // must match StudioContext's THUMBNAIL_SIZE
const BUCKET = 'design-thumbnails';

const env = Object.fromEntries(
  readFileSync(`${ROOT}.env.local`, 'utf8')
    .split('\n')
    .filter(line => line.includes('='))
    .map(line => [line.slice(0, line.indexOf('=')).trim(), line.slice(line.indexOf('=') + 1).trim()])
);
const SUPABASE_URL = env.VITE_SUPABASE_URL;
const SERVICE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('Needs VITE_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local');
  process.exit(1);
}
const auth = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` };

const rowsRes = await fetch(
  `${SUPABASE_URL}/rest/v1/designs?select=id,user_id,title,data&kind=eq.animation&data->>mode=eq.3d${ONLY_ID ? `&id=eq.${encodeURIComponent(ONLY_ID)}` : ''}&order=created_at`,
  { headers: auth }
);
if (!rowsRes.ok) {
  console.error(`designs query failed (${rowsRes.status}): ${await rowsRes.text()}`);
  process.exit(1);
}
const rows = await rowsRes.json();
console.log(`${rows.length} saved 3D animation(s)${DRY_RUN ? ' (dry run -- nothing will be uploaded)' : ''}`);
if (rows.length === 0) process.exit(0);

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = `${ROOT}.thumb3d-backfill/${DRY_RUN ? 'preview' : `previous-${stamp}`}/`;
mkdirSync(outDir, { recursive: true });

const server = await createServer({ root: ROOT, logLevel: 'error', server: { port: 0, open: false } });
await server.listen();
const base = server.resolvedUrls.local[0];
const browser = await chromium.launch({ args: ['--enable-gpu', '--use-angle=metal'] });
const page = await browser.newPage();
// A blank page on the dev server's origin, so the app's modules import from it
await page.goto(`${base}favicon.svg`).catch(() => page.goto(base));

let failed = 0;
try {
  for (const row of rows) {
    const label = `${row.id}  "${row.title}"`;
    try {
      const b64 = await page.evaluate(
        async ({ data, size }) => {
          const { render3DStill } = await import('/src/animation3d/renderStill.js');
          const { storedVideo } = await import('/src/lib/savedAnimation.js');
          const { cycleDuration, speedRamp } = storedVideo(data);
          const blob = await render3DStill(data.design, { duration: cycleDuration, speedRamp, width: size, height: size });
          const bytes = new Uint8Array(await blob.arrayBuffer());
          let s = '';
          for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
          return btoa(s);
        },
        { data: row.data, size: THUMBNAIL_SIZE }
      );
      const jpeg = Buffer.from(b64, 'base64');
      const path = `${row.user_id}/${row.id}.jpg`;
      if (DRY_RUN) {
        writeFileSync(`${outDir}${row.id}.jpg`, jpeg);
        console.log(`WOULD REBUILD  ${label}  (${(jpeg.length / 1024).toFixed(0)} KB, preview written)`);
        continue;
      }
      // Keep the thumbnail being replaced, so this run can be put back by hand
      const previous = await fetch(`${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${path}`);
      if (previous.ok) writeFileSync(`${outDir}${row.id}.jpg`, Buffer.from(await previous.arrayBuffer()));
      const up = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${path}`, {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'image/jpeg', 'x-upsert': 'true', 'cache-control': 'max-age=3600' },
        body: jpeg
      });
      if (!up.ok) throw new Error(`upload failed (${up.status}): ${await up.text()}`);
      console.log(`OK    ${label}`);
    } catch (err) {
      failed++;
      console.error(`FAIL  ${label}: ${err.message}`);
    }
  }
} finally {
  await browser.close();
  await server.close();
}
console.log(`\nDone. ${rows.length - failed} ok, ${failed} failed. ${DRY_RUN ? 'Previews' : 'Previous thumbnails'} in ${outDir}`);
process.exit(failed ? 1 : 0);
