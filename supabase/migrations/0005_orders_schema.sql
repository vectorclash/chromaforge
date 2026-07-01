-- Orders: real Printful purchases, paid via Stripe Checkout.
--
-- Orders/order_items are written ONLY by the stripe-webhook Edge Function (and the initial
-- 'pending' insert from create-checkout-session), both running with the service role, which
-- bypasses RLS -- there is deliberately no insert/update policy for the `authenticated` role
-- below. A client-side insert would let a user fabricate a "paid" order with no actual
-- Stripe charge; only server-side code holding the service role key should ever write here.
-- Clients get read-only access to their own orders.
--
-- order_items snapshots product/variant/design data at time of purchase (not FKs to a live
-- mutable catalog or to `designs`) -- orders must stay reproducible/auditable even if the
-- user later edits/deletes the source design, Printful's catalog prices change, or a
-- product is discontinued. design_data is a frozen copy of designs.data (jsonb).

create table public.orders (
  id                        uuid primary key default gen_random_uuid(),
  user_id                   uuid not null references public.profiles(id) on delete cascade,
  status                    text not null default 'pending'
                              check (status in ('pending', 'paid', 'submitted', 'failed', 'canceled')),
  stripe_session_id         text not null unique,
  stripe_payment_intent_id  text,
  printful_order_id         text,
  shipping_name             text,
  shipping_address          jsonb,        -- Stripe's collected shipping address, frozen
  currency                  text not null default 'usd',
  subtotal_cents            integer not null,
  total_cents               integer not null,
  failure_reason            text,         -- set if Printful order creation fails post-payment
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now()
);

create index orders_user_id_idx on public.orders(user_id);

alter table public.orders enable row level security;

create policy "Users can view their own orders"
  on public.orders for select using (auth.uid() = user_id);

-- No insert/update/delete policy for `authenticated` -- only the service role (used
-- exclusively by create-checkout-session and stripe-webhook) can write orders. This is
-- intentional, not an oversight.

create table public.order_items (
  id               uuid primary key default gen_random_uuid(),
  order_id         uuid not null references public.orders(id) on delete cascade,
  product_id       integer not null,        -- Printful catalog product id (not a local FK)
  variant_id       integer not null,        -- Printful catalog variant id
  product_title    text not null,
  variant_label    text,                    -- e.g. "M / Black", frozen for display
  quantity         integer not null check (quantity > 0),
  unit_price_cents integer not null,
  design_data      jsonb not null,          -- frozen copy of designs.data at purchase time
  print_file_urls  jsonb not null,          -- { [placement]: url, ... } -- the swappable seam:
                                             -- v1 = capped-res browser renders uploaded to
                                             -- design-mockups, a later phase points this at a
                                             -- print-resolution render service instead without
                                             -- changing this column's shape
  created_at       timestamptz not null default now()
);

create index order_items_order_id_idx on public.order_items(order_id);

alter table public.order_items enable row level security;

create policy "Users can view their own order items"
  on public.order_items for select using (
    exists (select 1 from public.orders o where o.id = order_id and o.user_id = auth.uid())
  );

-- Keep updated_at current on every status transition (pending -> paid -> submitted/failed).
create or replace function public.handle_order_updated_at()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger on_order_updated
  before update on public.orders
  for each row execute function public.handle_order_updated_at();
