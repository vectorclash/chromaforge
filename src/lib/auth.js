import { supabase, isSupabaseConfigured } from './supabase';

// Thin auth layer over Supabase. Email/password plus Google OAuth as a second sign-in
// method (Google provider configured in the Supabase dashboard, not here).

function client() {
  if (!isSupabaseConfigured) {
    throw new Error('Supabase is not configured. Add credentials to .env.local.');
  }
  return supabase;
}

// Sign up with email/password. If the project requires email confirmation, `session` is
// null and `needsConfirmation` is true — the caller should tell the user to check their
// inbox. Otherwise they're signed in immediately.
//
// emailRedirectTo is set to the current origin rather than left to Supabase's dashboard
// "Site URL" default, so the confirmation link lands back on whichever environment the
// user actually signed up from (localhost in dev, chromaforge.app in prod) instead of
// always pointing at one fixed URL. Both origins still need to be in the Supabase
// dashboard's Auth -> URL Configuration "Redirect URLs" allow-list, or Supabase will
// reject the custom redirect and fall back to the Site URL anyway.
export async function signUpWithEmail(email, password) {
  const { data, error } = await client().auth.signUp({
    email,
    password,
    options: { emailRedirectTo: window.location.origin }
  });
  if (error) throw error;
  return { user: data.user, session: data.session, needsConfirmation: !data.session };
}

export async function signInWithEmail(email, password) {
  const { data, error } = await client().auth.signInWithPassword({ email, password });
  if (error) throw error;
  return { user: data.user, session: data.session };
}

// Redirects the whole page to Google, then back to redirectTo (current origin) with the
// session in the URL hash -- handled by onAuthChange + the existing redirect-cleanup
// logic in DisplayCanvas (see handleAuthRedirect), the same as the email-confirmation flow.
// There's no return value: the caller's component unmounts as the redirect happens.
export async function signInWithGoogle() {
  const { error } = await client().auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: window.location.origin }
  });
  if (error) throw error;
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
