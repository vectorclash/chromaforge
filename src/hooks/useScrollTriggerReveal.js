import { useEffect, useRef } from 'react';
import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { DURATION_BASE } from '../utils/motionTokens';

gsap.registerPlugin(ScrollTrigger);

// Scrub-driven reveal: scroll position directly controls progress through a homepage
// section's own '.reveal-item' children fading + sliding in, staggered top to bottom.
// Scrolling down advances the timeline; scrolling back up rewinds it, continuously, in
// real time -- this is `scrub`, not a discrete "play once, maybe reverse" trigger (that
// was an earlier, wrong version of this hook -- toggleActions only ever calls play()/
// reverse() on the tween as a one-shot command at two fixed points, it doesn't tie
// progress to scroll position the way scrub does).
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
    const targets = items.length ? items : el;

    // Some reveal targets (.cf-card, via GallerySection's Card) have their own CSS
    // `transition: transform ...` for an unrelated hover-lift effect. Since GSAP also
    // animates `transform` here (the y slide) via inline styles on every scrub update,
    // the CSS transition tries to *additionally* ease each of those updates on top of
    // GSAP's own scrub-driven values -- two competing animation systems on the same
    // property, which is what produced the "starts slow, then suddenly speeds up" motion.
    //
    // Disabled unconditionally, immediately, rather than waiting for an onEnter callback:
    // onEnter/onEnterBack only fire on a threshold *crossing*, which a fast/discrete
    // scroll (or the page loading already past the trigger point) can skip entirely,
    // leaving the CSS transition active for the whole scrub range with nothing to ever
    // disable it. Only the *restore* side needs onLeave/onLeaveBack -- that's a smaller
    // gap (worst case, hover briefly snaps instead of easing) than the reveal motion
    // itself fighting the CSS transition.
    const restoreTransition = () => gsap.set(targets, { clearProps: 'transition' });
    gsap.set(targets, { transition: 'none' });

    const tween = gsap.fromTo(
      targets,
      { opacity: 0, y: 36 },
      {
        opacity: 1,
        y: 0,
        duration: DURATION_BASE,
        ease: 'power2.out',
        stagger: 0.12,
        scrollTrigger: {
          trigger: el,
          // html/body are overflow:hidden site-wide (the studio needs a locked full-bleed
          // canvas), so the homepage scrolls its own div, not the window -- ScrollTrigger
          // defaults to the window/document, and would simply never fire without this.
          // Same closest('.overflow-y-auto') pattern GalleryPage's own IntersectionObserver
          // already uses to find its real scroll ancestor for the identical reason.
          scroller: el.closest('.overflow-y-auto') || undefined,
          start: 'top 90%',
          end: 'top 35%',
          scrub: 0.3,
          onLeave: restoreTransition,
          onLeaveBack: restoreTransition
        }
      }
    );

    // Safety net: sections whose real content loads/measures asynchronously (images,
    // ShopCarousel's cardWidth) can still settle into their final layout slightly after
    // the deps below re-run this effect, leaving the trigger's cached start/end positions
    // calculated against a not-quite-final layout. A follow-up refresh a beat later
    // recalculates against whatever actually ended up on screen.
    const refreshId = requestAnimationFrame(() => ScrollTrigger.refresh());

    return () => {
      cancelAnimationFrame(refreshId);
      tween.scrollTrigger?.kill();
      tween.kill();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return ref;
}
