// An order's shipments, read back from Printful's v1 API (GET /orders/{id}), and whether they
// have all arrived. Shared by printful-webhook (records tracking when an order ships) and
// order-watchdog (moves a shipped order to 'delivered' once Printful says it arrived).
//
// v1 on purpose: v2 is still a beta, and v1's order already carries what this needs. Each
// shipment has `delivered_at` (unix seconds, null until the carrier reports delivery) --
// verified 2026-10-24 on this store's own orders: set on the three that had arrived, null on
// one shipped the day before.
//
// Plain fetch, no supabase-js: order-watchdog imports this and is kept SDK-free for the same
// bundle-timeout reason as render-print-file.

const PRINTFUL_API_BASE = "https://api.printful.com";
const STORE_ID = "18363066"; // same store as stripe-webhook -- an account id, not a secret

// What orders.shipments stores, newest last as Printful lists them (see migration 0019).
export type Shipment = {
  carrier: string | null;
  service: string | null;
  tracking_number: string | null;
  tracking_url: string | null;
  shipped_at: string | null;
  delivered_at: string | null;
};

// Shipment statuses that will never arrive: called off, or sent back. A reshipment is its own
// shipment, so leaving these out is what lets a returned-then-reshipped order count as delivered
// once the replacement lands. Only "shipped" has been seen in this store's data; these two are
// Printful's documented outcomes, and a status not listed here counts as still on its way, so an
// unfamiliar one makes an order wait rather than claim a delivery.
const NOT_EXPECTED_STATUSES = new Set(["canceled", "returned"]);

const isoFromUnix = (value: unknown) =>
  typeof value === "number" ? new Date(value * 1000).toISOString() : null;

// Throws on any failure, so a caller can retry (the webhook asks Printful to redeliver; the
// watchdog simply checks again on its next run).
export async function fetchShipments(
  printfulOrderId: string | number,
  signal?: AbortSignal
): Promise<{ shipments: Shipment[]; deliveredAt: string | null }> {
  const apiKey = Deno.env.get("PRINTFUL_API_KEY");
  if (!apiKey) throw new Error("PRINTFUL_API_KEY is not set");
  const res = await fetch(`${PRINTFUL_API_BASE}/orders/${printfulOrderId}`, {
    headers: { Authorization: `Bearer ${apiKey}`, "X-PF-Store-Id": STORE_ID },
    signal
  });
  if (!res.ok) throw new Error(`GET /orders/${printfulOrderId} -> ${res.status}`);
  const body = await res.json();
  const raw = (body.result?.shipments ?? []) as Array<Record<string, unknown>>;

  const shipments = raw.map(s => ({
    carrier: (s.carrier as string) ?? null,
    service: (s.service as string) ?? null,
    tracking_number: s.tracking_number != null ? String(s.tracking_number) : null,
    // Only an https link is ever stored: the account page renders it as an href.
    tracking_url:
      typeof s.tracking_url === "string" && s.tracking_url.startsWith("https://")
        ? s.tracking_url
        : null,
    shipped_at: isoFromUnix(s.shipped_at),
    delivered_at: isoFromUnix(s.delivered_at)
  }));

  // Delivered once EVERY package still expected has arrived, dated by the last of them. An order
  // in several boxes is not delivered while one is still in transit.
  const expected = raw.filter(s => !NOT_EXPECTED_STATUSES.has(String(s.status)));
  const deliveredAt =
    expected.length > 0 && expected.every(s => typeof s.delivered_at === "number")
      ? isoFromUnix(Math.max(...expected.map(s => s.delivered_at as number)))
      : null;

  return { shipments, deliveredAt };
}
