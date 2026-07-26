// Validates that Printful's v1 orders API accepts a product's full placement set and its
// required item options -- WITHOUT any money, any Stripe involvement, or touching
// STORE_ENABLED / PRINTFUL_SKIP_CONFIRM.
//
//   PRINTFUL_API_KEY=... node scripts/check-printful-draft-orders.mjs --products 390,615,654
//
// Run this whenever a product is added to PRODUCT_MOCKUP_CONFIG, before it can be bought.
// Mockups passing proves nothing about ordering: a mockup exercises Printful's mockup
// generator, while the failures this catches happen at ORDER time and have bitten this
// project repeatedly -- the zip hoodie 400ing without an explicit stitch_color, the track
// jacket rejecting `details` alongside the sleeves, and every label_inside order silently
// failing on the v2 API (the reason stripe-webhook runs on v1 at all).
//
// WHY THIS IS FREE: POST /orders creates an UNCONFIRMED DRAFT. Printful only charges and
// produces once POST /orders/{id}/confirm is called, which this script never does. Drafts
// are deleted at the end unless --keep. Note that v1's DELETE marks a draft `canceled` and
// leaves it visible in the dashboard rather than removing it -- that is Printful's
// behaviour, not a failure here.
//
// WHY IT WAITS: the v2 label_inside failure was ASYNCHRONOUS -- create returned 200, then
// the order flipped to `failed` 10-40s later with its placements silently emptied. A clean
// create therefore proves nothing on its own, so every order is re-read after a delay and
// judged on its per-file statuses.
//
// FIDELITY, stated plainly: every placement gets the same stand-in image by default (the
// deployed og-image.jpg -- chosen because it is stable and public, unlike the
// content-hashed bucket renders which cleanup-storage deletes within days). That is
// deliberate: this checks whether Printful ACCEPTS AND PROCESSES a file at each placement,
// which is what has actually failed. It does NOT check that the artwork is composed
// correctly for the garment -- mockups already cover that. Pass --file <url> to use a real
// print render instead.
//
// Flags: --products <ids>  comma-separated, required
//        --file <url>      stand-in image (default: the deployed og-image.jpg)
//        --wait <seconds>  async settle time before re-reading (default 45)
//        --keep            leave the drafts in place instead of deleting them

import { PRODUCT_MOCKUP_CONFIG } from '../src/lib/printfulMockupConfig.js';

const API = 'https://api.printful.com';
const KEY = process.env.PRINTFUL_API_KEY;

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
};
const has = name => process.argv.includes(`--${name}`);

const productsArg = arg('products');
const FILE_URL = arg('file', 'https://chromaforge.app/og-image.jpg');
const WAIT_MS = Number(arg('wait', '45')) * 1000;

if (!KEY) {
  console.error('PRINTFUL_API_KEY is required (it is in .env.local).');
  process.exit(1);
}
if (!productsArg) {
  console.error('--products is required, e.g. --products 390,615,654');
  console.error(`configured products: ${Object.keys(PRODUCT_MOCKUP_CONFIG).join(', ')}`);
  process.exit(1);
}

const productIds = productsArg.split(',').map(s => s.trim()).filter(Boolean);

// A draft order still needs a deliverable address -- Printful validates it on create, so a
// junk address would fail for reasons unrelated to what is being tested. This is the store
// owner's own address and nothing is ever produced or shipped.
const RECIPIENT = {
  name: 'Aaron Sterczewski',
  address1: '855 Folsom St',
  address2: 'Apt 303',
  city: 'San Francisco',
  country_code: 'US',
  state_code: 'CA',
  zip: '94107'
};

