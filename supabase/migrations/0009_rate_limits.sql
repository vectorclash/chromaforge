-- Per-user rate limiting for endpoints that trigger real spend (Fly.io render compute,
-- Printful mockup-generation quota, Printful/Stripe checkout). verify_jwt + a GoTrue
-- user check (already in place on all three functions) stops anonymous scripts, but does
-- nothing to stop a signed-up account from scripting hundreds of requests/minute -- a free
-- account is trivial to create, so this is the actual missing control against a
-- cost-flood, not just a "belt and suspenders" nicety.
--
-- Fixed-window counter (not sliding/token-bucket) -- simpler, and fine for this purpose:
-- the goal is capping worst-case cost, not smoothing traffic precisely. One row per
-- (user_id, action); check_rate_limit() atomically resets an expired window or increments
-- the current one and returns whether the caller is still under limit, all inside one
-- statement so concurrent requests from the same user can't race past the cap.
create table if not exists rate_limits (
  user_id uuid not null,
  action text not null,
  window_start timestamptz not null,
  request_count int not null default 0,
  primary key (user_id, action)
);

alter table rate_limits enable row level security;
-- No client policies at all -- only the service role (used exclusively by Edge Functions)
-- reads/writes this table, same pattern as orders/order_items.

create or replace function check_rate_limit(
  p_user_id uuid,
  p_action text,
  p_limit int,
  p_window_seconds int
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count int;
begin
  insert into rate_limits (user_id, action, window_start, request_count)
  values (p_user_id, p_action, now(), 1)
  on conflict (user_id, action) do update
    set request_count = case
          when rate_limits.window_start < now() - make_interval(secs => p_window_seconds)
            then 1
          else rate_limits.request_count + 1
        end,
        window_start = case
          when rate_limits.window_start < now() - make_interval(secs => p_window_seconds)
            then now()
          else rate_limits.window_start
        end
  returning request_count into v_count;

  return v_count <= p_limit;
end;
$$;
