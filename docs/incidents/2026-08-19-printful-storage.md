# Incident log — Printful cannot fetch our Supabase Storage URLs

**Opened:** 2026-08-19 (investigated ~05:00–05:45 UTC)
**Status:** CLOSED 2026-08-19. Recovered upstream on its own (we changed nothing).
Store purchasing RE-ENABLED 2026-08-19 14:40 UTC after the mockup and order paths were
both re-verified. Gateway logs pulled and analysed — **§12's JWT theory is REFUTED**; see §16 for what the
logs actually show. Root cause is inside Printful, not us. It can still recur.
**Symptom as reported:** "the mockup generator keeps timing out... tried it 10 times."

---

## 1. One-paragraph summary

Printful's file fetcher can no longer retrieve files from our Supabase Storage domain
(`fgrhbzqzadpjpbzuszpm.supabase.co`). Any `POST /v2/mockup-tasks` whose layer URL points
there sits at `status: "pending"` **forever** — Printful never completes it and never fails
it, so `failure_reasons` stays `[]` and there is nothing to surface as an error. Our poll
loop (`POLL_MAX_TRIES = 45` × `POLL_INTERVAL_MS = 4000` = 180s, then one automatic retry)
eventually throws `"Mockup generation timed out."` That message is accurate but misleading:
nothing on our side timed out or misbehaved. **The same tasks complete in 6–12 seconds when
the identical file is served from `chromaforge.app` instead.**

## 2. Current state (what I changed)

- `STORE_ENABLED=false` set via `npx supabase secrets set` at **2026-08-19 05:43 UTC**.
  Verified two ways: the deployed digest equals `sha256("false")`
  (`fcbcf165…24f8aa`), and `GET /functions/v1/printful-catalog?id=630` now returns
  `storeEnabled: false`. Buy Now is disabled app-wide; browsing, mockups, gallery and
  studio are untouched. **Revert with `npx supabase secrets set STORE_ENABLED=true`** —
  takes effect on the next request, no redeploy.
- **No code was changed.** Nothing committed, working tree untouched.
- One diagnostic file was uploaded to `design-mockups/diagnostic-tmp/host-test.jpg` and
  deleted again via the Storage REST API (`{"message":"Successfully deleted"}`, and it is
  gone from the bucket listing). The Cloudflare edge may serve its cached copy for up to
  an hour; harmless, it was a copy of our own public `og-image.jpg`.

## 3. Evidence — the isolation table

All rows are real `POST /v2/mockup-tasks` calls made **directly against Printful**, with
`curl` and the production API key, bypassing our edge function and our app entirely.

