-- The automatic half of the store switch (2026-11-11). See _shared/storeStatus.ts.
--
-- STORE_ENABLED is a function secret, which only a person with the CLI can change. This one-row
-- table is a second switch that order-watchdog can close on its own when paid orders start
-- failing or piling up, so the store stops taking money for orders it cannot currently fulfil.
-- create-checkout-session and printful-catalog read it; either switch being off closes checkout.
--
-- The watchdog closes it for two different reasons, recorded in closed_by:
--   'orders'   paid orders are failing or piling up. Stays closed until a person reopens it.
--   'storage'  the watchdog's own Storage upload test failed twice running (the 2026-11-04 hang:
--              every upload saved, then never answered). Reopens by itself once the test passes
--              twice running, because nothing about it needs a person to look.
-- probe_failures / probe_successes are that test's running counts.
--
-- To reopen by hand:
--   update public.store_state set enabled = true, reason = null, closed_by = null, changed_at = now();
-- To close by hand from SQL (the secret still works too):
--   update public.store_state set enabled = false, reason = 'why', changed_at = now();
--
-- Service role only: RLS on with no policies, and no grants to the public roles. The functions
-- fail OPEN when this table is missing, so they are safe to deploy before or after this runs.
--
-- Applied via the Supabase MCP apply_migration path, NOT `db push` -- see 0010's note.

create table if not exists public.store_state (
  id boolean primary key default true check (id),
  enabled boolean not null default true,
  reason text,
  closed_by text,
  probe_failures integer not null default 0,
  probe_successes integer not null default 0,
  changed_at timestamptz not null default now()
);

insert into public.store_state (id) values (true) on conflict (id) do nothing;

alter table public.store_state enable row level security;
revoke all on public.store_state from anon, authenticated;
