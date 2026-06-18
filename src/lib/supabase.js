import { createClient } from '@supabase/supabase-js';

// Client-safe credentials live in .env.local (VITE_ prefix exposes them to the bundle).
// The anon key is protected by Row Level Security, so this is safe to ship.
const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

// The app must keep working before Supabase is wired up. When the env vars are absent
// we export `null` and let the data layer surface a clear error, rather than throwing
// at import time and white-screening the whole app.
export const isSupabaseConfigured = Boolean(url && anonKey);

export const supabase = isSupabaseConfigured ? createClient(url, anonKey) : null;

if (!isSupabaseConfigured && import.meta.env.DEV) {
  // eslint-disable-next-line no-console
  console.warn(
    '[ChromaForge] Supabase not configured — set VITE_SUPABASE_URL and ' +
      'VITE_SUPABASE_ANON_KEY in .env.local to enable accounts and the gallery.'
  );
}
