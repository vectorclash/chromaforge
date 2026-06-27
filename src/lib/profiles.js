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
