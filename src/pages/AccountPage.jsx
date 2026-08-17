import React, { useCallback, useEffect, useRef, useState } from 'react';
import PageContainer from '../components/ui/PageContainer';
import Button from '../components/ui/Button';
import GoogleIcon from '../components/buttons/GoogleIcon';
import FadeImage from '../components/ui/FadeImage';
import { Field, Input } from '../components/ui/Field';
import Turnstile from '../components/ui/Turnstile';
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
import { getActiveOrderPreviews, listMyActiveOrders, listMyOrderHistory } from '../lib/checkout';
import { generateAvatar } from '../render/generateAvatar';
import renderAvatar from '../render/renderAvatar';
import { randomSeed } from '../render/prng';
import { useAuth } from '../context/AuthContext';
import { usePageMeta } from '../hooks/usePageMeta';

const AVATAR_SIZE = 256;

// 'pending' is deliberately excluded -- neither listMyActiveOrders() nor listMyOrderHistory()
// ever return it (see lib/checkout.js), it's an implementation detail of checkout, not a
// customer-visible state. 'failed' gets the same accent-color treatment as form errors
// elsewhere on this page, so it doesn't blend in with a normal completed order.
//
// 'fulfilled' is the one history status that is GOOD news, so it keeps the same
// text-secondary weight the in-flight statuses use rather than 'canceled''s muted grey --
// a completed order should not read as the faded-out end of the list.
//
// Labelled "Shipped", not "Delivered": Printful's `fulfilled` means every item has left the
// facility, which is not the same claim as arrival, and there is no tracking/delivery signal
// anywhere in this app to back the stronger word.
const ORDER_STATUS_DISPLAY = {
  paid: { label: 'Processing', className: 'text-text-secondary' },
  submitted: { label: 'In production', className: 'text-text-secondary' },
  fulfilled: { label: 'Shipped', className: 'text-text-secondary' },
  failed: { label: 'Needs attention', className: 'text-accent' },
  canceled: { label: 'Canceled', className: 'text-text-muted' }
};

const HISTORY_PAGE_SIZE = 20;

// Same tab-underline idiom as GalleryPage.jsx's Public/My Designs tabs, sized to match this
// block's existing text-xs uppercase heading instead of Gallery's larger page-level tabs.
const orderTabClass = active =>
  'cursor-pointer font-quicksand text-xs font-bold uppercase tracking-[0.14em] pb-2 border-b-2 transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-interactive ' +
  (active ? 'border-accent text-text' : 'border-transparent text-text-muted hover:text-text');

// Scrolling container for the order lists -- and it deliberately does NOT scroll until the
// rows have finished animating in (Aaron's call, 2026-08-11, from a real annoyance).
//
// Why: the rows enter with fade-slide-up, whose `backwards` fill holds them 16px BELOW their
// final position for the whole length of their stagger delay. Inside an overflow-y-auto box
// that counts as scrollable overflow, so a list that will never need a scrollbar grows one
// anyway and then loses it -- measured on a 3-row list at exactly 16px, present from
// t=1360ms to t=2000ms. Absorbing the 16px with bottom padding was tried first and is worse:
// it fixes the short case but pushes a 5-row list past max-height into scrolling it did not
// previously need.
//
// The wait keys off the REAL animations rather than re-deriving their timing from the delay
// props and --duration-slow, so it cannot drift if the motion tokens change. Two details
// that are load-bearing: the skeleton's `animate-pulse` runs forever, so its `finished`
// promise must be filtered out or scrolling would never come back; and this only ever
// settles once (`settled` is never set false again), because clamping overflow on a list the
// user has already scrolled would jump them back to the top when "Load more" appends rows.
function OrderList({ hasRows, children }) {
  const ref = useRef(null);
  const [settled, setSettled] = useState(false);

  useEffect(() => {
    if (!hasRows || settled) return;
    const el = ref.current;
    if (!el?.getAnimations) {
      setSettled(true);
      return;
    }
    let cancelled = false;
    const running = el
      .getAnimations({ subtree: true })
      .filter(a => a.effect?.getTiming().iterations !== Infinity);
    Promise.allSettled(running.map(a => a.finished)).then(() => !cancelled && setSettled(true));
    // Safety net: a list must never be left permanently unscrollable because an animation
    // was cancelled or never resolved.
    const timeout = setTimeout(() => !cancelled && setSettled(true), 3000);
    return () => {
      cancelled = true;
      clearTimeout(timeout);
    };
  }, [hasRows, settled]);

  return (
    <div
      ref={ref}
      className={
        'mt-3 space-y-2 lg:max-h-[32rem] lg:pr-1 ' +
        (settled ? 'lg:overflow-y-auto' : 'lg:overflow-y-hidden')
      }
    >
      {children}
    </div>
  );
}

