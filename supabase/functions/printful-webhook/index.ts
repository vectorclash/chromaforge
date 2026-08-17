// Reconciles local `orders` rows with Printful's own live order state -- previously a
// one-way street: once stripe-webhook submitted an order, nothing here ever heard from
// Printful again, so a dashboard-side cancel/delete just left the row showing stale
// 'submitted'/"In production" forever. This function is the other half.
//
// verify_jwt is explicitly false for this function (set in supabase/config.toml) -- same
// reasoning as stripe-webhook: Printful's webhook caller carries no Supabase JWT, only its
// own signature headers. Auth here is entirely the signature check below.
//
// Verified directly against Printful's v2 API docs (developers.printful.com/docs/, the
// "Webhook v2" section), not guessed:
//   - Event types this handles: order_canceled, order_failed, order_refunded, order_updated,
//     order_put_hold, order_put_hold_approval, order_remove_hold. (order_created is ignored --
//     we already create the order ourselves in stripe-webhook. Shipment/catalog events are a
//     separate, not-yet-built feature -- there's no shipping/tracking UI yet.)
//   - Payload shape: { type, occurred_at, retries, store_id, data: { order: { id, external_id,
//     status, created, updated, dashboard_url } } }.
//   - Auth headers: `x-pf-webhook-signature` (hex HMAC-SHA256 of the raw request body) and
//     `x-pf-webhook-public-key` (base64, identifies which webhook configuration fired --
//     unused here since this store only ever registers one). The secret key used for the
//     HMAC is itself hex-encoded and must be decoded to raw bytes before use as the HMAC key.
//
// Needs secret: PRINTFUL_WEBHOOK_SECRET_KEY (the hex `secret_key` from the one-time
// POST /v2/webhooks registration response -- Printful only shows it once, at creation time;
// see this repo's TODO.md / setup notes for the exact registration command).
// SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY are auto-provided.
//
// Deploy with: npx supabase functions deploy printful-webhook --no-verify-jwt

import { createClient } from "@supabase/supabase-js";
import { sendOrderFailureAlert } from "../_shared/orderAlert.ts";

// Both event *type* and reported *status value* can carry the same real-world change --
// confirmed live: deleting an unconfirmed draft in the Printful dashboard delivers an
// order_updated event (not a dedicated cancel event) with data.order.status "archived". So
// the terminal check below keys off whichever signal is present, not just event.type alone --
// otherwise a real cancellation delivered as "just an update" would never flip our own
// status, leaving the order stuck looking active forever (the exact bug this function exists
// to close). Both target values already exist in the orders.status enum and already mean
// "this order did not end up produced," so this is a legitimate transition into an existing
// value, not a new concept.
type OrderStatus = "submitted" | "on_hold" | "fulfilled" | "refunded" | "failed" | "canceled";

// Events whose meaning is unambiguous from the TYPE alone -- no status string needed, which
// is what makes the hold/refund mappings evidence-based rather than a guess at Printful's
// vocabulary (their docs do not publish the full status enum anywhere we could find).
const EVENT_STATUS: Record<string, OrderStatus> = {
  order_canceled: "canceled",
  order_failed: "failed",
  order_refunded: "refunded",
  order_put_hold: "on_hold",
  order_put_hold_approval: "on_hold",
  // The only mapping that moves an order BACKWARD into an active state. Holds are the one
  // reversible thing Printful reports -- everything else here is one-way.
  order_remove_hold: "submitted"
};

// ...and the same real-world changes as they arrive via a plain order_updated instead.
// Confirmed live: deleting an unconfirmed draft in the dashboard delivers order_updated with
// status "archived", not a dedicated cancel event, so keying off event.type alone would let a
// real cancellation pass as "just an update" -- the exact bug this function exists to close.
//
// Every key here has been OBSERVED in this store's own orders.printful_status column, rather
// than taken from documentation: archived (11), fulfilled (2), canceled (1), onhold (1).
// Printful's other statuses (draft/pending/inprocess/partial) are deliberately unmapped --
// our `submitted` already means "in production", so they would be no-ops, and an unmapped
// status is safe by construction: it falls through to the mirror-only branch below.
const PRINTFUL_STATUS_STATUS: Record<string, OrderStatus> = {
  canceled: "canceled",
  archived: "canceled",
  failed: "failed",
  onhold: "on_hold",
  // The one terminal status that is GOOD news, and it arrives ONLY this way -- Printful
  // publishes no "order_fulfilled" event type. Without it the happy path had no terminal
  // value at all, so a produced-and-shipped order stayed `submitted` and sat in the account
  // page's Active list reading "In production" indefinitely.
  fulfilled: "fulfilled"
};

