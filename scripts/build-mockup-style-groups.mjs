// Builds the generator_mockup_id -> style-group table that lets ONE mockup task carry flats,
// detail shots AND on-model shots without ambiguity.
//
//   PRINTFUL_API_KEY=... node scripts/build-mockup-style-groups.mjs
//   PRINTFUL_API_KEY=... node scripts/build-mockup-style-groups.mjs --products=320,801
//
// WHY THIS EXISTS. Ask v1 for several option_groups in one task and each placement's photo comes
// back as an untyped `mockup_url` primary, with `option_group` present only on the `extra` entries
// -- so the most important photos arrive saying nothing about what they show. That is what capped
// src/lib/printfulViewPolicy.js at two groups for a year, and it is real: measured 2026-09-07,
// asking in a different order does NOT move it (["Flat","Product details","Men's"] and
// ["Men's","Flat","Product details"] give byte-identical assignment -- Printful has its own fixed
// notion of which style owns a placement's primary, and the request order is not a lever).
//
// What was missed is that EVERY photo, primary and extra alike, carries `generator_mockup_id`, and
// that id is STABLE across tasks. Measured on the track jacket: a Flat-only task returns 57206/57214,
// a Men's-only task returns 57252/57260, and a task asking for both returns those same four ids as
// untyped primaries. So asking for one group at a time LEARNS the classification that a combined
// task cannot state, and the learned table then disambiguates the combined task exactly -- no
// inference, no filename guessing (useless here anyway: the flat back and the on-model back are both
// `...-white-back-<hash>.jpg`).
//
// The table is therefore a cache of Printful's own style catalogue, keyed by the id their generator
// actually stamps on a photo -- NOT the v2 /mockup-styles ids, which are a different numbering
// entirely and do not match (checked: 0 of 7 ids found).
//
// COST: one mockup task per product per group, ~50 in total, and every one leaves a file in
// Printful's library permanently (they expose no delete API). Not a thing to re-run casually -- use
// --products= when a single product's styles change. Re-running is otherwise safe and idempotent.
//
// DRIFT is safe by construction: an id the table does not know sorts LAST in the filmstrip, so a
// style Printful adds later can never displace the flats at the front of the strip. Add
// `scripts/check-printful-mockups.mjs` to the loop -- it fails on any id this table is missing.
import { readFileSync, writeFileSync } from 'node:fs';
import { PRODUCT_MOCKUP_CONFIG } from '../src/lib/printfulMockupConfig.js';
import { mockupPlacementEntries, buildMockupFiles } from '../src/lib/printfulPlacements.js';
import { catalogGroupsFor, viewGroupRank } from '../src/lib/printfulViewPolicy.js';

const KEY = process.env.PRINTFUL_API_KEY;
const HEADERS = { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };
const ART = 'https://chromaforge.app/og-image.jpg';
const CREATE_SPACING_MS = 6500;
const POLL_MS = 3000;
const POLL_TRIES = 60;

const args = process.argv.slice(2);
const only = args.find(a => a.startsWith('--products='))?.split('=')[1]?.split(',');
const productIds = Object.keys(PRODUCT_MOCKUP_CONFIG).filter(id => !only || only.includes(id));

const sleep = ms => new Promise(r => setTimeout(r, ms));
const pf = async (path, init) => {
  const res = await fetch(`https://api.printful.com${path}`, { headers: HEADERS, ...init });
  return { res, body: await res.json() };
};

let lastCreate = 0;
async function throttle() {
  const wait = lastCreate + CREATE_SPACING_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastCreate = Date.now();
}

const problems = [];

