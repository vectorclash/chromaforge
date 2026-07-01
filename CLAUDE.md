# ChromaForge — project context for Claude

This file is the portable handoff doc for this project. It's checked into git specifically
so that any Claude Code session — on any machine — has the architecture decisions and
current state without needing the original chat history. Keep it updated as work lands;
treat the bullet points below as living facts, not a changelog (prune/update rather than
appending forever).

## What this is

A generative art web app (live at **chromaforge.app**). Vite + React, static build,
deployed via GitHub Actions → FTP on every push to `master` (see
`.github/workflows/deploy.yml`). UI language is "the artwork is the interface": the
generated piece fills the screen; controls live in a small frosted-glass panel that
floats on top. Designs are JSON, re-renderable via Canvas2D from that JSON alone.

**The goal in progress:** turn a saved design into printed merch (shirts/hoodies) via
Printful, with user accounts and a gallery. Stack: Supabase (Postgres + Auth + Storage),
Stripe (payment), Printful (fulfillment), Vite/React frontend (unchanged).

## Architecture decisions (the load-bearing ones)

### Renderer: seed-based, not pixel-based
The renderer is a pure deterministic function of `(seed, colors, settings, width,
height)` — NOT stored pixel/normalized coordinates. A tiny JSON `{ generatorVersion,
seed, colors, settings }` reconstructs the full artwork at any size/ratio. This was a
deliberate choice over "store the resolved composition": it enables **method-4
recompose-per-ratio** — screen and print are sibling compositions generated fresh from
the same seed, not the same layout reflowed. The print mockup the customer approves is
the actual print, generated the same deterministic way.

- `src/render/prng.js` — seeded PRNG (xmur3 + mulberry32: `makeRng`, `randomSeed`,
  `randomColorHex`). Every `Generate*` class in `src/components/Canvas/` takes an `rng`
  param and uses it instead of `Math.random()`/`tinycolor.random()`.
- `src/render/generateArtwork.js` / `src/render/renderArtwork.js` — pure, React-free
  generation/compositing, so the same code can eventually run server-side (Node/headless)
  for print resolution. `GENERATOR_VERSION` bumps when the algorithm changes in a way that
  alters output for a given seed.
- **Print rendering must be server-side**, not client-side: iOS Safari caps canvas area
  around 16.7 Mpx, and 150 DPI print (4200×5400 = 22.7 Mpx) exceeds that. Desktop Chrome
  handles it fine (proven up to 300 DPI), but mobile can't — this is why a render service
  is still needed before the print pipeline is real.
- **Generators are now ratio-aware** (`GENERATOR_VERSION = 3`, `src/render/scale.js`):
  sizes scale off `min(width, height)` instead of `width` alone (a tall/narrow print was
  sizing stars off its narrow axis only), and element counts scale off canvas area relative
  to the studio's actual default resolution (3840×2160) instead of fixed constants (a
  320×320 thumbnail was getting literally the same star counts as a 4200×5400 print).
  Count scaling is `sqrt(area ratio)`, not the raw ratio — tested against real renders and
  plain linear area scaling collapsed thumbnail-size renders to nearly nothing, since
  320×320 is ~1.2% of the reference area but the old fixed counts already looked
  reasonable there.
  - **Real bug caught and fixed mid-implementation**: the first version scaled each
    generation loop's *trip count* directly by the size factor. That desyncs `rng()`
    consumption across sizes — every layer generated after a size-scaled loop (radial
    field → star field → geometry → overlay, in that order) draws from a different
    position in the sequence depending on how many stars/gradients happened to be
    generated at that specific width/height. Confirmed live: **the same seed would gain or
    lose an entire geometry-shape layer purely depending on what size it was rendered
    at** — directly breaking the "mockup and its print are the same underlying piece"
    guarantee `renderArtwork`'s method-4 recompose-per-ratio design depends on. Fixed by
    always generating the *original fixed* count (exactly matching pre-fix `rng()`
    consumption, so every downstream draw lands in the same position regardless of size)
    and only **slicing** the result down to a size-scaled subset afterward — sizes at or
    above the reference resolution keep everything generated (unchanged density from
    before `v3`); only smaller canvases keep a reduced slice. Verified live with a script
    that inspects `generateArtwork`'s output directly (not just pixels): confirmed
    `radialFieldConfig`/`geometryConfig`/`overlayConfig` presence is now identical for the
    same seed across thumbnail/moderate/studio-default/tall-print/print sizes, both for a
    seed with geometry on and one with it off.
  - Also verified visually across the same five sizes, isolating the star layer alone
    (radial field/geometry/overlay temporarily forced off in a local test, then reverted)
    to judge density without other randomized layers reshuffling alongside count changes.
  **Consequence, accepted deliberately:** this still changes output for every existing
  seed (the fixed-then-slice approach preserves rng() *position* consistency across sizes
  for `v3`, but `v3`'s formulas still differ from `v2`'s) — old `v2` saved designs render
  differently now and fail render-service's version check for printing until re-saved.
  Same treatment as pre-seed (`v1`) designs already got — best-effort only, not a
  blocker, and nothing is live to real customers yet so the timing cost is low.

