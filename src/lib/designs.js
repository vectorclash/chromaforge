import { supabase, isSupabaseConfigured } from './supabase';

// Data-access layer for saved designs. A design is stored seed-first: `data` holds the
// canonical { generatorVersion, seed, colors, ... } payload (or { animation, frames } for
// animations), reconstructable at any resolution. Relational columns carry ownership,
// visibility, and like counts.

function client() {
  if (!isSupabaseConfigured) {
    throw new Error('Supabase is not configured. Add credentials to .env.local.');
  }
  return supabase;
}

async function currentUser() {
  const {
    data: { user }
  } = await client().auth.getUser();
  return user;
}

// Persist a design for the signed-in user. `data` is the seed-based payload.
export async function saveDesign({ title = null, kind = 'image', data, isPublic = true }) {
  const sb = client();
  const user = await currentUser();
  if (!user) throw new Error('You must be signed in to save a design.');

  const { data: row, error } = await sb
    .from('designs')
    .insert({ user_id: user.id, title, kind, data, is_public: isPublic })
    .select()
    .single();
  if (error) throw error;
  return row;
}

export async function getDesign(id) {
  const { data, error } = await client().from('designs').select('*').eq('id', id).single();
  if (error) throw error;
  return data;
}

// Public gallery feed, newest first. `before` is an ISO timestamp for keyset pagination.
export async function listPublicDesigns({ limit = 30, before = null } = {}) {
  // Disambiguate the profiles embed: `likes` also links designs<->profiles, so PostgREST
  // sees two relationship paths. The `!designs_user_id_fkey` hint pins it to the author FK.
  let query = client()
    .from('designs')
    .select('*, profiles!designs_user_id_fkey(username, display_name, avatar_url)')
    .eq('is_public', true)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (before) query = query.lt('created_at', before);

  const { data, error } = await query;
  if (error) throw error;
  return data;
}

// Top-liked public designs for the homepage gallery preview, most-liked first.
export async function listTopLikedDesigns({ limit = 8 } = {}) {
  const { data, error } = await client()
    .from('designs')
    .select('*, profiles!designs_user_id_fkey(username, display_name, avatar_url)')
    .eq('is_public', true)
    .order('likes_count', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data;
}

export async function listMyDesigns() {
  const sb = client();
  const user = await currentUser();
  if (!user) throw new Error('You must be signed in.');

  const { data, error } = await sb
    .from('designs')
    .select('*')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data;
}

export async function deleteDesign(id) {
  const { error } = await client().from('designs').delete().eq('id', id);
  if (error) throw error;
}

const THUMBNAIL_BUCKET = 'design-thumbnails';

// Upload a thumbnail for a design the signed-in user owns. Path is
// `${user_id}/${design_id}.jpg` so storage RLS can key off the folder alone -- see
// supabase/migrations/0002_design_thumbnails_storage.sql. upsert:true lets re-saving
// regenerate a design's thumbnail in place.
export async function uploadDesignThumbnail(designId, blob) {
  const sb = client();
  const user = await currentUser();
  if (!user) throw new Error('You must be signed in to upload a thumbnail.');

  const path = `${user.id}/${designId}.jpg`;
  const { error } = await sb.storage
    .from(THUMBNAIL_BUCKET)
    .upload(path, blob, { contentType: 'image/jpeg', upsert: true });
  if (error) throw error;
}

// Public URL for a design's thumbnail, keyed by the design's owner + id. Returns null
// when Supabase isn't configured; callers should already be handling a missing/404
// image (older designs predating this feature simply have nothing at this path).
export function getThumbnailUrl(userId, designId) {
  if (!isSupabaseConfigured || !userId) return null;
  const path = `${userId}/${designId}.jpg`;
  return supabase.storage.from(THUMBNAIL_BUCKET).getPublicUrl(path).data.publicUrl;
}

// Design ids the signed-in user has liked, among the given list -- used to seed each
// gallery card's initial liked/unliked state. Returns an empty array when signed out
// (no error -- callers render unliked hearts for anonymous visitors) rather than throwing,
// since this is meant to be called unconditionally alongside the gallery's own list fetch.
export async function listMyLikedIds(designIds) {
  if (!designIds || designIds.length === 0) return [];
  const sb = client();
  const user = await currentUser();
  if (!user) return [];

  const { data, error } = await sb
    .from('likes')
    .select('design_id')
    .eq('user_id', user.id)
    .in('design_id', designIds);
  if (error) throw error;
  return data.map(row => row.design_id);
}

// Toggle the signed-in user's like on a design. Returns the new liked state.
// designs.likes_count is kept in sync by a database trigger.
export async function toggleLike(designId) {
  const sb = client();
  const user = await currentUser();
  if (!user) throw new Error('You must be signed in to like a design.');

  const { data: existing } = await sb
    .from('likes')
    .select('design_id')
    .eq('user_id', user.id)
    .eq('design_id', designId)
    .maybeSingle();

  if (existing) {
    const { error } = await sb
      .from('likes')
      .delete()
      .eq('user_id', user.id)
      .eq('design_id', designId);
    if (error) throw error;
    return { liked: false };
  }

  const { error } = await sb.from('likes').insert({ user_id: user.id, design_id: designId });
  if (error) throw error;
  return { liked: true };
}
