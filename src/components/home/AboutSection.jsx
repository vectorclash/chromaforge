import React from 'react';
import { Link } from 'react-router-dom';
import AboutBlob from './AboutBlob';
import AboutShirts from './AboutShirts';
import { useScrollTriggerReveal } from '../../hooks/useScrollTriggerReveal';

// Explains what the app is and where it came from -- deliberately NOT a "how it works in
// three steps" tour, even though the 2021 design was exactly that: the two steps it would
// cover (preview it on a garment, see what others made) are now the shop carousel and the
// gallery section directly below this one, with their own real images and links.
//
// Shape: a section header, then two rows that each pair one visual with the prose it belongs
// to, with the visual swapping sides between them. AboutBlob (a live render of the visitor's
// current design inside the 2021 illustration's silhouette) carries the generative half; the
// shirt carousel carries the printed-garment half.
//
// The header is NOT inside the first row. It was briefly, which put the blob above the
// section's own heading in the mobile stack -- an image introducing a section before the
// section is named. It also broke the homepage's own convention: the gallery and shop
// sections both open with a left-aligned eyebrow + h2 block above their content, and this
// section was already the only centred one on the page.
//
// A two-column version WAS built and rejected once, on the grounds that ~600px of prose
// against a ~260px image left the image stranded in dead space. That measurement was of the
// whole section's prose against a single image, which is not this: with the intro paragraph
// carried by the header, each row is one paragraph beside an image that draws taller than it.
// Worth knowing if the copy ever grows a lot -- the objection comes back if one row's text
// runs much past its image.
//
// Worth knowing before "fixing" the mobile height here: no column layout can shorten it.
// Everything collapses to one column at phone widths, so length is purely a function of
// word count plus image height -- the same reason the 2021 design's about frame was TALLER
// on mobile (1801px) than on desktop (1522px).

// max-w-5xl matches the gallery and shop sections; this one used to be the odd max-w-2xl out
// because it was a single narrow column of prose.
const ROW = 'grid items-center gap-8 lg:grid-cols-2 lg:gap-14';
// Both images fill their row, and they are sized identically -- no per-image fraction.
//
// An earlier version held the shirts to 84% of the blob's width, on the theory that
// AboutBlob's canvas is larger than the silhouette inside it so the blob only fills 84% of its
// box. That number is the blob's SILHOUETTE box, and it ignores that the edge stars overflow
// that box: measured off the live canvases' actual non-transparent extents, AboutBlob's ink
// fills 94.5% of its width and AboutShirts' 99%. So the correction was aimed at a 19%
// mismatch that is really 4.8% -- below noticing -- and overshot far enough to make the shirts
// 12% SMALLER than the blob rather than equal to it.
//
// The one thing the caps were right about is the band between the mobile stack and the
// two-column breakpoint: with no cap at all, a 900px viewport gave images 852px wide and grew
// the section from 1294px to 1682px. max-w-xl keeps that in hand while still letting both
// images fill the row everywhere it matters -- on phones the container is well under it, and
// above lg the column governs.
const IMAGE_SIZE = 'mx-auto w-full max-w-xl lg:max-w-none';

