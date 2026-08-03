import { useEffect, useRef } from 'react';
import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { SplitText } from 'gsap/SplitText';

gsap.registerPlugin(ScrollTrigger, SplitText);

// Scrub-driven reveal: scroll position directly controls progress through a homepage
// section's own '.reveal-item' children fading + sliding in -- scrolling down advances
// the timeline, scrolling back up rewinds it, continuously, in real time (`scrub`, not a
// discrete "play once, maybe reverse" trigger).
//
// Each '.reveal-item' gets its OWN independent ScrollTrigger, keyed to its own position --
// not one trigger on the section with an artificial per-item `stagger` delay. That first
// version looked right for a single-column section (About) but broke down for a
// multi-row grid (Gallery's cards): stagger offsets are a fixed time/index-based delay
// from when the *section's* top starts entering, with no relationship to where any
// individual card actually sits on the page -- so cards several rows down could finish
// their stagger slot before they'd even scrolled into view, making the whole reveal look
// "done" well before you could see most of it. Triggering off each item's own position
// means it's always genuinely mid-reveal as *that* item enters the viewport, regardless
// of how tall the section is or how many rows it has -- items in the same row naturally
// end up triggering together since they sit at roughly the same height, giving the same
// top-to-bottom cascade without needing an artificial delay.
//
// Each section marks whichever of its own elements should cascade in with the shared
// '.reveal-item' class (rather than e.g. ':scope > *', since the sections don't share a
// consistent DOM shape). Falls back to animating the whole container as one block if a
// section has no '.reveal-item' children marked.
//
// `deps` matters for sections that fetch/measure their real content async
// (GallerySection, ShopCarousel) -- see each call site's own comment for why.

// A reveal target that is purely TEXT cascades in line by line (SplitText) instead of as one
// block. Everything else -- a card carrying a thumbnail, the carousel's arrow row, AboutBlob's
// canvas -- moves as a single object, which is what it visually is.
//
// The test is "contains nothing but text-level markup", not a tag whitelist on the target
// itself, because several targets are WRAPPER divs holding an eyebrow + heading + paragraph
// (AboutSection's header, ShopCarousel's and GallerySection's intros).
const TEXT_LEVEL = /^(P|H[1-6]|SPAN|A|STRONG|EM|B|I|SMALL|BR|CODE)$/;
function isTextBlock(el) {
  if (!el.textContent.trim()) return false;
  return [...el.querySelectorAll('*')].every(node => TEXT_LEVEL.test(node.tagName));
}

// What SplitText is actually pointed at: the leaf text elements inside a target, never the
// target itself when it is a wrapper.
//
// This is not a refinement, it is load-bearing. Splitting a wrapper FLATTENS it -- the line
// divs come back as siblings of each other, with the original <p>/<h2> boxes and their
// mt-3/mt-5 margins gone, so that spacing gets redistributed between every line and the block
// balloons (measured in a harness against the real stylesheet: AboutSection's header went
// 156px -> 196px, with paragraph lines spaced like separate paragraphs). Aaron caught this
// live as "massive spacing". Splitting each <p>/<h2> in place leaves every element box exactly
// as it was -- verified pixel-identical to the unsplit block.
//
// The lines still animate as ONE staggered run: SplitText takes the whole list in a single
// call and returns their lines together in DOM order, so the eyebrow, heading and copy cascade
// continuously rather than as three separately-timed blocks.
const LEAF_TEXT = 'p, h1, h2, h3, h4, h5, h6, li, blockquote';
function splitTargets(el) {
  const leaves = el.querySelectorAll(LEAF_TEXT);
  return leaves.length ? [...leaves] : [el];
}

// Shorter than the block reveal's 48px: a line travelling as far as a whole paragraph reads
// as sliding rather than settling, and the cascade already carries the movement.
const LINE_SHIFT = 24;
const LINE_STAGGER = 0.15;

