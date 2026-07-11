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
// Supabase deliberately returns the *same* shape (200, session: null) whether this is a
// genuine new signup or the email already has an account — an anti-enumeration measure so
// the API response itself can't be used to probe which emails are registered. Without
// distinguishing these, a returning user hitting "create account" is told to check an
// inbox that will never receive anything. The documented way to tell them apart client-side
// is `user.identities`: empty for an existing account (confirmed live, 2026-07-01 — no
// confirmation email was sent and no new row appeared), populated for a real new signup.
// `alreadyRegistered` lets the caller redirect them to sign in instead.
//
// emailRedirectTo is set to the current origin rather than left to Supabase's dashboard
// "Site URL" default, so the confirmation link lands back on whichever environment the
// user actually signed up from (localhost in dev, chromaforge.app in prod) instead of
// always pointing at one fixed URL. Both origins still need to be in the Supabase
// dashboard's Auth -> URL Configuration "Redirect URLs" allow-list, or Supabase will
// reject the custom redirect and fall back to the Site URL anyway.
// captchaToken (here and on signInWithEmail/requestPasswordReset): a Cloudflare Turnstile
// token, required by GoTrue when the Supabase dashboard's CAPTCHA protection is on --
// see src/components/ui/Turnstile.jsx. Optional so the flows keep working with the
// dashboard flag off (the option is simply ignored server-side then).
export async function signUpWithEmail(email, password, captchaToken) {
  const { data, error } = await client().auth.signUp({
    email,
    password,
    options: { emailRedirectTo: window.location.origin, captchaToken }
  });
  if (error) throw error;
  const alreadyRegistered = !data.session && data.user?.identities?.length === 0;
  return {
    user: data.user,
    session: data.session,
    alreadyRegistered,
    needsConfirmation: !data.session && !alreadyRegistered
  };
}

export async function signInWithEmail(email, password, captchaToken) {
  const { data, error } = await client().auth.signInWithPassword({
    email,
    password,
    options: { captchaToken }
  });
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

// Sends a password-reset email with a recovery link. Supabase doesn't reveal whether the
// email actually belongs to an account (same anti-enumeration principle as signUp's
// identities check above) -- there's no signal to branch on here, so the caller always
// shows a generic "check your email" message regardless of whether anything was sent.
//
// redirectTo is the bare origin (not a specific path) so it reuses the same Supabase
// dashboard redirect allow-list entries already set up for signUpWithEmail/signInWithGoogle
// -- AuthContext detects `type=recovery` in the returned hash and routes to /account itself,
// so no extra allow-list entry is needed.
export async function requestPasswordReset(email, captchaToken) {
  const { error } = await client().auth.resetPasswordForEmail(email, {
    redirectTo: window.location.origin,
    captchaToken
  });
  if (error) throw error;
}

// Sets a new password for the currently-authenticated session. Only meaningful right after
// a recovery-link session lands (see AuthContext's recoveryMode) -- Supabase's recovery
// link itself signs the user in, so this is just a normal authenticated update, not a
// separate token exchange.
export async function updatePassword(newPassword) {
  const { error } = await client().auth.updateUser({ password: newPassword });
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
