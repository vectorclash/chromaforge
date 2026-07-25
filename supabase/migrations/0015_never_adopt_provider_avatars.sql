-- Stop adopting OAuth provider avatars. Chromaforge avatars are generated art (see
-- src/render/generateAvatar.js); a Google profile photo is neither ours nor generated, and
-- we never want one in the product.
--
-- Until now handle_new_user() copied raw_user_meta_data->>'avatar_url' straight into
-- profiles.avatar_url, so every Google sign-up arrived with an lh3.googleusercontent.com
-- URL. Two problems with that beyond it simply not being the look we want:
--   * Rendering it anywhere public makes every visitor's browser fetch an image from
--     Google, handing over their IP and the referring URL -- a third-party request on a
--     site whose Privacy page promises no trackers.
--   * Signing in with Google is not consent to have your Google profile photo (often a
--     real face) published next to your work in a public gallery.
--
-- display_name is still taken from OAuth metadata: that's a string we store, not a
-- third-party asset every visitor's browser has to go and fetch.
--
-- AccountPage already generates and uploads an avatar for any profile that has none
-- (`if (!profile.avatar_url) regenerateAvatar()`), so leaving this null is not a gap --
-- it's what routes new users into the generated-avatar path. Until then they show the same
-- hexagon placeholder a signed-out visitor sees.
--
-- src/components/ui/AuthorBadge.jsx keeps its own self-hosted-origin check on top of this.
-- That is deliberate defence in depth, not redundancy: avatar_url is a free-text column and
-- RLS lets a user update their own profile row, so the client must never assume the value
-- came from this trigger.

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, display_name)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name')
  );
  return new;
end;
$$;

-- Re-assert 0012's lockdown. CREATE OR REPLACE FUNCTION preserves an existing ACL, so this
-- is belt-and-braces rather than a fix -- but 0012 revoked these deliberately as a security
-- change, and a SECURITY DEFINER function silently regaining PUBLIC execute would undo it.
revoke execute on function public.handle_new_user() from public, anon, authenticated;

-- Drop provider avatars already stored. Matched on this project's own Storage origin so
-- only genuinely self-hosted avatars survive; anything else becomes null and the owner gets
-- a generated one next time they open their Account page.
update public.profiles
set avatar_url = null
where avatar_url is not null
  and avatar_url not like 'https://fgrhbzqzadpjpbzuszpm.supabase.co/storage/v1/object/public/avatars/%';