// One row, shared by the Active and History lists below.
//
// `previewUrl` (active orders only) is Printful's own composite of the finished garment,
// rendered from the real print files -- see getActiveOrderPreviews.
//
// The preview arrives on a second, slower request than the order rows, so the slot is
// RESERVED before the URL exists rather than appearing when it lands -- an image that pops
// in and shoves the text sideways is the thing this layout is built to avoid. `previewPending`
// is the caller's prediction that one is coming, and it can be made honestly: it uses the
// exact condition the Edge Function selects on (an active order with a printful_order_id),
// so it is right except when Printful itself fails to return a preview for an order that has
// one. That case collapses the slot once the request resolves, which is the only reflow left
// and is rare by construction.
function OrderRow({ order, delay, previewUrl = null, previewPending = false }) {
  const item = order.order_items?.[0];
  const status = ORDER_STATUS_DISPLAY[order.status] ?? ORDER_STATUS_DISPLAY.submitted;
  // A preview URL that 404s (Printful's CDN, not ours) must leave no gap behind -- same
  // treatment as the gallery's missing thumbnails, which is the established pattern here.
  const [failed, setFailed] = useState(false);
  const showSlot = (previewUrl || previewPending) && !failed;

  return (
    <div
      style={{ animationDelay: `${delay}ms` }}
      className="animate-fade-slide-up flex items-center gap-3 rounded-lg border border-hairline bg-ink-800 p-4 font-quicksand text-sm"
    >
      {showSlot && (
        // 64px rather than the 48-56 a list row would normally take: Printful's preview is a
        // full-body model shot, so the garment itself is only about a quarter of the frame
        // and anything smaller reads as an indistinct blob. `relative` is FadeImage's one
        // requirement (it positions its skeleton against this box).
        <div className="relative h-16 w-16 shrink-0 overflow-hidden rounded-md border border-hairline bg-ink-700">
          {previewUrl ? (
            <FadeImage
              src={previewUrl}
              alt={`Printful's mockup of ${item?.product_title ?? 'this order'}`}
              loading="lazy"
              onError={() => setFailed(true)}
              className="h-full w-full object-cover"
            />
          ) : (
            // Same pulsing fill FadeImage uses once a src exists, so the wait for the URL
            // and the wait for the image decode are visually one continuous state.
            <div className="absolute inset-0 animate-pulse bg-ink-700" aria-hidden="true" />
          )}
        </div>
      )}
      <div className="min-w-0 flex-1">
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
    </div>
  );
}

