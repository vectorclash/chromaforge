-- Storage bucket for generated profile avatars.
--
-- Mirrors 0002_design_thumbnails_storage.sql's bucket/RLS shape, but unlike thumbnails
-- (whose public URL is deterministically derived from user_id + design_id, with no DB
-- column tracking it), avatars need an explicit profiles.avatar_url column: that same
-- column already holds Google's OAuth-provided photo URL for Google sign-ins, and a
-- generated avatar has to live alongside that, not replace a path convention.
--
-- Path is always `${user_id}/avatar.jpg`, one object per user (upsert:true on
-- regenerate), so RLS keys off the path's first segment exactly like thumbnails.
--
-- Run this in the Supabase SQL editor (or via `supabase db push` if using the CLI).

insert into storage.buckets (id, name, public)
values ('avatars', 'avatars', true)
on conflict (id) do nothing;

create policy "Avatars are viewable by everyone"
  on storage.objects for select
  using (bucket_id = 'avatars');

create policy "Users can upload avatars into their own folder"
  on storage.objects for insert
  with check (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "Users can replace avatars in their own folder"
  on storage.objects for update
  using (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "Users can delete avatars in their own folder"
  on storage.objects for delete
  using (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
