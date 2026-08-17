-- Adds a 'fulfilled' terminal status to orders, closing the gap where a successfully
-- produced-and-shipped order sat in the account page's Active list forever reading
-- "In production" (found 2026-08-17 from two real completed orders).
--
-- The enum only ever described how an order could FAIL to end (failed/canceled) -- there was
-- no value meaning "this one ended well," so `submitted` was terminal in practice.
-- printful-webhook mapped only order_canceled/order_failed into a status change, and its own
-- header comment called shipment events a not-yet-built feature.
--
-- No Printful webhook re-registration is needed for this, which is the useful part: the
-- existing `order_updated` subscription ALREADY delivers status "fulfilled", and the webhook
-- already verified those deliveries and recorded them -- it just had nowhere in our own enum
-- to put them, so they fell through its "genuinely ambiguous" branch and only mirrored
-- printful_status. Both real completed orders below were sitting there with
-- printful_status = 'fulfilled' already, which is what this backfill reads.

alter table public.orders
  drop constraint orders_status_check;

alter table public.orders
  add constraint orders_status_check
    check (status in ('pending', 'paid', 'submitted', 'fulfilled', 'failed', 'canceled'));

-- Backfill: any order Printful already told us it fulfilled, which we recorded but could not
-- act on. Deliberately driven off printful_status rather than a hardcoded id list, so this is
-- correct for however many such rows exist at apply time rather than only the two known ones.
-- Scoped to `submitted` so it can never resurrect a row that was later canceled or refunded.
update public.orders
   set status = 'fulfilled'
 where status = 'submitted'
   and printful_status = 'fulfilled';