const api = async (path, init) => {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', ...init?.headers }
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  console.log(`stand-in file: ${FILE_URL}`);
  const probe = await fetch(FILE_URL, { method: 'HEAD' });
  if (!probe.ok) {
    console.error(`stand-in file is not fetchable (${probe.status}) -- Printful fetches files by URL, so this would fail every order for the wrong reason.`);
    process.exit(1);
  }

  const created = [];
  const failures = [];

  for (const id of productIds) {
    const cfg = PRODUCT_MOCKUP_CONFIG[id];
    console.log(`\n${'='.repeat(66)}\nproduct ${id}${cfg ? '' : '  (NOT in PRODUCT_MOCKUP_CONFIG)'}\n${'='.repeat(66)}`);

    const pf = await api(`/mockup-generator/printfiles/${id}`);
    if (pf.status !== 200) {
      console.log(`  printfile lookup failed: http ${pf.status}`);
      failures.push({ id, reason: `printfile lookup http ${pf.status}` });
      continue;
    }

    // First variant is enough: placements and required options are per-PRODUCT, not per
    // variant, so whichever variant a customer picks exercises the same shape.
    const entry = pf.body.result.variant_printfiles[0];
    const placements = Object.keys(entry.placements);

    // Every placement Printful lists, matching resolvePlacementEntries' no-filter behaviour
    // for real orders -- a placement left out prints as blank fabric on the real garment.
    // v1 file types match our placement keys except 'front', which v1 calls 'default'.
    const files = placements.map(p => ({ type: p === 'front' ? 'default' : p, url: FILE_URL }));

    // Same { name, value } -> { id, value } mapping stripe-webhook does. Load-bearing: v1
    // hard-rejects some products without their required option.
    const options = cfg?.productOptions?.map(({ name, value }) => ({ id: name, value }));

    console.log(`  variant  ${entry.variant_id}`);
    console.log(`  options  ${options ? options.map(o => `${o.id}=${o.value}`).join(', ') : 'none configured'}`);
    console.log(`  files    ${files.map(f => f.type).join(', ')}`);

    const res = await api('/orders', {
      method: 'POST',
      body: JSON.stringify({
        recipient: RECIPIENT,
        packing_slip: {
          email: 'support@chromaforge.app',
          store_name: 'Chromaforge',
          logo_url: 'https://chromaforge.app/apple-touch-icon.png',
          message: 'Thanks for supporting Chromaforge! chromaforge.app',
          // Printful caps custom_order_id at 20 chars -- a real uuid blew past it and 400ed
          // every order once (2026-07-16). Keep anything put here short.
          custom_order_id: `drafttest${id}`
        },
        items: [{ quantity: 1, variant_id: entry.variant_id, ...(options ? { options } : {}), files }]
      })
    });

    if (res.status !== 200) {
      const msg = res.body?.result || res.body?.error?.message || 'unknown';
      console.log(`  CREATE FAILED  http ${res.status}: ${msg}`);
      failures.push({ id, reason: `create http ${res.status}: ${msg}` });
      continue;
    }
    console.log(`  created draft ${res.body.result.id}`);
    created.push({ id, orderId: res.body.result.id });
  }

  if (created.length) {
    console.log(`\nwaiting ${WAIT_MS / 1000}s for async file processing...`);
    await sleep(WAIT_MS);
  }

  console.log(`\n${'='.repeat(66)}\nRESULT\n${'='.repeat(66)}`);
  for (const c of created) {
    const r = (await api(`/orders/${c.orderId}`)).body?.result;
    const states = (r?.items?.[0]?.files || []).map(f => `${f.type}:${f.status}`);
    const notOk = states.filter(s => !s.endsWith(':ok'));
    const ok = r?.status === 'draft' && states.length > 0 && notOk.length === 0;
    if (!ok) failures.push({ id: c.id, reason: `status=${r?.status} error=${r?.error || 'none'} bad=${notOk.join(',') || 'no files'}` });
    console.log(`${ok ? 'PASS' : 'FAIL'}  product ${c.id}  order ${c.orderId}  status=${r?.status}  files=${states.length}`);
    console.log(`      ${states.join(', ') || 'NO FILES (placements emptied -- the v2 label_inside signature)'}`);
    if (r?.error) console.log(`      error: ${r.error}`);
  }

  if (!created.length) {
    // Nothing reached Printful, so there is nothing to clean up and nothing was proven.
  } else if (!has('keep')) {
    for (const c of created) {
      await api(`/orders/${c.orderId}`, { method: 'DELETE' });
    }
    console.log(`\ndeleted ${created.length} draft order(s) (they show as 'canceled' in the dashboard)`);
  } else {
    console.log(`\nkept: ${created.map(c => c.orderId).join(' ')}`);
  }

  if (failures.length) {
    console.log('\nFAILURES:');
    for (const f of failures) console.log(`  product ${f.id}: ${f.reason}`);
    process.exit(1);
  }
  console.log('\nAll products accepted.');
}

main().catch(e => {
  console.error('FATAL', e);
  process.exit(1);
});