// Once an order reaches one of these, Printful has nothing left to tell us that should move
// it -- so a late or out-of-order delivery can never resurrect a finished order into the
// customer's Active list. `refunded` is exempt as a TARGET (see canTransition): a fulfilled
// order can be returned and a canceled one can still be refunded, and money moving is the
// more authoritative fact.
const TERMINAL_STATUSES = new Set<OrderStatus>(["fulfilled", "refunded", "failed", "canceled"]);

// Not every terminal status is a failure, and conflating the two would stamp a perfectly good
// order with "Failed via Printful" and page a human about a successful delivery. Only these
// write a failure_reason.
const FAILURE_STATUSES = new Set<OrderStatus>(["canceled", "failed"]);

// Which transitions are worth waking a human for, and what that human should actually DO --
// the action differs enough that one fixed line of advice would be wrong for most of them.
// `fulfilled` and `submitted` (a hold being lifted) are absent on purpose: both are good news
// and need nobody.
const ALERT_ACTION: Partial<Record<OrderStatus, string>> = {
  failed:
    "This customer is NOT auto-refunded -- check whether the order is fixable and " +
    "resubmittable, or refund via the Stripe dashboard.",
  canceled:
    "This customer is NOT auto-refunded -- check whether the order is fixable and " +
    "resubmittable, or refund via the Stripe dashboard.",
  on_hold:
    "Printful has paused this order and will not produce it until the hold is cleared. " +
    "Resolve it in the Printful dashboard -- holds are usually an address or payment issue.",
  refunded:
    "Printful has refunded this order on their side. The customer's own Stripe payment is " +
    "unaffected and is NOT refunded automatically -- refund it via the Stripe dashboard if " +
    "the customer is not receiving the goods."
};

const RECOGNIZED_EVENTS = new Set([
  "order_canceled",
  "order_failed",
  "order_refunded",
  "order_updated",
  "order_put_hold",
  "order_put_hold_approval",
  "order_remove_hold"
]);

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}

// Constant-time-ish comparison -- avoids a short-circuiting `===` leaking timing information
// about how many leading characters of the signature guessed right. Length is compared first
// since two hex digests of different lengths can never legitimately match anyway.
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

async function verifySignature(secretHex: string, rawBody: string, signatureHex: string): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    "raw",
    hexToBytes(secretHex),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
  return timingSafeEqual(bytesToHex(new Uint8Array(digest)), signatureHex);
}

