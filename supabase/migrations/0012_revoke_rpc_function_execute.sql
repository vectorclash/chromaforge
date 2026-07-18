-- Revoke public/anon/authenticated EXECUTE on the SECURITY DEFINER functions that
-- PostgREST exposes at /rest/v1/rpc/* (flagged by Supabase's security advisor,
-- 2026-07-17). None of these are ever called by the frontend — the rate-limit pair is
-- called only from Edge Functions with the service-role key (_shared/rateLimit.ts), and
-- the rest are trigger functions (trigger firing does not check the calling role's
-- EXECUTE privilege, so triggers are unaffected).
--
-- The rate-limit revoke closes a real abuse vector, not just lint hygiene: with the
-- default PUBLIC grant, anyone holding the anon key (it ships in the JS bundle) could
-- call check_rate_limit_verbose directly with the global sentinel user id and burn the
-- store-wide 2/min mockup budget — a trivially scriptable DoS of mockup previews.
--
-- Applied to the live project via the Supabase MCP apply_migration (NOT `db push` —
-- see CLAUDE.md's note on this project's remote migration-history drift); this file is
-- the readable local record.

revoke execute on function public.check_rate_limit(uuid, text, integer, integer)
  from public, anon, authenticated;
revoke execute on function public.check_rate_limit_verbose(uuid, text, integer, integer)
  from public, anon, authenticated;
grant execute on function public.check_rate_limit(uuid, text, integer, integer)
  to service_role;
grant execute on function public.check_rate_limit_verbose(uuid, text, integer, integer)
  to service_role;

revoke execute on function public.handle_new_user() from public, anon, authenticated;
revoke execute on function public.handle_like_change() from public, anon, authenticated;
revoke execute on function public.handle_order_updated_at() from public, anon, authenticated;
revoke execute on function public.rls_auto_enable() from public, anon, authenticated;
