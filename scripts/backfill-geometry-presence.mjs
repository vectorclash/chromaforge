// One-off (re-runnable): make every stored design state whether it HAS the geometry layer,
// instead of storing the odds it was rolled at. Writes `settings.geometry.present` (a
// boolean) and removes `settings.geometry.chance` outright.
//
// *** RUN THIS ONLY ONCE THE NEW FRONTEND IS LIVE. *** It is the one step here with an
// ordering requirement: a row that has had `chance` removed states its geometry only through
// `present`, which a bundle predating that field does not read -- so an older deployed
// frontend would fall back to the 0.4 coin and re-roll those designs on the live gallery.
// Until it runs, rows keep `chance: 1|0`, which the new code reads correctly as a statement
// of fact (see designSettings' compactSettings), so there is no hurry and no broken window.
//
//   node scripts/backfill-geometry-chance.mjs --dry-run
//   node scripts/backfill-geometry-chance.mjs
//
// WHY. `settings.geometry.chance` used to be a probability that lived in a design's saved
// data, so the coin was re-flipped on every render -- a design's appearance depended on a
// number in the bundle (the absent-value default) and on its own position in the shared rng
// sequence. That is precisely the failure mode of the 2026-08-02 incident, where a change
// upstream in the sequence made 13 saved designs lose their geometry layer outright.
// generateArtwork now persists the RESOLVED outcome instead, as `present: true|false`, and a
// stated presence overrides the coin entirely. This backfill applies the same resolution to
// rows saved before that change, so no row in the table stores odds and nothing depends on
// the legacy absent-value default any more.
//
// SAFETY. The value written is computed by the CURRENT bundle -- i.e. it is exactly what that
// row renders as today -- and every rewritten row is re-rendered and compared field-by-field
// at three sizes before anything is sent. The previous `data` of every touched row is written
// to a rollback file first. Read-modify-write on `data` only; no other column is touched, and
// thumbnails need no backfill because the render is unchanged by construction.
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DRY = process.argv.includes('--dry-run');

const envPath = path.join(REPO, '.env.local');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE) {
  console.error('Need SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (writing to designs.data).');
  process.exit(1);
}
const headers = {
  apikey: SERVICE,
  Authorization: `Bearer ${SERVICE}`,
  'Content-Type': 'application/json'
};

// Same three sizes check-render-regression.mjs uses: studio default, the thumbnail density
// floor, a real print file.
const SIZES = [
  [3840, 2160],
  [2000, 2000],
  [3150, 5550]
];
const COMPOSITION_FIELDS = [
  'gradientBackgroundConfig',
  'firstBlend',
  'radialFieldConfig',
  'secondBlend',
  'starFieldConfig',
  'thirdBlend',
  'geometryConfig',
  'overlayBlend',
  'overlayAlpha',
  'overlayConfig'
];

execSync('node build.js', { cwd: path.join(REPO, 'render-service'), stdio: 'pipe' });
await import(path.join(REPO, 'render-service', 'shim.js'));
const { generateArtwork } = await import(
  path.join(REPO, 'render-service', 'generated', 'render-lib.js')
);

const res = await fetch(`${SUPABASE_URL}/rest/v1/designs?select=id,kind,data&limit=1000`, {
  headers
});
if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
const rows = (await res.json()).filter(r => r.data && r.data.seed);
if (rows.length === 0) {
  console.error('No stored designs came back -- refusing to report a clean run on an empty set.');
  process.exit(1);
}

