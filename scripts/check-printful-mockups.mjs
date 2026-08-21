// Generates a real Printful mockup for EVERY variant of EVERY configured product and asserts the
// whole preview pipeline holds together.
//
//   PRINTFUL_API_KEY=... node scripts/check-printful-mockups.mjs
//   PRINTFUL_API_KEY=... node scripts/check-printful-mockups.mjs --products 654,615
//
// Exit 0 = every variant produced usable previews. Exit 1 = at least one did not.
//
// WHY THIS EXISTS. The v1 mockup migration (2026-08-21) shipped with three product-specific bugs
// that no build, unit test or type check could have caught, and that only surfaced because Aaron
// clicked through products by hand:
//   - the reversible bucket hat returned 8 views, 4 of them a blank white hat, because v1 hands
//     back every camera angle a product has rather than only the ones the submitted files cover;
//   - switching the windbreaker's colour silently restored the previous colour's photo, because
//     both colours share printfile ids and the cache key keyed on those;
//   - and before that, v2 broke every pillow size except 18"x18" with no signal anywhere.
// All three are the same shape: a fault that exists for ONE product, or ONE variant, and is
// invisible everywhere else. Clicking 114 variants is not a thing to ask a human to do twice.
//
// WHAT IT DOES NOT COVER, so nobody mistakes a green run for full coverage: it drives Printful
// directly with a fixed public image, so it does not exercise our artwork render, the Supabase
// upload, the Edge Function's auth or rate-limit gates, or any of the browser UI (the filmstrip,
// cache invalidation, React state). It answers exactly one question -- "does every product and
// variant we sell produce usable preview photos" -- which is the question the hand-testing was
// answering slowly.
//
// It imports the REAL helpers from src/lib/printfulPlacements.js rather than reimplementing them.
// The one thing it must mirror is the Edge Function's response normalisation (printful-mockup's
// GET handler), because that runs in Deno and cannot be imported here -- keep NORMALISE in step
// with it, same discipline as _shared/compactDesign.ts mirroring render/compactDesign.js.
import { PRODUCT_MOCKUP_CONFIG } from '../src/lib/printfulMockupConfig.js';
import {
  resolvePlacementEntries,
  buildMockupFiles,
  hideUnsubmittedViews
} from '../src/lib/printfulPlacements.js';

const KEY = process.env.PRINTFUL_API_KEY;
if (!KEY) {
  console.error('PRINTFUL_API_KEY is required');
  process.exit(1);
}
const HEADERS = { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };

// A real, permanently-hosted image on a host Printful has never had trouble fetching. Deliberately
// NOT a Supabase Storage URL: this check is about our placement config, and pointing it at the
// bucket would make it fail for a completely unrelated reason during an incident like 2026-08-19.
const ART = 'https://chromaforge.app/og-image.jpg';

// Printful's own cap on POST create-task is 10/60s, shared across BOTH API versions and every user
// of the app. 6.5s between creates keeps a comfortable margin; concurrency 3 keeps the polling GETs
// (their own 120/60s bucket) well clear too.
const CREATE_SPACING_MS = 6500;
const CONCURRENCY = 3;
const POLL_MS = 3000;
const POLL_TRIES = 60;

const args = process.argv.slice(2);
const only = args.find(a => a.startsWith('--products='))?.split('=')[1]?.split(',');
const productIds = Object.keys(PRODUCT_MOCKUP_CONFIG).filter(id => !only || only.includes(id));

const sleep = ms => new Promise(r => setTimeout(r, ms));
const failures = [];
const rows = [];

// Mirrors printful-mockup/index.ts's GET handler. See the header note.
const PLACEMENT_LABELS = {
  default: 'Front', front: 'Front', back: 'Back',
  sleeve_left: 'Left', sleeve_right: 'Right',
  hood: 'Hood', pocket: 'Pocket', details: 'Details',
  outside_front: 'Front', outside_back: 'Back',
  inside_front: 'Inside front', inside_back: 'Inside back'
};
function normalise(result) {
  const byUrl = new Map();
  const raw = [];
  const seenUrls = new Set();
  const push = (url, name) => {
    if (!url || seenUrls.has(url)) return;
    seenUrls.add(url);
    raw.push({ url, name });
  };
  for (const m of result.mockups ?? []) {
    push(m.mockup_url, PLACEMENT_LABELS[m.placement] ?? m.placement);
    for (const e of m.extra ?? []) push(e.url, e.title);
  }
  const reserved = new Set(raw.map(r => r.name));
  const taken = new Set();
  for (const { url, name } of raw) {
    let final = name;
    if (taken.has(final)) {
      for (let n = 2; taken.has(final) || (final !== name && reserved.has(final)); n++) final = `${name} ${n}`;
    }
    taken.add(final);
    byUrl.set(url, { mockup_url: url, display_name: final });
  }
  return { status: result.status, error: result.error ?? null, mockups: [...byUrl.values()] };
}

async function pf(path, init) {
  const res = await fetch(`https://api.printful.com${path}`, { headers: HEADERS, ...init });
  return { res, body: await res.json() };
}

// Serialised through a promise chain, NOT a shared timestamp. The first version read
// `lastCreate` and awaited a sleep before writing it back, so three concurrent workers could all
// read the same value and fire together -- which produced 76 spurious 429s on the first full run
// and no real signal. Awaiting the previous caller's turn before taking your own is what makes
// the spacing hold under concurrency.
let createChain = Promise.resolve();
let lastCreate = 0;
function throttleCreate() {
  createChain = createChain.then(async () => {
    const wait = lastCreate + CREATE_SPACING_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastCreate = Date.now();
  });
  return createChain;
}

