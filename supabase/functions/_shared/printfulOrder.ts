// Builds and submits the real Printful order for a paid Chromaforge order. Moved out of
// stripe-webhook (2026-10-19) when print files started rendering after payment: process-order
// now submits, once every file exists. The body and the create-then-confirm sequence are
// unchanged from the webhook's version; what is new is `onCreated`, so the caller can record
// Printful's id the moment the draft exists. A run that dies between create and confirm is now
// resumed by order-watchdog, and resuming with that id confirms the existing draft instead of
// creating a second one.
//
// Printful order API: the STABLE v1 orders API, not the v2 beta -- v2's order pipeline fails any
// order containing the label_inside placement (live-proven 2026-07-15; see CLAUDE.md). POST
// /orders creates an unconfirmed DRAFT; POST /orders/{id}/confirm actually charges and produces.
//
// PRINTFUL_SKIP_CONFIRM=true leaves every order as an unconfirmed draft (Printful has no sandbox),
// for end-to-end testing. Unset it before real customers can check out.

const PRINTFUL_API_BASE = "https://api.printful.com";
const STORE_ID = "18363066"; // same store as printful-mockup -- not a secret, just an account id

// The subset of a Stripe Checkout Session this reads. The same JSON whether it came from the
// Stripe SDK or a plain REST fetch.
export type StripeSession = {
  currency?: string | null;
  amount_subtotal?: number | null;
  amount_total?: number | null;
  total_details?: { amount_discount?: number; amount_shipping?: number; amount_tax?: number } | null;
  customer_details?: { email?: string | null; name?: string | null } | null;
  collected_information?: {
    shipping_details?: {
      name?: string | null;
      address?: {
        line1?: string | null;
        line2?: string | null;
        city?: string | null;
        country?: string | null;
        state?: string | null;
        postal_code?: string | null;
      } | null;
    } | null;
  } | null;
};

export type OrderItemRow = {
  quantity: number;
  variant_id: number;
  unit_price_cents: number;
  product_options: Array<{ name: string; value: string }> | null;
  print_file_urls: Record<string, string>;
};

// Stripe minor units -> Printful's decimal strings.
const money = (cents: number | null | undefined) => ((cents ?? 0) / 100).toFixed(2);

function retailCosts(session: StripeSession) {
  const details = session.total_details;
  return {
    currency: (session.currency ?? "usd").toUpperCase(),
    subtotal: money(session.amount_subtotal),
    discount: money(details?.amount_discount),
    shipping: money(details?.amount_shipping),
    tax: money(details?.amount_tax),
    total: money(session.amount_total)
  };
}

export function buildPrintfulOrderBody(orderId: string, session: StripeSession, items: OrderItemRow[]) {
  // Stripe API versions from 2025-03-31 onward moved shipping details under
  // collected_information -- confirmed live against this account, pinned to 2026-06-24.dahlia.
  const shippingDetails = session.collected_information?.shipping_details;

  // Branded packing slip -- the paper insert Printful puts in the box. logo_url must be a raster
  // image; packing-slip-mark.png is the mark as black lines on white, cropped tight because
  // Printful fits every slip logo into a 175x117 box. Printful copies the image at order creation
  // and may reuse a copy fetched from the same URL, so a changed logo gets a NEW filename.
  // custom_order_id is capped at 20 chars by Printful (a full uuid 400'd every order, 2026-07-17),
  // hence dashes stripped and truncated -- still enough for `orders.id::text like '<prefix>%'`.
  const packingSlip = {
    email: "support@chromaforge.app",
    store_name: "Chromaforge",
    logo_url: "https://chromaforge.app/packing-slip-mark.png",
    // Same text as the store's default slip message in the Printful dashboard (which only
    // applies to orders created there by hand) -- keep the two matching.
    message:
      "Thanks for supporting Chromaforge! Your piece was printed just for you. Show it off and " +
      "tag @chromaforge.app — and make your next one at chromaforge.app",
    custom_order_id: orderId.replace(/-/g, "").slice(0, 20)
  };

  return {
    recipient: {
      name: shippingDetails?.name ?? session.customer_details?.name ?? "",
      // Without an email, Printful has no way to send the customer shipping/tracking
      // notifications -- they'd get nothing between the success page and the package.
      email: session.customer_details?.email ?? undefined,
      address1: shippingDetails?.address?.line1 ?? "",
      address2: shippingDetails?.address?.line2 ?? undefined,
      city: shippingDetails?.address?.city ?? "",
      country_code: shippingDetails?.address?.country ?? "",
      state_code: shippingDetails?.address?.state ?? "",
      zip: shippingDetails?.address?.postal_code ?? ""
    },
    packing_slip: packingSlip,
    // What the customer actually paid, for Printful's international paperwork (packing slips and
    // customs use retail prices, and fall back to Printful's wholesale costs without them).
    // Applied only when EVERY item carries a retail_price.
    retail_costs: retailCosts(session),
    items: items.map(item => ({
      quantity: item.quantity,
      variant_id: item.variant_id,
      retail_price: (item.unit_price_cents / 100).toFixed(2),
      // Stored in the v2/mockup shape ({ name, value }); v1 item options use { id, value }, and
      // v1 HARD-REJECTS some products without their required option (the zip hoodie 400s
      // without stitch_color), so this mapping is load-bearing.
      ...(item.product_options
        ? { options: item.product_options.map(({ name, value }) => ({ id: name, value })) }
        : {}),
      // v1 file types match our placement keys except 'front', which v1 calls 'default'.
      files: Object.entries(item.print_file_urls).map(([placement, url]) => ({
        type: placement === "front" ? "default" : placement,
        url
      }))
    }))
  };
}