const pending = [];
let alreadyResolved = 0;
for (const row of rows) {
  if (typeof row.data.settings?.geometry?.present === 'boolean') {
    alreadyResolved++;
    continue;
  }
  // What this row renders as TODAY, resolved once at the studio's own size -- whether that
  // comes from an explicit chance (1, 0, or real odds) or from the absent-value coin. The
  // draw is size-independent (one rng() call from the shared sequence, whose position does
  // not vary with canvas size), which the per-size verification below re-confirms per row.
  const current = generateArtwork(row.data.seed, 3840, 2160, row.data.colors || [], row.data.settings || null);
  const hasGeometry = !!current.geometryConfig;
  // `chance` is removed, not overwritten: odds have no meaning on a piece that already
  // exists, and leaving them alongside `present` would be two sources of truth.
  const { chance: _odds, ...dna } = row.data.settings?.geometry || {};
  const next = {
    ...row.data,
    settings: { ...(row.data.settings || null), geometry: { ...dna, present: hasGeometry } }
  };
  // Prove equivalence rather than trusting the algebra: the rewritten row must generate the
  // identical composition, including the star field and every blend, at every size.
  for (const [w, h] of SIZES) {
    const a = generateArtwork(row.data.seed, w, h, row.data.colors || [], row.data.settings || null);
    const b = generateArtwork(next.seed, w, h, next.colors || [], next.settings);
    for (const f of COMPOSITION_FIELDS) {
      if (JSON.stringify(a[f] ?? null) !== JSON.stringify(b[f] ?? null)) {
        console.error(`FAIL ${row.id} (${row.data.seed}) diverges on ${f} at ${w}x${h}.`);
        process.exit(1);
      }
    }
  }
  pending.push({ row, next, hasGeometry });
}

console.log(`${rows.length} stored designs`);
console.log(`  already state \`present\` : ${alreadyResolved}`);
console.log(`  to rewrite               : ${pending.length}`);
const on = pending.filter(p => p.hasGeometry).length;
console.log(`     -> present: true  (has geometry) : ${on}`);
console.log(`     -> present: false (has none)     : ${pending.length - on}`);
console.log('  all rewrites verified identical at 3 sizes across every composition field.');

if (pending.length === 0) {
  console.log('\nNothing to do.');
  process.exit(0);
}
if (DRY) {
  console.log('\nDry run -- nothing written.');
  process.exit(0);
}

const rollback = path.join(REPO, `geometry-chance-rollback-${Date.now()}.json`);
fs.writeFileSync(
  rollback,
  JSON.stringify(pending.map(p => ({ id: p.row.id, data: p.row.data })), null, 2)
);
console.log(`\nPrevious data for every touched row saved to ${path.basename(rollback)}`);

let written = 0;
for (const { row, next } of pending) {
  const put = await fetch(`${SUPABASE_URL}/rest/v1/designs?id=eq.${row.id}`, {
    method: 'PATCH',
    headers: { ...headers, Prefer: 'return=minimal' },
    body: JSON.stringify({ data: next })
  });
  if (!put.ok) {
    console.error(`\nFAILED on ${row.id}: ${put.status} ${await put.text()}`);
    console.error(`Rows written so far: ${written}. Restore from ${path.basename(rollback)}.`);
    process.exit(1);
  }
  written++;
}
console.log(`Rewrote ${written} rows.`);

// Re-read and re-verify against what each row rendered as before the write.
const after = await fetch(`${SUPABASE_URL}/rest/v1/designs?select=id,data&limit=1000`, { headers });
const byId = new Map((await after.json()).map(r => [r.id, r.data]));
let bad = 0;
for (const { row, hasGeometry } of pending) {
  const d = byId.get(row.id);
  if (d?.settings?.geometry?.present !== hasGeometry || 'chance' in (d?.settings?.geometry || {})) {
    console.error(`  ${row.id}: stored ${JSON.stringify(d?.settings?.geometry)}, expected present: ${hasGeometry} and no chance`);
    bad++;
    continue;
  }
  for (const [w, h] of SIZES) {
    const a = generateArtwork(row.data.seed, w, h, row.data.colors || [], row.data.settings || null);
    const b = generateArtwork(d.seed, w, h, d.colors || [], d.settings || null);
    for (const f of COMPOSITION_FIELDS) {
      if (JSON.stringify(a[f] ?? null) !== JSON.stringify(b[f] ?? null)) {
        console.error(`  ${row.id}: re-read row diverges on ${f} at ${w}x${h}`);
        bad++;
      }
    }
  }
}
if (bad) {
  console.error(`\nFAIL: ${bad} rows did not verify after the write. Restore from ${path.basename(rollback)}.`);
  process.exit(1);
}
console.log('Verified after write: every rewritten row still renders exactly as it did.');
