-- Performance fixes flagged by Supabase's own advisor (2026-07-02 audit), no behavior
-- change: RLS policies were calling auth.uid() directly, which Postgres re-evaluates per
-- row instead of once per query. Wrapping it in a scalar subquery lets the planner treat it
-- as an InitPlan (evaluated once) -- Supabase's own recommended fix, see
-- https://supabase.com/docs/guides/database/postgres/row-level-security#call-functions-with-select
-- Also adds the one unindexed FK the advisor flagged (likes.design_id) -- without it,
-- deleting a design forces a full table scan of `likes` to find rows to cascade-delete.
--
-- Applied directly against the live project via the Supabase MCP server (migration
-- 20260702185406); this file mirrors that so the repo's migration history stays in sync.

alter policy "Users can insert their own profile"
  on public.profiles with check ((select auth.uid()) = id);

alter policy "Users can update their own profile"
  on public.profiles using ((select auth.uid()) = id);

alter policy "Public designs are viewable by everyone"
  on public.designs using (is_public or (select auth.uid()) = user_id);

alter policy "Users can insert their own designs"
  on public.designs with check ((select auth.uid()) = user_id);

alter policy "Users can update their own designs"
  on public.designs using ((select auth.uid()) = user_id);

alter policy "Users can delete their own designs"
  on public.designs using ((select auth.uid()) = user_id);

alter policy "Users can like as themselves"
  on public.likes with check ((select auth.uid()) = user_id);

alter policy "Users can remove their own likes"
  on public.likes using ((select auth.uid()) = user_id);

alter policy "Users can view their own orders"
  on public.orders using ((select auth.uid()) = user_id);

alter policy "Users can view their own order items"
  on public.order_items using (
    exists (select 1 from public.orders o where o.id = order_id and o.user_id = (select auth.uid()))
  );

create index if not exists likes_design_id_idx on public.likes(design_id);
