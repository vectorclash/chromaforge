// Whether this browser is holding a signed-in session, answered synchronously on the very first
// render -- before AuthContext has heard back from Supabase, which on a cold load means a network
// round trip to refresh the token.
//
// supabase-js keeps the session in localStorage under `sb-<project-ref>-auth-token` (its default
// storageKey; lib/supabase.js does not override it). The key being there is not proof the session
// is still valid -- a refresh can fail -- so this is only a HINT for what shape of page to draw
// while waiting, never a statement that someone is signed in. /account uses it so a returning
// visitor does not see the sign-in form flash up and then give way to their account.
//
// No imports on purpose: RouteSkeleton reads it and is part of the main bundle.
export function hasStoredSession() {
  try {
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i);
      if (key && key.startsWith('sb-') && key.endsWith('-auth-token')) return true;
    }
  } catch {
    // Storage blocked (a private window, disabled site data): assume signed out.
  }
  return false;
}