// Runs a real task and returns Map<generator_mockup_id, filename>. Called with ONE group when
// learning the id -> group table (a single-group task has no ambiguity to resolve, which is the
// whole reason this runs a group at a time) and with every group at once by --names, which only
// needs filenames and so does not care.
async function filesForGroups(productId, cfg, specs, variant, groups) {
  const entries = mockupPlacementEntries(specs, variant, cfg);
  const files = buildMockupFiles(entries, specs, Object.fromEntries(entries.map(([k]) => [k, ART])));
  const options = Array.isArray(cfg.productOptions)
    ? Object.fromEntries(cfg.productOptions.map(o => [o.name, o.value]))
    : cfg.productOptions;
  const payload = JSON.stringify({
    variant_ids: [variant.id],
    format: 'jpg',
    files,
    ...(options && Object.keys(options).length ? { product_options: options } : {}),
    option_groups: groups
  });

  let taskKey = null;
  for (let attempt = 1; attempt <= 4 && !taskKey; attempt++) {
    await throttle();
    const { res, body } = await pf(`/mockup-generator/create-task/${productId}`, { method: 'POST', body: payload });
    if (res.ok && body.result?.task_key) taskKey = body.result.task_key;
    else if (res.status === 429 && attempt < 4) {
      // Printful states the wait in the body ("Please try again after 2 seconds"). Honour it plus a
      // margin rather than guessing -- a fixed sleep either wastes minutes or comes back too early,
      // and coming back too early is what burned a retry budget and cost a group its ids.
      const text = typeof body?.result === 'string' ? body.result : body?.error?.message ?? '';
      const stated = Number(/after (\d+) second/i.exec(text)?.[1]);
      await sleep(((Number.isFinite(stated) ? stated : 15) + 5) * 1000);
    }
    else throw new Error(`create ${res.status}: ${JSON.stringify(body.result ?? body.error ?? body).slice(0, 160)}`);
  }

  let result = null;
  for (let i = 0; i < POLL_TRIES && !result; i++) {
    await sleep(POLL_MS);
    const polled = await pf(`/mockup-generator/task?task_key=${taskKey}`);
    if (polled.body.result?.status !== 'pending') result = polled.body.result;
  }
  if (!result) throw new Error('still pending');
  if (result.status !== 'completed') throw new Error(`status ${result.status}: ${result.error ?? 'no reason'}`);

  const byId = new Map();
  const note = (id, url) => {
    if (id && url && !byId.has(id)) byId.set(id, url.split('/').pop());
  };
  for (const m of result.mockups ?? []) {
    note(m.generator_mockup_id, m.mockup_url);
    for (const e of m.extra ?? []) note(e.generator_mockup_id, e.url);
  }
  return byId;
}

// Writes both generated files from a finished table. Split out so --regenerate can re-emit them
// after a change to the TIER definitions (which group counts as on-model) without spending a single
// mockup task -- the group names in the table are all that decision needs.
function writeTable(table, views) {
  const header = `// GENERATED by scripts/build-mockup-style-groups.mjs -- do not edit by hand.
//
// generator_mockup_id -> the style group that id belongs to, per product. v1 stamps this id on
// every mockup photo it returns, primary and extra alike, and it is stable across tasks -- so it is
// the only thing that says which group an untyped primary came from. Read the builder's header for
// why that matters and how the table is learned.
//
// MODEL_GROUPS_BY_PRODUCT names the on-model group each product's ids were learned for. It is what
// gates asking for that group at all, and what tells the Edge Function which photos to label "on
// model" without restating the tier patterns in Deno.
//
// MOCKUP_STYLE_VIEWS is the view each id actually SHOWS, read from Printful's own filename (which is
// honest where the placement key is not -- see the builder). It names the on-model shots, and only
// those: the flats keep the placement-derived names they have always had, so this cannot reorder or
// relabel a single photo the filmstrip already carried.
//
// A product missing from MODEL_GROUPS_BY_PRODUCT is never asked for an on-model group, so it keeps
// exactly the two-group filmstrip it has today. An id missing from a product's entry sorts last.
// Both degradations are deliberate: neither can reorder the flats.
`;
  // The model group is recovered from the table's own group NAMES rather than tracked separately,
  // so the tier definition lives in exactly one place (printfulViewPolicy.js) and a product whose
  // model task failed -- the pillow's Person styles are restricted to variants this build cannot
  // reach -- simply has no entry here, which is the gate working as intended.
  const modelGroups = {};
  for (const [productId, ids] of Object.entries(table)) {
    for (const group of new Set(Object.values(ids))) {
      if (viewGroupRank(group) === 2) modelGroups[productId] = group;
    }
  }
  const body = `export const MOCKUP_STYLE_GROUPS = ${JSON.stringify(table, null, 2)};

export const MODEL_GROUPS_BY_PRODUCT = ${JSON.stringify(modelGroups, null, 2)};

export const MOCKUP_STYLE_VIEWS = ${JSON.stringify(views ?? {}, null, 2)};
`;
  writeFileSync(new URL('../src/lib/printfulMockupStyleGroups.js', import.meta.url), `${header}\n${body}`);
  // Mirrored for the Edge Function, which runs in Deno and cannot import from src/. Both files are
  // written by this one call so they cannot drift -- same discipline as _shared/compactDesign.ts.
  writeFileSync(
    new URL('../supabase/functions/_shared/mockupStyleGroups.ts', import.meta.url),
    `${header}\n${body.replace('export const MOCKUP_STYLE_GROUPS =', 'export const MOCKUP_STYLE_GROUPS: Record<string, Record<string, string>> =')
      .replace('export const MODEL_GROUPS_BY_PRODUCT =', 'export const MODEL_GROUPS_BY_PRODUCT: Record<string, string> =')
      .replace('export const MOCKUP_STYLE_VIEWS =', 'export const MOCKUP_STYLE_VIEWS: Record<string, Record<string, string>> =')}`
  );
}

