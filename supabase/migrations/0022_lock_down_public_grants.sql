-- Removes table rights the public roles never needed (2026-11-04 security audit).
--
-- Supabase's default privileges hand anon and authenticated every right on every new table, and
-- RLS is what actually stops them. That held when tested (a stranger's UPDATE and DELETE on orders
-- touched 0 rows), but RLS does not govern TRUNCATE at all: the only thing between a public role
-- and an empty orders table was the Data API having no way to issue one. A grant that is not there
-- cannot be reached by any future route.
--
-- After this, what each role can do is exactly what the client does (src/lib/designs.js,
-- profiles.js, checkout.js):
--   anon           reads designs, likes, profiles
--   authenticated  also reads its own orders and order_items through RLS, writes designs and
--                  likes, and updates three profile columns (0018's column grants, unchanged)
-- Orders and order_items are written only by Edge Functions through service_role, which is not
-- affected. rate_limits is only touched by the SECURITY DEFINER functions from 0011.
--
-- Applied via the Supabase MCP apply_migration path, NOT `db push` -- see 0010's note.

-- Rights no client path uses, on every table, and on tables created later.
revoke truncate, references, trigger, maintain on all tables in schema public from anon, authenticated;
alter default privileges for role postgres in schema public
  revoke truncate, references, trigger, maintain on tables from anon, authenticated;

-- Written only by service_role. Read by the signed-in owner, through RLS.
revoke insert, update, delete on public.orders, public.order_items from anon, authenticated;
revoke select on public.orders, public.order_items from anon;

-- Touched only by SECURITY DEFINER functions.
revoke all on public.rate_limits from anon, authenticated;

-- Signed-out visitors can read but never write. A signed-in user can add and remove a like, never
-- edit one, and nothing deletes a profile row from the client.
revoke insert, update, delete on public.likes from anon;
revoke update on public.likes from authenticated;
revoke delete on public.designs from anon;
revoke delete on public.profiles from anon, authenticated;

-- Deliberately not here: anon and authenticated can still execute net.http_post. Revoking it runs
-- without error and changes nothing, because supabase_admin owns those grants. It is not reachable:
-- the Data API exposes only public and graphql_public (checked: PGRST106 for net), and pg_graphql is
-- off. If `net` is ever added to the exposed schemas, anyone with the anon key could make the
-- database send arbitrary requests, so do not.

-- Largest file ever seen in this bucket was 9.5MB (2026-11-04), and it was the one bucket with no
-- limit of its own. Generous on purpose: a print file too big to upload would fail a paid order.
update storage.buckets set file_size_limit = 52428800 where id = 'design-mockups';
