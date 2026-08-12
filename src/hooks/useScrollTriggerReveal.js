import { useEffect, useRef } from 'react';
import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { isScrollLocked, subscribeScrollLock } from './useScrollLock';

gsap.registerPlugin(ScrollTrigger);

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
export function useScrollTriggerReveal(deps = []) {
  const ref = useRef(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const items = el.querySelectorAll('.reveal-item');
    const targets = items.length ? [...items] : [el];

    const tweens = targets.map(target => {
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

      return gsap.fromTo(
        target,
        { opacity: 0, y: 48 },
        {
          opacity: 1,
          y: 0,
          ease: 'power2.out',
          scrollTrigger: {
            trigger: target,
            // No `scroller` -- ScrollTrigger's default (the window/document) is correct now
            // that the document is what scrolls site-wide (see tailwind.css). This used to
            // pass an explicit `closest('.overflow-y-auto')` ancestor, which today would
            // find either nothing or, worse, MobileNav's fixed full-screen panel.
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
    });

    // Sit out any full-screen overlay's scroll lock. Locking pins the body with
    // `position: fixed`, which makes the document report scroll 0 (see useScrollLock) --
    // and a scrub trigger believes it, rewinding every item to its start. That is why
    // opening and closing a modal used to replay the whole reveal: measured on the
    // homepage, the visible cards went from opacity 1 to 0.004 the moment the modal
    // opened, then eased back in over ~600ms once it closed.
    //
    // `disable(false, ...)` deliberately does NOT revert -- reverting would snap the items
    // back to their pre-tween values, which is the same pop by another route -- and
    // `enable(false, ...)` does not reset progress, so the trigger resumes holding exactly
    // the value it held before the overlay, against a scroll position that has been
    // restored to exactly what it was. Nothing to animate, so nothing animates. The one
    // case that does need a refresh is a section that MOUNTED during a lock (navigating
    // from an open MobileNav): its start/end were cached against a collapsed document.
    let cachedWhileLocked = isScrollLocked();
    const setLocked = locked => {
      tweens.forEach(tween => {
        const st = tween.scrollTrigger;
        if (!st) return;
        if (locked) st.disable(false, true);
        else st.enable(false, cachedWhileLocked);
      });
      if (!locked) cachedWhileLocked = false;
    };
    if (cachedWhileLocked) setLocked(true);
    const unsubscribeLock = subscribeScrollLock(setLocked);

    // Safety net: sections whose real content loads/measures asynchronously (images,
    // ShopCarousel's cardWidth) can still settle into their final layout slightly after
    // the deps below re-run this effect, leaving each trigger's cached start/end
    // positions calculated against a not-quite-final layout. A follow-up refresh a beat
    // later recalculates against whatever actually ended up on screen.
    const refreshId = requestAnimationFrame(() => ScrollTrigger.refresh());

    return () => {
      unsubscribeLock();
      cancelAnimationFrame(refreshId);
      tweens.forEach(tween => {
        tween.scrollTrigger?.kill();
        tween.kill();
      });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return ref;
}