// Re-emit both files from the table already in the repo, no API calls. Use after changing which
// groups count as on-model; use the full run when a PRODUCT's styles change.
if (args.includes('--regenerate')) {
  const text = readFileSync(new URL('../src/lib/printfulMockupStyleGroups.js', import.meta.url), 'utf8');
  // Read by text rather than by import, so this still works when the file is missing an export the
  // policy module imports -- the one state in which nothing else can load it.
  const match = /export const MOCKUP_STYLE_GROUPS = (\{[\s\S]*?\n\});/.exec(text);
  if (!match) {
    console.error('could not read MOCKUP_STYLE_GROUPS out of the generated file');
    process.exit(1);
  }
  const viewsMatch = /export const MOCKUP_STYLE_VIEWS = (\{[\s\S]*?\n\});/.exec(text);
  writeTable(JSON.parse(match[1]), viewsMatch ? JSON.parse(viewsMatch[1]) : {});
  console.log('Regenerated both files from the existing table.');
  process.exit(0);
}

// Which variants each style group can actually render, from the catalog's own
// `restricted_to_variants` (absent = every variant). Two things come out of this, both load-bearing:
//
//   - A group that does NOT cover every variant must never be requested, because v1 answers a task
//     for an uncovered variant with a 400 "No variants to generate" and the customer gets no preview
//     at all. The pillow's `Person` covers 3 of its 5 sizes, which is exactly why it 400s here.
//   - A product with ANY restricted style hands out DIFFERENT generator_mockup_ids per variant, so
//     one variant's ids do not classify another's. Learning only the first variant is what left the
//     bandana's other two sizes with an unclassifiable flat that sorted behind its close-up
//     (Aaron, live: "the flat is now second which feels wrong. it's closeup then flat").
//
// Measured 2026-09-07: exactly two products in the catalogue restrict styles, the pillow (83) and
// the bandana (630) -- the same pair whose per-variant style ids broke under v2. Everything else is
// learnable from one variant, which is what keeps this cheap.
async function styleCoverage(productId, variantIds) {
  const { body } = await pf(`/v2/catalog-products/${productId}/mockup-styles`);
  const coverage = new Map();
  let restricted = false;
  for (const entry of body?.data ?? []) for (const st of entry?.mockup_styles ?? []) {
    if (!st?.category_name) continue;
    if (st.restricted_to_variants) restricted = true;
    if (!coverage.has(st.category_name)) coverage.set(st.category_name, new Set());
    for (const v of st.restricted_to_variants ?? variantIds) coverage.get(st.category_name).add(v);
  }
  return { coverage, restricted, names: [...coverage.keys()] };
}

