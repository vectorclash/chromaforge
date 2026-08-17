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
type TerminalStatus = "canceled" | "failed" | "fulfilled";

const TERMINAL_EVENT_STATUS: Record<string, TerminalStatus> = {
  order_canceled: "canceled",
  order_failed: "failed"
};
const TERMINAL_PRINTFUL_STATUS: Record<string, TerminalStatus> = {
  canceled: "canceled",
  archived: "canceled",
  failed: "failed",
  // The one terminal status that is GOOD news, arriving (like `archived` above) as a plain
  // order_updated rather than an event type of its own -- Printful publishes no
  // "order_fulfilled" event. Without this the happy path had no terminal value at all, so a
  // produced-and-shipped order stayed `submitted` and sat in the account page's Active list
  // reading "In production" indefinitely. Note this branch is reached only via the status
  // value, never via TERMINAL_EVENT_STATUS, which is why that map stays failure-only.
  fulfilled: "fulfilled"
};

// Not every terminal status is a failure, so the two must not be conflated: only these write
// a failure_reason and raise an alert email. Getting this wrong would stamp a perfectly good
// order with "Failed via Printful" and page a human about a successful delivery.
const FAILURE_STATUSES = new Set<TerminalStatus>(["canceled", "failed"]);

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
  const terminalStatus =
    TERMINAL_EVENT_STATUS[event.type] ?? (printfulStatus ? TERMINAL_PRINTFUL_STATUS[printfulStatus] : undefined);

  if (!terminalStatus) {
    // Genuinely ambiguous (order_refunded/hold events, or an order_updated whose status
    // isn't one of the known terminal values) -- mirror Printful's own status for visibility
    // without guessing at our own status enum.
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
  // Printful retries deliveries (the payload carries a `retries` count), so the same
  // order_canceled/order_failed event can arrive more than once. Guarding the update on
  // `status <> terminalStatus` means a repeat delivery is a no-op here too, and in particular
  // never sends a second alert email for the same real-world event.
  const isFailure = FAILURE_STATUSES.has(terminalStatus);
  const { data: updatedRows, error: updateError } = await supabase
    .from("orders")
    .update({
      status: terminalStatus,
      ...(isFailure
        ? { failure_reason: terminalStatus === "canceled" ? "Canceled via Printful" : "Failed via Printful" }
        : {}),
      printful_status: printfulStatus,
      printful_status_at: new Date().toISOString()
    })
    .eq("id", order.id)
    .neq("status", terminalStatus)
    .select("id");
  if (updateError) {
    console.error("printful-webhook: failed to update order status", updateError);
    return new Response("Update failed", { status: 500 });
  }

  if (isFailure && updatedRows && updatedRows.length > 0) {
    await sendOrderFailureAlert(
      order.id,
      `Printful ${terminalStatus === "canceled" ? "canceled" : "failed"} this order after it was submitted ` +
        `(printful_order_id ${printfulOrderId}).`
    );
  }

  return new Response("ok", { status: 200 });
});
