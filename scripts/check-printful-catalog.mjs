// Scheduled Printful catalog-drift check (see .github/workflows/printful-catalog-check.yml).
//
// Why this exists: Printful's v2 API is still beta and has already changed catalog data
// under us silently once -- the pillow (83) grew per-variant restrictions on its Default
// Front/Back mockup styles when 14"/16" sizes were added, breaking mockups for every size
// except 18"x18" with no signal anywhere (2026-07-12, fixed with mockupStyleIdsByVariant).
// This script re-asserts, for every product in PRODUCT_MOCKUP_CONFIG, that the live
// catalog still matches what the app hardcodes. Read-only GETs only (~3 per product, on
// the general 120/60s rate bucket -- nowhere near the limit, and zero mockup quota).
//
// Checks per product:
//  1. Product exists and is not discontinued (v1 GET /products/{id}).
//  2. Configured productOptions (stitch_color) names/values are still valid, falling back
//     to v2's product_options for products v1 doesn't list the option on at all.
//  3. Every configured mockup placement still exists in the printfile catalog.
//  4. Printfile dimensions match scripts/printful-catalog-baseline.json -- dimension
//     changes invalidate pocketCrop math and print-render sizing, so they must be
//     reviewed by a human, then the baseline regenerated deliberately:
//       node scripts/check-printful-catalog.mjs --write-baseline
//  5. Every configured mockup style id (mockupStyleIds + mockupStyleIdsByVariant) still
//     exists (v2 GET /catalog-products/{id}/mockup-styles).
//  6. For every catalog variant, the style pair the app would resolve for it
//     (mockupStyleIdsByVariant[variant] ?? mockupStyleIds, mirroring
//     resolveMockupStyleIds) is not restricted away from that variant -- the exact
//     failure mode the pillow hit. A NEW variant Printful adds later fails here too if
//     the fallback pair doesn't cover it, which is precisely when a human should look.
//
// Exit code is non-zero on any finding, so the GitHub Actions cron fails loudly (GitHub's
// own failed-workflow email is the alert channel).
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { PRODUCT_MOCKUP_CONFIG } from '../src/lib/printfulMockupConfig.js';

const API_KEY = process.env.PRINTFUL_API_KEY;
if (!API_KEY) {
  console.error('PRINTFUL_API_KEY is not set');
  process.exit(2);
}

const BASELINE_PATH = join(dirname(fileURLToPath(import.meta.url)), 'printful-catalog-baseline.json');
const WRITE_BASELINE = process.argv.includes('--write-baseline');

const failures = [];
const fail = msg => {
  failures.push(msg);
  console.error(`FAIL: ${msg}`);
};

