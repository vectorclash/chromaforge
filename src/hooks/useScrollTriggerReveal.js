import { useEffect, useRef } from 'react';
import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { DURATION_BASE } from '../utils/motionTokens';

gsap.registerPlugin(ScrollTrigger);

// Fades + slides a homepage section's own '.reveal-item' children in, staggered top to
// bottom, as the section scrolls into view -- and reverses if the user scrolls back up
// past where it started. Each section marks whichever of its own elements should cascade
// in with that class (a shared class rather than e.g. ':scope > *', since the sections
// don't share a consistent DOM shape -- some have an inner content wrapper, some don't).
// Falls back to animating the whole container as one block if a section has no
// '.reveal-item' children marked.
//
// `deps` matters for sections that fetch their real content async (GallerySection,
// ShopCarousel): this effect runs once on mount by default, which for those sections is
// *before* the fetch resolves -- at that point the only '.reveal-item' in the DOM is the
// static header, since the cards are still gated behind a loading state. Pass e.g.
// `[loading]` so this re-queries the DOM (and rebuilds the ScrollTrigger against the real,
// now-rendered set of items) once the content that actually needs to stagger exists.
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
    // animates `transform` here (the y slide) via inline styles on every frame, the CSS
    // transition tries to *additionally* ease each of those per-frame updates on top of
    // GSAP's own easing -- two competing animation systems on the same property, which is
    // exactly what produced the "starts slow, then suddenly speeds up" motion. Force it off
    // for the duration of this tween, then hand it back so hover still works normally
    // afterward.
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
        onComplete: () => gsap.set(targets, { clearProps: 'transition' }),
        onReverseComplete: () => gsap.set(targets, { clearProps: 'transition' }),
        scrollTrigger: {
          trigger: el,
          // html/body are overflow:hidden site-wide (the studio needs a locked full-bleed
          // canvas), so the homepage scrolls its own div, not the window -- ScrollTrigger
          // defaults to the window/document, and would simply never fire without this.
          // Same closest('.overflow-y-auto') pattern GalleryPage's own IntersectionObserver
          // already uses to find its real scroll ancestor for the identical reason.
          scroller: el.closest('.overflow-y-auto') || undefined,
          // 70%, not 85% -- the section needs to be meaningfully on-screen before it
          // reveals, not just barely peeking in at the very bottom edge of the viewport.
          start: 'top 70%',
          end: 'top 30%',
          toggleActions: 'play none none reverse'
        }
      }
    );

    return () => {
      tween.scrollTrigger?.kill();
      tween.kill();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return ref;
}