// Creates (unless `existingPrintfulOrderId` says a draft already exists) and confirms the order,
// with one retry, as the webhook always did. Returns Printful's id whenever a draft exists, even
// on failure -- it is the draft a human needs to find, and printful-webhook matches later events
// by it.
export async function submitPrintfulOrder({
  printfulKey,
  orderId,
  session,
  items,
  existingPrintfulOrderId,
  onCreated
}: {
  printfulKey: string;
  orderId: string;
  session: StripeSession;
  items: OrderItemRow[];
  existingPrintfulOrderId: string | null;
  onCreated: (printfulOrderId: string) => Promise<void>;
}): Promise<{ printfulOrderId: string | null; error: Error | null }> {
  const headers = {
    Authorization: `Bearer ${printfulKey}`,
    "X-PF-Store-Id": STORE_ID,
    "Content-Type": "application/json"
  };
  const skipConfirm = Deno.env.get("PRINTFUL_SKIP_CONFIRM") === "true";
  const body = buildPrintfulOrderBody(orderId, session, items);

  let printfulOrderId: string | null = existingPrintfulOrderId;
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      if (!printfulOrderId) {
        const createRes = await fetch(`${PRINTFUL_API_BASE}/orders`, {
          method: "POST",
          headers,
          body: JSON.stringify(body)
        });
        const createData = await createRes.json();
        if (!createRes.ok) {
          throw new Error(createData?.error?.message || `Printful order creation failed (${createRes.status})`);
        }
        const id = createData.result?.id ?? createData.data?.id;
        if (id == null) throw new Error("Printful returned no order id");
        printfulOrderId = String(id);
        await onCreated(printfulOrderId);
      }

      if (!skipConfirm) {
        const confirmRes = await fetch(`${PRINTFUL_API_BASE}/orders/${printfulOrderId}/confirm`, {
          method: "POST",
          headers
        });
        const confirmData = await confirmRes.json();
        if (!confirmRes.ok) {
          throw new Error(confirmData?.error?.message || `Printful order confirmation failed (${confirmRes.status})`);
        }
      } else {
        console.warn(
          `printfulOrder: PRINTFUL_SKIP_CONFIRM is set -- order ${printfulOrderId} left as an ` +
            `unconfirmed draft, not charged or produced. Unset this secret before going live.`
        );
      }
      return { printfulOrderId, error: null };
    } catch (err) {
      lastError = err instanceof Error ? err : new Error("Printful order submission failed");
      if (attempt === 0) {
        console.warn(`printfulOrder: submission attempt failed, retrying once: ${lastError.message}`);
        await new Promise(resolve => setTimeout(resolve, 1500));
      }
    }
  }
  return { printfulOrderId, error: lastError };
}
