import { useEffect, useRef } from 'react';
import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';

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
    const scroller = el.closest('.overflow-y-auto') || undefined;

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
        { opacity: 0, y: 36 },
        {
          opacity: 1,
          y: 0,
          ease: 'power2.out',
          scrollTrigger: {
            trigger: target,
            // html/body are overflow:hidden site-wide (the studio needs a locked
            // full-bleed canvas), so the homepage scrolls its own div, not the window --
            // ScrollTrigger defaults to the window/document, and would simply never fire
            // without this. Same closest('.overflow-y-auto') pattern GalleryPage's own
            // IntersectionObserver already uses to find its real scroll ancestor for the
            // identical reason.
            scroller,
            // Starts the instant this specific item first touches the viewport (0%
            // visible) and finishes once it's reached the vertical center -- a generous,
            // clearly-perceptible scroll distance per item, so it's still visibly
            // revealing as it approaches full view, not finished before you can see it.
            start: 'top bottom',
            end: 'top center',
            scrub: 0.3,
            onLeave: restoreTransition,
            onLeaveBack: restoreTransition
          }
        }
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
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return ref;
}