// The groups this product can be asked for: the tiers the policy wants, minus any that cannot
// render every variant.
function requestableGroups({ coverage, names }, variantIds, productId, problems) {
  return catalogGroupsFor(names).filter(group => {
    const covered = variantIds.filter(v => coverage.get(group)?.has(v));
    if (covered.length === variantIds.length) return true;
    problems.push(
      `${productId}: "${group}" covers only ${covered.length}/${variantIds.length} variants -- not requestable, ` +
        `so it is left out of the table (asking for it would 400 on the rest).`
    );
    return false;
  });
}

// Printful names a photo's FILE after the view it actually shows, and that name is honest where the
// placement key is not: on the track jacket the `front` placement returns the garment's back, and
// the filename says "back". The slug in front of it is the product+colour, identical across every
// photo of one task, so the view token is whatever is left once the common leading segments are
// removed. Backs off a segment if that would leave any view with an empty name, which is what keeps
// a product whose only views are "front" and "front-2" from collapsing to nothing.
function viewNamesFromFiles(files) {
  const parts = files.map(f => f.replace(/\.[a-z]+$/i, '').replace(/-[0-9a-f]{8,}$/i, '').split('-'));
  let common = 0;
  while (parts.every(p => p.length > common + 1 && p[common] === parts[0][common])) common++;
  while (common > 0 && parts.some(p => p.length <= common)) common--;
  return parts.map(p =>
    p.slice(common).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
  );
}

// Checked here rather than at the top: --regenerate makes no API calls, so it must not demand a key.
if (!KEY) {
  console.error('PRINTFUL_API_KEY is required');
  process.exit(1);
}

// --names fills in each id's true view name, and asks for every group AT ONCE rather than one at a
// time: a combined task shows every photo the product will ever return, and all this mode needs from
// each is its filename. So it costs one task per product instead of one per group.
if (args.includes('--names')) {
  const text = readFileSync(new URL('../src/lib/printfulMockupStyleGroups.js', import.meta.url), 'utf8');
  const table = JSON.parse(/export const MOCKUP_STYLE_GROUPS = (\{[\s\S]*?\n\});/.exec(text)[1]);
  // Seeded from what is already recorded, for the same reason the id pass merges: a run scoped to
  // one product must not wipe the names of the other seventeen.
  const views = JSON.parse(/export const MOCKUP_STYLE_VIEWS = (\{[\s\S]*?\n\});/.exec(text)?.[1] ?? '{}');
  for (const productId of productIds.filter(id => table[id])) {
    const cfg = PRODUCT_MOCKUP_CONFIG[productId];
    const { body: specsBody } = await pf(`/mockup-generator/printfiles/${productId}`);
    const { body: productBody } = await pf(`/products/${productId}`);
    const allVariants = productBody.result?.variants ?? [];
    const style = await styleCoverage(productId, allVariants.map(v => v.id));
    const groups = requestableGroups(style, allVariants.map(v => v.id), productId, problems);
    // Same per-variant rule as the id pass: a restricted product's views are named per variant.
    const learnFrom = style.restricted ? allVariants : [allVariants[0]];
    try {
      // Names are derived PER VARIANT, never across variants. The common-prefix trim strips the
      // product slug, and on a restricted product that slug carries the SIZE -- so pooling two
      // variants' filenames first leaves the size in the name and the filmstrip reads "L Front"
      // and "14x14 Back". Merging the per-variant results keeps each id named for what it shows.
      const named = {};
      for (const v of learnFrom) {
        const files = await filesForGroups(productId, cfg, specsBody.result, v, groups);
        const ids = [...files.keys()];
        const names = viewNamesFromFiles(ids.map(id => files.get(id)));
        ids.forEach((id, i) => { named[id] ??= names[i]; });
      }
      views[productId] = { ...(views[productId] ?? {}), ...named };
      console.log(`  ${productId} ${Object.keys(named).length} view name(s): ${[...new Set(Object.values(named))].join(', ')}`);
    } catch (err) {
      problems.push(`${productId} names: ${err.message}`);
      console.log(`  ${productId} FAILED: ${err.message}`);
    }
  }
  writeTable(table, views);
  console.log(`\nWrote view names for ${Object.keys(views).length} product(s).`);
  if (problems.length) {
    console.error(`\n${problems.length} problem(s):`);
    for (const p of problems) console.error(`  ${p}`);
    process.exit(1);
  }
  process.exit(0);
}

