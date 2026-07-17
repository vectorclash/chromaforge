// One-off backfill: regenerate every existing design's Storage thumbnail at the new
// high-density size (see src/context/StudioContext.jsx's renderDesignBlob `highDensity`
// option and src/render/scale.js's densityFloorSize) so thumbnails saved before that fix
// -- a sparse DIRECT 320x320 render -- get replaced with a true downsample of a dense
// composition, matching what saving the same design today would produce. Empirically
// confirmed live (see the two /tmp/thumb-*.jpg comparisons made while building this): the
// old direct render shows a handful of large triangles and a couple of sparkles; the new
// one (generate at 2000x2000, downsample to 320x320) shows the same design's real density
// of geometry and stars.
//
// READ-ONLY on the `designs` table -- this only overwrites the derived Storage thumbnail
// JPEG at its existing `${user_id}/${design_id}.jpg` path (upsert, the exact same path a
// normal save already writes to), never the design row's own seed/colors/settings. Every
// design stays fully recoverable from its row regardless of what this script does to its
// thumbnail. Run with --dry-run first to see what would be touched without uploading
// anything.
//
// Lives in render-service/, not scripts/, so its bare imports resolve without installing
// anything new: @napi-rs/canvas from render-service/node_modules (this dir), and
// @supabase/supabase-js by walking up to the repo root's node_modules (Node's normal
// ancestor resolution) -- confirmed both resolve correctly from here.
//
// Usage:
//   cd render-service
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node backfill-thumbnails.mjs --dry-run
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node backfill-thumbnails.mjs
//
// Needs the project's SERVICE ROLE key (Dashboard -> Project Settings -> API), not the
// anon key -- this reads every user's designs and writes into their thumbnail path
// regardless of which account runs the script, which Storage's owner-only RLS (see
// supabase/migrations/0002_design_thumbnails_storage.sql) would otherwise block. Pass it
// as an env var for this one run only; never commit it or put it in .env.local.
import { createClient } from '@supabase/supabase-js';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { renderDesign } from './render.js';
import { densityFloorSize } from '../src/render/scale.js';

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DRY_RUN = process.argv.includes('--dry-run');

// Must match StudioContext.jsx's THUMBNAIL_SIZE exactly -- this backfill is only
// reproducing what that code already does for a fresh save, not choosing its own size.
const THUMBNAIL_SIZE = 320;
const THUMBNAIL_BUCKET = 'design-thumbnails';
const JPEG_QUALITY = 85; // @napi-rs/canvas's toBuffer takes 0-100, NOT 0-1 like browser
// Canvas.toBlob -- confirmed empirically (0.85 and 1 produced byte-identical output, both
// clearly the lowest-quality encode; 85 produced the expected larger/better file). Matches
// the app's own renderDesignBlob JPEG quality target (0.85 there, same 0-100 scale intent).

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error('Set SUPABASE_URL (or VITE_SUPABASE_URL) and SUPABASE_SERVICE_ROLE_KEY.');
  process.exit(2);
}

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
const { width: GEN_WIDTH, height: GEN_HEIGHT } = densityFloorSize(THUMBNAIL_SIZE, THUMBNAIL_SIZE);

async function renderThumbnailJpeg(source) {
  const png = await renderDesign({
    seed: source.seed,
    colors: source.colors,
    settings: source.settings ?? null,
    width: GEN_WIDTH,
    height: GEN_HEIGHT
  });
  const img = await loadImage(png);
  const out = createCanvas(THUMBNAIL_SIZE, THUMBNAIL_SIZE);
  out.getContext('2d').drawImage(img, 0, 0, THUMBNAIL_SIZE, THUMBNAIL_SIZE);
  return out.toBuffer('image/jpeg', JPEG_QUALITY);
}

async function main() {
  const { data: rows, error } = await supabase.from('designs').select('id, user_id, kind, title, data');
  if (error) throw error;

  console.log(
    `${rows.length} design(s) found. Generating at ${GEN_WIDTH}x${GEN_HEIGHT}, downsampled to ` +
      `${THUMBNAIL_SIZE}x${THUMBNAIL_SIZE}.${DRY_RUN ? ' (dry run -- nothing will be uploaded)' : ''}`
  );

  let ok = 0;
  let skipped = 0;
  let failed = 0;
  for (const row of rows) {
    // Mirrors StudioContext.jsx's saveCurrentDesign: an animation's thumbnail is
    // recomposed from its first frame (the only single {seed,colors} it has); an image
    // design's data IS that shape already.
    const source = row.data?.animation && row.data?.frames ? row.data.frames[0] : row.data;
    if (!source?.seed) {
      console.log(`SKIP  ${row.id}  "${row.title}"  -- no seed to recompose from`);
      skipped++;
      continue;
    }
    if (DRY_RUN) {
      console.log(`WOULD REBUILD  ${row.id}  "${row.title}"  (${row.kind}, user ${row.user_id})`);
      ok++;
      continue;
    }
    try {
      const jpeg = await renderThumbnailJpeg(source);
      const path = `${row.user_id}/${row.id}.jpg`;
      const { error: uploadError } = await supabase.storage
        .from(THUMBNAIL_BUCKET)
        .upload(path, jpeg, { contentType: 'image/jpeg', upsert: true });
      if (uploadError) throw uploadError;
      console.log(`OK    ${row.id}  "${row.title}"`);
      ok++;
    } catch (err) {
      console.error(`FAIL  ${row.id}  "${row.title}"  -- ${err.message}`);
      failed++;
    }
  }

  console.log(`\nDone. ${ok} ok, ${skipped} skipped, ${failed} failed.`);
  if (failed) process.exit(1);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
