# TODO — road to launch (and after)

Working list for Aaron + Claude, written after the full pre-launch review on 2026-07-01
(review findings + same-day fixes are summarized in that session's commit, "Pre-launch
hardening"). Check items off / delete sections as they land — like CLAUDE.md, this file
tracks what's true now, not history.

## Deployed — leg wrap + mockups submit every placement (2026-08-29)

Live as of 2026-08-29. Artwork now runs across the front of the two-leg products as one piece
(`src/render/legWrap.js`), and mockups submit every placement an order does. Shipped in commit
`feb8cc1`, in the required order (render-service and the Edge Functions BEFORE the frontend, since
Fly ignores an unknown field and the reverse would have shown a wrapped mockup while printing a
flat garment, with no version bump to catch it).

- [x] `flyctl deploy --config render-service/fly.toml` — **v35, both machines**, no split release;
      `drawLegWrap` confirmed present on the machine via `flyctl ssh console`.
- [x] `npx supabase functions deploy render-print-file` — v63.
- [x] `npx supabase functions deploy printful-mockup` — v75 (view naming: label placements get real
      labels and are pushed last, so a shared photo is named after the panel it shows).
- [x] Frontend pushed; Action green; new chunks confirmed *serving* by crawling the entry bundle's
      imports (the render code lands in a shared chunk, so grepping `index-*.js` alone waits
      forever while looking like a slow deploy).
- [x] Full checkout chain verified against deployed infrastructure with a real user JWT: true
      11250x4350 render via `render-print-file` -> Fly -> Storage, matching a local render at
      **RMSE 0.358 / max delta 4**. That is cross-platform Skia noise, in line with the 0.45-0.46
      this repo has measured before — byte equality across darwin and the linux container is NOT
      achievable, so do not set that as a pass criterion. The stale-version gate was confirmed to
      still reject (v12 -> "generatorVersion mismatch").
- [x] Draft orders 693/604/784 — every placement `ok`, `label_outside` included; plus one extra
      draft carrying a REAL leg-wrapped print file, whose Printful-rendered order preview shows the
      design continuous across the centre front. Note the standard run submits a stand-in image, so
      its `preview:ok` proves the order path, not the artwork.
- [x] Full `check-printful-mockups.mjs` — **129/129 variants, 22.7 min**.

**Camera-angle policy (2026-08-29, same day).** `src/lib/printfulViewPolicy.js` now derives which
style groups a mockup asks for from each product's own live style list, replacing v1's unchosen
default. View spread across the catalogue went from **2-10 to 2-6**, twelve products landing on six
with real angle variety. Deployed: `printful-catalog` (new `styles=1`), `printful-mockup` (accepts
`optionGroups`, and no longer lets a non-visible placement name a view). Verified one variant per
product, 18/18.

**Still unexercised, and it needs a browser:** the client-side composite path
(`renderDesignBlob` -> `createImageBitmap` -> `drawLegWrap` -> `toBlob` -> Supabase upload) and the
`:legwrap` render cache key. Generate one mockup on the mesh shorts while signed in and confirm the
**front and back thumbnails genuinely differ** — if that cache key were wrong they would be
identical, and nothing automated covers it (`check-printful-mockups.mjs` drives Printful directly
and exercises none of our render, upload, or UI). Worth a glance at the track jacket too, whose
collar band and chest label are newly submitted.

## Closed incident, both follow-ups deferred (2026-08-19)

- [x] **Printful could not fetch our Supabase Storage URLs — every mockup task hung
      `pending` forever.** Store was off 05:43–14:40 UTC (~9h). **Recovered upstream on its
      own; we changed nothing.** Order path re-verified before re-enabling
      (`check-printful-draft-orders.mjs --file <real Storage URL>`, products 257/630/717,
      17 files all `ok`). Full write-up: `docs/incidents/2026-08-19-printful-storage.md`.
      **Gateway logs pulled and analysed (incident log §16): the cause is NOT on our
      side and NOT the Supabase JWT incident.** Across the whole project in the failure
      window there were zero 401/403/5xx to anyone but my own probes, and Printful's
      fetcher demonstrably reached our storage — 7 HEADs per upload, **all 200**. The fault
      is inside Printful, after a successful fetch. **It can recur.**
- [~] **Ask Printful why tasks `959089343` / `959089912` / `959090827` never completed
      despite their fetcher receiving HTTP 200 — DEFERRED 2026-08-21, Aaron's call.** Their
      support "is not at all helpful", so the expected value of sending it is low. **The
      message is written and ready to send** if this ever recurs:
      `docs/incidents/2026-08-19-printful-support-question.md`. It assembles §16.5's wording
      with §3's paired control (byte-identical file, only the host differs: external
      completed in 9s, Supabase hung) and §20's Cloudflare-challenge question, which is the
      one thing only they can answer. Lead with the access-log evidence (7 HEADs, all 200),
      never with "can you fetch our URL" — the logs already answer that.
      Re-verified 2026-08-21: all three still `pending` with empty `failure_reasons`, still
      queryable. Unknown how long Printful keeps a stalled task, so the evidence may not
      keep indefinitely.
