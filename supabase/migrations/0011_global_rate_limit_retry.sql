-- Verbose variant of check_rate_limit(), used by printful-mockup for BOTH its per-user
-- gate and a new store-wide (all-users) gate matching Printful's own measured limit on
-- POST /v2/mockup-tasks (2 requests/60s across the whole API key -- see TODO.md). The
-- plain boolean check_rate_limit() is enough to gate a request, but the client needs to
-- know how long to wait before auto-retrying instead of just failing outright -- that
-- needs the window's start time, not just pass/fail. Reuses check_rate_limit() itself for
-- the actual atomic gate (so the three existing callers' behavior is untouched) and adds
-- one extra read for the retry hint; the read isn't part of the same atomic statement,
-- but it's only used for a UI countdown, not correctness, so the tiny race window is fine.
create or replace function check_rate_limit_verbose(
  p_user_id uuid,
  p_action text,
  p_limit int,
  p_window_seconds int
) returns table(allowed boolean, retry_after_seconds int)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_allowed boolean;
  v_window_start timestamptz;
begin
  v_allowed := check_rate_limit(p_user_id, p_action, p_limit, p_window_seconds);

  select rate_limits.window_start into v_window_start
  from rate_limits
  where rate_limits.user_id = p_user_id and rate_limits.action = p_action;

  return query select
    v_allowed,
    greatest(1, p_window_seconds - extract(epoch from now() - v_window_start)::int);
end;
$$;