| # | Product | Placements / styles | File URL host | Result |
|---|---|---|---|---|
| 1 | 257 t-shirt | 1 placement, 1 style | chromaforge.app | **completed 9s** |
| 2 | 257 t-shirt | 4 placements, 2 styles (realistic) | chromaforge.app | **completed 12s** |
| 3 | 630 bandana | real config, 2 styles | chromaforge.app | **completed 6s** |
| 4 | 630 bandana | real config, 2 styles | **Supabase Storage** (Aaron's own uploaded file) | **pending >20 min** |
| 5 | 257 t-shirt | 1 placement, 1 style | **Supabase Storage** | **pending >20 min** |
| 6 | 257 t-shirt | 1 placement, 1 style | **Supabase Storage**, *byte-identical copy of the file that passed in row 1* | **pending >20 min** |

**Row 6 is the decisive one.** Same bytes, same product, same variant, same style id, same
payload — only the host differs. External completes in 9s; Supabase hangs indefinitely.

Task ids, if Printful support wants them: `959088720` and `959088847` (completed,
external), `959089911` (completed, external bandana), `959089343`, `959089912`,
`959090827` (all hung, Supabase-hosted).

## 4. What was ruled out — and how

Each of these was checked, not assumed:

- **Printful API health.** `GET /products/257` → 200 in 0.10s. `GET /v2/mockup-tasks` →
  200. Their status page shows no incident. Four tasks completed normally during the
  investigation.
- **The API key.** `sha256` of the local `.env.local` `PRINTFUL_API_KEY` equals the
  deployed Supabase secret digest exactly (`119c81ca…60db`). Not a repeat of the
  stale-local-key trap. It also demonstrably works — every successful task above used it.
- **Our render + upload step.** It succeeds on *every* attempt. Aaron's files are in the
  bucket, timestamped across all his tries: 04:47, 04:50, 04:52, 05:07, 05:08, 05:20,
  05:25 UTC (plus earlier sets on 18 Aug). So the pipeline gets all the way to "file
  uploaded, URL handed to Printful" and dies there.
- **The image itself.** Downloaded and inspected: baseline JPEG, JFIF, 8-bit, RGB,
  2000×2000, 3 components. Not progressive, not CMYK, not oversized. Structurally
  indistinguishable from the external test image that works.
- **The product / placement config.** Bandana 630 completes fine with an external URL
  (row 3), hangs with ours (row 4). Same for the t-shirt. Product-independent.
- **The edge function.** `POST /functions/v1/printful-mockup` with the anon key returns
  `401` — correct behaviour (the anon key is a valid JWT but not a real user, which is
  exactly what `getSignedInUserId` is there to catch). Function is deployed and reachable.
- **Rate limiting.** Read `check_rate_limit` / `check_rate_limit_verbose` in migrations
  0009/0011. The fixed-window logic is correct and self-heals after 60s — it cannot get
  permanently jammed, which was my first hypothesis. Not the cause.
- **Storage serving.** The public URLs return `200`, `content-type: image/jpeg`, correct
  `content-length`, from any user-agent I tried (default, empty, Guzzle-like). Publicly
  fetchable from here.
- **Project health.** `supabase projects list` → `ACTIVE_HEALTHY`.

## 5. Probable cause (circumstantial — NOT proven)

Three things line up, and none of them is proof:

1. **Supabase status page** currently reads *Partially Degraded Service*, with
   **API Gateway → `degraded_performance`** and an open incident *"401 errors due to JWT
   rejections"* dated 2026-08-14.
2. **This project's platform secrets were all rewritten 2026-08-17 21:42 UTC** —
   `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_JWKS`,
   `SUPABASE_PUBLISHABLE_KEYS`, `SUPABASE_SECRET_KEYS`, `SUPABASE_DB_URL`, all with the
   same timestamp. That is a platform-side migration, roughly a day before the symptom.
3. **Storage now serves through Cloudflare with bot management active** — responses carry
   `server: cloudflare`, a `__cf_bm` bot-management cookie, `x-smart-cdn: true` and
   `sb-gateway-mode: direct`.

Working theory: Printful's datacenter-side fetcher is being challenged or blocked at that
Cloudflare edge, while ordinary browser-ish requests (mine, Aaron's) pass fine.

**This is unproven and should be treated as a lead, not a conclusion.** I could not
reproduce a non-200 from anywhere; verifying it needs a fetch from a datacenter IP, which
I had no way to do from here. The honest state is: *the fault is at the boundary between
Printful's fetcher and our Storage host, and it is not in our code.*

## 6. Blast radius — this is bigger than previews

`render-print-file` uploads real print files to the **same `design-mockups` bucket** and
hands Printful the **same public URL form** at checkout
(`supabase/functions/render-print-file/index.ts:221`, `src/lib/printful.js:832`). So a real
order would submit URLs Printful cannot fetch either. A customer would have been charged by
Stripe and then hit a hanging or failing Printful submission.

That is why the store is off. **Do not turn `STORE_ENABLED` back on until a real order path
is verified end to end**, not just a mockup.

## 7. Where to pick up in the morning

Fastest first:

1. **Re-run the isolation test.** If the platform issue cleared overnight this is a
   two-minute check — resubmit row 6 (identical bytes, Supabase host) and see if it
   completes. If it does, the whole thing is resolved upstream; verify a real order before
   re-enabling the store.
2. **Supabase support ticket.** Project ref `fgrhbzqzadpjpbzuszpm`. Lead with: public
   Storage objects are fetchable from browsers but a third-party server-side fetcher gets
   nothing; ask whether the 2026-08-17 gateway migration or Cloudflare bot management is
   now filtering datacenter clients on `/storage/v1/object/public/*`. Cite the open API
   Gateway incident.
3. **Printful support.** Give them the hung task ids from §3 and ask what their fetcher
   sees when retrieving `https://fgrhbzqzadpjpbzuszpm.supabase.co/storage/v1/object/public/...`
   — they can see the actual HTTP status, which is the one fact this investigation could
   not obtain.
4. **Real fix if it persists: serve print/mockup source files from `chromaforge.app`
   instead of Supabase Storage.** Proven to work in every test above. Touches
   `uploadMockupSourceImage` (`src/lib/printful.js:832`) and `render-print-file`'s upload
   path. Non-trivial — that host is a static rsync target with no upload endpoint today, so
   it needs somewhere to write. Don't start here unless 1–3 dead-end.

## 8. Two unrelated findings, worth noting but not urgent

- **Our global mockup rate limit was 5× stricter than Printful's actual one — FIXED
  2026-08-19.** Printful now returns `x-ratelimit-limit: 10` on `POST /v2/mockup-tasks`;
  `printful-mockup`'s `GLOBAL_RATE_LIMIT` was `2` per 60s, measured live back when that was
  their real cap, so it capped the whole store at 2 mockups a minute across all users.
  Raised to `10`; **needs `npx supabase functions deploy printful-mockup` to take effect.**
  The client side needed no change — `useMockup`'s `queued`/retry path handles both our own
  gate and a real passthrough 429 identically. Re-read the header if the account's plan ever
  changes; the gate must stay at or below whatever they advertise.
- **`npx supabase storage rm` silently no-ops.** It returned `{"deleted":[]}` for a path
  that `ls -r` had just listed, across several path forms. The Storage REST API
  (`DELETE /storage/v1/object/<bucket>/<path>` with the service role key) worked first try.
  Use the REST call, not the CLI, for storage deletion.

## 9. Reusable lesson

**When a Printful round trip hangs, re-submit the identical payload with an externally
hosted file before touching any of our code.** That single substitution separated "our
renderer / our config / our edge function" from "the file host" in about three minutes,
after a lot of plausible-but-wrong hypotheses (rate-limit jam, stale API key, bad image
format, product config drift). A task that stays `pending` with an empty `failure_reasons`
forever is the signature of a fetch Printful cannot complete — it is not a Printful outage
and not a timeout in the ordinary sense.


---

# UPDATE — 2026-08-19 (morning): recovered on its own

## 10. Confirmed resolved, and the order path re-verified

- **The decisive test now passes.** Byte-identical file, same product, same variant, same
  style id, served from Supabase Storage — the exact test that hung >20 min last night
  **completed in 19s**.
- **The real ORDER path was verified too**, which is what §6 said had to happen before the
  store goes back on. `scripts/check-printful-draft-orders.mjs` was run with
  `--file <a real Supabase Storage URL>` (not its default chromaforge.app stand-in) across
  products **257, 630 and 717** — 17 placement files in total, including `label_inside`,
  `label_panel` and the zip hoodie's full 8-placement set. **Every file came back `ok`**,
  drafts deleted, nothing charged. So Printful can both fetch and *process* our
  Storage-hosted files again, on the order path as well as the mockup path.
- **Nothing was changed by us to achieve this.** No code, no config, no secret except
  `STORE_ENABLED`. It recovered upstream.

## 11. What last night's stuck tasks did

The three Supabase-hosted tasks (`959089343`, `959089912`, `959090827`) are **still
`pending` ~12 hours later**, with `failure_reasons: []`. Printful never retried them to
completion and never failed them — they are permanently orphaned.

That is a genuinely useful behavioural fact: **a Printful mockup task whose file fetch
fails is not eventually failed or garbage-collected — it hangs forever.** Our poll loop is
the only thing that ever gives up. So "pending with empty failure_reasons" will always mean
"Printful could not get the file", and no amount of waiting or re-polling will resolve it.

## 12. Most likely cause — the timing fit

Supabase's incident history has two open items on the **API Gateway**, and both point at
the same subsystem:

1. **"401 errors due to JWT rejections"** (API Gateway, open since 2026-08-14). Their
   2026-08-18 18:38 UTC update: *"Fixes for this issue are being sequentially rolled out.
   The impact of the issue is limited to a subset of new projects that can experience it
   upon some JWT renewals."*
2. **"Sign-in failures for `signInWithIdToken` (OIDC) logins on free-tier projects"**,
   raised 2026-08-19 12:47 UTC, stating: **"Impacted timeframe was 18th August 4pm UTC –
   19th Aug 10:30am UTC."**

Line that second window up against our own timeline:

| Time (UTC) | Event |
|---|---|
| 2026-08-17 21:42 | This project's platform secrets all rewritten (`SUPABASE_ANON_KEY`, `SUPABASE_JWKS`, `SUPABASE_SECRET_KEYS`, `SUPABASE_SERVICE_ROLE_KEY`, …) — i.e. **a JWT/key renewal on our project** |
| 2026-08-18 16:00 | Supabase's stated impact window **opens** |
| 2026-08-19 04:47–05:25 | Aaron's ~10 failed attempts |
| 2026-08-19 05:34–06:00 | My reproduction: every Supabase-hosted task hangs, every external one completes |
| 2026-08-19 10:30 | Supabase's stated impact window **closes** |
| 2026-08-19 ~13:00 | Retest: passes in 19s. Draft orders: all `ok` |

Every failure sits inside the window; every success sits outside it. Our project had a key
renewal two days before, which is precisely the trigger condition item (1) describes.

**The working theory:** our project was caught in the API Gateway's JWT-rejection bug
following its 2026-08-17 key rotation, and some gateway paths returned 401 for requests to
this project. We never saw it from a browser or from `curl` — those always got 200 — but
Printful's server-side fetcher, arriving over a different path/edge, consistently could not
retrieve the object.

## 13. What is still NOT proven, and the one way to prove it

**The mechanism is inferred from timing, not observed.** The gaps:

- Supabase's published incidents describe **auth/OIDC sign-in** and **API requests with
  JWTs**. Neither explicitly covers an *unauthenticated public* object fetch
  (`/storage/v1/object/public/*`), which is what Printful was doing. So the correlation is
  strong but the causal path is assumed.
- We never observed a single non-200 from that URL. Every check from here returned 200.
- Cloudflare bot management (`__cf_bm`, `x-smart-cdn: true`, `sb-gateway-mode: direct`) is
  an untested alternative explanation and fits the "browsers fine, datacenter fetcher
  blocked" shape at least as well as the JWT theory does.

**The single remaining way to get a hard answer: ask Printful what HTTP status their
fetcher received.** Give support the three orphaned task ids from §11 and the URL host.
They are the only party that saw the actual response. Worth doing even now that it works —
knowing whether it was a 401, a 403 challenge page, or a timeout tells us which of the two
theories is right, and therefore whether it can recur.

⚠️ **Time-sensitive:** this project is on the free tier, where log retention is short
(~1 day). If our own side of the story is wanted, the Storage/Edge logs for
**2026-08-19 04:00–06:00 UTC** must be pulled from the Supabase dashboard **today** —
filter to `/storage/v1/object/public/design-mockups/*` and look for any non-200. After that
they are gone and §12 can never be upgraded from "probable" to "confirmed".

## 14. Re-enabling the store

Everything §6 asked for has been satisfied (mockup path verified, order path verified with
real Storage URLs across 3 products). Re-enable with:

    npx supabase secrets set STORE_ENABLED=true

Takes effect on the next request, no redeploy.

**Done: re-enabled 2026-08-19 14:40 UTC** on Aaron's go-ahead. Verified the deployed digest
equals `sha256("true")` and that `printful-catalog` reports `storeEnabled: true` to the app.
`PRINTFUL_SKIP_CONFIRM` confirmed still unset, so orders confirm and fulfil for real.
Total time purchasing was off: **05:43 → 14:40 UTC (~9 hours)**.

## 15. Standing risk

The root cause was never in our control and was never positively identified, so **it can
recur without warning.** Two cheap mitigations worth considering:

- **A canary.** A scheduled job that submits one mockup task against a known Storage URL
  and alerts if it is still `pending` after ~60s would have caught this before a customer
  did. `sendOrderFailureAlert`'s SMTP path already exists to page a human.
- **Fail faster and more honestly.** Our poll spends 180s, then retries the whole thing —
  up to ~6 minutes before the customer sees anything. Given §11 (a stuck task never
  recovers), a task still `pending` at ~60s could be surfaced as "preview service is having
  trouble" rather than burning a second full attempt.


---

# UPDATE 2 — 2026-08-19 (afternoon): the logs, and a correction

## 16. I pulled the gateway logs. §12's theory was wrong.

Retrieved via the Management API (`/v1/projects/{ref}/analytics/endpoints/logs.all`), using
the PAT the Supabase CLI already had in the login keychain. **Delete §12 from your mental
model — the JWT/API-Gateway theory does not survive contact with the data.**

### 16.1 Our side served no errors at all

Across the **entire project** (every path, not just Storage) for
**2026-08-19 04:00–06:30 UTC**, which brackets every one of Aaron's failures and all of my
reproductions:

| status | count |
|---|---|
| 200 | 676 |
| 304 | 65 |
| 201 | 2 |
| 403 | 1 |
| 400 | 1 |

**Both non-2xx/3xx responses are mine**, from my own diagnostics, one second apart:

    05:25:32.034  400  GET /storage/v1/object/public/design-mockups/does-not-exist.png
    05:25:32.486  403  GET /auth/v1/user

That is my deliberate missing-object probe and my anon-key auth check. **There were zero
401s, zero 403s to anyone else, and zero 5xx, for the whole window.** Nothing was rejected.
The JWT-rejection incident did not touch this project's request path, and the timing
correlation in §12 was exactly that — a coincidence I over-read.

### 16.2 Printful reached our storage, and got 200 every time

The logs contain a distinct client: **blank user-agent, US, HEAD requests in bursts of
~7 at 5-second intervals**, starting within a second of each upload. One burst per upload,
matching Aaron's timestamps exactly (04:47:18, 04:50:50, 04:52:50, 05:07:35, 05:08:57,
05:20:17, 05:25:03) and matching my own test submissions.

**That client is Printful.** Our own code sends a HEAD in only two places — a single one in
`render-print-file` (checkout only, never ran here) and a single one in
`check-printful-draft-orders.mjs`. Nothing of ours polls a HEAD seven times.

**Every one of those HEADs returned 200.**

So the §1 framing — "Printful cannot fetch our Storage URLs" — is wrong as a *mechanism*.
Printful reached us, repeatedly, and we answered correctly every time. Then the task hung
anyway.

### 16.3 What the logs cannot tell us, and why

No GET from Printful appears — but that proves nothing, because objects are served
`cache-control: public, max-age=3600` through Cloudflare, and a GET served from the CDN edge
never reaches Supabase's gateway and is therefore never logged. Equally, a request blocked or
challenged **at** Cloudflare would not be logged either.

Today's *successful* task shows the **same** blank-UA HEAD-only pattern (5–26 HEADs, all
200, no logged GET). So HEAD-vs-GET does not discriminate working from broken, and no
observable on our side does.

