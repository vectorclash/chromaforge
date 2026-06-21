import React, { createContext, useContext, useEffect, useState } from 'react';
import { onAuthChange } from '../lib/auth';

// App-wide auth state. Replaces the imperative onAuthChange subscription that used to
// live only inside DisplayCanvas, so any route (header, account, gallery) can read the
// signed-in user without going through the canvas component.
//
// NOTE (phased migration): the Supabase auth-redirect-hash handling still lives in
// DisplayCanvas for now (it strips the hash and surfaces the "Signed in" banner on the
// studio). It moves here in the phase that strips DisplayCanvas's commerce/account code.
// Subscribing here in addition is harmless -- supabase-js supports multiple listeners.

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);

  useEffect(() => {
    const unsubscribe = onAuthChange(u => setUser(u));
    return unsubscribe;
  }, []);

  return <AuthContext.Provider value={{ user }}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider');
  return ctx;
}
