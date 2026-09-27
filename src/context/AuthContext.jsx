import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { onAuthChange } from '../lib/auth';
import { isSupabaseConfigured } from '../lib/supabase';
import { getMyProfile, uploadMyAvatar } from '../lib/profiles';
import { generateAvatar } from '../render/generateAvatar';
import renderAvatar from '../render/renderAvatar';
import { randomSeed } from '../render/prng';
import { useToastNotice } from '../hooks/useToastNotice';
import Toast from '../components/ui/Toast';
import { humanError } from '../lib/errorMessage';

// App-wide auth state, reachable from any route (header, account, gallery, studio save).
// Also owns the Supabase auth-redirect handling (moved here from DisplayCanvas) so it works
// regardless of which route the OAuth/email-confirm/password-recovery link lands on.

const AuthContext = createContext(null);

const AVATAR_SIZE = 256;

export function AuthProvider({ children }) {
  const navigate = useNavigate();
  // A NEW OBJECT every time supabase-js announces the session, and it re-announces it (as
  // SIGNED_IN, with a freshly parsed copy of the same user) every time the tab becomes visible.
  // So an effect that should run once per account must key on `user?.id`, never on `user`: three
  // did, and each one re-ran on every tab switch -- this file's profile fetch, AccountPage's data
  // load (which overwrote unsaved edits) and ArtworkPickerModal's reset (which dropped the
  // customer's place and selection).
  const [user, setUser] = useState(null);
  // Has Supabase told us who (if anyone) is signed in yet? `user` starts null, which is
  // indistinguishable from a real signed-out session -- so any surface that renders a
  // signed-out state off `user` alone is asserting a fact it does not have.
  //
  // That is not hypothetical and it is not only a first-paint concern: a returning visitor's
  // access token has expired, so supabase-js must make a NETWORK round trip to /auth/v1/token
  // before it knows anything. Measured against live Supabase that took 779ms, and with the
  // refresh stubbed at 700ms the header rendered "Sign in" for 204ms before correcting itself
  // to "Account" -- the header paints long before the network answers, so the flash is the
  // refresh latency minus the paint, and grows with a slower connection.
  //
  // Consumers should render a NEUTRAL state while this is false, never the signed-out one.
  // Note it says nothing about whether the profile has loaded: `avatarUrl` arrives a second
  // round trip later, since that fetch cannot start until `user` exists.
  const [authResolved, setAuthResolved] = useState(false);
  const [notice, setNotice] = useToastNotice(); // { type: 'success'|'error', message }
  const [avatarUrl, setAvatarUrl] = useState(null);
  // True while an avatar is being made, whether the automatic first one below or the Account
  // page's Regenerate button, so that button cannot start a second one on top of it.
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [avatarError, setAvatarError] = useState(null);
  const avatarJob = useRef(null); // { userId, promise } while one is in flight
  // Whose avatar a result that lands late may still be shown as -- nobody's after a sign-out.
  const signedInId = useRef(null);
  // profiles.is_admin. A UI-only flag -- `profiles` is world-readable, so this conceals
  // admin-only controls rather than protecting anything. Nothing privileged hangs off it;
  // anything that ever does must check it server-side instead.
  // Currently UNCONSUMED: its one reader was the studio's Admin settings tab, whose only
  // control (the loop-seam logo mark) was opened to everyone and moved into the Video tab.
  // Kept wired up because the column exists live and the next admin-only control will want it.
  const [isAdmin, setIsAdmin] = useState(false);
  // Set once a password-recovery link's session lands (see the hash-parsing effect below).
  // AccountPage reads this to show the set-new-password form instead of the normal
  // signed-in view; cleared once the new password is saved.
  const [recoveryMode, setRecoveryMode] = useState(false);
  const awaitingRedirect = useRef(false);
  const awaitingRecovery = useRef(false);

  // Renders a brand-new avatar off-canvas and uploads it, replacing whatever the profile has
  // now. One per user at a time: asking again while one is in flight joins it, rather than
  // uploading a second random avatar over the first.
  //
  // The job is registered BEFORE it starts because an async function runs synchronously up to
  // its first await: a render that threw there would reach `finally` before the job existed,
  // and leave it registered as in flight, with the button disabled, for the rest of the visit.
  const makeAvatar = useCallback(userId => {
    if (avatarJob.current?.userId === userId) return avatarJob.current.promise;
    const job = { userId, promise: null };
    avatarJob.current = job;
    setAvatarBusy(true);
    setAvatarError(null);
    job.promise = (async () => {
      try {
        const canvas = renderAvatar(generateAvatar(randomSeed(), AVATAR_SIZE));
        const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.9));
        canvas.width = 0;
        canvas.height = 0;
        // A real outcome rather than a defensive one: WebKit returns null from toBlob under
        // memory pressure (see DisplayCanvas's build path), and uploading null fails with an
        // error that says nothing about why.
        if (!blob) throw new Error('The avatar canvas produced no image.');
        const url = await uploadMyAvatar(blob);
        if (signedInId.current === userId) setAvatarUrl(url);
      } catch (err) {
        if (signedInId.current === userId) {
          setAvatarError(humanError(err, "We couldn't generate your avatar. Try again."));
        }
      } finally {
        if (avatarJob.current === job) {
          avatarJob.current = null;
          setAvatarBusy(false);
        }
      }
    })();
    return job.promise;
  }, []);

  // Fetched here (rather than only inside AccountPage) so the tiny avatar in SiteHeader has
  // something to show on every route -- and so a profile with NO avatar gets one on whichever
  // page its owner is signed in on.
  //
  // That second half used to live in AccountPage, which generated one whenever it found none,
  // and it looked complete. It was not: a Google sign-in and an email-confirmation link both
  // return to the site's ORIGIN (see lib/auth.js), so a new user's first signed-in page is the
  // homepage, and the Account page is somewhere they may never go. Ever since provider avatars
  // stopped being adopted (0015_never_adopt_provider_avatars.sql), that left new users saving
  // designs to the public gallery under the hexagon placeholder (Aaron, 2026-09-27: "New users
  // should have had one generated, even Google users"). Anyone it already happened to gets one
  // the next time they load any page signed in.
  //
  // Keyed on the user's ID (see `user` above): keying on the object re-fetched the profile on
  // every tab switch -- and, now that a fetch can start an upload, would be one more way to ask
  // for a second avatar while the first is still uploading.
  const userId = user?.id ?? null;
  useEffect(() => {
    signedInId.current = userId;
    if (!userId) {
      setAvatarUrl(null);
      setAvatarError(null);
      setIsAdmin(false);
      return;
    }
    let cancelled = false;
    getMyProfile()
      .then(profile => {
        if (cancelled) return;
        setAvatarUrl(profile.avatar_url || null);
        setIsAdmin(profile.is_admin === true);
        if (!profile.avatar_url) makeAvatar(userId);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [userId, makeAvatar]);

  const regenerateAvatar = useCallback(() => {
    if (userId) makeAvatar(userId);
  }, [userId, makeAvatar]);

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
      // Supabase's own wording, straight off the URL, so it goes through the same mapper as
      // every other error the visitor can meet -- "Database error saving new user" is not a
      // sentence to put in front of someone who just clicked a link in their email.
      const raw = decodeURIComponent(errorDescription.replace(/\+/g, ' '));
      setNotice({
        type: 'error',
        message: humanError(raw, "That sign-in link didn't work. Try requesting a new one.")
      });
    } else if (params.get('type') === 'recovery') {
      awaitingRecovery.current = true;
      navigate('/account');
    } else {
      awaitingRedirect.current = true;
    }
    window.history.replaceState({}, document.title, window.location.pathname + window.location.search);
  }, [navigate]);

  useEffect(() => {
    // onAuthChange never calls back at all without a configured client, so resolving has to
    // happen here or every consumer would wait forever for an answer that isn't coming.
    if (!isSupabaseConfigured) {
      setAuthResolved(true);
      return undefined;
    }
    const unsubscribe = onAuthChange(u => {
      setUser(u);
      setAuthResolved(true);
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

  return (
    <AuthContext.Provider
      value={{
        user,
        authResolved,
        isAdmin,
        avatarUrl,
        avatarBusy,
        avatarError,
        regenerateAvatar,
        recoveryMode,
        clearRecoveryMode: () => setRecoveryMode(false),
        showNotice: setNotice
      }}
    >
      {children}
      <Toast notice={notice} />
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider');
  return ctx;
}
