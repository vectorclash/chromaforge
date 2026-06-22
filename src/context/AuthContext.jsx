import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import { onAuthChange } from '../lib/auth';

// App-wide auth state, reachable from any route (header, account, gallery, studio save).
// Also owns the Supabase auth-redirect handling (moved here from DisplayCanvas) so it works
// regardless of which route the OAuth/email-confirm link lands on.

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [notice, setNotice] = useState(null); // { type: 'success'|'error', message }
  const awaitingRedirect = useRef(false);

  // Supabase confirmation/OAuth links land back with tokens in the URL hash (or an
  // error_description if the link expired/was reused). supabase-js consumes the hash
  // asynchronously and fires onAuthChange once the session is set -- there's no other
  // signal, so flag it here and show the banner from that callback. Strip the hash either
  // way so a refresh doesn't reprocess a stale token.
  useEffect(() => {
    const hash = window.location.hash;
    if (!hash || (!hash.includes('access_token') && !hash.includes('error'))) return;
    const params = new URLSearchParams(hash.replace(/^#/, ''));
    const errorDescription = params.get('error_description');
    if (errorDescription) {
      setNotice({ type: 'error', message: decodeURIComponent(errorDescription.replace(/\+/g, ' ')) });
    } else {
      awaitingRedirect.current = true;
    }
    window.history.replaceState({}, document.title, window.location.pathname + window.location.search);
  }, []);

  useEffect(() => {
    const unsubscribe = onAuthChange(u => {
      setUser(u);
      if (awaitingRedirect.current && u) {
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
    <AuthContext.Provider value={{ user }}>
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
