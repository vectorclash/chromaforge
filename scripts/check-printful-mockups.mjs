// Generates a real Printful mockup for EVERY variant of EVERY configured product and asserts the
// whole preview pipeline holds together.
//
//   PRINTFUL_API_KEY=... node scripts/check-printful-mockups.mjs
//   PRINTFUL_API_KEY=... node scripts/check-printful-mockups.mjs --products=654,615
//   PRINTFUL_API_KEY=... node scripts/check-printful-mockups.mjs --variants=1   # one per product
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
// cache invalidation, React state). It answers two questions: "does every product and variant we
// sell produce usable preview photos" (the one the hand-testing was answering slowly) and, since
// 2026-08-29, "are we even ASKING for every view each product can show" -- see checkCoverage, and
// read its comment before trusting a green run, because the second question is precisely the one
// two earlier green runs could not see.
//
// It imports the REAL helpers from src/lib/printfulPlacements.js rather than reimplementing them.
// The one thing it must mirror is the Edge Function's response normalisation (printful-mockup's
// GET handler), because that runs in Deno and cannot be imported here -- keep NORMALISE in step
// with it, same discipline as _shared/compactDesign.ts mirroring render/compactDesign.js.
import { PRODUCT_MOCKUP_CONFIG } from '../src/lib/printfulMockupConfig.js';
import {
  resolvePlacementEntries,
  mockupPlacementEntries,
  buildMockupFiles,
  hideUnsubmittedViews
} from '../src/lib/printfulPlacements.js';
import { chooseOptionGroups, orderViews, MAX_VIEWS } from '../src/lib/printfulViewPolicy.js';

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
// --variants=N samples the first N variants of each product instead of all of them. Every run
// leaves a file in Printful's library PERMANENTLY (they expose no delete or list API), so a full
// 129-variant sweep is not something to do casually. Use the sample when what changed is a
// property of the PRODUCT -- a placement list, a product option, the wrap geometry -- and the full
// run when it could differ per variant: a size- or colour-restricted mockup style, a variant's own
// printfile ids, or anything touching the cache key's colour discriminator.
const variantLimit = Number(args.find(a => a.startsWith('--variants='))?.split('=')[1]) || Infinity;
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
  inside_front: 'Inside front', inside_back: 'Inside back',
  label_inside: 'Inside label', label_outside: 'Outside label', label_panel: 'Lining'
};
const LABEL_PLACEMENTS = new Set(['label_inside', 'label_outside', 'label_panel']);

