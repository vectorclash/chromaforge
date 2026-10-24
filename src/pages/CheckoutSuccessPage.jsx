import React, { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import PageContainer from '../components/ui/PageContainer';
import Button from '../components/ui/Button';
import HexagonLoader, { HEXAGON_DRAWN } from '../components/HexagonLoader';
import { CheckoutSuccessSkeleton, SkeletonFadeOut } from '../components/ui/RouteSkeleton';
import { getOrder } from '../lib/checkout';
import { usePageMeta } from '../hooks/usePageMeta';
import { DURATION_BASE, DURATION_SLOW } from '../utils/motionTokens';

const ORDER_ID_KEY = 'chromaforge:lastOrderId';
const POLL_INTERVAL_MS = 2000;
// ~90s. The webhook usually beats the browser back here, but since print files render AFTER
// payment (2026-10-19) an order then spends a further ~10-30s at 'paid' before it reaches
// Printful, longer for a big garment on a cold render machine.
const POLL_MAX_TRIES = 45;
// How long the skeleton may stand in before an order that is genuinely not ready yet gets the
// "Confirming your order" loader. Almost every visit's first answer is already a confirmed
// order, and those never see the loader at all.
const CONFIRMING_AFTER_MS = 1200;

// Statuses that mean "stop polling" -- deliberately NOT every terminal status, which is the
// trap here. Below, only 'failed' gets its own screen: anything else that resolves falls
// through to "Order confirmed -- your order is on its way to production", so adding 'canceled'
// or 'refunded' to this set would render a dead order as a confirmed one. They stay out and
// keep the existing poll-then-timeout behaviour, which says "still confirming" and offers the
// order history -- vague, but never false.
//
// 'fulfilled' is safe to include (it IS confirmed, just further along) and 'on_hold' is
// correctly absent anyway: a hold is a pause, not an outcome. In practice none of these are
// reachable in this page's ~30s window -- Printful takes days -- and the order id is
// read-then-deleted from sessionStorage, so the page is effectively single-use.
const RESOLVED_STATUSES = new Set(['submitted', 'fulfilled', 'failed']);

const FADE_OUT = 'transition-opacity duration-[var(--duration-base)] ease-out';

// Lands here from Stripe's success_url. The webhook that actually confirms payment and
// submits the Printful order runs server-side and may not have finished by the time the
// browser redirect does -- this polls until it has (or times out without claiming failure,
// since "not done yet" and "failed" are different things).
//
// How it arrives (2026-10-24, Aaron: "there is content for a flash before the data is received
// and then it just pops into place"). It used to open on the "Confirming your order" loader and
// swap the whole page for "Order confirmed" in one frame when the first answer landed, a few
// hundred ms later, on nearly every visit. Now each screen it can show is a VIEW, and moving
// between views is never a cut:
//   - it opens on a skeleton of the confirmed page (CheckoutSuccessSkeleton, also the route's
//     Suspense fallback), which crossfades into whatever the order turns out to be, the product
//     page's handover;
//   - the loader only appears once an answer has said the order is not ready AND
//     CONFIRMING_AFTER_MS has passed, so a slow network on a confirmed order keeps the skeleton
//     instead of flashing the loader;
//   - leaving any real view fades it out first (DURATION_BASE) and the next one enters with the
//     route's own cascade, and the loader leaves no sooner than its strokes are fully drawn, the
//     studio's rule for that loader.
export default function CheckoutSuccessPage() {
  usePageMeta({ title: 'Order confirmation', path: '/checkout/success', noindex: true });
  // Read DURING RENDER, so a visit with no order in this session (a reload, a bookmark) shows
  // its answer on the first frame instead of the skeleton. Read without removing: StrictMode
  // calls this initialiser twice in development, and a removal here would make the second call
  // find nothing. The effect below removes it -- the page is single-use either way.
  const [orderId] = useState(() => sessionStorage.getItem(ORDER_ID_KEY));
  const [order, setOrder] = useState(null);
  const [answered, setAnswered] = useState(false);
  const [timedOut, setTimedOut] = useState(false);
  const [graceOver, setGraceOver] = useState(false);

  useEffect(() => {
    sessionStorage.removeItem(ORDER_ID_KEY);
    if (!orderId) return;

    let cancelled = false;
    let tries = 0;
    let pollTimer;
    const grace = setTimeout(() => !cancelled && setGraceOver(true), CONFIRMING_AFTER_MS);

    const poll = async () => {
      try {
        const row = await getOrder(orderId);
        if (cancelled) return;
        setOrder(row);
        setAnswered(true);
        if (RESOLVED_STATUSES.has(row.status)) return;
      } catch {
        // Keep polling -- the order row may not exist for an instant if this page loads
        // before create-checkout-session's insert has propagated, though that's already
        // long done by the time Stripe redirects back.
        if (cancelled) return;
        setAnswered(true);
      }
      tries += 1;
      if (tries >= POLL_MAX_TRIES) {
        setTimedOut(true);
        return;
      }
      pollTimer = setTimeout(poll, POLL_INTERVAL_MS);
    };
    poll();

    return () => {
      cancelled = true;
      clearTimeout(grace);
      clearTimeout(pollTimer);
    };
  }, [orderId]);

  // 'paid' is shown as confirmed (it is: the money has settled) while polling carries on until the
  // order reaches Printful or fails. It is not in RESOLVED_STATUSES because polling must not stop
  // there -- a render or submission failure after payment still has to reach the screen below.
  const preparing = order?.status === 'paid';
  const resolved = order && (RESOLVED_STATUSES.has(order.status) || preparing);
  const view = !orderId
    ? 'notFound'
    : resolved
      ? order.status === 'failed'
        ? 'failed'
        : 'confirmed'
      : timedOut || (graceOver && answered)
        ? 'confirming'
        : 'waiting';

  // `shown` is the view on screen, which trails `view` while the outgoing one fades.
  const [shown, setShown] = useState(view);
  const [exiting, setExiting] = useState(false);
  const [skeletonLeaving, setSkeletonLeaving] = useState(false);
  const shownAt = useRef(0);

  // The skeleton is the one view that does not fade out first: it crossfades over the arriving
  // view. Adjusted during render, so the frame the answer lands is already the crossfade.
  if (shown === 'waiting' && view !== 'waiting') {
    setSkeletonLeaving(true);
    setShown(view);
  }

  useEffect(() => {
    shownAt.current = performance.now();
  }, [shown]);

  // Every other view fades out, THEN the next one enters. The loader is never taken away before
  // its strokes are fully drawn, so that hold comes before the fade, not after it.
  const leaving = shown !== 'waiting' && view !== shown;
  useEffect(() => {
    if (!leaving) {
      setExiting(false);
      return;
    }
    const hold =
      shown === 'confirming'
        ? Math.max(0, HEXAGON_DRAWN * 1000 - (performance.now() - shownAt.current))
        : 0;
    const fade = setTimeout(() => setExiting(true), hold);
    const swap = setTimeout(() => {
      setExiting(false);
      setShown(view);
    }, hold + DURATION_BASE * 1000);
    return () => {
      clearTimeout(fade);
      clearTimeout(swap);
    };
  }, [leaving, shown, view]);

  // Drop the faded-out skeleton once its transition has run (a timer, not transitionend, which
  // never fires under reduced motion -- same as ProductPage).
  useEffect(() => {
    if (!skeletonLeaving) return;
    const t = setTimeout(() => setSkeletonLeaving(false), DURATION_SLOW * 1000);
    return () => clearTimeout(t);
  }, [skeletonLeaving]);

  if (shown === 'waiting') return <CheckoutSuccessSkeleton />;

  // Keyed on the view, so each one mounts fresh and plays the route's entrance; `relative` so
  // the outgoing skeleton can sit over it while it fades.
  return (
    <div key={shown} className={`relative ${FADE_OUT} ${exiting ? 'opacity-0' : 'opacity-100'}`}>
      {skeletonLeaving && (
        <SkeletonFadeOut>
          <CheckoutSuccessSkeleton />
        </SkeletonFadeOut>
      )}
      <View shown={shown} order={order} preparing={preparing} timedOut={timedOut} />
    </div>
  );
}

function View({ shown, order, preparing, timedOut }) {
  if (shown === 'notFound') {
    return (
      <PageContainer title="Order confirmation">
        <p className="text-text-secondary">
          We couldn't find a recent order in this browser session.{' '}
          <Link to="/account" className="text-accent underline">Check your order history</Link> instead.
        </p>
      </PageContainer>
    );
  }

  if (shown === 'confirming') {
    return (
      <PageContainer title="Confirming your order">
        <div className="flex flex-col items-center gap-3 py-12 text-center text-text">
          <HexagonLoader />
          {/* Keyed so the late wording fades in rather than replacing the first in place. */}
          <div key={timedOut ? 'late' : 'now'} className="flex animate-fade-in flex-col items-center gap-3">
            <p className="text-sm font-bold">
              {timedOut ? 'Still confirming — this is taking a little longer than usual.' : 'Confirming your order…'}
            </p>
            <p className="max-w-xs text-xs text-text-secondary">
              {timedOut
                ? "Your payment went through. We'll keep trying in the background — check your order history in a few minutes."
                : 'Your payment is being confirmed and your order sent to production.'}
            </p>
            {timedOut && (
              <Button as={Link} to="/account" variant="secondary" className="mt-2">
                Go to order history
              </Button>
            )}
          </div>
        </div>
      </PageContainer>
    );
  }

  if (shown === 'failed') {
    return (
      <PageContainer title="We hit a snag">
        <div className="max-w-sm rounded-lg border border-accent/30 bg-accent/10 px-4 py-3">
          <p className="text-sm font-bold text-accent">
            Your payment went through, but we ran into an issue submitting your order for
            production. We're looking into it — no action needed from you right now.
          </p>
        </div>
        <Button
          as={Link}
          to="/account"
          variant="secondary"
          className="mt-6"
        >
          Go to order history
        </Button>
      </PageContainer>
    );
  }

  const item = order.order_items?.[0];

  return (
    <PageContainer
      title="Order confirmed"
      subtitle={
        // Keyed: the order moves from 'paid' to 'submitted' while this is on screen, and the new
        // sentence fades in rather than replacing the old one in place.
        <span key={preparing ? 'preparing' : 'sent'} className="animate-fade-in">
          {preparing
            ? "Thanks! Your payment went through and we're preparing your print files now."
            : 'Thanks! Your order is on its way to production.'}
        </span>
      }
    >
      {item && (
        <div className="max-w-sm rounded-xl border border-hairline bg-ink-800 p-5">
          <p className="font-quicksand text-sm font-bold text-text">
            {item.product_title}
            {item.variant_label ? ` (${item.variant_label})` : ''}
          </p>
          <p className="mt-1 text-sm text-text-secondary">Qty {item.quantity}</p>
          <p className="mt-3 font-display text-xl text-text">${(order.total_cents / 100).toFixed(2)}</p>
        </div>
      )}
      <div className="mt-6 flex gap-3">
        <Button as={Link} to="/account">View order history</Button>
        <Button as={Link} to="/shop" variant="secondary">Keep shopping</Button>
      </div>
    </PageContainer>
  );
}