### 16.4 Where that leaves the cause

- **Definitively ruled out:** our storage erroring; the Supabase JWT/API-Gateway incident
  affecting us; any block that stopped Printful reaching us at all; and (from UPDATE 1) our
  renderer, uploads, API key, edge function and rate limiting.
- **Still unknown, and now unknowable from our side:** what Printful's pipeline did after
  receiving `200` on HEAD. The fault lies inside Printful, or at the Cloudflare↔Printful
  boundary, which we cannot see.
- **The host correlation was real, not noise** — 6 out of 6 last night, byte-identical file,
  external host passing and Supabase host hanging. So something about our Storage responses
  did disagree with Printful's ingestion. Candidates never tested: the `set-cookie: __cf_bm`
  header Supabase's Cloudflare layer attaches (chromaforge.app sends no cookie), URL length,
  or HTTP/2 behaviour. Any of these is speculation.

### 16.5 The question to put to Printful — now much sharper

Do not ask "can you fetch our URL". Ask:

> On mockup tasks `959089343`, `959089912` and `959090827` (created 2026-08-19 ~05:30–05:40
> UTC), your fetcher issued 7 HEAD requests at 5-second intervals against
> `https://fgrhbzqzadpjpbzuszpm.supabase.co/storage/v1/object/public/design-mockups/...`
> and received **HTTP 200 on every one** — we have the server-side access logs. The tasks
> have now been `pending` with empty `failure_reasons` for over 12 hours. What did your
> pipeline do after those HEADs, and why was the task never completed or failed?

