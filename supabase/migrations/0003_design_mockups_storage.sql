-- Storage bucket for Printful mockup source images.
--
-- uploadMockupSourceImage() (src/lib/printful.js) renders the design off-canvas and uploads
-- it here so Printful's mockup-generator worker can fetch it by URL -- it needs a stable,
-- directly-fetchable address (confirmed live that redirect-based hosts leave the render task
-- stuck pending forever). Object path is `${user_id}/mockup-${timestamp}-${label}.jpg`, same
-- folder-keyed-by-owner approach as design-thumbnails (0002), so RLS can check ownership
-- from the path alone.
--
-- This bucket + its policies already exist on the live project (created via the dashboard
-- alongside other one-off setup, same as Google OAuth -- see CLAUDE.md). This migration
-- exists for parity: a fresh clone/environment running migrations from scratch needs this
-- too, and didn't have it captured anywhere until now. Re-running it against the live
-- project is a harmless no-op for the bucket (`on conflict do nothing`); the `create policy`
-- statements would error there since the policies already exist -- that's expected, this
-- file is for fresh setups, not meant to be re-applied to the current live project.

insert into storage.buckets (id, name, public)
values ('design-mockups', 'design-mockups', true)
on conflict (id) do nothing;

create policy "Public read access for design mockups"
  on storage.objects for select
  using (bucket_id = 'design-mockups');

create policy "Users can upload their own mockup source images"
  on storage.objects for insert
  with check (
    bucket_id = 'design-mockups'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "Users can update their own mockup source images"
  on storage.objects for update
  using (
    bucket_id = 'design-mockups'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "Users can delete their own mockup source images"
  on storage.objects for delete
  using (
    bucket_id = 'design-mockups'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
