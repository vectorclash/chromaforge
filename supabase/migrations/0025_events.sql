-- Anonymous visit events: what people do on the site, so an ad's clicks can be followed past
-- the homepage (2026-11-14, Aaron: 40 Instagram clicks, no purchases, and nothing could say how
-- far any of them got). Written by src/lib/track.js.
--
-- What it holds, and what it deliberately does not:
--   session_id  a random id kept in sessionStorage, so it lives for ONE tab and is gone when
--               the tab closes. No cookie, no localStorage, nothing that recognises a
--               returning visitor, and no user id -- events are never tied to an account.
--   name        one of a fixed list (the check below), so a script cannot fill the table with
--               arbitrary strings.
--   path        the page's path, no query string.
--   source      where the visit came from: instagram / facebook / a utm_source / a referring
--               host / direct.
--   device      phone / tablet / desktop.
--   props       a small object of facts about the event (which product, which surface).
--
-- Clients may INSERT and nothing else: no SELECT, so the anon key cannot read anyone's events
-- (track.js inserts with return=minimal for exactly this reason). Reads happen with the service
-- role, from the dashboard or the Supabase MCP.
--
-- Kept 180 days, then deleted by the cron job at the bottom.

create table public.events (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  session_id uuid not null,
  name text not null check (name in (
    'page_view',
    'home_section',
    'generate',
    'save_click',
    'shop_click',
    'scroll_cue_click',
    'product_view',
    'mockup_click',
    'mockup_ready',
    'mockup_failed',
    'buy_click',
    'checkout_redirect',
    'signup_submit',
    'signin_submit',
    'google_click'
  )),
  path text check (char_length(path) <= 200),
  source text check (char_length(source) <= 60),
  device text check (device in ('phone', 'tablet', 'desktop')),
  props jsonb check (props is null or pg_column_size(props) <= 1024)
);

create index events_created_at_idx on public.events (created_at);
create index events_session_idx on public.events (session_id);

alter table public.events enable row level security;

-- Supabase's default privileges hand a new table every right to both client roles (see 0022).
revoke all on public.events from anon, authenticated;
grant insert (session_id, name, path, source, device, props) on public.events to anon, authenticated;

create policy events_insert on public.events
  for insert to anon, authenticated
  with check (true);

-- 180 days is long enough to compare ad runs months apart, short enough not to keep a
-- browsing record of anyone indefinitely.
select cron.schedule(
  'delete-old-events',
  '17 5 * * *',
  $$delete from public.events where created_at < now() - interval '180 days'$$
);
