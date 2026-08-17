-- Closes the remaining statuses Printful can report that our own enum had no answer for
-- (2026-08-17, immediately after 0016's `fulfilled`). Same root shape as that bug: the enum
-- only ever described how an order could END BADLY, so anything else Printful said fell
-- through printful-webhook's mirror-only branch and left the order sitting in the account
-- page's Active list reading "In production".
--
--   on_hold  -- Printful paused the order and will not produce it until the hold is cleared.
--              Subscribed as order_put_hold / order_put_hold_approval and already observed
--              once in this store's data as printful_status 'onhold'. NOT terminal: it is the
--              one reversible thing Printful reports (order_remove_hold returns it to
--              'submitted'), so it stays in the ACTIVE list -- a held order genuinely is still
--              in flight, it just isn't progressing, which is what the label has to say.
--   refunded -- Printful refunded on their side. Subscribed as order_refunded, recognized by
--              the webhook since it was written, but mapped to nothing. Terminal, and belongs
--              in history.
--
-- No backfill: no order has ever reached either state. The one row that ever carried
-- printful_status 'onhold' (de012dba, 2026-07-22) was subsequently canceled, and canceled is
-- terminal -- deliberately left alone rather than rewritten to reflect a state it has since
-- moved on from.

alter table public.orders
  drop constraint orders_status_check;

alter table public.orders
  add constraint orders_status_check
    check (status in (
      'pending', 'paid', 'submitted', 'on_hold', 'fulfilled', 'refunded', 'failed', 'canceled'
    ));