### Server-side print rendering: `render-service/` — built, deployed, wired into checkout, live-verified
`render-service/` (new top-level dir, separate from the Vite app) runs the actual,
unmodified `generateArtwork.js`/`renderArtwork.js`/`Generate*.js` files in plain Node —
**no headless browser** (Puppeteer/Chromium were both considered and rejected: a managed
screenshot API is a recurring per-render vendor bill the project owner explicitly doesn't
want; a real browser needs a ~1GB+ RAM host for something this can now do in ~1GB, see
memory note below). Verified this session, with real test code against real output (not
assumed): every `globalCompositeOperation` this app uses, gradient rendering, and the one
non-Canvas2D dependency (`GeometricShape.js`'s use of createjs/EaselJS) all render
correctly under `@napi-rs/canvas` (Skia-backed, same engine real Chrome uses) plus
`render-service/shim.js`'s `document`/`window`/createjs polyfill.

- **A real bug was caught and fixed via this work**, independent of the render-service
  project itself: `GenerateLargeRadialField.js:18` sets `radGrad.alpha =
  rng().toFixed(2)` — a **string**. Browsers silently coerce that to a number when
  assigned to `ctx.globalAlpha`; `@napi-rs/canvas` doesn't (leaves `globalAlpha` at its
  default of `1`). Fixed in `LargeRadialField.js` with `Number(...)`, matching the
  coercion `renderArtwork.js` already does for `overlayAlpha` — verified via pixel diff
  against a real Puppeteer-captured browser screenshot (0-1000ppm scratch harness, not
  committed) that this closes the gap from a 250/765 average pixel difference down to
  ~1/765 (PNG rounding noise). This bug was latent in the browser-only renderer the whole
  time, just never surfaced because browsers tolerate it.
- `render-service/build.js` bundles `generateArtwork.js`+`renderArtwork.js` (via esbuild)
  into `render-service/generated/render-lib.js` before each run/deploy — **not a code
  port**, just resolving Vite-style extensionless imports that Node's native ESM loader
  can't handle; the executed logic is byte-for-byte the same as what ships to the
  browser. Re-run `npm run build` in `render-service/` after any change to `src/render`.
- **Deployed to Fly.io** (`chromaforge-render.fly.dev`, `iad` region, scale-to-zero) and
  **live-verified end to end** (2026-07-01): a real `onBuyNowClick` through the actual app
  produced a `print_file_urls` entry at **3150×5550px** (true print resolution — the old
  capped client-side path tops out at `RENDER_CAP = 1200`), confirmed by downloading the
  real uploaded file and checking its pixel dimensions, not just that the request
  succeeded. The Dockerfile's build stage needed `COPY src/components/Canvas` added (it
  only copied `src/render`, but `generateArtwork.js`/`renderArtwork.js` import from
  `../components/Canvas/*` — missed until a real Docker build surfaced it, since the local
  `npm run build` sanity check runs inside the full repo checkout and never hit the gap).
  `fly.toml`'s `[build] dockerfile` path resolves relative to `fly.toml`'s own directory
  (`render-service/`), not the repo root, despite `flyctl deploy`'s own `--dockerfile` flag
  docs implying otherwise — confirmed via flyctl v0.4.63; the file's header comment
  reflects the working invocation.
