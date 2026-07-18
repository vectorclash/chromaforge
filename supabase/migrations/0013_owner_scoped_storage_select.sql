-- Rescope the three public buckets' SELECT policies from "everyone" to owner-only
-- (Supabase security advisor's public_bucket_allows_listing warning, 2026-07-17).
--
-- Why this is safe: object serving for PUBLIC buckets (/storage/v1/object/public/...,
-- what every getPublicUrl <img> in the app uses) bypasses RLS entirely and needs no
-- SELECT policy. The broad policies' only real effect was letting anyone with the anon
-- key call the Storage LIST endpoint and enumerate every file path in the bucket
-- (verified live before this migration: anon listing returned user-id folders for all
-- three buckets). What DOES need SELECT is the app's own `upsert: true` uploads
-- (Storage's update path checks SELECT + UPDATE) and owner `.remove()` — and every
-- upload path in all three buckets is keyed `${user_id}/...` (avatars/profiles.js,
-- thumbnails/designs.js, mockups/printful.js), so owner-scoped SELECT preserves those
-- exactly, matching the owner-scoped INSERT/UPDATE/DELETE policies that already exist.
-- Edge Functions and render-service use the service role, which bypasses RLS.
--
-- Applied live via the Supabase MCP apply_migration (not `db push` — see CLAUDE.md);
-- this file is the readable local record.

drop policy "Avatars are viewable by everyone" on storage.objects;
drop policy "Public read access for design mockups" on storage.objects;
drop policy "Thumbnails are viewable by everyone" on storage.objects;

create policy "Users can read avatars in their own folder"
  on storage.objects for select
  using (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

create policy "Users can read their own mockup source images"
  on storage.objects for select
  using (
    bucket_id = 'design-mockups'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

create policy "Users can read thumbnails in their own folder"
  on storage.objects for select
  using (
    bucket_id = 'design-thumbnails'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );
