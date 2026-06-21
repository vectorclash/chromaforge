-- Storage bucket for gallery thumbnails.
--
-- Thumbnails are regenerated client-side from the design's own seed/colors at a small
-- size (the same "recompose-per-ratio" approach as the main renderer, not a downscaled
-- screenshot) and uploaded here at save time. The object path is always
-- `${user_id}/${design_id}.jpg`, so RLS can key off the path's first segment instead of
-- needing a separate ownership table. There's no DB column tracking "has a thumbnail" --
-- the app derives the public URL from the design id and lets a missing object 404
-- client-side (older designs saved before this feature just won't have one).
--
-- Run this in the Supabase SQL editor (or via `supabase db push` if using the CLI).

insert into storage.buckets (id, name, public)
values ('design-thumbnails', 'design-thumbnails', true)
on conflict (id) do nothing;

create policy "Thumbnails are viewable by everyone"
  on storage.objects for select
  using (bucket_id = 'design-thumbnails');

create policy "Users can upload thumbnails into their own folder"
  on storage.objects for insert
  with check (
    bucket_id = 'design-thumbnails'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "Users can replace thumbnails in their own folder"
  on storage.objects for update
  using (
    bucket_id = 'design-thumbnails'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "Users can delete thumbnails in their own folder"
  on storage.objects for delete
  using (
    bucket_id = 'design-thumbnails'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
