# Support question for Printful — the three tasks that never completed

**Status:** ready to send. Re-verified 2026-08-21: all three tasks still `status: pending`
with empty `failure_reasons`, still queryable via `GET /v2/mockup-tasks?id=`. The evidence
is live, so this can go as-is.

Full background: `2026-08-19-printful-storage.md`. This file is just the message, assembled
from §3 (the paired control), §16.2 (the access logs) and §20 (the Cloudflare question).

**Do not ask "can you fetch our URL."** Our own server-side access logs already answer that:
their fetcher reached us and we returned 200 every time. Asking it again invites the reply
we have already disproved and costs a round trip.

---

## The message

> Subject: Three v2 mockup tasks stuck `pending` since 2026-08-19 — your fetcher received
> HTTP 200 on every request
>
> Store: Chromaforge (API key ending in the account on file).
>
> On 2026-08-19 between roughly 05:30 and 06:00 UTC, three mockup tasks —
> **`959089343`, `959089912`, `959090827`** — entered `pending` and have never left it.
> As of 2026-08-21 they still return `status: pending` with an empty `failure_reasons`
> array. They were never completed and never failed.
>
> **We ran a controlled comparison at the time, and only one variable differs.**
> Task `959088720` used product 257, one placement, one style, with the print file served
> from `chromaforge.app` — it **completed in 9 seconds**. Task `959089343` used the same
> product, same variant, same style id, same payload, and a **byte-identical copy of that
> same file**, served instead from our Supabase Storage bucket
> (`https://fgrhbzqzadpjpbzuszpm.supabase.co/storage/v1/object/public/design-mockups/...`).
> It hung indefinitely. We repeated this six times that night with the same result: every
> task whose file URL pointed at the Supabase host hung, every task pointing at the other
> host completed in under 15 seconds.
>
> **Your fetcher reached our storage successfully.** We have the server-side access logs
> for the bucket. For each of these submissions they show a client with a blank
> `User-Agent` issuing a burst of ~7 HEAD requests at 5-second intervals, beginning within
> a second of the upload — and **every one of those requests returned HTTP 200**. There
> were no 4xx or 5xx responses to any client during the window.
>
> So the file was reachable, and we answered correctly. Two questions:
>
> 1. **What did your pipeline do after receiving those 200s, and why was the task never
>    completed or moved to a failed state?** A task that hangs forever with empty
>    `failure_reasons` gives us nothing to retry on or alert from.
>
> 2. **Did your fetcher receive a Cloudflare challenge or block page instead of the image
>    — an HTML body, or a 403/503 carrying a `cf-ray` header?** This is the most
>    diagnostic thing you can tell us. Supabase Storage sits behind Cloudflare with bot
>    management active, the other host does not, and your fetcher sends a blank
>    `User-Agent`. A challenge issued at Cloudflare's edge would never reach Supabase's
>    origin and so would never appear in our logs — which is consistent with everything we
>    can see. We cannot confirm it from our side; you can, from yours.
>
> The three task ids above are still queryable, so the state is inspectable rather than
> reconstructed. Happy to re-run the paired comparison on request.

---

## If they answer "yes" to question 2

The fix is structural and already scoped (§20): serve print/mockup source files from a host
without bot management in front of it. Check the cheaper options first — whether Supabase's
Storage bot-management behaviour can be relaxed, or whether a custom domain in front of the
bucket bypasses it.

## If they answer "no", or cannot say

Then the fault is inside their pipeline after a successful fetch, and nothing we build
prevents it. The canary (§15/§17) is the whole defence: a stuck task is permanent, so
"still `pending` at ~60s" is safe to treat as failure.