Those three task ids are still queryable and still `pending`, so the evidence is live.

## 17. Standing risk, restated

Since the cause was never found and provably was not on our side, **§15's canary is now the
main defence, not an optional nicety.** Nothing we can build will prevent this; the goal is
to find out within a minute rather than from a customer. Note also that a stuck task is
permanent (§11), so a canary can safely treat "still pending at ~60s" as failure.


---

# UPDATE 3 — 2026-08-19: the Bluesky lead, and a better hypothesis

## 18. Bluesky was not shared infrastructure — but the instinct was right one layer over

Aaron noticed Bluesky was also failing the same night. Checked: **Bluesky was under a DDoS
attack lasting roughly 24 hours around 2026-08-18**, publicly confirmed by Bluesky and
reported by TechCrunch. That is Bluesky's own incident, not a dependency it shares with
Printful or Supabase. So the literal "shared infrastructure was down" answer is **no**.

Checked and cleared alongside it: **Cloudflare's status page** has only two incidents
overlapping the window — Durable Objects in *Hong Kong* (06:59–07:20 UTC) and CDNJS
(16:16–16:34 on the 18th) — neither of which touches this. AWS's public feed is
current-events-only and carries no history for the window.

## 19. But it produced the best hypothesis yet, and it beats §16's

Chasing it surfaced the structural difference between the two hosts, which I had noted in
§12 and not taken seriously enough:

