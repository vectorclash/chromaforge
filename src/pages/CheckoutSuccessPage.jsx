import React, { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import PageContainer from '../components/ui/PageContainer';
import Button from '../components/ui/Button';
import HexagonLoader from '../components/HexagonLoader';
import { getOrder } from '../lib/checkout';
import { usePageMeta } from '../hooks/usePageMeta';

const POLL_INTERVAL_MS = 2000;
const POLL_MAX_TRIES = 15; // ~30s -- the webhook usually beats the browser back to this page

// Statuses that mean "stop polling, the outcome is known". 'fulfilled' cannot realistically
// be reached inside this page's ~30s window (Printful takes days to ship), but it is a
// terminal status and enumerating the terminal set without it is the kind of omission that
// bites later -- reachable today only by revisiting this URL for a long-since-shipped order,
// which would otherwise poll to a needless timeout.
const RESOLVED_STATUSES = new Set(['submitted', 'fulfilled', 'failed']);

// Lands here from Stripe's success_url. The webhook that actually confirms payment and
// submits the Printful order runs server-side and may not have finished by the time the
// browser redirect does -- this polls until it has (or times out without claiming failure,
// since "not done yet" and "failed" are different things).
export default function CheckoutSuccessPage() {
  usePageMeta({ title: 'Order confirmation', path: '/checkout/success', noindex: true });
  const [order, setOrder] = useState(null);
  const [timedOut, setTimedOut] = useState(false);
  const [notFound, setNotFound] = useState(false);
  // Read-then-delete from sessionStorage must happen exactly once -- StrictMode's
  // dev-only double-invocation of effects would otherwise find the value already gone on
  // the second pass and report a false "not found". The id is cached in a ref (rather than
  // bailing out of the whole effect on the second run) so polling still restarts after the
  // double-invoke -- an early-return guard here previously left the page stuck on
  // "Confirming…" in dev, because the first run's cleanup had already cancelled its poll
  // loop and the guarded second run never started one.
  const orderIdRef = useRef(undefined);

  useEffect(() => {
    if (orderIdRef.current === undefined) {
      orderIdRef.current = sessionStorage.getItem('chromaforge:lastOrderId');
      sessionStorage.removeItem('chromaforge:lastOrderId');
    }
    const orderId = orderIdRef.current;
    if (!orderId) {
      setNotFound(true);
      return;
    }

    let cancelled = false;
    let tries = 0;

    const poll = async () => {
      try {
        const row = await getOrder(orderId);
        if (cancelled) return;
        setOrder(row);
        if (RESOLVED_STATUSES.has(row.status)) return;
      } catch {
        // Keep polling -- the order row may not exist for an instant if this page loads
        // before create-checkout-session's insert has propagated, though that's already
        // long done by the time Stripe redirects back.
      }
      tries += 1;
      if (tries >= POLL_MAX_TRIES) {
        if (!cancelled) setTimedOut(true);
        return;
      }
      setTimeout(poll, POLL_INTERVAL_MS);
    };
    poll();

    return () => {
      cancelled = true;
    };
  }, []);

  if (notFound) {
    return (
      <PageContainer title="Order confirmation">
        <p className="text-text-secondary">
          We couldn't find a recent order in this browser session.{' '}
          <Link to="/account" className="text-accent underline">Check your order history</Link> instead.
        </p>
      </PageContainer>
    );
  }

  const resolved = order && RESOLVED_STATUSES.has(order.status);

  if (!resolved) {
    return (
      <PageContainer title="Confirming your order">
        <div className="flex flex-col items-center gap-3 py-12 text-center text-text">
          <HexagonLoader />
          <p className="text-sm font-bold">
            {timedOut ? 'Still confirming -- this is taking a little longer than usual.' : 'Confirming your order…'}
          </p>
          <p className="max-w-xs text-xs text-text-secondary">
            {timedOut
              ? "Your payment went through. We'll keep trying in the background -- check your order history in a few minutes."
              : 'Your payment is being confirmed and your order sent to production.'}
          </p>
          {timedOut && (
            <Button as={Link} to="/account" variant="secondary" className="mt-2">
              Go to order history
            </Button>
          )}
        </div>
      </PageContainer>
    );
  }

  if (order.status === 'failed') {
    return (
      <PageContainer title="We hit a snag">
        <div className="animate-pop-in max-w-sm rounded-lg border border-accent/30 bg-accent/10 px-4 py-3">
          <p className="text-sm font-bold text-accent">
            Your payment went through, but we ran into an issue submitting your order for
            production. We're looking into it -- no action needed from you right now.
          </p>
        </div>
        <Button
          as={Link}
          to="/account"
          variant="secondary"
          className="mt-6 animate-fade-slide-up"
          style={{ animationDelay: '80ms' }}
        >
          Go to order history
        </Button>
      </PageContainer>
    );
  }

  const item = order.order_items?.[0];

  return (
    <PageContainer title="Order confirmed" subtitle="Thanks! Your order is on its way to production.">
      {item && (
        <div className="animate-fade-slide-up max-w-sm rounded-xl border border-hairline bg-ink-800 p-5">
          <p className="font-quicksand text-sm font-bold text-text">
            {item.product_title}
            {item.variant_label ? ` (${item.variant_label})` : ''}
          </p>
          <p className="mt-1 text-sm text-text-secondary">Qty {item.quantity}</p>
          <p className="mt-3 font-display text-xl text-text">${(order.total_cents / 100).toFixed(2)}</p>
        </div>
      )}
      <div className="mt-6 flex animate-fade-slide-up gap-3" style={{ animationDelay: '80ms' }}>
        <Button as={Link} to="/account">View order history</Button>
        <Button as={Link} to="/shop" variant="secondary">Keep shopping</Button>
      </div>
    </PageContainer>
  );
}
