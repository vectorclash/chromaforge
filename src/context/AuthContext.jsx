import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { onAuthChange } from '../lib/auth';
import { getMyProfile } from '../lib/profiles';

// App-wide auth state, reachable from any route (header, account, gallery, studio save).
// Also owns the Supabase auth-redirect handling (moved here from DisplayCanvas) so it works
// regardless of which route the OAuth/email-confirm/password-recovery link lands on.

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const navigate = useNavigate();
  const [user, setUser] = useState(null);
  const [notice, setNotice] = useState(null); // { type: 'success'|'error', message }
  const [avatarUrl, setAvatarUrl] = useState(null);
  // Set once a password-recovery link's session lands (see the hash-parsing effect below).
  // AccountPage reads this to show the set-new-password form instead of the normal
  // signed-in view; cleared once the new password is saved.
  const [recoveryMode, setRecoveryMode] = useState(false);
  const awaitingRedirect = useRef(false);
  const awaitingRecovery = useRef(false);

  // Fetched once here (rather than only inside AccountPage) so the tiny avatar in
  // SiteHeader has something to show on every route, not just after visiting /account.
  // AccountPage still owns generating/uploading a new one -- it just mirrors the result
  // into this shared value via setAvatarUrl so the header picks it up immediately.
  useEffect(() => {
    if (!user) {
      setAvatarUrl(null);
      return;
    }
    let cancelled = false;
    getMyProfile()
      .then(profile => !cancelled && setAvatarUrl(profile.avatar_url || null))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [user]);

  // Supabase confirmation/OAuth/recovery links land back with tokens in the URL hash (or
  // an error_description if the link expired/was reused). supabase-js consumes the hash
  // asynchronously and fires onAuthChange once the session is set -- there's no other
  // signal, so flag it here and act from that callback. Strip the hash either way so a
  // refresh doesn't reprocess a stale token.
  //
  // A recovery link's redirectTo is the bare origin (see requestPasswordReset), so it can
  // land on any route -- type=recovery in the hash is what distinguishes it from a normal
  // OAuth/confirm sign-in, and navigate('/account') routes it to the one page that knows
  // how to show the set-new-password form.
  useEffect(() => {
    const hash = window.location.hash;
    if (!hash || (!hash.includes('access_token') && !hash.includes('error'))) return;
    const params = new URLSearchParams(hash.replace(/^#/, ''));
    const errorDescription = params.get('error_description');
    if (errorDescription) {
      setNotice({ type: 'error', message: decodeURIComponent(errorDescription.replace(/\+/g, ' ')) });
    } else if (params.get('type') === 'recovery') {
      awaitingRecovery.current = true;
      navigate('/account');
    } else {
      awaitingRedirect.current = true;
    }
    window.history.replaceState({}, document.title, window.location.pathname + window.location.search);
  }, [navigate]);

  useEffect(() => {
    const unsubscribe = onAuthChange(u => {
      setUser(u);
      if (awaitingRecovery.current && u) {
        awaitingRecovery.current = false;
        setRecoveryMode(true);
      } else if (awaitingRedirect.current && u) {
        awaitingRedirect.current = false;
        setNotice({ type: 'success', message: 'Signed in.' });
      }
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), notice.type === 'error' ? 8000 : 5000);
    return () => clearTimeout(t);
  }, [notice]);

  return (
    <AuthContext.Provider
      value={{
        user,
        avatarUrl,
        setAvatarUrl,
        recoveryMode,
        clearRecoveryMode: () => setRecoveryMode(false),
        showNotice: setNotice
      }}
    >
      {children}
      {notice && (
        <div
          className={
            'fixed left-1/2 top-5 z-50 -translate-x-1/2 rounded-xl px-5 py-3 text-center text-sm shadow-lg backdrop-blur-md ' +
            (notice.type === 'error' ? 'bg-red-900/85 text-red-50' : 'bg-neutral-900/85 text-white')
          }
        >
          {notice.message}
        </div>
      )}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider');
  return ctx;
}
