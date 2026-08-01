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
      <div className="reveal-item mb-12 lg:mb-16">
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
        <AboutBlob className={`reveal-item ${IMAGE_SIZE} lg:order-2`} />
        <p className="reveal-item font-quicksand text-text-secondary lg:order-1">
          It started as a few tools I was building to make art with. I wanted to see whether I
          could make my work directly in code, and one thing led to another until it was a full
          generative art builder. The procedurally generated universes of games like No
          Man&rsquo;s Sky are somewhere underneath it.
        </p>
      </div>

      {/* Fades out at both ends rather than butting into the padding as a hard line, the same
          way the hero's dot grid dissipates. Its own reveal-item so it draws in with the row
          it introduces instead of sitting there ahead of the content. */}
      <div
        className="reveal-item my-14 h-px bg-gradient-to-r from-transparent via-[rgba(250,250,250,0.14)] to-transparent lg:my-20"
        aria-hidden="true"
      />

      <div className={ROW}>
        <AboutShirts className={`reveal-item ${IMAGE_SIZE} lg:order-1`} />
        <div className="lg:order-2">
          {/* The non-breaking space is doing real work, not decoration. The site-wide
              `text-wrap: pretty` rule (tailwind.css) only prevents a ONE-word last line, and
              at the 460px column this row is pinned to on every desktop width it was landing
              on a two-word tail ("came up.") -- measured, at every viewport from 1024 up, not
              just a couple of unlucky widths. Binding the last two words makes pretty treat
              them as a single token, so it pulls a third word down instead. */}
          <p className="reveal-item font-quicksand text-text-secondary">
            It rewards digging in, though. Feed it your own colors, work the geometry sliders,
            and you&rsquo;ll end up with something that prints far better on a garment than the
            first thing that came&nbsp;up.
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
