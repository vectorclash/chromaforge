import { supabase, isSupabaseConfigured } from './supabase';

// Data-access layer for the signed-in user's own profile row. `profiles` is 1:1 with
// auth.users (trigger-created on signup, see supabase/migrations/0001_initial_schema.sql);
// username/display_name/avatar_url all start null and are populated from OAuth metadata
// where available, or left for the user to set here.

function client() {
  if (!isSupabaseConfigured) {
    throw new Error('Supabase is not configured. Add credentials to .env.local.');
  }
  return supabase;
}

export async function getMyProfile() {
  const sb = client();
  const {
    data: { user }
  } = await sb.auth.getUser();
  if (!user) throw new Error('You must be signed in.');

  const { data, error } = await sb
    .from('profiles')
    .select('username, display_name, avatar_url')
    .eq('id', user.id)
    .single();
  if (error) throw error;
  return data;
}

// Throws a friendly message on a duplicate username (the column has a unique constraint)
// rather than surfacing Postgres' raw "duplicate key value violates..." text.
export async function updateMyProfile({ username, display_name }) {
  const sb = client();
  const {
    data: { user }
  } = await sb.auth.getUser();
  if (!user) throw new Error('You must be signed in.');

  const { error } = await sb
    .from('profiles')
    .update({ username: username || null, display_name: display_name || null })
    .eq('id', user.id);
  if (error) {
    if (error.code === '23505') throw new Error('That username is already taken.');
    throw error;
  }
}

const AVATAR_BUCKET = 'avatars';

// Uploads a freshly rendered avatar image and points the profile at it. Path is always
// `${user_id}/avatar.jpg` (one object per user; upsert:true overwrites in place on
// regenerate) -- see supabase/migrations/0004_avatars_storage.sql. A `v` cache-busting
// query param is appended to the stored URL since the path itself never changes, so a
// regenerate would otherwise keep serving the old cached image at the same URL.
export async function uploadMyAvatar(blob) {
  const sb = client();
  const {
    data: { user }
  } = await sb.auth.getUser();
  if (!user) throw new Error('You must be signed in.');

  const path = `${user.id}/avatar.jpg`;
  const { error: uploadError } = await sb.storage
    .from(AVATAR_BUCKET)
    .upload(path, blob, { contentType: 'image/jpeg', upsert: true });
  if (uploadError) throw uploadError;

  const { data: urlData } = sb.storage.from(AVATAR_BUCKET).getPublicUrl(path);
  const avatarUrl = `${urlData.publicUrl}?v=${Date.now()}`;

  const { error } = await sb.from('profiles').update({ avatar_url: avatarUrl }).eq('id', user.id);
  if (error) throw error;

  return avatarUrl;
}