- **Real capacity bug, not just a deploy-config one**: the initial 512MB Fly machine size
  got OOM-killed mid-render on a real product's printfile spec (confirmed in Fly's logs —
  `anon-rss:412116kB` at kill time). Some printfiles run up to ~6000×6000px; the raw RGBA
  buffer alone is ~144MB before Skia/Node overhead and PNG encoding headroom. Bumped to
  1024MB in `fly.toml` and reverified live — no further OOM kills. If future products push
  printfile sizes higher, watch for this failure mode again (Fly logs show
  `Out of memory: Killed process ... (node)` distinctly from any application-level error).
- `supabase/functions/render-print-file/index.ts` deliberately uses plain `fetch()` against
  Supabase's Auth (`/auth/v1/user`) and Storage (`/storage/v1/object/...`) REST endpoints
  instead of the `@supabase/supabase-js` SDK every other function uses — pulling in the
  full SDK (which drags in `realtime-js`'s Node polyfills) made this function's bundle step
  repeatedly time out on deploy (`Bundle generation timed out` / a `deno.land` fetch
  timeout inside `realtime-js`), confirmed reproducible across multiple attempts. No
  `deno.json`/import map needed as a result. If this function ever needs more than
  "verify a JWT" + "upload a file," reconsider whether the SDK's bundle-time cost is worth
  it, but don't reach for it by default here.
- `RENDER_SERVICE_KEY` (shared secret, `X-Render-Key` header) is set both as a Fly.io
  secret (`flyctl secrets set RENDER_SERVICE_KEY=... --app chromaforge-render`) and as the
  `render-print-file` Edge Function's `RENDER_SERVICE_KEY` secret — same value, two places,
  no code ties them together automatically if one is rotated. `RENDER_SERVICE_URL` is the
  Edge Function's only other secret (`https://chromaforge-render.fly.dev`).
- `src/lib/printful.js`'s `renderAndUploadPrintFiles` takes an injected `renderOne(design,
  spec, printfileId)` strategy instead of being hardcoded to one render path:
  `capRenderStrategy(renderDesignBlob)` (mockups, `useMockup.js` — cheap, capped, client-side,
  unchanged behavior) vs. `renderPrintFileStrategy` (checkout, `ProductPage.jsx` — true print
  resolution via the Edge Function above). Mockup previews are untouched by design — no
  reason to add render-service cost to something already free and good enough for picking
  artwork/variant.
- **Known gap, still open**: Printful order submission failure after a successful Stripe
  charge still isn't auto-refunded (unchanged from before this work — see the "Known gap"
  note under Merch pipeline below). This session didn't touch that path.

### MP4 export: client-side (WebCodecs), not server-side
Animation export is fully client-side: WebCodecs (`VideoEncoder`/`VideoFrame`,
`AudioEncoder`/`AudioData`) muxed with `mp4-muxer`. All in
`src/components/DisplayCanvas.jsx` (`exportAnimationVideo`, `encodeAudioTrack`). **There
is no `server/` directory, no `/api/export`, no Vite proxy** — an earlier server-side
FFmpeg design was fully removed; don't reintroduce it from old assumptions. Prefers H.264
Constrained Baseline (`avc1.42E034`) specifically to avoid B-frame reordering, which
silently halved framerate on Windows hardware encoders. This is a *different* concern
from print rendering above (video vs. still images) — don't conflate the two.

### Backend: Supabase, seed-first schema
- `supabase/migrations/0001_initial_schema.sql` — `profiles` (1:1 auth.users, trigger
  auto-created on signup), `designs` (`data` jsonb = `{ generatorVersion, seed, colors,
  ... }`, public-readable by default, write-owner-only via RLS), `likes` (junction,
  triggers keep `likes_count` in sync).
- `src/lib/supabase.js` / `designs.js` / `auth.js` — client + data access + email/password
  auth. The client is guarded: exports `null` and warns if env vars are missing, so the
  app doesn't crash without Supabase configured.
- **Gotcha:** the public-gallery query disambiguates the `profiles` embed with
  `profiles!designs_user_id_fkey(...)` — the `likes` junction creates a second
  designs↔profiles join path that confuses PostgREST otherwise.
- **Email/password plus Google OAuth.** Google sign-in needed a Google Cloud Console
  OAuth client (Web application type, authorized redirect URI =
  `https://fgrhbzqzadpjpbzuszpm.supabase.co/auth/v1/callback`) and the resulting Client
  ID/Secret entered in the Supabase dashboard's Authentication → Providers → Google
  config — that's all dashboard-side, no migration. `signInWithGoogle()` in `auth.js`
  reuses the same redirect-handling code already built for email confirmation links.
