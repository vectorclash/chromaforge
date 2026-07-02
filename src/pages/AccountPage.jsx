import React, { useCallback, useEffect, useState } from 'react';
import PageContainer from '../components/ui/PageContainer';
import Button from '../components/ui/Button';
import GoogleIcon from '../components/buttons/GoogleIcon';
import FadeImage from '../components/ui/FadeImage';
import { Field, Input } from '../components/ui/Field';
import { isSupabaseConfigured } from '../lib/supabase';
import {
  signInWithEmail,
  signUpWithEmail,
  signInWithGoogle,
  signOut,
  requestPasswordReset,
  updatePassword
} from '../lib/auth';
import { getMyProfile, updateMyProfile, uploadMyAvatar } from '../lib/profiles';
import { getMyDesignStats } from '../lib/designs';
import { listMyOrders } from '../lib/checkout';
import { generateAvatar } from '../render/generateAvatar';
import renderAvatar from '../render/renderAvatar';
import { randomSeed } from '../render/prng';
import { useAuth } from '../context/AuthContext';
import { usePageTitle } from '../hooks/usePageTitle';

const AVATAR_SIZE = 256;

// 'pending' is deliberately excluded -- listMyOrders() never returns it (see lib/checkout.js),
// it's an implementation detail of checkout, not a customer-visible state. 'failed' gets the
// same accent-color treatment as form errors elsewhere on this page, so it doesn't blend in
// with a normal completed order.
const ORDER_STATUS_DISPLAY = {
  paid: { label: 'Processing', className: 'text-text-secondary' },
  submitted: { label: 'In production', className: 'text-text-secondary' },
  failed: { label: 'Needs attention', className: 'text-accent' },
  canceled: { label: 'Canceled', className: 'text-text-muted' }
};