// What the repo already knows. A run covering only some products (--products=) must not drop the
// rest, and a group that fails mid-run must not drop ids a previous run had learned -- which
// happened once (a 429 on the bandana's second group) and left the table looking complete while
// classifying less than it did before.
let existingTable = {};
try {
  const prev = readFileSync(new URL('../src/lib/printfulMockupStyleGroups.js', import.meta.url), 'utf8');
  existingTable = JSON.parse(/export const MOCKUP_STYLE_GROUPS = (\{[\s\S]*?\n\});/.exec(prev)[1]);
} catch {
  existingTable = {};
}

const table = { ...existingTable };
for (const productId of productIds) {
  const cfg = PRODUCT_MOCKUP_CONFIG[productId];
  const { body: specsBody } = await pf(`/mockup-generator/printfiles/${productId}`);
  const { body: productBody } = await pf(`/products/${productId}`);
  const specs = specsBody.result;
  const variant = productBody.result?.variants?.[0];
  if (!specs || !variant) {
    problems.push(`${productId}: could not load catalog data`);
    continue;
  }
  // The product's own group list, exactly as the app sees it, so this learns the groups the policy
  // will actually ask for and nothing else.
  const allVariants = productBody.result?.variants ?? [];
  const variantIds = allVariants.map(v => v.id);
  const style = await styleCoverage(productId, variantIds);
  const groups = requestableGroups(style, variantIds, productId, problems);
  if (!groups.length) {
    problems.push(`${productId}: no requestable style groups`);
    continue;
  }
  // Only a product with restricted styles needs every variant walked; for the rest one variant's
  // ids are the whole product's, and walking them all would spend 129 tasks to learn nothing.
  const learnFrom = style.restricted ? allVariants : [variant];
  if (learnFrom.length > 1) console.log(`  ${productId} has per-variant style ids -- learning all ${learnFrom.length} variants`);

  const forProduct = {};
  for (const group of groups) {
    try {
      const ids = [];
      for (const v of learnFrom) ids.push(...(await filesForGroups(productId, cfg, specs, v, [group])).keys());
      for (const id of ids) {
        // An id claimed by two groups would make the table a lie. It has not been observed; if it
        // ever is, the first group wins and it is reported rather than silently overwritten.
        if (forProduct[id] && forProduct[id] !== group) {
          problems.push(`${productId}: id ${id} is in both "${forProduct[id]}" and "${group}"`);
          continue;
        }
        forProduct[id] = group;
      }
      console.log(`  ${productId} ${group.padEnd(18)} ${new Set(ids).size} view(s)`);
    } catch (err) {
      problems.push(`${productId} "${group}": ${err.message}`);
      console.log(`  ${productId} ${group.padEnd(18)} FAILED: ${err.message}`);
    }
  }
  // MERGED into whatever the table already knows for this product, never assigned over it. A group
  // that fails mid-run (a 429, a transient Printful error) would otherwise silently delete ids a
  // previous run had learned -- which happened, and left the bandana with its flat ids and no
  // Product details id, i.e. a table that looks complete and classifies less than it did before.
  if (Object.keys(forProduct).length) table[productId] = { ...(existingTable[productId] ?? {}), ...forProduct };
}

// A full run learns groups, not view names, so it carries forward whatever --names already found
// rather than silently emptying the map (and with it every on-model label).
let existingViews = {};
try {
  const prev = readFileSync(new URL('../src/lib/printfulMockupStyleGroups.js', import.meta.url), 'utf8');
  existingViews = JSON.parse(/export const MOCKUP_STYLE_VIEWS = (\{[\s\S]*?\n\});/.exec(prev)[1]);
} catch {
  existingViews = {};
}
writeTable(table, existingViews);

const products = Object.keys(table).length;
const ids = Object.values(table).reduce((n, m) => n + Object.keys(m).length, 0);
console.log(`\nWrote ${ids} ids across ${products} product(s).`);
if (problems.length) {
  console.error(`\n${problems.length} problem(s):`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