export function useScrollTriggerReveal(deps = []) {
  const ref = useRef(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const items = el.querySelectorAll('.reveal-item');
    const targets = items.length ? [...items] : [el];
    const scroller = el.closest('.overflow-y-auto') || undefined;

    const tweens = [];
    const splits = [];

    targets.forEach(target => {
      // Some reveal targets (.cf-card, via GallerySection's Card) have their own CSS
      // `transition: transform ...` for an unrelated hover-lift effect. Since GSAP also
      // animates `transform` here (the y slide) via inline styles on every scrub update,
      // the CSS transition tries to *additionally* ease each of those updates on top of
      // GSAP's own scrub-driven values -- two competing animation systems on the same
      // property, which is what produces a laggy, unnatural motion. Disabled
      // unconditionally and immediately (not gated behind an onEnter callback, which only
      // fires on a threshold *crossing* and can be skipped by a fast scroll or by the
      // page loading already past the trigger point); only the *restore* side needs
      // onLeave/onLeaveBack, which is also exactly when hover would actually happen
      // (settled, not mid-scrub).
      gsap.set(target, { transition: 'none' });
      const restoreTransition = () => gsap.set(target, { clearProps: 'transition' });

      // One shared scrub/trigger config, so a line cascade and a block reveal enter on
      // exactly the same scroll relationship -- only what MOVES differs between them.
      const reveal = (animated, vars) =>
        gsap.fromTo(
          animated,
          { opacity: 0, y: vars.shift },
          {
            opacity: 1,
            y: 0,
            stagger: vars.stagger,
            ease: 'power2.out',
            scrollTrigger: {
              // Always the target itself, never the split lines: a line's own position
              // would give each one its own start/end and undo the cascade (they would
              // each animate as they individually reached the viewport bottom instead of
              // running as one staggered sequence off the block's arrival).
              trigger: target,
              // html/body are overflow:hidden site-wide (the studio needs a locked
              // full-bleed canvas), so the homepage scrolls its own div, not the window --
              // ScrollTrigger defaults to the window/document, and would simply never fire
              // without this. Same closest('.overflow-y-auto') pattern GalleryPage's own
              // IntersectionObserver already uses to find its real scroll ancestor for the
              // identical reason.
              scroller,
              // Starts when this specific item first touches the viewport bottom, finishes
              // once its top reaches the vertical center. clamp() (GSAP 3.12+) adjusts both
              // for items too close to either end of the page to ever physically reach
              // those positions -- without it, an item near the page bottom whose top can
              // never scroll up to viewport-center would freeze permanently half-revealed.
              start: 'clamp(top bottom)',
              end: 'clamp(top center)',
              // 2s catch-up, deliberately -- this number is the whole reason the reveal is
              // perceptible at all. A real trackpad flick moves the page 500-1500px in a
              // fraction of a second; with a near-instant scrub (0.3 was tried) the
              // animation tracks scroll so tightly that one flick carries an item through
              // its entire range before the eye gets there, so everything looked "already
              // done" the moment it was visible. With the longer smoothing the tween keeps
              // easing toward the scroll position after the gesture ends (measured: a card
              // landing mid-range at opacity ~0.4 visibly finishes over the following
              // ~500ms of stationary time, longer with real momentum scrolling feeding it)
              // -- and it's still fully scroll-driven: pausing mid-range holds it partially
              // revealed, scrolling back rewinds it.
              scrub: 2,
              onLeave: restoreTransition,
              onLeaveBack: restoreTransition
            }
          }
        );

      if (!isTextBlock(target)) {
        tweens.push(reveal(target, { shift: 48 }));
        return;
      }

      // autoSplit re-splits on a resize or a late webfont load and re-runs onSplit, which
      // matters because the split freezes the CURRENT line breaks into real elements --
      // without it, a rotated phone or a font swapping in leaves lines wrapped to widths
      // that no longer exist. The returned animation is what SplitText cleans up on each
      // re-split; its ScrollTrigger is NOT covered by that, so it is killed by hand first
      // (otherwise every re-split leaves another live trigger behind on the same element).
      let lineTween;
      splits.push(
        SplitText.create(splitTargets(target), {
          type: 'lines',
          // Keeps the block readable to screen readers as one continuous string rather
          // than as a pile of per-line divs.
          aria: 'auto',
          autoSplit: true,
          onSplit(self) {
            lineTween?.scrollTrigger?.kill();
            lineTween = reveal(self.lines, { shift: LINE_SHIFT, stagger: LINE_STAGGER });
            tweens.push(lineTween);
            return lineTween;
          }
        })
      );
    });

    // Safety net: sections whose real content loads/measures asynchronously (images,
    // ShopCarousel's cardWidth) can still settle into their final layout slightly after
    // the deps below re-run this effect, leaving each trigger's cached start/end
    // positions calculated against a not-quite-final layout. A follow-up refresh a beat
    // later recalculates against whatever actually ended up on screen.
    const refreshId = requestAnimationFrame(() => ScrollTrigger.refresh());

    return () => {
      cancelAnimationFrame(refreshId);
      tweens.forEach(tween => {
        tween.scrollTrigger?.kill();
        tween.kill();
      });
      // After the tweens, so reverting the split (which unwraps the line divs and restores
      // the original markup) can't leave a live tween pointed at elements that no longer
      // exist.
      splits.forEach(split => split.revert());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return ref;
}