- Backend is live and verified against the real Supabase project (connection, RLS, the
  embed query, auth endpoint all checked). **Now wired into the UI**, all in
  `DisplayCanvas.jsx`: a Sign In/Account panel (email/password + "Continue with Google",
  with a banner handling Supabase's auth redirect — it lands back on the app with a
  token in the URL hash, which needs explicit UI feedback since `supabase-js` consumes
  it silently),
  Save now also persists to the `designs` table for signed-in users (alongside the
  existing share-link, which still works for everyone), and a Gallery panel
  (Public / My Designs tabs) that lists saved designs and reloads one onto the canvas on
  click.
- **Gallery now has thumbnails, delete, and pagination.** Saving a design regenerates it
  from its own seed/colors at 320x320 (recompose-per-ratio, same approach as the main
  renderer — not a downscaled screenshot of the full canvas) and uploads it to the
  `design-thumbnails` Supabase Storage bucket (`supabase/migrations/
  0002_design_thumbnails_storage.sql`), keyed by `${user_id}/${design_id}.jpg` so RLS can
  check ownership from the path alone — no DB column tracks "has a thumbnail"; a missing
  object just 404s client-side (`<img onError>` hides it), which is what happens for
  designs saved before this existed. My Designs has a per-row Delete (wired to the
  existing `deleteDesign`); the Public tab pages 20 at a time via `listPublicDesigns`'s
  `before` cursor with a "Load More" button.
- **Gotcha:** Supabase's confirmation email links hit Supabase's own verify endpoint
  first (not the app directly), which consumes the one-time token and *then* redirects to
  the app's redirect URL with the session in the hash. If that redirect URL is unreachable
  (e.g. dev server not running yet), the token is still consumed — a retry click will
  show "invalid or expired" even though the account was already confirmed. Fixed by
  passing `emailRedirectTo: window.location.origin` in `signUpWithEmail` (`auth.js`) so
  the link targets whichever environment the user actually signed up from; both
  `localhost:5173` and `chromaforge.app` need to be in Supabase Auth → URL Configuration's
  redirect allow-list for this to work (already added).
- **Email confirmation is live and required** (`enable_confirmations = true`, matching the
  live project — `config.toml` previously had this wrong as `false`, don't trust it without
  checking the Dashboard). Confirmation/recovery/etc. emails go out via **custom SMTP
  through a dedicated Hostinger mailbox** (`no-reply@chromaforge.app`, `smtp.hostinger.com`
  port 465, auth via a Hostinger **App Password** not the mailbox login password) — needed
  because Supabase's built-in mailer caps at 2 emails/hour and only delivers to project-team
  addresses; custom SMTP raises that to a configurable 30+/hour and lifts the
  team-address-only restriction. Configured in the Dashboard's Auth → Emails → SMTP
  Settings (hosted projects only — the CLI/`config.toml`'s `[auth.email.smtp]` block is
  local-dev-only parity, same caveat as the template below). Deliberately a *separate*
  mailbox from `support@chromaforge.app` (which stays human-monitored, linked on the legal
  pages) — keeps automated/bot-prone signup traffic from risking the reputation of the
  address people expect real replies from.
