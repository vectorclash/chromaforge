-- Printful's real order API needs the same per-product options some AOP products require
-- for mockup-tasks too (e.g. stitch_color) -- see PRODUCT_MOCKUP_CONFIG in src/lib/printful.js.
-- Snapshotting this client-side at purchase time (same "frozen copy" approach as
-- design_data/print_file_urls) avoids duplicating that config inside the stripe-webhook
-- edge function, which can't import frontend JS modules and would otherwise drift out of
-- sync with the client-side source of truth.
alter table public.order_items add column product_options jsonb;
