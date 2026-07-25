# Ideas — not committed to, not scheduled

Parking lot for things Aaron and Claude talked through on 2026-07-24, the day the first
real store order went out. None of this is planned work. The point of writing it down is
that each idea has a real constraint attached that took a conversation to surface — the
constraint is the valuable part, not the idea. If one of these gets picked up, read its
constraint first; it decides the shape of the whole thing.

Same convention as CLAUDE.md/TODO.md: prune as things land or die, don't append forever.

## Shader / post-processing effects the user can pick from

A picker of visual effects applied over the generated artwork.

**The constraint that decides everything:** shaders mean GPU, and the print pipeline has
no GPU. `render-service/` runs the renderer as plain Canvas2D in Node via
`@napi-rs/canvas`, deliberately with no headless browser (Puppeteer/Chromium were
considered and rejected — recurring vendor cost and RAM). WebGL can't run there. An effect
that exists only in the browser makes the mockup show something the print can't
reproduce, which breaks the exact guarantee the seed-based recompose-per-ratio design
exists to protect.

**The version that works:** CPU pixel post-processing — effects as pure functions over
`ImageData`, running byte-identically in the browser and in Node. No real GLSL, and
limited to what's tractable per-pixel, but determinism and print parity survive with zero
new infrastructure. Plausible: displacement, chromatic aberration, posterize/quantize,
halftone, scanlines, grain, palette remap, dithering. Bloom and heavy blur are the
expensive ones and need real care — the Fly machine has OOM'd twice at print sizes
already.

Plumbing already exists. This rides in `settings` exactly like `geometry`: normalized in
`designSettings.js`, persisted only when non-default, part of `isSameDesign` identity,
mirrored into `_shared/compactDesign.ts`. If a "none" default consumes no `rng()`, **no
`GENERATOR_VERSION` bump** and every existing design stays byte-identical — same trick
the density slider used.

Two things that will bite if forgotten:

- **Deploy render-service BEFORE the frontend.** It ignores unknown settings and renders
  without the effect, so a frontend that can send one while Fly runs the old bundle means
  the mockup lies about the print — and with no version change, the mismatch check won't
  catch it. Exactly the density-slider hazard.
- **Verify every effect at 4200×5400 for time AND memory**, not just at studio size. The
  first real question when picking this up is whether a pixel pass at print resolution
  blows the Fly machine — before choosing any effects.

## Bucket hat

Most Printful headwear is embroidery (snapbacks, dad hats, beanies), which needs stitch
files with a limited thread-color count — the generative artwork fundamentally can't
produce that. The **bucket hat** is the exception: Printful offers it as all-over-print
cut-sew, so it should slot into the existing flow like any other product (verify
placements against a real mockup task, add a `PRODUCT_MOCKUP_CONFIG` entry, done).

If a hat happens, this is the one to check first.

## Beanie with the vectorclash mark

Fits better than it looks, because `src/render/generateLabelMark.js` already renders the
mark as pure line geometry (37 chords + the ring). Vector line art is far closer to
something an embroidery digitizer can use than any generative composition will ever be.

Tradeoff: the randomization has to go. That generator spins per-design colors — random
greys, a palette-derived accent, a 60% survival roll per chord. Embroidery needs one fixed
design in a handful of thread colors. Arguably correct anyway: a logo beanie is branding,
not a generated piece.

Open question if picked up: whether Printful's embroidery flow accepts what you'd hand
them. That's the first thing to check, not the artwork.

## User poll for what product to add next

Aaron's idea, deliberately deferred the same day. With traffic this low a poll returns
single-digit responses — noise you can't act on — and an empty-looking poll on a new store
reads worse than none. The real signal it buys is engagement, not product data.

If it happens anyway: keep it tiny (4–5 options, results only after voting, no account
required), and note it isn't free — a table, RLS, and abuse handling for anonymous votes.

Revisit when there's enough traffic for answers to mean something.

## Settled the same day (no action needed)

Worth recording so nobody re-investigates: **customers never see Printful's wholesale
cost.** The order email showing the wholesale line, Printful shipping, and "Printful
Wallet" goes to the Printful *account* email, not `recipient.email` — Aaron only received
it because he was both owner and recipient on the first order. An API store has no
storefront for Printful to email on the customer's behalf, so there is no customer
order-confirmation email and no setting for one (confirmed by going through every page
under Settings → Store settings). Customers get the Stripe receipt, and later a
shipping/tracking notification.

Still unverified, and it answers itself on delivery of that first order: whether the
physical packing slip prints prices. We send a `packing_slip` object but never
`retail_costs`, so it should show none. If it shows wholesale instead, add
`retail_costs` in `stripe-webhook` from the authoritative Stripe amounts already written
to the order row.