- **Branded "Confirm signup" email template**, `supabase/templates/confirmation.html` —
  table-based/inline-styled HTML (with an Outlook VML button fallback) matching the site's
  actual design tokens (Exo/Quicksand, the studio-green wordmark treatment, the spectrum
  gradient bar, the exact `.cf-btn-primary` purple→magenta CTA gradient) rather than a
  generic template. `config.toml`'s `[auth.email.template.confirmation]` points at it for
  local dev; the **hosted project needs this HTML pasted directly into the Dashboard's Auth
  → Email Templates → "Confirm signup"** — the CLI does not push email templates to hosted
  projects. Live-verified 2026-07-01: real signup → real Hostinger-delivered email,
  correctly branded, working confirmation link.
- **Gotcha, fixed:** GoTrue's anti-enumeration behavior means `signUp()` returns the same
  shape (`session: null`) whether it's a genuine new signup or the email already has a
  confirmed account — without handling this, a returning user hitting "Create account" was
  told to check an inbox that would never receive anything. `signUpWithEmail` (`auth.js`)
  now detects this via `user.identities.length === 0` (confirmed live: this is `[]` for an
  existing account, populated for a real new signup) and returns `alreadyRegistered: true`;
  `AccountPage.jsx` switches to sign-in mode and shows "An account with this email already
  exists. Sign in instead." instead of the misleading confirmation message.

