-- Daily sweep of the design-mockups Storage bucket via the cleanup-storage Edge Function
-- (see supabase/functions/cleanup-storage/index.ts for the full rationale -- found
-- 2026-07-19 holding ~357MB of orphaned print renders + stale mockup sources, a third of
-- the Storage quota). Storage deletion has to go through the Storage API (deleting
-- storage.objects rows directly orphans the underlying S3 objects), hence the pg_net HTTP
-- call to an Edge Function instead of doing it in SQL like 0010's order cancellation.
--
-- The X-Cleanup-Key value here must match the function's CLEANUP_STORAGE_KEY secret
-- (npx supabase secrets set CLEANUP_STORAGE_KEY=...). It lives in this cron job's command
-- (readable only by privileged DB roles); if it's ever rotated, update BOTH places --
-- nothing ties them together automatically, same caveat as RENDER_SERVICE_KEY.
--
-- Applied to the live project via the Supabase MCP apply_migration path, NOT `db push` --
-- see 0010's note on this project's migration-history drift.
create extension if not exists pg_net;

select cron.schedule(
  'cleanup-design-mockups-storage',
  '41 4 * * *', -- daily, off-peak, offset from the hourly order-cancel job
  $$
  select net.http_post(
    url := 'https://fgrhbzqzadpjpbzuszpm.supabase.co/functions/v1/cleanup-storage',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'X-Cleanup-Key', '7ea971807026bc2b2b823c9c591c955ad94f38d76a51ef75b28e9e21ff4b18d6'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  )
  $$
);
