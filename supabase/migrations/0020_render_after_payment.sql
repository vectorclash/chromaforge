-- Print files are rendered AFTER payment (2026-10-19). See process-order's header comment.
--
-- order_items.print_jobs: one render request per placement, written by create-checkout-session
-- after checking it against Printful's printfile specs. process-order renders each one and adds
-- the finished URL to print_file_urls, which then holds every file Printful is sent (it already
-- held the label marks, which the browser still renders). Null on orders from before this.
--
-- orders.print_*: process-order's bookkeeping, written by the service role only (orders has no
-- client insert/update policy at all -- see 0005). Readable by the owner like every other order
-- column, which is harmless: it is their own order's progress.
--   print_lease_until  a run is in progress until then; one run per order at a time.
--   print_attempts     runs started, bounded by process-order's MAX_ATTEMPTS. A run that only
--                      found a generator-version hold gives its attempt back.
--   print_hold         set while render-service is on a different generator version from the
--                      design the customer saw; the order waits rather than print a different
--                      picture. Cleared once it renders.

alter table public.order_items
  add column if not exists print_jobs jsonb;

alter table public.orders
  add column if not exists print_lease_until timestamptz,
  add column if not exists print_attempts integer not null default 0,
  add column if not exists print_hold text;

-- order-watchdog now RESUMES stalled orders, not just alerts, so it runs every 5 minutes instead of
-- every 30. Same command, reused from the existing job so the shared X-Cleanup-Key secret is never
-- written into this file (cron.schedule with an existing job name replaces that job).
select cron.schedule(
  'order-watchdog',
  '*/5 * * * *',
  (select command from cron.job where jobname = 'order-watchdog')
);
