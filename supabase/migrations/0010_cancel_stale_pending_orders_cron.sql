-- Cleanup for abandoned checkouts. create-checkout-session always writes a 'pending' orders
-- row (and creates a real Stripe Checkout Session) before the browser ever reaches Stripe --
-- if the customer never completes payment (closes the tab, leaves mid-render, or the
-- page-leave bug fixed 2026-07-17 that could strand one after the browser had already left
-- the page), nothing ever transitions that row out of 'pending'. There was no expiry
-- mechanism at all until now, so these accumulate forever.
--
-- Stripe's own Checkout Session already expires 24h after creation by default (no
-- expires_at override is set in create-checkout-session) -- past that point the session
-- can no longer be completed regardless, so anything still 'pending' after 24h is
-- guaranteed abandoned, not just probably abandoned. Mirrors that same window here.
--
-- Deliberately DB-only: the print/mockup files referenced by an abandoned order's
-- print_file_urls live in the design-mockups Storage bucket under a content-hashed path
-- (see src/lib/printful.js's uploadMockupSourceImage) and can be shared across multiple
-- orders and live mockup previews for the same design/product/size combo -- there's no
-- safe way to know a given file is only referenced by this one abandoned order, so Storage
-- is left untouched. Storage growth here is bounded by unique (design, product, placement,
-- size) combinations rendered, not by abandoned-checkout count.
create extension if not exists pg_cron;

-- Cheap even as the table grows: only ever matches the (usually empty) pending set.
create index orders_pending_created_at_idx on public.orders(created_at) where status = 'pending';

select cron.schedule(
  'cancel-stale-pending-orders',
  '23 * * * *', -- hourly, off the top of the hour
  $$
  update public.orders
  set status = 'canceled', failure_reason = 'Abandoned -- checkout was never completed'
  where status = 'pending' and created_at < now() - interval '24 hours'
  $$
);
