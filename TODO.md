# TODO — road to launch (and after)

Working list for Aaron + Claude, written after the full pre-launch review on 2026-07-01
(review findings + same-day fixes are summarized in that session's commit, "Pre-launch
hardening"). Check items off / delete sections as they land — like CLAUDE.md, this file
tracks what's true now, not history.

## Blocking launch — dashboard/ops (Aaron, no code)

- [ ] **Activate Stripe Tax** in the Stripe dashboard (Settings → Tax: origin address +
      home-state registration). `create-checkout-session` now sends `automatic_tax: enabled`,
      so the *next checkout attempt errors* until this is done. Escape hatch while sorting it
      out: `npx supabase secrets set STRIPE_AUTOMATIC_TAX=false`.
- [ ] **Enable receipt emails** in Stripe (Settings → Customer emails). Test mode never sends
      them, so this can't be verified until live mode.
- [ ] **Set the real Instagram URL** in `src/components/ui/SiteFooter.jsx` (currently a bare
      `https://instagram.com` placeholder) — or drop the icon.
- [ ] **Tune `SHIPPING_FLAT_CENTS`** if $5.99 flat isn't right (defaults to 599; compare
      against Printful's actual rates for the starter products, especially international).
- [ ] Confirm `ORDER_ALERT_*` secrets are set on stripe-webhook (alert failures are silent
      by design — check the function logs after any test).

## Go-live sequence (in order, last step flips the switch)

1. [ ] Merge `feature/account-gallery-ui` → `master` (nothing on that branch is live on
       chromaforge.app until then; the Supabase/Fly deploys are already live regardless).
2. [ ] Verify deep links work on the live site (`chromaforge.app/shop` direct hit) — the
       `.htaccess` SPA fallback has never been exercised in production.
3. [ ] Run one full test purchase on the live site (Stripe test keys still fine here) and
       confirm the Printful draft looks right, the order shows in account history, and the
       confirmation page resolves.
4. [ ] Swap Stripe test → live: `STRIPE_SECRET_KEY`, register a live-mode webhook endpoint,
       set the new `STRIPE_WEBHOOK_SECRET`.
5. [ ] Unset `PRINTFUL_SKIP_CONFIRM` — **the final switch**; after this, paid orders are
       really produced and billed.

## Code — high value, near term

- [ ] **Password reset flow** (top priority of these): "Forgot password?" on AccountPage →
      `supabase.auth.resetPasswordForEmail` + a set-new-password screen on the redirect
      back. Reuse the branded email template style for the recovery email (paste into the
      Dashboard's Auth → Email Templates, same as confirmation — CLI doesn't push these).
- [ ] **Route-level code splitting**: `React.lazy` the pages (especially the studio /
      DisplayCanvas out of the store routes) — single 713 KB chunk today.
- [ ] **Toast/confirm system on design tokens**: replace `window.confirm` for design delete
      and the raw-color (`bg-neutral-900`/`bg-red-900`) AuthContext notice banner with shared
      Toast + ConfirmDialog components; reuse for save/checkout feedback.
- [ ] **Shared focus-visible ring** (`--color-interactive`) for the ad-hoc Tailwind buttons
      (variant picker, gallery tabs, thumbnail strips) — `cf-btn-*` already has one.
      Verify visually against live styles before landing (project convention).
- [ ] **GSAP reduced-motion in the studio**: the new `prefers-reduced-motion` CSS only
      covers CSS-driven motion; DisplayCanvas's GSAP morphs need `gsap.matchMedia()`.

## Code — worth doing, lower urgency

- [ ] Storage cleanup: `deleteDesign` leaves the public thumbnail behind; `design-mockups`
      accumulates every mockup source forever. (Keep *order* print files deliberately —
      audit trail.)
- [ ] Motion token migration: define 2–3 duration/easing tokens in `@theme` and replace the
      ad-hoc 0.2/0.3/0.35/0.45/0.5s values.
- [ ] Empty states (gallery "no designs yet", etc.): use generated art instead of plain
      text — MiniGenerator already exists for this.
- [ ] Homepage scroll-reveal audit: sections below the hero vs. the card entrances the
      grids already have.
- [ ] Delete CRA leftovers: `src/serviceWorker.js`, `src/App.test.js`.
- [ ] `sitemap.xml` (static routes only) + decide on privacy-friendly analytics or none
      (Privacy page currently promises no trackers — keep it true either way).
- [ ] Expand `ALLOWED_SHIPPING_COUNTRIES` deliberately (checked against Printful coverage)
      as demand appears.

## Explicitly deferred / decisions made

- **No auto-refund on Printful failure after payment** — deliberate human-judgment gap;
  alert email + 'Needs attention' status is the design.
- **Flat-rate shipping** (not per-address quotes) — hosted Checkout collects the address
  after session creation, so exact quoting isn't possible anyway. Revisit only if margins
  say so.
- **three.js is installed but unused** — reserved for an upcoming feature; it costs nothing
  at runtime (never imported, so never bundled). Don't "clean it up."
