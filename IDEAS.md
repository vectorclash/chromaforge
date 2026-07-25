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

## ~~Bucket hat~~ → shipped 2026-07-25

The reversible bucket hat (654) is in the starter set now, along with the windbreaker
(615) and bomber jacket (390). The reasoning that made it the right headwear pick still
holds and is worth keeping: most Printful headwear is embroidery (snapbacks, dad hats,
beanies), which needs stitch files with a limited thread-color count that the generative
artwork fundamentally can't produce. The bucket hat is the exception — all-over-print
cut-sew, so it slotted into the existing flow like any other product.

The optional second design for its inside face (Aaron's idea, raised the same day) was
built immediately after — see CLAUDE.md's merch-pipeline section. The one thing to
remember about it: **no mockup style photographs the inside**, so that choice can never
appear in a preview, which is why the UI states it outright rather than implying otherwise.

Its two side seams are handled too: the front and back halves each carry half the crown
side-wall and half the brim, so an unmirrored back restarts the pattern at both seams
(confirmed on a real side-view mockup, style 4899). Printing the back mirrored closes
*both* — the front's right edge meets the mirrored back's left edge, which is the same
pixels, and the same holds coming round the other side. Exposed as a customer toggle
(Continuous / Independent, default Continuous) rather than decided globally, since the
result is bilaterally symmetric, which is a matter of taste. Endless wrap isn't reachable:
it would need a horizontally tileable composition the generator can't produce.

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

## Saved default sizes — built and reverted, 2026-07-25

A `preferred_top_size` / `preferred_bottom_size` pair on `profiles`, pre-selecting the size
on every clothing product. Fully built (migration, Account page UI, variant resolution,
verified across all 14 products) and then reverted the same day on Aaron's call. Both the
columns and the code are gone; migration `0016` was dropped by `revert_profile_default_sizes`.

**The constraint that killed it:** Printful's sizing is not consistent across product lines.
These are different blanks from different manufacturers — an all-over-print cut-sew tee's L
and a windbreaker's L are not the same fit — so a saved size can only ever be a guess, while
a *pre-selected* size carries the authority of a decision. The failure mode isn't the default
being wrong, it's a customer skimming past a choice they didn't know had been made, and a
wrong-size order the customer picked isn't covered by Printful's returns.

Two lesser findings worth keeping if this is ever revisited:

- **Never substitute a near size.** The first build fell back to the nearest available size
  when a product didn't stock the saved one (5XL → a tee's 2XL). That silently puts a size in
  the cart nobody chose, and it's strictly worse than not pre-selecting at all.
- **Four products can't take a body size anyway** — the tote and crossbody have one variant,
  the pillow is sized in inches, and the bucket hat sizes on head circumference (S/M, L/XL),
  which has no relationship to a chest measurement.

**The actually-useful version of this idea was built instead:** Printful's per-product size
tables are now surfaced on the product page (a "Size guide" link beside the size picker, see
CLAUDE.md). They answer "which size am I on THIS garment" — the real question — rather than
guessing at it from a remembered preference.

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
