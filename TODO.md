# TODO — road to launch (and after)

Working list for Aaron + Claude, written after the full pre-launch review on 2026-07-01
(review findings + same-day fixes are summarized in that session's commit, "Pre-launch
hardening"). Check items off / delete sections as they land — like CLAUDE.md, this file
tracks what's true now, not history.

## Blocking launch — dashboard/ops (Aaron, no code)

- [ ] **Activate Stripe Tax** in the Stripe dashboard (the dedicated **Tax** product in the
      sidebar, not Settings → Tax — that page is just default price-level tax behavior and
      isn't the blocker). `create-checkout-session` now sends `automatic_tax: enabled`, so
      the *next checkout attempt errors* until this is done. Escape hatch while sorting it
      out: `npx supabase secrets set STRIPE_AUTOMATIC_TAX=false`.
      **In progress (2026-07-02):** Stripe Tax is a paid add-on (per-transaction fee, not
      bundled) — worth checking "View plans" pricing if that matters. California seller's
      permit application submitted to CDTFA (Printful listed as supplier: Printful, Inc.,
      11025 Westlake Dr, Charlotte, NC 28273) — **pending a permit number back from
      CDTFA.** Once that arrives: Stripe → Tax → Registrations → Add registration →
      California → "I've already registered" → enter the permit number. That's the last
      step before this item is actually done.
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

- [x] **Password reset flow** — "Forgot password?" on AccountPage (signed-out, sign-in mode
      only) → `requestPasswordReset` (`src/lib/auth.js`) → branded email
      (`supabase/templates/recovery.html`, wired in `config.toml`) → AuthContext detects
      `type=recovery` in the returned hash and routes straight to `/account` (needed
      `AuthProvider` moved inside `BrowserRouter` in `App.jsx` so it can call `useNavigate`)
      → AccountPage's `recoveryMode` branch shows a set-new-password form →
      `updatePassword`. Verified locally: build clean, the forgot-password request/response
      round-tripped against the real Supabase project, and the recovery-hash routing was
      exercised headlessly (Playwright) with no console errors. **Not yet verified with a
      real emailed link** — that needs an actual "Forgot password?" click against a real
      inbox. Also caught and fixed a real pre-existing bug this surfaced: `setImage()` in
      `DisplayCanvas.jsx` had an unguarded `document.querySelector('.image-container')` in
      a `gsap.delayedCall(1, ...)` with no unmount cancellation — harmless before since
      nothing navigated away from a freshly-mounted homepage that fast, but the recovery
      redirect does exactly that every time. Now null-guarded like the neighboring
      `#controls-main` lookup already was.
      Recovery template pasted into the Dashboard's Auth → Email Templates → "Reset
      password" (Aaron, done). Still not merged to `master`, so not live on
      chromaforge.app yet.
- [x] **Route-level code splitting**: `ShopPage`/`ProductPage`/`GalleryPage`/`AccountPage`/
      `CheckoutSuccessPage`/`TermsPage`/`PrivacyPage`/`NotFoundPage` are now `React.lazy` in
      `App.jsx`, with the `Suspense` boundary scoped to `SiteLayout`'s `<Outlet />` (not the
      whole layout, so header/footer/mini-generator never flash away between routes).
      `HomePage`/`StudioPage` deliberately stay eager — `Hero.jsx` statically imports
      `StudioPage` (the homepage hero *is* the compact studio), so lazy-splitting `/studio`
      itself would just duplicate the DisplayCanvas/GSAP/createjs code into a second chunk
      rather than removing it from either. Real, measured result: main chunk
      718 KB → 397 KB (gzip 217 KB → 129 KB); Supabase's SDK (201 KB) and each page now
      split into their own on-demand chunks; the "chunks larger than 500 KB" build warning
      is gone. Verified live (Playwright): every route (`/`, `/shop`, `/gallery`,
      `/account`, `/terms`, `/privacy`, `/studio`, an unknown path) loads with the correct
      title and zero console errors, both cold and on repeat visits.
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
- **Supabase's other auth email templates (Invite user, Magic Link, Change Email Address,
  Reauthentication) are intentionally left unbranded** — nothing in the app currently
  triggers them (no invite flow, no magic-link sign-in, no email-change UI, and
  `secure_password_change = false` means no reauth prompt either). Invite user is a
  plausible future feature (inviting someone to view/collaborate?) — revisit branding it
  if that gets built, not before.
