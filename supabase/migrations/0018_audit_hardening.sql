-- Hardening from the 2026-09-22 audit. Every item here was confirmed against the live database
-- first, not inferred from the migration files.
--
-- Applied via the Supabase MCP tooling (apply_migration), like every schema change on this
-- project since 0010 -- see CLAUDE.md on why `supabase db push` is not used here.

-- ---------------------------------------------------------------------------------------------
-- 1. Column-level write permissions on designs and profiles.
--
-- RLS decides which ROWS a user may write; it says nothing about which COLUMNS. Supabase grants
-- the `authenticated` role table-wide INSERT/UPDATE, so an owner could write any column of their
-- own row -- measured live: authenticated held UPDATE on designs.likes_count and
-- profiles.is_admin. That let anyone:
--   - set their own design's likes_count to any number (the homepage's "top liked" section
--     sorts by it),
--   - backdate or future-date a design's created_at to pin it at the top of the newest-first
--     gallery,
--   - set profiles.is_admin = true on themselves. Nothing reads that flag server-side TODAY,
--     but the first admin-only feature built on it would have inherited the hole.
-- The fix is to revoke the table-wide grants and grant back exactly the columns the app writes.
-- A column-level REVOKE alone would not work: a table-level grant covers every column.
--
-- Unaffected, because they bypass these grants: the likes trigger (handle_like_change) and the
-- signup trigger (handle_new_user) are SECURITY DEFINER, and every Edge Function uses the
-- service role.
revoke insert, update on public.designs from anon, authenticated;
grant insert (user_id, title, kind, data, is_public) on public.designs to authenticated;
grant update (title, is_public) on public.designs to authenticated;

-- Profiles are created by the signup trigger, never by the client (src/lib/profiles.js only
-- ever updates), so no INSERT grant is needed at all.
revoke insert, update on public.profiles from anon, authenticated;
grant update (username, display_name, avatar_url) on public.profiles to authenticated;

-- ---------------------------------------------------------------------------------------------
-- 2. Size limits on user-written content.
--
-- designs.data had no limit, and every gallery query selects it (select('*')), so one
-- multi-megabyte row would be downloaded by every visitor -- the 2026-07-02 egress incident,
-- but deliberate this time. A real design is { generatorVersion, seed, colors, settings }:
-- the largest stored today is 352 bytes. 64KB leaves room for an animation's frame list.
alter table public.designs
  add constraint designs_data_size check (pg_column_size(data) <= 65536),
  add constraint designs_title_length check (title is null or char_length(title) <= 120);

alter table public.profiles
  add constraint profiles_username_length check (username is null or char_length(username) <= 40),
  add constraint profiles_display_name_length check (display_name is null or char_length(display_name) <= 80);

-- Storage buckets had no size or type limits, so a user could put any file of any size in their
-- own folder of a PUBLIC bucket (i.e. free hosting). Limits sit well above real usage, measured
-- live: largest thumbnail 172KB, largest avatar 12KB, largest print file 7.8MB. design-mockups
-- gets a type restriction but no size limit: print files are rendered server-side at up to
-- ~80Mpx, and a size cap there could fail a real checkout for no security gain (only the
-- service role and content-hashed mockup uploads write large files into it).
update storage.buckets
  set file_size_limit = 5242880, allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp']
  where id in ('design-thumbnails', 'avatars');
update storage.buckets
  set allowed_mime_types = array['image/jpeg', 'image/png']
  where id = 'design-mockups';

-- ---------------------------------------------------------------------------------------------
-- 3. Orders: settling payments and the stuck-order watchdog.

alter table public.orders
  add column if not exists paid_at timestamptz,
  add column if not exists watchdog_alerted_at timestamptz;

-- The hourly stale-pending cron (0010) cancels anything still `pending` after 24h. A
-- delayed-settlement payment (a bank debit) stays pending for days while the money is in flight,
-- so it would be cancelled before it landed and the customer charged for nothing. stripe-webhook
-- now records the payment intent on such an order the moment checkout completes, and this
-- excludes those. (cron.schedule with an existing job name replaces that job.)
select cron.schedule(
  'cancel-stale-pending-orders',
  '23 * * * *',
  $$
  update public.orders
  set status = 'canceled', failure_reason = 'Abandoned -- checkout was never completed'
  where status = 'pending'
    and stripe_payment_intent_id is null
    and created_at < now() - interval '24 hours'
  $$
);

-- order-watchdog: alerts on orders charged but never submitted to Printful (see that function's
-- header). Every 30 minutes. Built FROM the existing cleanup job's command so the shared
-- X-Cleanup-Key secret is reused without ever being written into this file or printed.
select cron.schedule(
  'order-watchdog',
  '7,37 * * * *',
  (select replace(command, '/functions/v1/cleanup-storage', '/functions/v1/order-watchdog')
     from cron.job where jobname = 'cleanup-design-mockups-storage')
);
