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
- [x] **Enable receipt emails** in Stripe (Settings → Business → Customer emails →
      "Successful payments" toggle) — done 2026-07-02. Still can't be verified end-to-end
      until live mode, since test mode never actually sends them.
- [x] **Instagram icon removed** from `SiteFooter.jsx` (2026-07-02, Aaron's call — not
      interested in being on Meta platforms). If a YouTube channel happens later, adding
      its icon/link back is a small, isolated change whenever there's a real URL to point
      at — don't add a placeholder speculatively before that exists.
- [x] **Deployed the reworked shipping calc** (2026-07-02) — `create-checkout-session` is
      live with the weight-class + region rates. **Still needs**: one live test purchase,
      trying a couple of different regions in the shipping-option picker, to confirm the
      right rate is charged and the totals look right.
- [x] **Confirm `ORDER_ALERT_*` secrets are set** — all 5 present (`ORDER_ALERT_EMAIL_TO`,
      `ORDER_ALERT_SMTP_HOST`, `ORDER_ALERT_SMTP_PASSWORD`, `ORDER_ALERT_SMTP_PORT`,
      `ORDER_ALERT_SMTP_USER`), confirmed 2026-07-02 via `npx supabase secrets list`. Names
      being set doesn't guarantee the values are correct (e.g. a typo'd password) — that
      still needs a real send to confirm, which the live test-purchase step above will
      cover (check `stripe-webhook`'s logs afterward for a clean send vs. the "alert not
      sent" error).

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

- [x] **Snappy entrance animations for "new content just appears" moments** (2026-07-02) —
      Aaron's ask, plus a real bug found while doing it: `DisplayCanvas.jsx`'s "Copied to
      clipboard" indicator already had a `gsap.fromTo('.alert', ...)` call meant to animate
      it in, but no element in the JSX actually had `className="alert"` (drifted at some
      point) -- animating a selector with zero matches is a silent no-op, so it was just
      popping in with no animation at all, and the share-link box was visibly resizing to
      fit it with no transition ("the box gets bigger" per Aaron's report). Fixed the class
      + a real render-timing race (`gsap.fromTo` querying the DOM immediately after
      `setState`, before React had actually rendered the new element -- same
      `gsap.delayedCall(0.05, ...)` pattern already used elsewhere in this file for exactly
      this). Added the matching treatment to the "✓ Saved to your gallery" confirmation,
      which had no entrance at all before. Extended the same "snappy, fun" language
      site-wide: new `--animate-toast-in`/`--animate-fade-in` tokens (`@theme`, same
      overshoot bezier as the existing `--animate-pop-in`, on the fast 200ms tier) for
      `Toast` and `ConfirmDialog`'s backdrop+panel; reused the existing `--animate-pop-in`
      for `AccountPage`'s message/error banners and `ProductPage`'s mockup-failed state.
      Verified live: the copy-link and account-banner flows round-tripped against real
      state changes (Playwright) with the animation actually visible in the DOM and zero
      console errors; `ConfirmDialog` checked via a temporary forced-open override (no
      test-account credentials available to drive it via a real delete).
      **Follow-up fix, same day**: Aaron caught a real regression in the first pass --
      the two GSAP-based animations (copy-link, gallery-saved) were popping in fully
      visible, then snapping to hidden, then animating in. Root cause: `gsap.delayedCall(
      0.05, ...)` deliberately waits for React to render before querying the DOM, but
      nothing hid the element *during* that 50ms gap, so it rendered at its natural
      (fully visible) opacity first, and only then did the GSAP `fromTo` yank it back to
      invisible before tweening up. Confirmed frame-by-frame by sampling computed opacity
      every `requestAnimationFrame`: opacity 1 for ~40ms, then a hard cut to 0 at the
      moment `fromTo` fired. Fixed with a static `opacity-0` class on both elements in the
      JSX, so they're already invisible from React's very first render, before GSAP ever
      touches them. The CSS-token-based ones (`Toast`/`ConfirmDialog`/`AccountPage`/
      `ProductPage`, all using `animation-fill-mode: both` present in the className from
      first render, no JS delay involved) were checked the same way and don't have this
      problem -- confirmed via the same frame-sampling technique, not assumed.
- [x] **Fixed a real Supabase egress bug** (2026-07-02) — `designs` rows were up to 2.3MB
      each (a resolved `starFieldConfig` can be 5MB+), driving 93.6% of daily egress via
      `select('*')` on every gallery/homepage load. Root cause: `MiniGenerator.jsx`'s Save
      button skipped the compaction step DisplayCanvas's own Save button already did.
      Fixed by centralizing compaction inside `StudioContext.saveCurrentDesign` (new shared
      `src/render/compactDesign.js`) so no future save path can reintroduce this. **Existing
      bloated rows backfilled directly in the database** — `designs` table: ~7MB+ → ~5.2KB
      across 46 image rows (1 animation row was already fine). See `CLAUDE.md`'s Gallery
      section for the full writeup. Verified live: gallery renders identically, a
      backfilled design still regenerates correctly from just its seed/colors.
      **Full follow-up audit found the same bug a second time**: `order_items.design_data`
      (checkout's "Current studio design" path, always uncompacted) had one row at 191KB —
      fixed with a mirrored `supabase/functions/_shared/compactDesign.ts` (Edge Functions
      can't share the frontend module directly, different runtime) and backfilled (191KB →
      77 bytes). Storage buckets checked and look legitimate, not bloated. Two
      lower-priority findings from Supabase's own performance advisor — RLS policies
      re-evaluating `auth.<function>()` per-row on several tables, and an unindexed FK on
      `likes.design_id` — also fixed same session:
      `supabase/migrations/0007_rls_performance_fixes.sql`. Advisor re-run after applying:
      zero performance warnings left.
- [x] **Weight-class + region shipping** (2026-07-02) — replaces the single
      `SHIPPING_FLAT_CENTS` flat rate. New `supabase/functions/_shared/shipping.ts`: product
      weight class (light t-shirts/shorts vs. heavy hoodies/sweatshirts/jackets/joggers) is
      known automatically from the product being bought, so that part isn't a guess. Region
      isn't known until checkout though — true dynamic per-address shipping needs Stripe's
      embedded (Elements) Checkout instead of hosted Checkout, which also kills Apple
      Pay/Google Pay, so instead `create-checkout-session` now offers 5 region-labeled
      `shipping_options` (US/Canada/UK/Europe/Australia-NZ) in the same session and the
      customer picks whichever matches their address — Stripe doesn't cross-check the pick
      against the typed address, a known accepted gap. Rates are Printful's real AOP costs
      (verified against Printful's live rate tables, 2026-07-02) plus a ~$1.50 margin
      buffer. `SHIPPING_FLAT_CENTS` still works as an emergency override/kill switch. Not
      yet deployed or live-tested — see the "Blocking launch" item above. The 3 non-clothing
      products (tote bag, crossbody bag, pillow) are approximated as "light" pending a real
      Printful bag/home-goods rate lookup (noted in `shipping.ts`'s header comment).
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
- [x] **Toast/confirm system on design tokens** (2026-07-02) — new
      `src/components/ui/Toast.jsx` (presentational; error uses the same `accent` token
      AccountPage/ShopPage/ProductPage already use for errors, not the old raw
      `bg-red-900`/`bg-neutral-900` pairing) + `src/hooks/useToastNotice.js` (the
      auto-dismiss timing, extracted so future save/checkout call sites can reuse it without
      re-deriving the timer). `AuthContext` now uses both instead of owning the markup
      itself. New `src/components/ui/ConfirmDialog.jsx` (a real modal — `SolidPanel` +
      backdrop, Escape-to-cancel) replaces `window.confirm` for design delete in
      `GalleryPage.jsx`. Verified live: the error toast renders in the accent treatment with
      no console errors (via a real `error_description` hash), and `ConfirmDialog` opens
      (screenshotted), closes on Escape, with no console errors — the actual authenticated
      delete click-through wasn't driven end-to-end (no test-account credentials available
      in this session), so give the real "My Designs → Delete" flow one manual pass when
      convenient.
- [x] **Shared focus-visible ring** (2026-07-02) — added
      `focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2
      focus-visible:outline-interactive` (compiles to the same `outline: 2px solid
      var(--color-interactive); outline-offset: 2px;` `cf-btn-*` already had) to
      `ProductPage.jsx`'s artwork-picker thumbnails, mockup filmstrip thumbnails, and
      size/color variant picker, plus `GalleryPage.jsx`'s Public/My Designs tabs. Repeated
      as a literal utility string at each site rather than a new shared class/component --
      only 4 call sites, consistent with Tailwind's own utility-repetition idiom. Verified
      live: confirmed the cyan ring renders correctly on the gallery tab, the artwork
      thumbnail (not clipped by its own `overflow-hidden`, since CSS outlines paint outside
      the box regardless), and the size-variant button.
- [x] **GSAP reduced-motion** (2026-07-02) — `App.jsx` now registers `gsap.matchMedia()`
      for `(prefers-reduced-motion: reduce)` once at the app root, scaling
      `gsap.globalTimeline.timeScale()` to 100 rather than editing each individual
      `gsap.to()`/`from()`/`fromTo()` call's duration across DisplayCanvas's panel morphs,
      ShopCarousel's loop, and ProductPage's TextPlugin scramble — keeps every
      `onComplete`-driven sequencing those already rely on intact, same "still fires
      completion, just ~instant" approach the CSS side already takes (0.01ms, not 0).
      Deliberately registered at the app root, not inside `DisplayCanvas` itself —
      `DisplayCanvas` unmounts on most route changes (only `/` and `/studio` render it),
      but the user's OS-level preference doesn't change with the route, so this needs to
      outlive any single component's mount/unmount. Verified live: `gsap.globalTimeline
      .timeScale()` reads `1` normally and `100` with reduced-motion emulated, confirmed
      across `/`, `/studio`, and `/shop` with zero console errors.

## Code — worth doing, lower urgency

- [x] **Storage cleanup, partial** (2026-07-02) — `deleteDesign` now also removes the
      design's thumbnail (best-effort; a removal failure doesn't undo the already-succeeded
      row delete). `design-mockups`'s unbounded growth is deliberately **not** fixed:
      deleting `storage.objects` rows directly via SQL (the approach used for the earlier
      data backfills) does not actually free the underlying files -- Storage's real
      deletion goes through its REST API, not a DB trigger on that metadata table, so a
      SQL-only "cleanup" would silently orphan billed bytes while hiding them from
      listings. A real fix needs a scheduled Edge Function using the actual Storage API;
      not urgent at today's 17MB, so deferred rather than risking a wrong fix.
- [x] **Motion token migration** (2026-07-02) — `tailwind.css`'s `@theme` now has
      `--duration-fast/base/slow` (200/350/500ms), used in the existing
      `--animate-fade-slide-up`/`--animate-pop-in` shorthands and via
      `duration-[var(--duration-*)]` on `ColorField`/`DisplayCanvas`'s Tailwind utility
      classes (`--duration-*` isn't a namespace Tailwind v4 auto-generates utilities from --
      confirmed by checking the compiled CSS, a plain `duration-base` class compiled to
      nothing before catching it). Mirrored in new `src/utils/motionTokens.js` for GSAP's
      JS-level tweens (can't read CSS custom properties without a runtime
      `getComputedStyle` lookup) -- consolidates the old ad-hoc 0.2/0.3/0.35/0.4/0.45/0.5s
      values across `DisplayCanvas`/`CloseButton`/`PlayPauseButton`/`AnimationPreview` down
      to three tiers, plus the two independently-declared `CROSSFADE_MS = 450` constants in
      `MiniGenerator`/`SiteFooter` now both import the same `DURATION_SLOW_MS`. Left
      `Logo.jsx` untouched (already-established: unused, don't migrate speculatively) and
      the three ~0.1s micro-timings in `DisplayCanvas.jsx` (genuinely distinct/faster,
      never in the original ad-hoc list). Verified live: the studio's settings/color-editor
      panel and its Close button (now on `DURATION_SLOW`) render and animate correctly with
      zero console errors.
- [x] **Empty states** (2026-07-02) — Gallery's "no designs yet" now shows the studio's live
      generated-art preview (same `previewUrl` the ambient `MiniGenerator` widget uses)
      above the message, plus a "Go create one" link on the My Designs tab. Verified live
      via a temporary forced-empty override (real data never naturally empties either tab).
- [x] **Homepage scroll-reveal, upgraded to real GSAP ScrollTrigger** (2026-07-02) —
      Aaron's ask: every homepage section below the hero should enter as it scrolls into
      frame and *reverse* if you scroll back up past it. The initial audit pass added a
      one-shot `IntersectionObserver`-based `useScrollReveal` (fires once, never reverses)
      to `AboutSection` only; superseded same day by `useScrollTriggerReveal` (GSAP
      ScrollTrigger, bundled free as of GSAP 3.13+, already installed at 3.15) applied to
      `AboutSection`, `GallerySection` (both its empty and populated render branches), and
      `ShopCarousel`. `toggleActions: 'play none none reverse'` -- play once scrolling
      down into it, leave it alone scrolling further down past it, reverse only when
      scrolling back up past where it started. **Real gotcha caught before testing**:
      `html`/`body` are `overflow: hidden` site-wide (the studio needs a locked full-bleed
      canvas), so the homepage scrolls its own div, not the window -- ScrollTrigger
      defaults to the window and would've simply never fired without explicitly passing
      `scroller: el.closest('.overflow-y-auto')`, the same pattern `GalleryPage`'s own
      `IntersectionObserver` already uses to find its real scroll ancestor. Verified live
      by scrolling the actual container programmatically and sampling computed opacity:
      hidden before scroll, `1` after scrolling a section into view, back to `0` after
      scrolling all the way back to the top -- confirmed the reverse, not just the enter.
- [x] **Deleted CRA leftovers** (2026-07-02): `src/serviceWorker.js`, `src/App.test.js`, and
      the now-dangling `serviceWorker.unregister()` call + import in `src/index.jsx`.
- [x] **`sitemap.xml`** (2026-07-02) — static routes only (`/`, `/studio`, `/shop`,
      `/gallery`, `/terms`, `/privacy`; excludes the dynamic `/shop/:productId` and the
      auth-gated/transactional `/account`, `/checkout/success`), referenced from
      `robots.txt`. **Analytics: decided none**, keeping the Privacy page's existing "we
      don't use analytics or trackers" promise true rather than revisiting it — flag if you
      want that reconsidered.
- [ ] Expand `ALLOWED_SHIPPING_COUNTRIES` deliberately (checked against Printful coverage)
      as demand appears. Still correctly untouched -- no signal of actual demand yet, and
      this item is explicitly conditional on that, not something to do speculatively.

## Explicitly deferred / decisions made

- **No auto-refund on Printful failure after payment** — deliberate human-judgment gap;
  alert email + 'Needs attention' status is the design.
- **True per-address dynamic shipping** (Stripe calculating the exact rate off the address
  the customer types) — would require switching hosted Checkout to Stripe's embedded
  (Elements) Checkout, which also disables Apple Pay/Google Pay entirely. Decided against
  that trade (2026-07-02); weight-class + customer-selected region (see "Code" above) is
  the compromise instead.
- **Supabase's other auth email templates (Invite user, Magic Link, Change Email Address,
  Reauthentication) are intentionally left unbranded** — nothing in the app currently
  triggers them (no invite flow, no magic-link sign-in, no email-change UI, and
  `secure_password_change = false` means no reauth prompt either). Invite user is a
  plausible future feature (inviting someone to view/collaborate?) — revisit branding it
  if that gets built, not before.