- [~] **Mockup canary + faster failure — DEFERRED 2026-08-21, Aaron's call.** "This may never
      happen again"; build it only if it recurs. Costed first: Supabase was never the
      constraint (hourly = 720 invocations, 0.14% of the free tier's 500K, and ~72MB of a
      5GB egress allowance). The real cost is that **every run adds a file to Printful's
      library permanently — they expose no delete or list API** (see the deferred item on
      that), so it is unbounded accumulation on someone else's system.
      Two design constraints worth keeping if it is ever built: a cheap "can Printful fetch
      our file" probe would NOT have caught this outage (their fetcher reached us and got
      200 every time — only a task that never completes is observable), so the canary must
      create a real mockup task; and `cleanup-storage` would delete its source file after
      3 days without a keep rule. Hourly caps exposure at ~1h against the 9h this ran.
      Still true regardless: our poll burns 180s then retries the whole thing (~6 min)
      before the customer sees anything, even though a stuck task provably never recovers.

## Blocking launch — dashboard/ops (Aaron, no code)

- [x] **RESOLVED 2026-07-15: the `label_inside` failures were specific to Printful's
      v2-beta ORDERS API — `stripe-webhook` now submits orders via the stable v1 API
      (commit 8ceb17e, deployed), labels kept, no placement filtering needed.** Proven by
      controlled v1 draft orders (166979280, then 166981022 with all 8 real
      pipeline-rendered zip-hoodie placements incl. the real 375×150 label mark — every
      file `ok`, stable, Aaron-verified in the dashboard) and a full live-site e2e checkout
      through the ported webhook (order 166989163, same result). v1 quirk handled in the
      port: v1 hard-rejects some products without their required item option (zip hoodie
      needs explicit `stitch_color`; v2 defaulted it) — mapped from
      `order_items.product_options`' `{name,value}` shape to v1's `{id,value}`. Mockups
      deliberately stay on v2 (works fine). Same-day related fix: the Fly render-service
      was stale (rendering GENERATOR_VERSION 3 vs. designs at v6, so Buy Now errored with
      "generatorVersion mismatch" before any of this could run) — redeployed; **redeploy
      render-service whenever GENERATOR_VERSION bumps**. Remaining validation (below in
      "go-live"): zero-cost draft-order tests for the other six label_inside products —
      hoodie (388), sweatshirt (320), mesh shorts (693), joggers (784), track jacket (801),
      crossbody bag (744). The support ticket can be closed or kept as an FYI to Printful
      about the v2 bug. **Remaining-products validation DONE 2026-07-15**: all six
      remaining label_inside products passed zero-cost v1 draft tests with full real
      pipeline-rendered placements incl. label_inside/label_outside marks — hoodie
      (166992864), sweatshirt (166992869), mesh shorts (166992871), joggers (166992874),
      track jacket (166992878), crossbody bag (166992881); every file `ok`, drafts stable
      well past the old failure window, left unconfirmed/unbilled. Every store product's
      order path is now verified fulfillable. Historical root-cause trail below.
      **Original root cause write-up (2026-07-05/09, superseded by the v1 port):** several
      starter products failed Printful's production pipeline on real orders:
      `create-checkout-session`/`stripe-webhook` succeed, Stripe charges go through, a real
      Printful order is created and shows as `draft` — then ~10-40s later (Printful's own
      async file-processing job) it flips to `failed` with no detail beyond "Failed to
      process design" and the order-item's `placements` array goes empty. Root-caused
      2026-07-05 (late evening) via controlled unconfirmed-draft A/B tests against the live
      API: `POST /v2/orders` with `label_inside` is rejected outright ("Invalid variant_id
      and placement: label_inside combination") even though Printful's own catalog lists it
      as valid; when it slips past that inconsistent sync check, it kills async
      file-processing instead. Confirmed by resubmitting the exact same real print files
      from a failed order WITHOUT `label_inside` — they fully process. `label_outside` and
      `label_panel` are both fine; it's only `label_inside`. Queried Printful's live catalog
      2026-07-09 (`mockup-generator/printfiles`, not guessed) for the current, precise list
      of affected starter products — **has `label_inside`**: hoodie (388), sweatshirt (320),
      zip hoodie (717), mesh shorts (693), joggers (784), track jacket (801), crossbody bag
      (744); **does not**: both t-shirts (257, 261), tote bag (274), pillow (83).
      **Fix NOT applied, reopened for discussion 2026-07-09**: stop submitting
      `label_inside` on real orders (drop it in `resolvePlacementEntries`/checkout). Aaron
      pushed back on doing this blind — not confirmed whether Printful prints
      `label_inside` onto the garment panel (so omitting it leaves plain fabric, as the
      code's doc comments assume) or physically attaches a separate tag regardless of what's
      submitted (in which case dropping the placement changes nothing). **Waiting on a reply
      from Printful support** before deciding: drop `label_inside` only, drop all three
      label-type placements for cross-product consistency, or something else — the ticket,
      if still filed, should cite the catalog/orders-API contradiction, not file size.
      **Deferred idea (2026-07-05, Aaron)**: when doing the label_inside filter, also
      consider rendering the vectorclash label mark onto `label_panel` (hoodie/zip
      hoodie/sweatshirt hood lining) instead of the current geometry-stripped front
      composition — branded-lining look, matches the square `label_outside` marks. Needs
      the render-service path (panel printfile is full-size, over iOS canvas cap) and a
      real-mockup check of the panel's visible crop before trusting "centered."
      <details>
      <summary>Superseded history: the original "file size" theory (2026-07-05/06),
      fully disproven the same night — kept only as an evidence trail, not a live
      concern. Do not cite this as a current blocker.</summary>

      The initial working theory was that Printful's production pipeline couldn't handle
      the print-area *dimensions* for these products, based on: a synthetic order with
      trivial solid-color placeholder files at the correct (large) dimensions failed
      identically to a real order (ruling out our renderer/content); the failing file
      matched the working t-shirt file on every other axis (RGBA, sRGB, 150dpi); and
      Printful's own design-template PDF for the mesh shorts confirmed 75in x 29in as the
      documented-correct spec, which still failed. This built a full "confirmed
      failing/untested-but-suspect/likely-fine" product breakdown by canvas size. **All of
      this was disproven later the same night**: synthetic solid-color files at the exact
      "failing" dimensions, sent WITHOUT `label_inside`, processed fine on v1 and v2 alike
      — size, alpha channel, and the v2-beta API are all exonerated. The product breakdown
      that looked like it correlated with size actually correlated with which products
      have a `label_inside` placement at all. Nothing here needs action; it's preserved so
      a future support-ticket write-up doesn't lose the "we ruled out X, Y, Z" evidence.
      </details>
- [x] **Leaked Printful API key, found and fixed (2026-07-05)** — the GitHub Actions repo
      secret `VITE_SUPABASE_ANON_KEY` was mistakenly set to the Printful API key's value
      instead of the actual Supabase publishable key, so every production build baked the
      Printful key into the public JS bundle (confirmed by decoding the live minified
      bundle) and sent it as the Supabase `apikey` header, which is why the Gallery started
      401ing with "invalid API key" right after the first live deploy. Fixed: Printful key
      rotated (old one revoked in Printful's dashboard), new key set as the `PRINTFUL_API_KEY`
      Supabase secret (verified live against `printful-catalog`) and in local `.env.local`,
      `VITE_SUPABASE_ANON_KEY` GitHub secret corrected to the real publishable key. The
      corrected bundle has long since shipped (many deploys between 2026-07-05 and launch);
      nothing outstanding.
- [x] **Activate Stripe Tax** — done 2026-07-09. Stripe Tax → Locations shows California
      with 1 registration, status "Collecting tax," 0 "Needs attention." CA seller's permit
      came back from CDTFA and the registration was added — Stripe's flow didn't actually
      prompt for the permit number itself (apparently not a required field on their end);
      confirmed done via the dashboard screenshot, not just assumed.
      **BUT tax was still not actually being collected until 2026-07-29, and this entry is
      why nobody noticed.** Activation has TWO halves and only one was done: the dashboard
      registration (2026-07-09, above) and the `STRIPE_AUTOMATIC_TAX` kill switch, which had
      been set to `false` on 2026-07-05 as the documented temporary unblock *while* the
      dashboard side was pending — and was never flipped back once it landed. So every live
      order between launch and 2026-07-29 was created with `automatic_tax: { enabled: false }`,
      including California ones. Unset 2026-07-29 (the code enables tax for any value that
      isn't the literal string `"false"`, so absent = on).
      **Lesson for any future entry here: a dashboard/console step and a code-side flag are
      separate halves, and ticking one is not the feature.** Ticking this box on the dashboard
      alone made the gap invisible for three weeks; it surfaced only from an unrelated secrets
      audit, where the flag's digest happened to match `STORE_ENABLED`'s.
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
- [x] **Deploy `printful-webhook` and register it with Printful** (2026-07-07, verified
      together via a real cancel-test) — closes the
      one-way gap where canceling/deleting an order in the Printful dashboard never made it
      back into `orders` (it just sat showing stale `submitted`/"In production" forever).
      See `supabase/functions/printful-webhook/index.ts`'s header comment for the verified
      event list/payload shape/signature scheme. Steps, in order:
      1. `npx supabase functions deploy printful-webhook --no-verify-jwt`
      2. Register the webhook against the real store (this is a real, mutating call against
         the live Printful account — run it once, not per-deploy):
         ```
         curl -X POST https://api.printful.com/v2/webhooks \
           -H "Authorization: Bearer $PRINTFUL_API_KEY" \
           -H "X-PF-Store-Id: 18363066" \
           -H "Content-Type: application/json" \
           -d '{
             "default_url": "https://fgrhbzqzadpjpbzuszpm.supabase.co/functions/v1/printful-webhook",
             "events": [
               {"type": "order_canceled"},
               {"type": "order_failed"},
               {"type": "order_refunded"},
               {"type": "order_updated"},
               {"type": "order_put_hold"},
               {"type": "order_put_hold_approval"},
               {"type": "order_remove_hold"}
             ]
           }'
         ```
      3. **The response's `secret_key` is shown exactly once** — copy it immediately and set:
         `npx supabase secrets set PRINTFUL_WEBHOOK_SECRET_KEY=<the hex secret_key value>`
         (losing it means re-registering from scratch, since Printful never displays it
         again after creation).
      4. Verify with a real test: cancel one of the existing unconfirmed test/draft orders
         in the Printful dashboard, then check the Edge Function logs for a verified
         signature and confirm the matching `orders` row flips to `canceled` (and moves from
         Active to the History tab on the account page) and that the alert email arrives.

## Go-live sequence (in order, last step flips the switch)

0. [x] `flyctl deploy` for the 2026-07-02 geometry-settings change — done 2026-07-03
       (deployed from repo root, not `render-service/`: the Dockerfile's build context is
       the repo root, since it needs `../src` and `../public` — see the Dockerfile's own
       header comment. Both machines updated to image version 4).
1. [x] Merge `feature/account-gallery-ui` → `master` (2026-07-05) — pushed, GitHub Actions
       deploy triggered. Confirm the Actions run finishes green and chromaforge.app reflects
       it before treating this as fully done.
2. [x] Verify deep links work on the live site (`chromaforge.app/shop` direct hit) — the
       `.htaccess` SPA fallback tested live, works.
3. [x] Run one full test purchase on the live site (Stripe test keys still fine here) and
       confirm the Printful draft looks right, the order shows in account history, and the
       confirmation page resolves. Done 2026-07-05 on a t-shirt — worked end to end. Mesh
       shorts and zip hoodie purchases also completed on our side but the Printful order
       itself failed downstream — see the new "Printful can't actually fulfill..." item
       above, a separate, non-blocking-for-this-step Printful catalog issue.
       **Remaining pre-launch test items closed out 2026-07-17** (`STORE_ENABLED`
       temporarily flipped `true` for this session, still on Stripe test keys and with
       `PRINTFUL_SKIP_CONFIRM` still set — see below):
       - **Shipping-region checkout, real test purchase to a UK address**: order
         `cb3c2684` (t-shirt, "light" weight class) charged shipping = $5.99, exactly
         `RATE_CENTS.light.GB` in `_shared/shipping.ts`. Tax = $0 (Stripe Tax is only
         registered for California, so an international destination correctly isn't
         taxed under current registrations — not a bug, but a real gap if UK
         VAT/compliance ever becomes a requirement). `create-checkout-session` and
         `stripe-webhook` both logged clean 200s; order reached `submitted` (Printful
         draft created, unconfirmed).
       - **Along the way, added client-side shipping-region pre-selection**
         (`src/lib/regionGuess.js`, timezone-based, no network call/IP geolocation —
         keeps the Privacy page's "no trackers" promise): Stripe's `shipping_options`
         never cross-checks the picked rate against the typed address (a known,
         accepted gap — see `shipping.ts`'s header comment), so this only reorders the
         list to default to the customer's likely region instead of always showing
         US-first; the customer can still override it manually, which is exactly how
         the UK test above was driven.
       - **Printful global mockup rate limit (2 req/60s store-wide at the time; raised
         to 10 on 2026-08-19), real 429 test**:
         confirmed live via `printful-mockup`'s edge-function logs — a real 429 fired
         on a rapid second mockup request, `queued` status kicked in, and the retry
         countdown displayed correctly. Not just a contract-level check anymore (see
         the "Graceful 429 handling" item below) — observed against Printful's actual
         behavior.
       - **Two real UI bugs found and fixed live during this pass**: (1)
         `ConfirmDialog.jsx`'s action buttons (`.cf-btn-primary`/`.cf-btn-ghost`, fixed
         56px height sized for short one-word labels) crushed/wrapped to 2-3 lines for
         the longer "Buy without preview"/"Keep waiting" labels used by the
         skip-the-preview escape hatch — the dialog's only other caller (design delete)
         used short labels, so this never surfaced before. Fixed by stacking the
         actions vertically (full width each) instead of side-by-side `flex-1`. (2)
         `ProductPage.jsx`'s busy UI showed two unrelated clocks at once during
         `queued` — a retry countdown and a separate elapsed-time count-up right below
         it. Fixed by hiding the elapsed counter specifically during `queued` (it still
         shows during rendering/creating/polling, where it's a single, meaningful
         timer).
4. [x] **Swapped Stripe test → live, 2026-07-17.** `STRIPE_SECRET_KEY` set to the live
       secret key from the Stripe account's actual live dashboard (`acct_1To9hzRGdn8L7uMg`
       — confirmed via a throwaway diagnostic edge function that called `GET /v1/account`
       with the configured key and reported back `livemode`/account id, then was deleted;
       this was needed because the account also has a second, unrelated sandbox called
       "Chromaforge sandbox" with a different account id, and the two were easy to
       confuse). A live-mode webhook endpoint was registered (Stripe's newer
       Workbench/Event-destinations UI, not the old "Developers → Webhooks" path) pointed
       at the same `stripe-webhook` URL, subscribed to just `checkout.session.completed`,
       and its signing secret set as `STRIPE_WEBHOOK_SECRET`.
       **Real incident during this step**: the live secret key got set (copied from
       Stripe's own dashboard recommendations panel) before the matching live webhook
       secret existed, while `STORE_ENABLED` was still `true` from the same-day testing
       session — a real window where a genuine customer completing checkout would have
       been actually charged via the live key, but the webhook's signature check would
       have failed (still holding the old test secret), leaving the order stuck
       `pending` with no Printful submission. Caught immediately via a routine
       `whoami-stripe` account check; `STORE_ENABLED` was set back to `false` within the
       same exchange, and the `orders` table was checked directly for the exposure
       window — zero orders were created, so no customer was actually affected. Sequencing
       lesson for next time: when swapping to a live key, pause `STORE_ENABLED` (or set
       the webhook secret first) before setting the live secret key, never after.
5. [x] **Unset `PRINTFUL_SKIP_CONFIRM`, 2026-07-17** — done together with re-enabling
       `STORE_ENABLED`, once the live secret key and live webhook secret were confirmed
       consistent. **Real first live order went through end to end the same session**:
       order id starting `de012dba`, Stripe session `cs_live_a1R0DU...` (genuinely live,
       paid via Apple Pay), `create-checkout-session`/`render-print-file` clean 200s,
       `stripe-webhook` verified the live signature and flipped the order to `submitted`,
       and `printful-webhook` delivered a follow-up status event for the same order —
       confirming both the payment path and the Printful status-tracking integration work
       against the real live account, not just in test mode. Chromaforge is live.
6. [x] **Re-verified end to end after the 2026-07-29 generator work (v8 + v9 in one day),
       2026-07-30.** `STORE_ENABLED` was paused during that work and this order is what
       re-opened it. Real live Apple Pay purchase, mesh shorts L, order `c15d1c8d`, Printful
       `169226286`. Everything below was checked against the real artifacts, not assumed:
       - **Tax collected for the first time ever** (see the Stripe Tax entry above for why it
         silently wasn't): $34.69 + $5.99 shipping + **$2.99 tax = $43.67**, confirmed on the
         emailed receipt. $2.99/$34.69 = **8.625%**, San Francisco's exact district rate, and
         applied to the item only — shipping correctly untaxed (CA exempts separately-stated
         common-carrier delivery). Taxing shipping too would have read $3.51, so this confirms
         Stripe Tax is applying real jurisdiction rules rather than a flat percentage.
       - **The two 2026-07-29 fixes, proven in production**: the back print file is an EXACT
         horizontal mirror of the front (0 differing subpixels of 195,750,000 at the true
         11250x4350), and it carries geometry — the front matches a local v9 "Detailed" render
         at RMSE 0.45 while the geometry-off variant sits at 68 and Oversized at 93. Sanity
         check that needs no tooling: front/back are 7.4/7.5 MB here, against 7.9/2.7 MB on the
         broken order that started it — that size gap WAS the missing geometry.
       - Order row `submitted` with a payment intent and Stripe's authoritative totals;
         `generatorVersion: 9` stamped; Printful `pending` (accepted, queued) with all five
         files `ok` and both artwork files at 11250x4350.
       - Pre-flight checks that passed the same session: both Fly machines on the v9 release
         (a split release would have failed ~half of checkouts intermittently — check
         `flyctl status`, not just the deploy output), live bundle serving v9,
         `PRINTFUL_SKIP_CONFIRM` absent, catalog drift clean on all 15 products, draft-order
         check PASS on 693/784, 38/38 thumbnails byte-identical to fresh v9 renders.

## Code — high value, near term

- [x] **Printful catalog-drift check (scheduled) — BUILT 2026-07-16.**
      `scripts/check-printful-catalog.mjs` (plain Node; PRODUCT_MOCKUP_CONFIG extracted to
      `src/lib/printfulMockupConfig.js` so it imports outside Vite) asserts per product:
      not discontinued, stitch_color values valid, configured placements exist, printfile
      dims match `scripts/printful-catalog-baseline.json` (regenerate deliberately with
      `--write-baseline` after reviewing a change), every configured style id exists, and
      each variant's RESOLVED style pair isn't restricted away from it (the exact pillow
      failure; a new variant uncovered by the fallback pair fails too). Verified live: all
      11 products pass; negative-tested (tampered baseline correctly fails). Runs daily via
      `.github/workflows/printful-catalog-check.yml` (13:17 UTC + manual dispatch); alert
      channel is GitHub's failed-workflow email. Companion fix shipped same day:
      `printful-mockup` now logs Printful's error body on non-2xx (deployed).
      `PRINTFUL_API_KEY` repo secret added and a manual dispatch ran green (Aaron,
      2026-07-16) — the cron is fully operational.
      Graceful 429 handling — BUILT 2026-07-17. `printful-mockup` now enforces a second,
      store-wide rate limit (`GLOBAL_RATE_LIMIT`, keyed on a fixed sentinel user id
      so it reuses the existing per-user `rate_limits` table with no schema change beyond a
      new `check_rate_limit_verbose` RPC that also reports retry-after seconds) ahead of the
      per-user one, since the global cap is the one that actually binds — set to whatever
      Printful's own `x-ratelimit-limit` currently advertises (2/60s when built; **raised to
      10/60s on 2026-08-19**, when they were found to have relaxed it). Also normalizes a real passthrough 429 from Printful itself
      (best-effort `Retry-After` header parse, since Printful doesn't document this
      endpoint's 429 body shape). `useMockup.js` auto-retries on either, via a new `queued`
      status (added to `BUSY_STATUSES`) that counts down `retryAfterSeconds` and resumes,
      bounded to 3 minutes total so a genuinely down Printful doesn't hang the customer
      forever. `ProductPage.jsx` narrates the wait instead of showing a bare error, and adds
      a "Buy without a preview" escape hatch (three entry points: while queued/busy, on a
      hard failure, and on the disabled-Buy-Now hint) behind `ConfirmDialog` — it calls the
      exact same `onBuyNowClick` used by the real Buy Now button, unmodified, since the real
      print-file render is already independent of whether a mockup ever succeeded; only the
      Stripe line-item image differs (falls back to the product's stock photo, same as
      `heroImage` already did whenever `!hasMockup`). Verified: `check_rate_limit_verbose`
      exercised directly against the live DB (allow → allow → deny-with-shrinking-retry,
      matching a limit=2 window), edge function deployed clean, full app build passes.
      Live-verified against a real Printful 429 during the 2026-07-17 pre-launch pass
      (see the go-live section's item 3): the 429 fired on a rapid second mockup request,
      `queued` kicked in, and the retry countdown displayed correctly — fully closed.
      <details><summary>Original item (2026-07-12), for context</summary>
- [previously open] **Printful catalog-drift check (scheduled), before full launch** (2026-07-12, Aaron
      — "add later, before we launch fully"). Context: pillow (83) mockups broke silently
      for every size except 18″×18″ because Printful restricted its Default Front/Back
      mockup styles per-variant when they added the new 14″/16″ sizes — the hardcoded
      `mockupStyleIds` pair in `PRODUCT_MOCKUP_CONFIG` only covered one variant (fixed
      same day with `mockupStyleIdsByVariant` + `resolveMockupStyleIds`; all 10 other
      products audited clean, unrestricted styles). The v2 API is still beta, so this
      class of silent catalog change will likely recur. Plan: a GitHub Actions cron job
      (daily/weekly) that, for each product in `PRODUCT_MOCKUP_CONFIG`, fetches
      `/v2/catalog-products/{id}` + `/mockup-styles` + `/catalog-variants` and asserts:
      configured style ids exist and cover all variants, configured placements exist,
      stitch_color values still valid, product not discontinued — ~20 read-only GETs, no
      mockup quota. Also worth asserting printfile dimensions haven't changed (the same
      axis as the label_inside launch blocker). Alert on failure via GitHub's own
      failed-workflow email (simplest) or the existing `ORDER_ALERT_SMTP_*` pattern.
      Cheap companion fix while in there: `printful-mockup/index.ts` should log Printful's
      error body on non-2xx so `get_logs` shows *why*, not just "POST | 400".
      **Related constraint, measured live 2026-07-12 (from Printful's own
      `x-ratelimit-*` headers — not documented anywhere)**: `POST /v2/mockup-tasks` is
      limited to **2 requests per 60s per API key** (**re-read 2026-08-19: now 10** — see
      `docs/incidents/2026-08-19-printful-storage.md`; even rejected/400 requests count;
      polling GETs are on the general 120/60s bucket). That's shared across ALL app
      users, so our edge function's 20/user/min limit is not the binding one — two users
      previewing in the same minute already exhausts it. At any real traffic the mockup
      preview needs graceful 429 handling (Printful's 429 body says exactly how many
      seconds to wait — auto-retry with that delay) or queuing. Limit may rise on a paid
      Printful plan — re-check the header if the account upgrades. Docs also mention an
      unquantified "daily file limit" for the mockup generator — ask support (can piggyback
      on the open label_inside ticket).
      </details>

- [x] **Artwork picker redesign for ProductPage** (planned 2026-07-09, built 2026-07-10) —
      replaced the "Choose artwork" horizontal scroll strip with pinned tiles + a
      "Browse gallery" modal, per the approved mockup
      (https://claude.ai/code/artifact/1c302aed-f04f-45d2-aff2-50ce850c5438). The two
      problems it fixes: (1) the strip fetched and preloaded the user's *entire* saved
      library (unbounded `listMyDesigns()`) on every visit; (2) other users' public
      designs were only reachable via the Gallery's one-way "Print this" hand-off.
      **As built:**
      - Pinned 96px tiles on the page itself: Current studio design (badge "Current"),
        the queued "Print this" hand-off when present ("Queued"), and the one design
        picked from the modal ("Gallery") — never more than three, each with a caption.
        A dashed "Browse gallery" tile opens the modal.
      - `ArtworkPickerModal` (`src/components/ui/`): My Designs / Public tabs — **My
        Designs is the default tab when signed in** (Aaron's call, 2026-07-09); signed
        out it defaults to Public and the My Designs tab is hidden. Fixed 8-per-page
        carousel (prev/next + dots up to 10 pages + "n / m" count), explicit "Use this
        artwork" / Cancel footer (the mockup's open question — went with the confirm
        footer as mocked). Pages are cursor-paginated (`before` keyset) and cached
        per-open; each page's 8 thumbnails preload before the grid's entrance stagger
        plays. Only `kind='image'` rows are listed (animations aren't printable).
      - Data layer: `listMyDesigns` grew optional `{ limit, before, kind }` (no-arg
        callers like GalleryPage unchanged), `listPublicDesigns` grew `kind`, and a new
        head-only `countDesigns({ mine, kind })` feeds the pager's total. Picking a
        design identical to the current studio design (or the queued tile) selects that
        pinned tile instead of duplicating it (`isSameDesign` / id match).
      - Removed as promised: the `myDesignThumbsPreloaded` preload gate, the strip's
        skeleton tiles, and `useHoverScroll` (ProductPage was its only consumer — hook
        file deleted).
      **Verified live** (Playwright vs the dev server, signed out): tiles + modal open,
      Public tab pages 1↔2 with correct "n / 7" counts, card select → footer enable →
      "Use this artwork" → Gallery tile appears, Escape/backdrop close, zero console
      errors; real mobile viewport (375px) checked — which caught and fixed a real flex
      bug (the grid wrapper squeezed under the 92vh panel cap instead of the panel
      scrolling, footer painting on top of cards; fixed with `shrink-0` on the panel's
      sections, same as GalleryModal). The signed-in My Designs tab and the
      picked-design → mockup/checkout flow were manually verified by Aaron (confirmed
      2026-07-15) — nothing outstanding here.

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
      exercised headlessly (Playwright) with no console errors. **Real emailed-link flow
      also went through fine** — Aaron ran a real "Forgot password?" reset against a real
      inbox, 2026-07-17. Also caught and fixed a real pre-existing bug this surfaced:
      `setImage()` in
      `DisplayCanvas.jsx` had an unguarded `document.querySelector('.image-container')` in
      a `gsap.delayedCall(1, ...)` with no unmount cancellation — harmless before since
      nothing navigated away from a freshly-mounted homepage that fast, but the recovery
      redirect does exactly that every time. Now null-guarded like the neighboring
      `#controls-main` lookup already was.
      Recovery template pasted into the Dashboard's Auth → Email Templates → "Reset
      password" (Aaron, done); this feature has since merged to `master` along with
      everything else in `feature/account-gallery-ui` (2026-07-05) and is live.
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
      (screenshotted), closes on Escape, with no console errors. **Real authenticated
      "My Designs → Delete" click-through confirmed working by Aaron, 2026-07-17.**
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
      **Follow-up same day**: Aaron found the first version underwhelming -- each section
      animated as one flat block, and the `top 85%` trigger fired too early (barely
      visible). Reworked to stagger each section's own elements top-to-bottom (a shared
      `.reveal-item` class, since the 3 sections don't share a consistent DOM shape) and
      moved the trigger to `top 70%`. Caught a second real bug before it shipped: for
      `GallerySection`/`ShopCarousel`, the hook's `querySelectorAll('.reveal-item')` ran
      once on mount, which for those two is *before* their async catalog/gallery fetch
      resolves -- at that point the only `.reveal-item` in the DOM is the static header,
      completely missing the cards that mount later. Fixed by giving the hook a `deps`
      array (`useScrollTriggerReveal([loading])`) so it re-queries once the real content
      exists. Verified live: `.reveal-item` counts came back `about: 4, gallery: 9, shop:
      2` (header + all 8 cards, not just the header), a mid-scroll screenshot shows the
      cascade actually in progress (one card in, others still waiting their turn), and the
      reverse-on-scroll-back-up still works with the new per-item structure.
      **Two more fixes, same day.** (1) Aaron caught the gallery card slide starting slow
      then suddenly speeding up -- `.cf-card` has its own CSS `transition: transform 0.2s`
      (an unrelated hover-lift effect) on the *same* `transform` property GSAP animates via
      inline styles every frame, so the CSS transition was additionally easing each of
      GSAP's own per-frame updates on top of GSAP's own curve. Fixed by forcing
      `transition: none` on the reveal targets for the duration of the tween, handing it
      back via `clearProps` once it (or its reverse) completes. Verified by sampling the
      actual transform Y-offset every frame: now a smooth, monotonically decelerating
      curve, and confirmed the hover-lift transition is correctly restored afterward. (2)
      Aaron caught `ShopCarousel`'s reveal firing while the section was still off-screen.
      Root cause: its cards are sized off `cardWidth` (`aspect-square`, so 0 width collapses
      height to ~0 too), which only gets measured a tick *after* `loading` turns false via a
      separate layout effect -- the `ScrollTrigger` was built against that transient,
      collapsed-height layout, and once the stage expanded to its real size the
      already-calculated trigger point was stale. Fixed by adding `cardWidth` to the hook's
      deps (`useScrollTriggerReveal([loading, cardWidth])`). Verified live: swept scroll
      position against the section's actual bounding box -- opacity correctly stays `0`
      while genuinely off-screen (confirmed at a position where the section's top was still
      800px below the viewport) and only reaches `1` once meaningfully visible.
      **Bigger rework, same day: this whole hook was solving the wrong problem.** Aaron's
      actual ask was that scroll position *scrub* each section's reveal in real time --
      scroll down to advance the timeline, scroll back up to rewind it continuously -- not
      a discrete "play once, reverse if you scroll back" trigger (`toggleActions`, what the
      hook actually did). Rebuilt on GSAP's `scrub` instead, which ties the tween's progress
      directly to scroll position between `start`/`end`. Also found the real reason the
      gallery-motion and Shop-visibility fixes above hadn't fully stuck: (a) the CSS
      `transition: none` override was only applied via `onEnter`/`onEnterBack` callbacks,
      which only fire on a threshold *crossing* -- a fast/discrete scroll (or the tests
      that "verified" the earlier fixes, which jumped straight to scroll positions instead
      of scrolling continuously) can skip that crossing entirely, leaving the CSS
      transition active with nothing to ever disable it. Now disabled unconditionally,
      immediately, the moment the tween is created. Verified this round with real
      continuous `mouse.wheel()` events instead of instant `scrollTo` jumps (closer to how
      Aaron actually found these): confirmed genuine scrubbing (an intermediate scroll
      position produces an intermediate opacity, and scrolling back to that exact position
      returns the same value), the gallery card's Y-offset decreases smoothly with no jump
      across a full continuous scroll, and Shop's opacity tracks its real on-screen
      visibility throughout the same continuous scroll (confirmed `ScrollTrigger.getAll()
      .length === 3`, one per section, ruling out React StrictMode's double-effect-invoke
      leaving duplicate/conflicting triggers as a cause).
      **Final rework, same day: the architecture itself was wrong for a grid.** Aaron
      caught it precisely: "the animations are at near completion as soon as the sections
      are visible." Root cause -- the hook used one `ScrollTrigger` on the *section*, with
      GSAP's `stagger` giving each `.reveal-item` a fixed time/index-based delay from when
      the section's top started entering. That has no relationship to where any individual
      card actually sits on the page: for a multi-row grid (Gallery), cards several rows
      down could finish their stagger slot before they'd even scrolled into view, so by the
      time you could actually see a row, it already looked done. Rebuilt so every
      `.reveal-item` gets its **own independent** `ScrollTrigger`, keyed to its own position
      (`start: 'top bottom'` / `end: 'top center'`, scrubbed) -- items in the same row
      naturally end up triggering together since they sit at the same height, giving the
      same top-to-bottom cascade without an artificial delay, and each item is now
      *guaranteed* to still be mid-reveal as it actually enters the viewport, regardless of
      section height or row count. Verified live (real continuous `mouse.wheel()` scroll):
      sampled every gallery item's own opacity against its own visible fraction -- e.g. the
      second row of cards was still at 0.89 opacity while already 96% visible, not finished
      before it could be seen. Re-confirmed the transform-smoothness fix and Shop's
      visibility-tracking both still hold with the new per-item structure.
      **Fifth and hopefully final round, same day -- the test methodology itself was the
      bug.** Aaron reported reveals still completing the moment things became visible.
      Every prior verification scrolled unrealistically gently (30px wheel ticks with
      pauses -- a slow crawl), which is why tests kept passing while real scrolling kept
      failing: a real trackpad flick moves 500-1500px in a fraction of a second, and with
      `scrub: 0.3` the animation tracks scroll so tightly that one flick carries an item
      through its whole trigger range before the eye gets there. Fixed by raising the
      scrub catch-up to `scrub: 2` (the tween keeps visibly easing toward the scroll
      position after the gesture ends -- still fully scroll-driven: pausing mid-range
      holds it, scrolling back rewinds it), bumping the slide distance to 48px, and
      switching start/end to GSAP's `clamp()` variants so items near the page bottom
      (which can never physically reach viewport-center) don't freeze half-revealed.
      Verified with a realistic fast flick this time (~1450px in ~150ms, then sampling
      while stationary): the first-row card lands at opacity ~0.4 and visibly finishes
      over the following ~500ms of stationary time (longer on real hardware, where
      momentum scrolling keeps feeding the scrub), and flicking back up rewinds it to 0.
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
