import { supabase, isSupabaseConfigured } from './supabase';

// Thin auth layer over Supabase. Email/password to start (zero extra project config);
// Google OAuth can be added later as another sign-in method without changing callers.

function client() {
  if (!isSupabaseConfigured) {
    throw new Error('Supabase is not configured. Add credentials to .env.local.');
  }
  return supabase;
}

// Sign up with email/password. If the project requires email confirmation, `session` is
// null and `needsConfirmation` is true — the caller should tell the user to check their
// inbox. Otherwise they're signed in immediately.
export async function signUpWithEmail(email, password) {
  const { data, error } = await client().auth.signUp({ email, password });
  if (error) throw error;
  return { user: data.user, session: data.session, needsConfirmation: !data.session };
}

export async function signInWithEmail(email, password) {
  const { data, error } = await client().auth.signInWithPassword({ email, password });
  if (error) throw error;
  return { user: data.user, session: data.session };
}

export async function signOut() {
  const { error } = await client().auth.signOut();
  if (error) throw error;
}

export async function getCurrentUser() {
  if (!isSupabaseConfigured) return null;
  const {
    data: { user }
  } = await supabase.auth.getUser();
  return user;
}

// Subscribe to sign-in/sign-out. Calls back with the current user (or null) and returns
// an unsubscribe function.
export function onAuthChange(callback) {
  if (!isSupabaseConfigured) return () => {};
  const { data } = supabase.auth.onAuthStateChange((_event, session) => {
    callback(session?.user ?? null);
  });
  return () => data.subscription.unsubscribe();
}