export default function AccountPage() {
  // avatarUrl/setAvatarUrl come from AuthContext (not local state) so a regenerate here
  // is immediately reflected in SiteHeader's tiny avatar too, without a second fetch.
  const { user, avatarUrl, setAvatarUrl, recoveryMode, clearRecoveryMode, showNotice } = useAuth();
  // noindex: this is either a private, per-user account view or a sign-in form -- neither
  // is content a search result should ever point to.
  usePageMeta({ title: user ? 'Account' : 'Sign in', path: '/account', noindex: true });
  const [mode, setMode] = useState('signin'); // signin | signup | forgot
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [message, setMessage] = useState(null);
  // Turnstile token for Supabase's CAPTCHA protection (see components/ui/Turnstile.jsx).
  // Stays null when VITE_TURNSTILE_SITE_KEY is unset. Tokens are single-use, so every
  // submission bumps captchaReset to make the widget issue a fresh one before a retry.
  const [captchaToken, setCaptchaToken] = useState(null);
  const [captchaReset, setCaptchaReset] = useState(0);

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
  const [activeOrders, setActiveOrders] = useState([]);
  const [activeOrdersLoading, setActiveOrdersLoading] = useState(true);
  // { [orderId]: previewUrl } from Printful, fetched alongside (not before) the rows.
  // previewsResolved flips once that request has finished either way, which is what lets a
  // row stop reserving space for a preview that turned out not to exist.
  const [orderPreviews, setOrderPreviews] = useState({});
  const [previewsResolved, setPreviewsResolved] = useState(false);
  const [orderTab, setOrderTab] = useState('active');
  const [historyOrders, setHistoryOrders] = useState([]);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyLoadingMore, setHistoryLoadingMore] = useState(false);
  const [historyHasMore, setHistoryHasMore] = useState(false);
  const [historyError, setHistoryError] = useState(null);

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
    listMyActiveOrders()
      .then(rows => {
        if (cancelled) return;
        setActiveOrders(rows);
        // Chained rather than fired in parallel, deliberately: this one leaves our own
        // infrastructure (Edge Function -> Printful, one call per in-flight order), and
        // most visits to this page have no active orders at all. Waiting on the cheap
        // local query first means those visits cost nothing. The rows are already on
        // screen by then; the thumbnails fade in behind them.
        if (rows.length > 0) {
          getActiveOrderPreviews().then(previews => {
            if (cancelled) return;
            setOrderPreviews(previews);
            setPreviewsResolved(true);
          });
        } else {
          setPreviewsResolved(true);
        }
      })
      .catch(() => {})
      .finally(() => !cancelled && setActiveOrdersLoading(false));
    return () => {
      cancelled = true;
    };
  }, [user, regenerateAvatar]);

  // Lazy-loaded on first visit to the History tab -- a signed-in user who never checks it
  // never pays for the extra query. Guarded by historyLoaded so switching tabs back and
  // forth doesn't re-fetch page 1 every time.
  useEffect(() => {
    if (orderTab !== 'history' || historyLoaded) return;
    let cancelled = false;
    setHistoryLoading(true);
    setHistoryError(null);
    listMyOrderHistory({ limit: HISTORY_PAGE_SIZE })
      .then(rows => {
        if (cancelled) return;
        setHistoryOrders(rows);
        setHistoryHasMore(rows.length === HISTORY_PAGE_SIZE);
        setHistoryLoaded(true);
      })
      .catch(err => !cancelled && setHistoryError(err.message))
      .finally(() => !cancelled && setHistoryLoading(false));
    return () => {
      cancelled = true;
    };
  }, [orderTab, historyLoaded]);

  const onLoadMoreHistory = async () => {
    const cursor = historyOrders[historyOrders.length - 1]?.created_at;
    if (!cursor) return;
    setHistoryLoadingMore(true);
    try {
      const more = await listMyOrderHistory({ limit: HISTORY_PAGE_SIZE, before: cursor });
      setHistoryOrders(rows => [...rows, ...more]);
      setHistoryHasMore(more.length === HISTORY_PAGE_SIZE);
    } catch (err) {
      setHistoryError(err.message);
    } finally {
      setHistoryLoadingMore(false);
    }
  };

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
          {resetError && <p className="animate-pop-in text-sm text-accent">{resetError}</p>}
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
            {/* Two columns, deliberately ASYMMETRIC rather than a uniform grid of equal
                cards. These blocks aren't peers: stats is two numbers, the profile is a
                short form, and orders is a long paginated list with its own tabs. Forcing
                them into equal cells would crowd the list and leave the stats card mostly
                whitespace. So the small, fixed-height things stack in a narrow side column
                and the one thing that actually grows gets the width -- which is also the
                width the page was wasting before, when every block was max-w-sm in a single
                column. Collapses to one column below lg, which is what it already was.
                Every block now shares the same card treatment; previously only stats had
                one, so the page read as a single card plus some loose content. */}
            <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
              <div className="space-y-6">
                <form
                  onSubmit={onSaveProfile}
                  className="animate-fade-slide-up space-y-5 rounded-xl border border-hairline bg-ink-800 p-5"
                >
                  <div className="flex items-center gap-5">
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
                        {avatarBusy
                          ? 'Generating…'
                          : avatarUrl
                            ? 'Regenerate avatar'
                            : 'Generate avatar'}
                      </Button>
                      {avatarError && (
                        <p className="animate-pop-in mt-2 text-sm text-accent">{avatarError}</p>
                      )}
                    </div>
                  </div>
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
                  {profileError && (
                    <p className="animate-pop-in text-sm text-accent">{profileError}</p>
                  )}
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

                {stats && (
                  <div
                    className="animate-fade-slide-up rounded-xl border border-hairline bg-ink-800 p-5"
                    style={{ animationDelay: '60ms' }}
                  >
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
              </div>

              {(!activeOrdersLoading || activeOrders.length > 0) && (
                <div
                  className="animate-fade-slide-up rounded-xl border border-hairline bg-ink-800 p-5"
                  style={{ animationDelay: '120ms' }}
                >
                  <div className="flex items-center gap-4 border-b border-hairline">
                    <button
                      className={orderTabClass(orderTab === 'active')}
                      onClick={() => setOrderTab('active')}
                    >
                      Active orders
                    </button>
                    <button
                      className={orderTabClass(orderTab === 'history')}
                      onClick={() => setOrderTab('history')}
                    >
                      Order history
                    </button>
                  </div>

                  {/* The list scrolls inside the card above lg, rather than growing the
                      card without limit: at desktop width this sits beside a short side
                      column, so an unbounded list leaves the profile/stats cards stranded
                      against a wall of orders. Below lg it's a single column again and the
                      page's own scroll is the natural one -- a nested scroller on a phone is
                      worse than a long page. */}
                  {orderTab === 'active' && (
                    <OrderList hasRows={activeOrders.length > 0}>
                      {activeOrdersLoading && (
                        <p className="text-sm text-text-secondary">Loading…</p>
                      )}
                      {!activeOrdersLoading && activeOrders.length === 0 && (
                        <p className="text-sm text-text-secondary">No orders in progress.</p>
                      )}
                      {activeOrders.map((order, i) => (
                        <OrderRow
                          key={order.id}
                          order={order}
                          delay={180 + Math.min(i, 10) * 50}
                          previewUrl={orderPreviews[order.id] ?? null}
                          // Reserve the thumbnail slot from the first paint for any order
                          // that will have one -- same condition printful-order-preview
                          // selects on, so the row never has to grow one later.
                          previewPending={!previewsResolved && Boolean(order.printful_order_id)}
                        />
                      ))}
                    </OrderList>
                  )}

                  {orderTab === 'history' && (
                    <OrderList hasRows={historyOrders.length > 0}>
                      {historyLoading && <p className="text-sm text-text-secondary">Loading…</p>}
                      {historyError && <p className="text-sm text-accent">{historyError}</p>}
                      {!historyLoading && historyLoaded && historyOrders.length === 0 && (
                        <p className="text-sm text-text-secondary">No past orders.</p>
                      )}
                      {historyOrders.map((order, i) => (
                        <OrderRow key={order.id} order={order} delay={180 + Math.min(i, 10) * 50} />
                      ))}
                      {historyHasMore && (
                        <Button
                          type="button"
                          variant="secondary"
                          size="sm"
                          onClick={onLoadMoreHistory}
                          disabled={historyLoadingMore}
                          aria-busy={historyLoadingMore}
                        >
                          {historyLoadingMore ? 'Loading…' : 'Load more'}
                        </Button>
                      )}
                    </OrderList>
                  )}
                </div>
              )}
            </div>
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
        const { needsConfirmation, alreadyRegistered } = await signUpWithEmail(
          email,
          password,
          captchaToken
        );
        if (alreadyRegistered) {
          setMode('signin');
          setError('An account with this email already exists. Sign in instead.');
        } else if (needsConfirmation) {
          setMessage('Check your email to confirm your account, then sign in.');
        }
      } else {
        await signInWithEmail(email, password, captchaToken);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setCaptchaToken(null);
      setCaptchaReset(n => n + 1);
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
      await requestPasswordReset(email, captchaToken);
      setMessage('If an account exists for that email, a reset link is on its way.');
    } catch (err) {
      setError(err.message);
    } finally {
      setCaptchaToken(null);
      setCaptchaReset(n => n + 1);
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
      title={
        mode === 'signup' ? 'Create account' : mode === 'forgot' ? 'Reset password' : 'Sign in'
      }
      subtitle={
        mode === 'forgot'
          ? "We'll email you a link to choose a new password."
          : 'Save your designs and order prints.'
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
          <Turnstile onToken={setCaptchaToken} resetSignal={captchaReset} />
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

          <Turnstile onToken={setCaptchaToken} resetSignal={captchaReset} />
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
            <button
              type="button"
              className="cursor-pointer text-accent underline"
              onClick={() => switchMode('signin')}
            >
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
