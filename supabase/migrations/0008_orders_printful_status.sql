-- Mirrors Printful's own live order status, reported via the printful-webhook Edge Function
-- (Printful's v2 webhooks: order_canceled/order_failed/order_refunded/order_updated/hold
-- events -- see that function's header comment for the verified event list and payload
-- shape). Deliberately separate from `orders.status`, which represents *our* checkout
-- lifecycle (pending -> paid -> submitted/failed/canceled) -- Printful's own vocabulary can
-- drift in ways that don't cleanly collapse into that enum (onhold, partial, ...), and may
-- grow over time, so this is a live mirror of "whatever Printful last told us" rather than
-- another attempt to force everything into one status column.
--
-- printful-webhook still updates `status` directly (to 'canceled'/'failed') for the two
-- unambiguous terminal events -- those values already exist and already mean "this order
-- did not end up produced," so a Printful-side cancellation is a legitimate transition into
-- the same value, not a new concept requiring its own column to surface in the UI.

alter table public.orders
  add column printful_status text,
  add column printful_status_at timestamptz;