// Placements that never correspond to a photograph a customer can be shown: brand marks, and
// interior surfaces (the track jacket's pocket is its inside lining, the windbreaker's
// hood_inner and facing likewise). Printful still associates SOME camera angle with each of
// them, so letting them name a view produces a photo of the jacket labelled "Pocket" -- which
// is exactly what happened once mockups started asking for more style groups and leftover
// photos began outnumbering the placements that could claim them. Their `extra` entries still
// count; those carry Printful's own view titles, which are real.
const NON_VIEW_PLACEMENTS = new Set([
  ...LABEL_PLACEMENTS, 'pocket', 'details', 'inside_pocket', 'hood_inner', 'facing'
]);
function normalise(result) {
  const byUrl = new Map();
  const raw = [];
  const seenUrls = new Set();
  const seenViews = new Set();
  const push = (url, name, optionGroup) => {
    if (!url || seenUrls.has(url)) return;
    const viewKey = `${optionGroup ?? ''}|${name}`;
    if (seenViews.has(viewKey)) return;
    seenViews.add(viewKey);
    seenUrls.add(url);
    raw.push({ url, name, optionGroup });
  };
  const ordered = [...(result.mockups ?? [])].sort(
    (a, b) => Number(LABEL_PLACEMENTS.has(a.placement)) - Number(LABEL_PLACEMENTS.has(b.placement))
  );
  // Extras across every placement FIRST, so a grouped copy always claims a URL a primary would
  // otherwise take -- then the primaries, flagged with whether they are a real front/back panel.
  for (const m of ordered) {
    for (const e of m.extra ?? []) push(e.url, e.title, e.option_group);
  }
  for (const m of ordered) {
    if (NON_VIEW_PLACEMENTS.has(m.placement)) continue;
    push(m.mockup_url, PLACEMENT_LABELS[m.placement] ?? m.placement);
  }
  const reserved = new Set(raw.map(r => r.name));
  const taken = new Set();
  for (const { url, name, optionGroup } of raw) {
    let final = name;
    if (taken.has(final)) {
      for (let n = 2; taken.has(final) || (final !== name && reserved.has(final)); n++) final = `${name} ${n}`;
    }
    taken.add(final);
    byUrl.set(url, { mockup_url: url, display_name: final, option_group: optionGroup ?? null });
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

// Asserts the mockup asks Printful for EVERY piece a real order would print -- not merely that
// the pieces we asked for came back usable.
//
// THIS IS THE ASSERTION THAT WAS MISSING, and its absence is why two full green runs (2026-08-21
// and 2026-08-28) sat on top of real gaps. Every other check in this file reasons about the views
// that came back for the placements we SUBMITTED -- and the submission list was itself the thing
// under test, so a piece we never thought to request was invisible by construction. Worse,
// checkVariant calls hideUnsubmittedViews, which correctly hid the mesh shorts' back view, and
// then asserted only `views.length > 0`. The check ran the code that hid the evidence and reported
// green on what survived. A checker cannot find a view it never thought to request.
//
// What it was hiding, once looked for: the shorts' whole back panel, the track jacket's collar
// band, and every product's label placements -- including the shorts' `label_outside`, a visible
// 3in patch on the front of the leg that customers were buying without ever seeing it.
//
// The rule is now simply "the mockup submits what the order submits" (Aaron, 2026-08-29), so this
// compares the resolved mockup entries against the product's full placement list and allows no
// exceptions. If Printful ever genuinely rejects a placement for a product, the fix is a filter at
// the call site WITH a reason and a retest date -- and this check should then be taught about it
// explicitly, so the exception stays visible instead of becoming another silent curation. Note two
// such beliefs were retested on v1 on 2026-08-29 and both had expired: the bandana does not reject
// `label_inside`, and the track jacket does not fail on `details` + sleeves.
//
// Costs no mockup quota, which is the other reason it should have existed from the start.
function checkCoverage(productId, cfg, specs, variant) {
  const all = Object.keys(specs.available_placements || {});
  if (!all.length) return failures.push(`${productId}: no available_placements in the printfile spec`);

  // The ORDER's set against the MOCKUP's set, both from the real helpers the app uses. The mockup
  // side must come from mockupPlacementEntries and not from an inline unfiltered call here, or
  // this compares a call to itself and passes forever.
  const ordered = resolvePlacementEntries(specs, variant);
  if (!ordered) return;
  const preview = mockupPlacementEntries(specs, variant, cfg);
  const orderedKeys = ordered.map(([k]) => k);
  const previewKeys = new Set(preview.map(([k]) => k));
  const dropped = orderedKeys.filter(k => !previewKeys.has(k));
  if (dropped.length) {
    failures.push(
      `${productId}/${variant.id}: the mockup drops placement(s) the order prints: ${dropped.join(', ')} ` +
        `-- customers can buy these pieces without ever seeing them.`
    );
  }

  // Separately: cfg.placements is the geometry-checkbox list now, not a submission set. A key that
  // names a placement this product does not have silently costs that panel its checkbox, which
  // includesGeometry then reads as "geometry off" for the real print.
  const geometryKeys = cfg.geometryPlacementKeys || cfg.placements || [];
  const unknown = geometryKeys.filter(p => !all.includes(p) && p !== 'default');
  if (unknown.length) {
    failures.push(`${productId}: geometry placement key(s) this product does not have: ${unknown.join(', ')}`);
  }
}

// The style groups a product has, fetched once per product and reused across its variants -- the
// same list printful-catalog?styles=1 hands the browser, so the checker and the app feed the policy
// identical input.
const styleGroupCache = new Map();
async function styleGroups(productId) {
  if (!styleGroupCache.has(productId)) {
    const { body } = await pf(`/v2/catalog-products/${productId}/mockup-styles`);
    const names = new Set();
    for (const e of body?.data ?? []) for (const st of e?.mockup_styles ?? []) {
      if (st?.category_name) names.add(st.category_name);
    }
    styleGroupCache.set(productId, [...names]);
  }
  return styleGroupCache.get(productId);
}

async function checkVariant(productId, cfg, specs, variant) {
  const label = `${productId}/${variant.id} ${variant.size ?? ''}${variant.color ? ' ' + variant.color : ''}`.trim();
  const fail = msg => failures.push(`${label}: ${msg}`);

  // The real helper useMockup uses, so this drives Printful with exactly what the app sends.
  const entries = mockupPlacementEntries(specs, variant, cfg);
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

  const groups = chooseOptionGroups(await styleGroups(productId));

  // v1 wants product_options as a JSON object; our config carries the [{name,value}] shape the
  // order path also uses. Same conversion the Edge Function does.
  const options = Array.isArray(cfg.productOptions)
    ? Object.fromEntries(cfg.productOptions.map(o => [o.name, o.value]))
    : cfg.productOptions;

  const payload = JSON.stringify({
    variant_ids: [variant.id],
    format: 'jpg',
    files,
    ...(options && Object.keys(options).length ? { product_options: options } : {}),
    // The same groups the app asks for, from the same policy module -- so a green run here reflects
    // the filmstrip a customer actually gets, not v1's unchosen default.
    ...(groups.length ? { option_groups: groups } : {})
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

  const views = orderViews(hideUnsubmittedViews(normalise(result).mockups, entries, specs), MAX_VIEWS);
  if (!views.length) return fail('completed but produced no views');
  const urls = new Set(views.map(v => v.mockup_url));
  if (urls.size !== views.length) return fail('duplicate view URLs survived de-duplication');
  const names = new Set(views.map(v => v.display_name));
  if (names.size !== views.length) return fail('duplicate view labels');
  // No view may be named after a raw Printful placement key. These are customer-facing filmstrip
  // tabs, and the day mockups started submitting every placement an order does, three keys with no
  // PLACEMENT_LABELS entry -- label_inside, label_outside, label_panel -- went straight onto the
  // UI. Keyed off the real key list rather than a regex on "label", so a future placement Printful
  // adds is caught the same way instead of only the ones that happen to be named label_*.
  const rawKeys = new Set(Object.keys(specs.available_placements || {}));
  const leaked = views.filter(v => rawKeys.has(v.display_name));
  if (leaked.length) return fail(`view label(s) are raw placement keys: ${leaked.map(v => v.display_name).join(', ')}`);

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
  // Coverage first: it costs no mockup task, and if it fails you want to see it before an
  // 18-minute run finishes. Per-variant, because the placement set is resolved per variant.
  checkCoverage(productId, cfg, specs, variants[0]);

  const sampled = variants.slice(0, variantLimit);
  totalVariants += sampled.length;
  console.log(
    `Checking product ${productId} (${sampled.length}${sampled.length < variants.length ? ` of ${variants.length}` : ''} variants)...`
  );

  const queue = [...sampled];
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