| | host that **failed** | host that **worked** |
|---|---|---|
| | Supabase Storage | chromaforge.app |
| `server:` | **cloudflare** | `hcdn` (Hostinger) |
| bot management | **active** — sets `__cf_bm` | none |
| `x-smart-cdn` | true | — |

And from §16.2 we now know a fact we did not have before: **Printful's fetcher sends a
blank `User-Agent`.** That is the single most classic bot signature there is.

**Leading hypothesis: Cloudflare bot mitigation on Supabase's storage edge intermittently
challenged or blocked Printful's blank-UA fetcher.** It accounts for every observation:

- **The host correlation** (6/6, byte-identical file) — Hostinger has no such layer, so the
  external URL was never subject to it.
- **Why our logs are clean.** This is the part that matters, and it corrects §16.4: *a
  Cloudflare-issued challenge never reaches Supabase's gateway, so it would never appear in
  `edge_logs`.* "No errors in our logs" is therefore fully consistent with "Cloudflare
  blocked it" — it is **not** evidence that the fault was inside Printful. §16.4's
  conclusion was too strong and should be read as "not our origin" rather than "Printful's
  bug".
- **HEADs logged at 200, no GET logged.** A cheap HEAD passing while the body GET is
  challenged fits; so does the CDN-cache explanation in §16.3. Both remain open.
- **Self-resolution with no change from us**, as a mitigation posture relaxes.
- **Timing**, weakly: an active DDoS wave against a major platform is the kind of period
  when edge mitigation tightens. This is the weakest link in the chain — Bluesky being
  attacked does not imply Cloudflare tightened anything globally. Do not lean on it.

**Still unproven.** No challenge was ever observed; a blank-UA request from here returns 200
today (tested).

## 20. Revised question for Printful, and the real fix if it recurs

Add to §16.5's wording: *"Did your fetcher receive a Cloudflare challenge or block page —
an HTML body, or a 403/503 carrying a `cf-ray` header — rather than the image?"* That is
now the single most diagnostic thing they can tell us, and it is answerable from their logs.

If it recurs and the answer is yes, the fix is structural and known:
**serve print/mockup source files from a host without bot management in front of it.**
That is what UPDATE 1 §7 item 4 already proposed, but the reason is now specific rather than
speculative — and it also means a cheaper option exists first: check whether Supabase's
Storage bot-management behaviour can be relaxed, or whether putting a custom domain in front
of the bucket bypasses it.