// Printful's 429 body states how long to wait ("Please try again after 14 seconds"). A rate limit
// is not a product fault, so it is waited out and retried rather than reported as a failure --
// otherwise the check's own pacing becomes indistinguishable from a broken placement config.
function retryAfterSeconds(body) {
  const text = typeof body?.result === 'string' ? body.result : body?.error?.message ?? '';
  const match = /after (\d+) second/i.exec(text);
  return match ? Number(match[1]) : 15;
}

async function checkVariant(productId, cfg, specs, variant) {
  const label = `${productId}/${variant.id} ${variant.size ?? ''}${variant.color ? ' ' + variant.color : ''}`.trim();
  const fail = msg => failures.push(`${label}: ${msg}`);

  const entries = resolvePlacementEntries(specs, variant, cfg.placements);
  if (!entries || !entries.length) return fail('no printfile mapping for this variant');

  let files;
  try {
    files = buildMockupFiles(entries, specs, Object.fromEntries(entries.map(([k]) => [k, ART])));
  } catch (err) {
    return fail(`buildMockupFiles threw: ${err.message}`);
  }
  if (files.length !== entries.length) return fail(`built ${files.length} files for ${entries.length} placements`);
  for (const f of files) {
    const p = f.position;
    if (!(p.width > 0 && p.height > 0)) return fail(`placement ${f.placement} has a zero-size position`);
  }

  // v1 wants product_options as a JSON object; our config carries the [{name,value}] shape the
  // order path also uses. Same conversion the Edge Function does.
  const options = Array.isArray(cfg.productOptions)
    ? Object.fromEntries(cfg.productOptions.map(o => [o.name, o.value]))
    : cfg.productOptions;

  const payload = JSON.stringify({
    variant_ids: [variant.id],
    format: 'jpg',
    files,
    ...(options && Object.keys(options).length ? { product_options: options } : {})
  });
  let created = null;
  for (let attempt = 1; attempt <= 4 && !created; attempt++) {
    await throttleCreate();
    const { res, body } = await pf(`/mockup-generator/create-task/${productId}`, { method: 'POST', body: payload });
    if (res.ok && body.result?.task_key) {
      created = body.result.task_key;
    } else if (res.status === 429 && attempt < 4) {
      await sleep((retryAfterSeconds(body) + 2) * 1000);
    } else {
      return fail(`create ${res.status}: ${JSON.stringify(body.result ?? body.error ?? body).slice(0, 140)}`);
    }
  }

  let result = null;
  for (let i = 0; i < POLL_TRIES && !result; i++) {
    await sleep(POLL_MS);
    const polled = await pf(`/mockup-generator/task?task_key=${created}`);
    if (polled.body.result?.status !== 'pending') result = polled.body.result;
  }
  if (!result) return fail(`still pending after ${(POLL_TRIES * POLL_MS) / 1000}s`);
  if (result.status !== 'completed') return fail(`status ${result.status}: ${result.error ?? 'no reason given'}`);

  const views = hideUnsubmittedViews(normalise(result).mockups, entries, specs);
  if (!views.length) return fail('completed but produced no views');
  const urls = new Set(views.map(v => v.mockup_url));
  if (urls.size !== views.length) return fail('duplicate view URLs survived de-duplication');
  const names = new Set(views.map(v => v.display_name));
  if (names.size !== views.length) return fail('duplicate view labels');

  rows.push({ productId, variant: variant.id, size: variant.size, color: variant.color, views: views.length,
    titles: views.map(v => v.display_name).join(', ') });
  return undefined;
}

const started = Date.now();
let done = 0;
let totalVariants = 0;

for (const productId of productIds) {
  const cfg = PRODUCT_MOCKUP_CONFIG[productId];
  const { body: specsBody } = await pf(`/mockup-generator/printfiles/${productId}`);
  const specs = specsBody.result;
  const { body: productBody } = await pf(`/products/${productId}`);
  const variants = productBody.result?.variants ?? [];
  if (!specs || !variants.length) {
    failures.push(`${productId}: could not load catalog data`);
    continue;
  }
  totalVariants += variants.length;
  console.log(`Checking product ${productId} (${variants.length} variants)...`);

  const queue = [...variants];
  const workers = Array.from({ length: CONCURRENCY }, async () => {
    for (;;) {
      const variant = queue.shift();
      if (!variant) return;
      await checkVariant(productId, cfg, specs, variant);
      done++;
    }
  });
  await Promise.all(workers);
}

const mins = ((Date.now() - started) / 60000).toFixed(1);
console.log(`\nChecked ${done}/${totalVariants} variants in ${mins} min.`);

// View counts per product, so a product whose previews quietly change shape is visible even when
// nothing technically failed.
console.log('\nViews per product:');
for (const productId of productIds) {
  const mine = rows.filter(r => r.productId === productId);
  if (!mine.length) continue;
  const counts = [...new Set(mine.map(r => r.views))].sort((a, b) => a - b);
  const sample = mine[0];
  console.log(`  ${productId.padEnd(5)} ${counts.join('/').padEnd(6)} views  e.g. ${sample.titles.slice(0, 60)}`);
}

if (failures.length) {
  console.error(`\n${failures.length} failure(s):`);
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}
console.log('\nAll variants produced usable previews.');
