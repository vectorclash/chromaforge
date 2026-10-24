-- 'delivered': a shipped order has arrived (2026-10-24, Aaron: a shipped order had already moved
-- to the account page's order history while it was still on its way).
--
-- Until now 'fulfilled' was where the happy path ENDED, so an order left the Active list the
-- moment Printful shipped it -- exactly when its "Track package" link matters most. Printful's v1
-- order turns out to report delivery after all (each shipment's delivered_at), so the lifecycle
-- gains its real last step:
--
--   Active  = paid, submitted, on_hold, fulfilled ("Shipped")
--   History = delivered, refunded, failed, canceled
--
-- order-watchdog moves fulfilled -> delivered (see _shared/printfulShipments.ts); nothing else
-- writes it. orders.delivered_at is when the last package arrived, per the carrier.
--
-- No backfill here: the watchdog's first run after deploy moves every order that has already
-- arrived (three as of today). No grant needed: only the service role writes orders, and
-- `authenticated` keeps its table-level SELECT under the existing owner-only row policy.

alter table public.orders
  drop constraint orders_status_check;

alter table public.orders
  add constraint orders_status_check
    check (status in (
      'pending', 'paid', 'submitted', 'on_hold', 'fulfilled', 'delivered', 'refunded', 'failed',
      'canceled'
    ));

alter table public.orders add column if not exists delivered_at timestamptz;