async function pf(path) {
  const res = await fetch(`https://api.printful.com${path}`, {
    headers: { Authorization: `Bearer ${API_KEY}` }
  });
  if (!res.ok) {
    throw new Error(`${path} -> HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  return res.json();
}

// v2 list endpoints paginate; walk offsets until a page comes back short.
async function pfV2AllPages(path) {
  const limit = 100;
  let offset = 0;
  const all = [];
  for (;;) {
    const page = await pf(`${path}?limit=${limit}&offset=${offset}`);
    const data = page.data ?? [];
    all.push(...data);
    if (data.length < limit) return all;
    offset += limit;
  }
}

const baseline = WRITE_BASELINE ? {} : JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
const newBaseline = {};

for (const [idStr, cfg] of Object.entries(PRODUCT_MOCKUP_CONFIG)) {
  const id = Number(idStr);
  console.log(`Checking product ${id}...`);

  // 1+2: product status + option validity (v1)
  const { result: productResult } = await pf(`/products/${id}`);
  const product = productResult.product;
  if (product.is_discontinued) fail(`product ${id}: is_discontinued is true`);
  // v1 and v2 disagree about which options a product has: the windbreaker (615) omits
  // stitch_color from v1's list entirely while v2 requires it on every mockup task (see
  // that product's PRODUCT_MOCKUP_CONFIG entry). So a v1 miss falls back to v2's own
  // product_options rather than failing -- an option genuinely disappearing still fails,
  // it just has to be absent from BOTH. v2 states values as either an object keyed by
  // value or a plain array of values, so normalize before checking membership.
  let v2Options = null;
  for (const opt of cfg.productOptions ?? []) {
    let catalogOpt = (product.options ?? []).find(o => o.id === opt.name);
    if (!catalogOpt) {
      v2Options ??= (await pf(`/v2/catalog-products/${id}`)).data?.product_options ?? [];
      const v2Opt = v2Options.find(o => o.name === opt.name);
      if (!v2Opt) {
        fail(`product ${id}: option '${opt.name}' no longer exists (checked v1 and v2)`);
        continue;
      }
      catalogOpt = { values: v2Opt.values };
    }
    const valid = Array.isArray(catalogOpt.values) ? catalogOpt.values : Object.keys(catalogOpt.values ?? {});
    if (valid.length && !valid.includes(opt.value)) {
      fail(
        `product ${id}: option '${opt.name}' value '${opt.value}' no longer valid ` +
          `(valid: ${valid.join(', ')})`
      );
    }
  }

  // 3+4: placements + printfile dimensions (v1)
  const { result: pfiles } = await pf(`/mockup-generator/printfiles/${id}`);
  const availablePlacements = new Set(Object.keys(pfiles.available_placements ?? {}));
  for (const placement of cfg.placements ?? []) {
    if (!availablePlacements.has(placement)) {
      fail(`product ${id}: configured mockup placement '${placement}' missing from catalog (has: ${[...availablePlacements].join(', ')})`);
    }
  }
  const dims = {};
  for (const file of pfiles.printfiles ?? []) {
    dims[file.printfile_id] = `${file.width}x${file.height}`;
  }
  newBaseline[id] = dims;
  if (!WRITE_BASELINE) {
    const expected = baseline[id];
    if (!expected) {
      fail(`product ${id}: no baseline entry -- run --write-baseline`);
    } else {
      for (const [pfId, size] of Object.entries(expected)) {
        if (dims[pfId] !== size) {
          fail(`product ${id}: printfile ${pfId} dimensions changed ${size} -> ${dims[pfId] ?? 'GONE'}`);
        }
      }
    }
  }

  // 5+6: mockup style existence + per-variant coverage (v2)
  const stylesByPlacement = await pfV2AllPages(`/v2/catalog-products/${id}/mockup-styles`);
  // Style ids repeat across placement groupings; merge restriction lists (null = open).
  const styleRestrictions = new Map();
  for (const group of stylesByPlacement) {
    for (const style of group.mockup_styles ?? []) {
      const restricted = style.restricted_to_variants?.length ? style.restricted_to_variants : null;
      if (!styleRestrictions.has(style.id)) {
        styleRestrictions.set(style.id, restricted);
      } else {
        const prev = styleRestrictions.get(style.id);
        styleRestrictions.set(style.id, prev && restricted ? [...new Set([...prev, ...restricted])] : null);
      }
    }
  }
  const configuredStyleIds = new Set([
    ...(cfg.mockupStyleIds ?? []),
    ...Object.values(cfg.mockupStyleIdsByVariant ?? {}).flat()
  ]);
  for (const styleId of configuredStyleIds) {
    if (!styleRestrictions.has(styleId)) fail(`product ${id}: mockup style ${styleId} no longer exists`);
  }
  for (const variant of productResult.variants ?? []) {
    const resolved = cfg.mockupStyleIdsByVariant?.[variant.id] ?? cfg.mockupStyleIds ?? [];
    for (const styleId of resolved) {
      const restricted = styleRestrictions.get(styleId);
      if (restricted && !restricted.includes(variant.id)) {
        fail(
          `product ${id}: variant ${variant.id} (${variant.name}) resolves style ${styleId}, ` +
            `which is restricted to variants [${restricted.join(', ')}] -- the pillow failure mode`
        );
      }
    }
  }
}

if (WRITE_BASELINE) {
  writeFileSync(BASELINE_PATH, JSON.stringify(newBaseline, null, 2) + '\n');
  console.log(`Baseline written to ${BASELINE_PATH}`);
}

if (failures.length) {
  console.error(`\n${failures.length} finding(s).`);
  process.exit(1);
}
console.log('\nAll checks passed.');
