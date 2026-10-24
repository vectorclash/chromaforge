// Fills orders.shipments for orders that shipped before printful-webhook started recording
// tracking (0019), or whose webhook could not reach Printful at the time. Reads each order back
// from Printful's v1 API -- the same read the webhook does -- and writes only rows whose
// shipments are still empty.
//
//   node scripts/backfill-order-shipments.mjs --dry-run
//   node scripts/backfill-order-shipments.mjs
//
// Needs VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and PRINTFUL_API_KEY (all in .env.local).
// Re-runnable: a row that already has shipments is never selected.

import fs from 'node:fs';

for (const line of fs.existsSync('.env.local') ? fs.readFileSync('.env.local', 'utf8').split('\n') : []) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

const SUPABASE_URL = process.env.VITE_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const PRINTFUL_KEY = process.env.PRINTFUL_API_KEY;
const STORE_ID = '18363066';
const dryRun = process.argv.includes('--dry-run');

if (!SUPABASE_URL || !SERVICE_KEY || !PRINTFUL_KEY) {
  console.error('Missing VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY or PRINTFUL_API_KEY');
  process.exit(1);
}

const db = (path, init = {}) =>
  fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      ...init.headers
    }
  });

// Same normalisation as supabase/functions/_shared/printfulShipments.ts -- keep the two in step.
function normalise(s) {
  return {
    carrier: s.carrier ?? null,
    service: s.service ?? null,
    tracking_number: s.tracking_number != null ? String(s.tracking_number) : null,
    tracking_url:
      typeof s.tracking_url === 'string' && s.tracking_url.startsWith('https://')
        ? s.tracking_url
        : null,
    shipped_at: typeof s.shipped_at === 'number' ? new Date(s.shipped_at * 1000).toISOString() : null,
    delivered_at:
      typeof s.delivered_at === 'number' ? new Date(s.delivered_at * 1000).toISOString() : null
  };
}

const res = await db(
  'orders?select=id,printful_order_id,status&printful_order_id=not.is.null&shipments=is.null' +
    '&status=in.(submitted,on_hold,fulfilled,delivered,refunded)&order=created_at.asc'
);
if (!res.ok) {
  console.error(`orders query failed: ${res.status} ${await res.text()}`);
  process.exit(1);
}
const orders = await res.json();
console.log(`${orders.length} order(s) without shipments${dryRun ? ' (dry run)' : ''}`);

let written = 0;
for (const order of orders) {
  const pf = await fetch(`https://api.printful.com/orders/${order.printful_order_id}`, {
    headers: { Authorization: `Bearer ${PRINTFUL_KEY}`, 'X-PF-Store-Id': STORE_ID }
  });
  if (!pf.ok) {
    console.log(`  ${order.id.slice(0, 8)}  Printful ${order.printful_order_id} -> ${pf.status}, skipped`);
    continue;
  }
  const shipments = ((await pf.json()).result?.shipments ?? []).map(normalise);
  if (shipments.length === 0) {
    console.log(`  ${order.id.slice(0, 8)}  ${order.status}: not shipped yet`);
    continue;
  }
  const summary = shipments.map(s => `${s.carrier} ${s.tracking_number}`).join(', ');
  if (dryRun) {
    console.log(`  ${order.id.slice(0, 8)}  would write ${shipments.length}: ${summary}`);
    continue;
  }
  // shipments=is.null again on the write, so a webhook that landed in the meantime wins.
  const up = await db(`orders?id=eq.${order.id}&shipments=is.null`, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ shipments })
  });
  if (!up.ok) {
    console.log(`  ${order.id.slice(0, 8)}  write failed: ${up.status} ${await up.text()}`);
    continue;
  }
  const rows = await up.json();
  written += rows.length;
  console.log(`  ${order.id.slice(0, 8)}  ${rows.length ? 'wrote' : 'already filled'}: ${summary}`);
}
if (!dryRun) console.log(`${written} row(s) written`);