export default function AboutSection() {
  const ref = useScrollTriggerReveal();
  return (
    <section id="about" ref={ref} className="mx-auto max-w-5xl px-6 py-24">
      {/* mb-8 matches ROW's gap-8, keeping the mobile stack on one rhythm; the roomier
          mb-16 is a desktop-only separation between the header and the first row. */}
      <div className="reveal-item mb-8 lg:mb-16">
        <p className="font-quicksand text-xs font-bold uppercase tracking-[0.18em] text-accent">
          How it works
        </p>
        <h2 className="mt-3 font-display text-3xl font-bold text-text">
          Art, computed from a single seed
        </h2>
        {/* Capped independently of the section: body copy set across the full 976px would run
            past a comfortable line length, which the eyebrow and heading above it do not. */}
        <p className="mt-5 max-w-2xl font-quicksand text-text-secondary">
          Chromaforge generates original artwork live in your browser. Each design is just a
          seed -- a handful of numbers that rebuilds the identical composition at any size.
          Save the ones you like, share them, or print one on a garment.
        </p>
      </div>

      {/* Image first in the DOM in BOTH rows, so the mobile stack puts it on top of its own
          paragraph without any order juggling; lg:order-* is what moves it to a side on
          desktop. Free to do because each visual is an aria-hidden canvas, so DOM order
          carries no reading order. */}
      <div className={ROW}>
        {/* AboutBlob's canvas is deliberately larger than the silhouette (its MARGIN block
            reserves room for the edge stars and the wobble), so 12.73% of its height is
            transparent below the blob and 19.35% above it (the top edge star reaches
            furthest) -- against AboutShirts, whose hexagon backdrop is full-bleed. Left
            alone, the mobile stack's gaps measure equal but READ unequal.
            Pulled back as percentages, not px: a percentage margin resolves against the
            container's WIDTH, and each blank is a fixed fraction of the canvas, so
            dividing by CANVAS_W/CANVAS_H gives 8.87% and 13.48% of the width, which hold
            at every viewport.
            Only in the stack -- at lg the rule separates the rows and items-center would
            just re-centre a shortened box. */}
        <AboutBlob
          className={`reveal-item ${IMAGE_SIZE} -mt-[13.48%] -mb-[8.87%] lg:order-2 lg:mt-0 lg:mb-0`}
        />
        <p className="reveal-item font-quicksand text-text-secondary lg:order-1">
          It started as a few tools I was building to make art with. I wanted to see whether I
          could make my work directly in code, and one thing led to another until it was a full
          generative art builder. The procedurally generated universes of games like No
          Man&rsquo;s Sky are somewhere underneath it.
        </p>
      </div>

      {/* Fades out at both ends rather than butting into the padding as a hard line, the same
          way the hero's dot grid dissipates. Its own reveal-item so it draws in with the row
          it introduces instead of sitting there ahead of the content.
          Desktop only: it separates two side-by-side rows. In the mobile stack there are no
          rows to separate -- every element is already one-per-line -- so the rule and its
          spacing both go. */}
      <div
        className="reveal-item hidden h-px bg-gradient-to-r from-transparent via-[rgba(250,250,250,0.14)] to-transparent lg:my-20 lg:block"
        aria-hidden="true"
      />

      {/* mt-8 matches ROW's own gap-8, so in the mobile stack the shirts sit the same
          distance below the preceding paragraph as the blob does above its one -- one
          consistent rhythm down the column. Zeroed at lg, where the rule's my-20 separates
          the two rows instead. */}
      <div className={`${ROW} mt-8 lg:mt-0`}>
        <AboutShirts className={`reveal-item ${IMAGE_SIZE} lg:order-1`} />
        <div className="lg:order-2">
          {/* This paragraph is worded for its TAIL, which is why it reads slightly long.
              It used to end "...that came&nbsp;up.", with the non-breaking space binding the
              last two words so `text-wrap: pretty` (tailwind.css) would pull a third word down
              rather than strand one. That binding no longer survives: the reveal now runs the
              copy through SplitText, whose `reduceWhiteSpace` (on by default) does
              `replace(/\s+/g, ' ')` -- and JS `\s` matches U+00A0, so the nbsp is normalised to
              an ordinary space before lines are measured. "up." was stranding alone on the last
              line (Aaron, live).
              The wording carries it instead: a longer, less end-loaded tail gives the wrap more
              places to break acceptably. Note this makes an orphan LESS LIKELY, it does not
              make it impossible -- if one shows up at some width again, the durable fix is
              <span className="whitespace-nowrap"> on the last two words, which is a style on a
              real element and so survives whitespace normalisation. */}
          <p className="reveal-item font-quicksand text-text-secondary">
            It rewards digging in, though. Feed it your own colors, work the geometry sliders,
            and you&rsquo;ll end up with something that prints far better on a garment than the
            first thing the generator happened to hand you.
          </p>
          <div className="reveal-item mt-6">
            <Link to="/studio" className="font-quicksand text-sm text-text-muted transition hover:text-text">
              Open the studio &rarr;
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
}