Deno.serve(async req => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const secretKey = Deno.env.get("PRINTFUL_WEBHOOK_SECRET_KEY");
  if (!secretKey) {
    console.error("printful-webhook: missing PRINTFUL_WEBHOOK_SECRET_KEY");
    return new Response("Server misconfigured", { status: 500 });
  }

  // Raw bytes, not parsed JSON -- signature verification needs the exact request body,
  // which parsing and re-serializing would not faithfully reproduce.
  const rawBody = await req.text();
  const signature = req.headers.get("x-pf-webhook-signature");
  if (!signature || !(await verifySignature(secretKey, rawBody, signature))) {
    console.error("printful-webhook: signature verification failed");
    return new Response("Invalid signature", { status: 401 });
  }

  let event: {
    type: string;
    data?: { order?: { id: number | string; status?: string } };
  };
  try {
    event = JSON.parse(rawBody);
  } catch {
    console.error("printful-webhook: could not parse event body");
    return new Response("ok", { status: 200 }); // malformed, not something a retry will fix
  }

  if (!RECOGNIZED_EVENTS.has(event.type)) {
    // Includes order_created (we already create the row ourselves) and any future event
    // type this function doesn't yet know about -- acknowledge cleanly rather than erroring,
    // since an unknown event isn't a delivery failure.
    return new Response("ok", { status: 200 });
  }

  const printfulOrderId = event.data?.order?.id;
  if (printfulOrderId == null) {
    console.error(`printful-webhook: ${event.type} event has no data.order.id`);
    return new Response("ok", { status: 200 });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  const { data: order, error: fetchError } = await supabase
    .from("orders")
    .select("id, status")
    .eq("printful_order_id", String(printfulOrderId))
    .maybeSingle();
  if (fetchError) {
    console.error("printful-webhook: failed to look up order", fetchError);
    return new Response("Lookup failed", { status: 500 }); // transient -- let Printful retry
  }
  if (!order) {
    // Not every Printful order in this store necessarily has a matching row here (e.g. a
    // manually-created test order) -- a no-op, not a failure.
    console.warn(`printful-webhook: no local order found for printful_order_id ${printfulOrderId}`);
    return new Response("ok", { status: 200 });
  }

  const printfulStatus = event.data?.order?.status ?? null;
  const mapped =
    EVENT_STATUS[event.type] ?? (printfulStatus ? PRINTFUL_STATUS_STATUS[printfulStatus] : undefined);
  // A finished order stays finished: a late, retried or out-of-order delivery must never
  // resurrect one into the customer's Active list. Money moving is the exception -- a
  // fulfilled order can be returned and a canceled one can still be refunded.
  const targetStatus =
    mapped && (mapped === "refunded" || !TERMINAL_STATUSES.has(order.status as OrderStatus))
      ? mapped
      : undefined;

  if (!targetStatus) {
    // Either genuinely ambiguous (an order_updated whose status isn't one we map -- see
    // PRINTFUL_STATUS_STATUS for why draft/pending/inprocess/partial are left out) or a
    // change we are deliberately refusing to apply to an already-finished order. Either way,
    // mirror Printful's own status for visibility without touching our own lifecycle.
    const { error: mirrorError } = await supabase
      .from("orders")
      .update({ printful_status: printfulStatus, printful_status_at: new Date().toISOString() })
      .eq("id", order.id);
    if (mirrorError) {
      console.error("printful-webhook: failed to update printful_status", mirrorError);
      return new Response("Update failed", { status: 500 }); // transient -- let Printful retry
    }
    return new Response("ok", { status: 200 });
  }

  // .select() so we know whether this delivery is the one that actually changed the status --
  // Printful retries deliveries (the payload carries a `retries` count), so the same event can
  // arrive more than once. Guarding the update on `status <> targetStatus` means a repeat
  // delivery is a no-op here too, and in particular never sends a second alert email for the
  // same real-world event.
  //
  // failure_reason is written only for the two genuine failures, exactly as before. It is an
  // ops-only column (nothing in the frontend renders it) and printful_status already records
  // Printful's own vocabulary precisely, so inventing text for holds and refunds would only
  // create a value that goes stale the moment a hold is lifted.
  const isFailure = FAILURE_STATUSES.has(targetStatus);
  const { data: updatedRows, error: updateError } = await supabase
    .from("orders")
    .update({
      status: targetStatus,
      ...(isFailure
        ? { failure_reason: targetStatus === "canceled" ? "Canceled via Printful" : "Failed via Printful" }
        : {}),
      printful_status: printfulStatus,
      printful_status_at: new Date().toISOString()
    })
    .eq("id", order.id)
    .neq("status", targetStatus)
    .select("id");
  if (updateError) {
    console.error("printful-webhook: failed to update order status", updateError);
    return new Response("Update failed", { status: 500 });
  }

  const alertAction = ALERT_ACTION[targetStatus];
  if (alertAction && updatedRows && updatedRows.length > 0) {
    await sendOrderFailureAlert(
      order.id,
      `Printful moved this order to "${targetStatus}"${printfulStatus ? ` (their status: ${printfulStatus})` : ""} ` +
        `after it was submitted (printful_order_id ${printfulOrderId}).`,
      alertAction
    );
  }

  return new Response("ok", { status: 200 });
});