export default function AccountPage() {
  // avatarUrl/setAvatarUrl come from AuthContext (not local state) so a regenerate here
  // is immediately reflected in SiteHeader's tiny avatar too, without a second fetch.
  const { user, avatarUrl, setAvatarUrl, recoveryMode, clearRecoveryMode, showNotice } = useAuth();
  usePageTitle(user ? 'Account' : 'Sign in');
  const [mode, setMode] = useState('signin'); // signin | signup | forgot
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [message, setMessage] = useState(null);

  // Set-new-password form (recoveryMode branch only, but hooks stay unconditional).
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [resetBusy, setResetBusy] = useState(false);
  const [resetError, setResetError] = useState(null);

  // Profile form (signed-in branch only, but hooks stay unconditional).
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [profileLoading, setProfileLoading] = useState(true);
  const [profileBusy, setProfileBusy] = useState(false);
  const [profileError, setProfileError] = useState(null);
  const [profileSaved, setProfileSaved] = useState(false);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [avatarError, setAvatarError] = useState(null);
  const [stats, setStats] = useState(null);
  const [orders, setOrders] = useState([]);
  const [ordersLoading, setOrdersLoading] = useState(true);

  // Renders a brand-new avatar off-canvas and uploads it, replacing whatever's there now
  // (a Google photo, a previous generated one, or nothing). Used both by the "Regenerate"
  // button and, below, to assign a first avatar automatically when a profile has none.
  const regenerateAvatar = useCallback(async () => {
    setAvatarBusy(true);
    setAvatarError(null);
    try {
      const config = generateAvatar(randomSeed(), AVATAR_SIZE);
      const canvas = renderAvatar(config);
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.9));
      canvas.width = 0;
      canvas.height = 0;
      const url = await uploadMyAvatar(blob);
      setAvatarUrl(url);
    } catch (err) {
      setAvatarError(err.message);
    } finally {
      setAvatarBusy(false);
    }
  }, []);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    getMyProfile()
      .then(profile => {
        if (cancelled) return;
        setUsername(profile.username || '');
        setDisplayName(profile.display_name || '');
        setAvatarUrl(profile.avatar_url || null);
        if (!profile.avatar_url) regenerateAvatar();
      })
      .catch(err => !cancelled && setProfileError(err.message))
      .finally(() => !cancelled && setProfileLoading(false));
    getMyDesignStats()
      .then(s => !cancelled && setStats(s))
      .catch(() => {});
    listMyOrders()
      .then(rows => !cancelled && setOrders(rows))
      .catch(() => {})
      .finally(() => !cancelled && setOrdersLoading(false));
    return () => {
      cancelled = true;
    };
  }, [user, regenerateAvatar]);

  const onSaveProfile = async e => {
    e.preventDefault();
    setProfileBusy(true);
    setProfileError(null);
    setProfileSaved(false);
    try {
      await updateMyProfile({ username: username.trim(), display_name: displayName.trim() });
      setProfileSaved(true);
    } catch (err) {
      setProfileError(err.message);
    } finally {
      setProfileBusy(false);
    }
  };

  if (!isSupabaseConfigured) {
    return (
      <PageContainer title="Account" subtitle="Accounts are not configured in this environment.">
        <p className="text-text-secondary">Set Supabase credentials to enable sign-in.</p>
      </PageContainer>
    );
  }

  // A landed recovery link signs the user in (see AuthContext's recoveryMode) -- show the
  // set-new-password form instead of the normal profile view until it's done, regardless
  // of whether they had a session already.
  if (user && recoveryMode) {
    const onSetNewPassword = async e => {
      e.preventDefault();
      setResetError(null);
      if (newPassword !== confirmPassword) {
        setResetError('Passwords do not match.');
        return;
      }
      setResetBusy(true);
      try {
        await updatePassword(newPassword);
        showNotice({ type: 'success', message: 'Password updated.' });
        clearRecoveryMode();
      } catch (err) {
        setResetError(err.message);
      } finally {
        setResetBusy(false);
      }
    };

    return (
      <PageContainer title="Set a new password" subtitle={`Signed in as ${user.email}`}>
        <form onSubmit={onSetNewPassword} className="max-w-sm space-y-4">
          <Field label="New password" htmlFor="new-password">
            <Input
              id="new-password"
              type="password"
              autoComplete="new-password"
              value={newPassword}
              onChange={e => setNewPassword(e.target.value)}
              placeholder="••••••••"
              required
              minLength={6}
            />
          </Field>
          <Field label="Confirm new password" htmlFor="confirm-password">
            <Input
              id="confirm-password"
              type="password"
              autoComplete="new-password"
              value={confirmPassword}
              onChange={e => setConfirmPassword(e.target.value)}
              placeholder="••••••••"
              required
              minLength={6}
            />
          </Field>
          {resetError && <p className="text-sm text-accent">{resetError}</p>}
          <Button type="submit" className="w-full" disabled={resetBusy} aria-busy={resetBusy}>
            {resetBusy ? 'Saving…' : 'Save new password'}
          </Button>
        </form>
      </PageContainer>
    );
  }

  if (user) {
    return (
      <PageContainer title="Account" subtitle={`Signed in as ${user.email}`}>
        {profileLoading ? (
          <p className="text-text-secondary">Loading profile…</p>
        ) : (
          <>
            <div className="mb-10 flex items-center gap-5">
              <div className="relative h-20 w-20 shrink-0 overflow-hidden rounded-full bg-ink-800">
                {avatarUrl && (
                  <FadeImage src={avatarUrl} alt="" className="h-full w-full object-cover" />
                )}
              </div>
              <div>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={regenerateAvatar}
                  disabled={avatarBusy}
                  aria-busy={avatarBusy}
                >
                  {avatarBusy ? 'Generating…' : avatarUrl ? 'Regenerate avatar' : 'Generate avatar'}
                </Button>
                {avatarError && <p className="mt-2 text-sm text-accent">{avatarError}</p>}
              </div>
            </div>

            {stats && (
              <div className="mb-10 max-w-sm rounded-xl border border-hairline bg-ink-800 p-5">
                <h2 className="font-quicksand text-xs font-bold uppercase tracking-[0.14em] text-text-muted">
                  Your stats
                </h2>
                <div className="mt-3 flex gap-8 font-quicksand text-sm text-text-secondary">
                  <span>
                    <strong className="text-text">{stats.designCount}</strong>{' '}
                    {stats.designCount === 1 ? 'design' : 'designs'} saved
                  </span>
                  <span>
                    <strong className="text-text">{stats.totalLikes}</strong>{' '}
                    {stats.totalLikes === 1 ? 'like' : 'likes'} received
                  </span>
                </div>
              </div>
            )}

            {!ordersLoading && orders.length > 0 && (
              <div className="mb-10 max-w-sm">
                <h2 className="font-quicksand text-xs font-bold uppercase tracking-[0.14em] text-text-muted">
                  Order history
                </h2>
                <div className="mt-3 space-y-2">
                  {orders.map(order => {
                    const item = order.order_items?.[0];
                    const status = ORDER_STATUS_DISPLAY[order.status] ?? ORDER_STATUS_DISPLAY.submitted;
                    return (
                      <div
                        key={order.id}
                        className="rounded-lg border border-hairline bg-ink-800 p-4 font-quicksand text-sm"
                      >
                        <div className="flex items-baseline justify-between gap-3">
                          <span className="truncate text-text">
                            {item?.product_title}
                            {item?.variant_label ? ` (${item.variant_label})` : ''}
                          </span>
                          <span className="shrink-0 text-text">${(order.total_cents / 100).toFixed(2)}</span>
                        </div>
                        <div className="mt-1 flex items-baseline justify-between gap-3 text-xs text-text-secondary">
                          <span>
                            {new Date(order.created_at).toLocaleDateString()}
                            {item ? ` · Qty ${item.quantity}` : ''}
                          </span>
                          <span className={status.className}>{status.label}</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            <form onSubmit={onSaveProfile} className="max-w-sm space-y-5">
              <Field label="Display name" htmlFor="display-name">
                <Input
                  id="display-name"
                  value={displayName}
                  onChange={e => {
                    setDisplayName(e.target.value);
                    setProfileSaved(false);
                  }}
                  placeholder="How your name shows on the gallery"
                />
              </Field>
              <Field label="Username" htmlFor="username">
                <Input
                  id="username"
                  value={username}
                  onChange={e => {
                    setUsername(e.target.value);
                    setProfileSaved(false);
                  }}
                  placeholder="yourname"
                />
              </Field>
              {profileError && <p className="text-sm text-accent">{profileError}</p>}
              <div className="flex items-center gap-3 pt-1">
                <Button type="submit" disabled={profileBusy} aria-busy={profileBusy}>
                  {profileBusy ? 'Saving…' : profileSaved ? 'Saved' : 'Save profile'}
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  onClick={async () => {
                    setBusy(true);
                    try {
                      await signOut();
                    } finally {
                      setBusy(false);
                    }
                  }}
                  disabled={busy}
                >
                  Sign out
                </Button>
              </div>
            </form>
          </>
        )}
      </PageContainer>
    );
  }

  const onSubmit = async e => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      if (mode === 'signup') {
        const { needsConfirmation, alreadyRegistered } = await signUpWithEmail(email, password);
        if (alreadyRegistered) {
          setMode('signin');
          setError('An account with this email already exists. Sign in instead.');
        } else if (needsConfirmation) {
          setMessage('Check your email to confirm your account, then sign in.');
        }
      } else {
        await signInWithEmail(email, password);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  // Supabase doesn't reveal whether the email actually has an account (see
  // requestPasswordReset), so the message here is deliberately non-committal either way.
  const onForgotPassword = async e => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await requestPasswordReset(email);
      setMessage('If an account exists for that email, a reset link is on its way.');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const switchMode = next => {
    setMode(next);
    setError(null);
    setMessage(null);
  };

  return (
    <PageContainer
      title={mode === 'signup' ? 'Create account' : mode === 'forgot' ? 'Reset password' : 'Sign in'}
      subtitle={
        mode === 'forgot' ? "We'll email you a link to choose a new password." : 'Save your designs and order prints.'
      }
    >
      {/* Prominent, hard-to-miss confirmation/error banner -- placed above the form so
          submitting never looks like it did nothing, even on a fast local response. */}
      {message && (
        <div className="mb-6 max-w-sm animate-pop-in rounded-lg border border-accent/30 bg-accent/10 px-4 py-3">
          <p className="text-sm font-bold text-text">
            <span className="text-accent">✓ </span>
            {message}
          </p>
        </div>
      )}
      {error && (
        <div className="mb-6 max-w-sm animate-pop-in rounded-lg border border-accent/30 bg-accent/10 px-4 py-3">
          <p className="text-sm font-bold text-accent">{error}</p>
        </div>
      )}

      {mode === 'forgot' ? (
        <form onSubmit={onForgotPassword} className="max-w-sm space-y-4">
          <Field label="Email" htmlFor="email">
            <Input
              id="email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder="you@example.com"
              required
            />
          </Field>
          <Button type="submit" className="w-full" disabled={busy} aria-busy={busy}>
            {busy ? 'Sending…' : 'Send reset link'}
          </Button>
        </form>
      ) : (
        <form onSubmit={onSubmit} className="max-w-sm space-y-4">
          <Field label="Email" htmlFor="email">
            <Input
              id="email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder="you@example.com"
              required
            />
          </Field>
          <Field label="Password" htmlFor="password">
            <Input
              id="password"
              type="password"
              autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="••••••••"
              required
            />
          </Field>
          {mode === 'signin' && (
            <p className="text-right">
              <button
                type="button"
                className="cursor-pointer text-sm text-accent underline"
                onClick={() => switchMode('forgot')}
              >
                Forgot password?
              </button>
            </p>
          )}

          <Button type="submit" className="w-full" disabled={busy} aria-busy={busy}>
            {busy ? 'Please wait…' : mode === 'signup' ? 'Create account' : 'Sign in'}
          </Button>
          <Button
            type="button"
            variant="secondary"
            className="w-full flex items-center justify-center gap-2"
            onClick={signInWithGoogle}
            disabled={busy}
          >
            <GoogleIcon size={18} />
            Continue with Google
          </Button>
        </form>
      )}

      <p className="mt-6 text-sm text-text-secondary">
        {mode === 'forgot' ? (
          <>
            Remembered it?{' '}
            <button type="button" className="cursor-pointer text-accent underline" onClick={() => switchMode('signin')}>
              Back to sign in
            </button>
          </>
        ) : (
          <>
            {mode === 'signup' ? 'Already have an account?' : 'New here?'}{' '}
            <button
              type="button"
              className="cursor-pointer text-accent underline"
              onClick={() => switchMode(mode === 'signup' ? 'signin' : 'signup')}
            >
              {mode === 'signup' ? 'Sign in' : 'Create one'}
            </button>
          </>
        )}
      </p>
    </PageContainer>
  );
}