### Merch pipeline: Printful catalog → mockup preview → Stripe checkout → real order
- `src/lib/printful.js` — catalog browsing (`listCatalogProducts`/`getCatalogProduct`/
  `getPrintfileSpecs`) via the `printful-catalog` edge function (read-only, Printful's v1
  API), plus `PRODUCT_MOCKUP_CONFIG` — a hand-verified, per-product map of
  placements/technique/required options for all 11 starter products (every entry confirmed
  against a real mockup task; see the file's header comments for product-specific quirks
  like the track jacket's `details`+sleeves combo failing outright). `resolvePlacementEntries`
  + `renderAndUploadPrintFiles` are shared between mockup previews and real checkout: mockup
  previews filter to only the placements visible in the requested camera-angle photo
  (`cfg.placements`); a real **order** needs every placement regardless of visibility
  (left-out placements render as blank fabric on the actual garment) — checkout calls
  `resolvePlacementEntries` with no filter.
- `src/hooks/useMockup.js` — drives the *preview* pipeline (render → upload → Printful v2
  `mockup-tasks` via the `printful-mockup` edge function → poll → dedupe by camera angle →
  cache). Free, no money involved. One automatic retry on Printful's occasional transient
  "Internal Server Error" for AOP products. Exposes `elapsedSeconds` + `BUSY_STATUSES` for
  UI feedback during the 30–90s+ round trip.
- **Real checkout** (`supabase/functions/create-checkout-session`,
  `supabase/functions/stripe-webhook`, `src/lib/checkout.js`, wired into
  `ProductPage.jsx`'s "Buy now" and a new `CheckoutSuccessPage` + `AccountPage` order
  history section): Stripe Checkout (hosted page, collects shipping address natively) →
  webhook confirms payment → submits the real Printful order. Schema:
  `supabase/migrations/0005_orders_schema.sql` + `0006_order_items_product_options.sql`
  (`orders`/`order_items`, owner-read-only RLS, **no client insert/update policy at all** —
  only the service role, used exclusively by these two functions, writes orders).
  - **Store-wide purchasing kill switch**: `supabase/functions/_shared/storeStatus.ts`'s
    `isStoreEnabled()`, gated on the `STORE_ENABLED` secret (same instant-toggle pattern as
    `PRICE_MARKUP_PERCENT` in `pricing.ts` — `npx supabase secrets set STORE_ENABLED=false`,
    takes effect on the next request, no redeploy). Only pauses checkout: `printful-catalog`
    attaches `storeEnabled` to its single-product response (the one `ProductPage.jsx`
    already fetches, so no extra request), which disables Buy Now and shows "Store
    purchasing is temporarily offline" — browsing, mockups, the gallery, and the studio all
    stay fully operational. `create-checkout-session` independently rejects with a 503 if
    the flag is off too (defense in depth against a tab left open from before the flag
    flipped, not just trusting the client-side check). Unset/anything other than the
    literal string `"false"` means enabled, so a fresh project isn't accidentally locked
    out. No effect on the signed-out flow, which already shows "Sign in to buy" regardless.
  - `create-checkout-session` (`verify_jwt = true`): re-prices server-side against
    Printful's catalog (never trusts the client's price), inserts a `pending` order +
    item *before* creating the Stripe session, and stashes just the order id in the
    session's `metadata` (Stripe metadata caps at 500 chars — nowhere near enough for a
    design jsonb, so the design/print-file URLs live in our own DB row instead).
  - `stripe-webhook` (`verify_jwt = false` — Stripe's caller carries no Supabase JWT, only
    a `Stripe-Signature` header, so auth here is the signature check alone, via
    `Stripe.createSubtleCryptoProvider()` + `constructEventAsync`, Deno's documented
    pattern since it has no Node crypto module). Idempotent on `status='pending'` guard
    (a redelivered webhook event no-ops rather than double-submitting to Printful).
    Printful's v2 Orders API (`POST /v2/orders`) **always creates an unconfirmed draft** —
    a separate `POST /v2/orders/{id}/confirm` actually charges/fulfills it; the webhook
    does both back-to-back since the customer already paid via Stripe.
  - **`PRINTFUL_SKIP_CONFIRM` secret**: Printful has no sandbox/test mode at all — orders
    are real and billed regardless of which store id is used, completely independent of
    Stripe being in test mode. Rather than standing up a second "test store" (which
    wouldn't actually be safer — still real, still billed), this secret makes the webhook
    create the Printful order but skip the `/confirm` call, so end-to-end testing produces
    a real, inspectable draft that's never charged or produced. **Set while testing; unset
    before real customers can check out** — that single secret is the only thing standing
    between this and live order fulfillment.
  - **Live-verified** (2026-06-30): a full real run — Stripe test-mode payment (card
    `4242...`) → webhook signature verified → order persisted → Printful order created and
    visible as a Draft in the dashboard (`PRINTFUL_SKIP_CONFIRM` was set) — confirmed
    working end to end, not just builds-clean. API version pinned to `2026-06-24.dahlia`
    in both edge functions, matching the actual Stripe account/webhook destination (not
    guessed). Stripe's "Managed Payments" (merchant-of-record tax/fraud handling) was
    explored but is **ineligible for physical goods** — it's a digital-goods-only program;
    this account uses standard Stripe Checkout instead.
  - **Known gap, not yet built:** Printful order submission failure after a successful
    Stripe charge is not auto-refunded — `orders.status` goes to `'failed'`, surfaced
    distinctly in order history, but a human needs to notice and act.
  - Print files now ship at true print resolution via the Fly.io render-service (see
    "Server-side print rendering" below) — the earlier capped-browser-render gap here is
    closed, live-verified end to end (2026-07-01).

### Styling: Tailwind v4, fully migrated (not partial)
The whole app was migrated from SCSS to Tailwind v4 + a small custom-CSS layer — this was
the user's explicit call, made *against* an earlier instinct to leave the working UI
alone, because "do it now while the app is small." It's done and merged to `master`.

- `src/tailwind.css` — `@import 'tailwindcss'` (Preflight is **enabled**), the
  `--font-quicksand` token, the relocated Quicksand/Exo Google Fonts `@import url()`
  (must stay the first statement in the file), and the few app-globals Preflight doesn't
  cover (bg color, full-viewport sizing, the font stack/smoothing).
- `src/styles/components.css` — scoped custom CSS for everything utilities can't express:
  glassmorphism `backdrop-filter`, gradient borders/fills, `@keyframes`, GSAP-morphed SVG
  internals, complex hover states, and the themed `jscolor` color-picker popup (see
  below). Everything here is scoped under `.display-canvas` or the relevant hook class.
- **Every GSAP/JS selector hook (class or id) was preserved** through the conversion —
  utilities were added alongside hook classes, never replacing them. If you touch
  `DisplayCanvas.jsx` or `ColorField.jsx`, grep for `gsap.` selectors and
  `querySelector`/`getAttribute('data-color-id')` before renaming any class.
- `src/components/Logo.jsx` + `Logo.scss` are the **one intentionally unconverted**
  leftover — it's the vectorclash logo mark, currently unused, earmarked for a future
  About page. Don't migrate it speculatively before it's actually mounted somewhere (you
  can't verify a conversion against a render that doesn't exist).
- The `jscolor` third-party color-picker popup (opened by tapping a color swatch) is
  themed via `jscolor.presets.default` in `index.html` (background/border/radius/shadow —
  most of it) plus targeted `!important` overrides in `components.css` for the bits the
  library sets via inline style (close-button font/hover) or doesn't expose as a preset
  option at all (inner palette/slider corner rounding, via structural `:has(> canvas)`
  selectors since those elements are unclassed). If you resize the picker
  (`width`/`height`/`sliderSize`/`padding` in the preset), the slider-rounding selector
  (`[style*='width: 20px']`) and the close-button's `right` value are both keyed to the
  current preset numbers — keep them in sync.

## Current state / what's deployed

`master` is deployed (push triggers GitHub Actions → FTP → chromaforge.app). As of the
last push, live includes: the seed-based renderer (Phases 1–2 of the print pipeline), the
full Tailwind migration, a batch of ColorField drag-and-drop fixes (dead-zone hit-testing,
swap-instead-of-insert reorder logic, a perf throttle, a listener-leak fix) plus the
jscolor picker theming, the Supabase auth/save/gallery UI, and the Printful catalog/mockup
preview pipeline (Shop/ProductPage, `useMockup`) — confirm what's actually been committed
and pushed before assuming any specific recent change is live, this file tracks what's
*built*, not what's deployed.

The Stripe checkout → real Printful order pipeline (see "Merch pipeline" above) is
**deployed to Supabase Edge Functions and live-verified** — a real Stripe test-mode
purchase has gone through both functions end to end and produced a correct Printful draft
order. `PRINTFUL_SKIP_CONFIRM` is still set (intentionally, for continued testing), so no
order can be confirmed/billed/produced yet — check whether it's still set before assuming
real customers can complete a purchase.

Server-side print-resolution rendering is **built, deployed (Fly.io + a new
render-print-file Edge Function), wired into checkout, and live-verified** (see
"Server-side print rendering" above) — the print-resolution gap called out in the Merch
pipeline section above is closed. The `render-service`/`printful.js`/`ProductPage.jsx`
changes landed on `feature/account-gallery-ui`, not yet merged to `master`, so this isn't
live on chromaforge.app until that branch merges and pushes — the Fly.io/Supabase Edge
Function deploys themselves are already live regardless of that merge (they're deployed
directly, not via the GitHub Actions → FTP flow). Ratio-aware generation tuning is also
done now (see "Renderer: seed-based, not pixel-based" above) — same merge-to-`master`
caveat applies before it's live on chromaforge.app.

## Local setup (new machine / clone)

1. `npm install`
2. Create `.env.local` (gitignored, not in git) with:
   ```
   VITE_SUPABASE_URL=<see Supabase dashboard>
   VITE_SUPABASE_ANON_KEY=<the "publishable" key, sb_publishable_... works fine with supabase-js v2>
   ```
   Ask the developer for these — they're real project credentials, not regenerable from
   the repo.
3. `npm start` → Vite dev server on **port 5173** (not 3000 — `.claude/launch.json` is
   already corrected for this, but if it drifts again, 5173 is Vite's actual default).
4. Build/verify with `npm run build` before considering any change done.

## Working conventions established this project

- **Verify every styling/behavior change against a live baseline** — computed-style
  diffs, screenshots, and actual interaction tests (drag, click, toggle), not just "it
  builds." This caught several real bugs (clipped pointer indicators, dead-zone hit
  testing, a reorder-logic bug) that a build-only check would have missed.
- Prefer fixing root causes over hardcoded magic numbers — e.g. the close-button width
  fix uses `left`/`right` anchoring so it self-adjusts if the picker is resized, instead
  of a fixed pixel width that would drift out of sync.
- Don't migrate/touch code that isn't actually exercised yet (see Logo.jsx above) — you
  can't verify a change against a render that doesn't exist.
