import { useEffect, useRef } from 'react';
import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { DURATION_SLOW } from '../utils/motionTokens';

gsap.registerPlugin(ScrollTrigger);

// Fades + slides a homepage section in as it scrolls into view, and reverses it if the
// user scrolls back up past where it started -- for sections below the hero (Hero itself
// is already on-screen at load, nothing to "enter"). Supersedes the old IntersectionObserver
// -based useScrollReveal, which only ever fired once and never reversed.
//
// toggleActions is GSAP's own "onEnter onLeave onEnterBack onLeaveBack" shorthand: play
// once scrolling down into it, leave it alone once fully shown (don't hide it again just
// because it scrolled past the top while continuing further down), do nothing special
// re-entering from below while scrolling back up (it should already be in its played
// state), and only reverse on onLeaveBack -- scrolling back up past the point it started
// animating from.
export function useScrollTriggerReveal() {
  const ref = useRef(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const tween = gsap.fromTo(
      el,
      { opacity: 0, y: 30 },
      {
        opacity: 1,
        y: 0,
        duration: DURATION_SLOW,
        ease: 'power2.out',
        scrollTrigger: {
          trigger: el,
          // html/body are overflow:hidden site-wide (the studio needs a locked full-bleed
          // canvas), so the homepage scrolls its own div (see HomePage.jsx), not the
          // window -- ScrollTrigger defaults to the window/document, and would simply
          // never fire without this. Same closest('.overflow-y-auto') pattern
          // GalleryPage's own IntersectionObserver already uses to find its real scroll
          // ancestor for the identical reason.
          scroller: el.closest('.overflow-y-auto') || undefined,
          start: 'top 85%',
          end: 'top 40%',
          toggleActions: 'play none none reverse'
        }
      }
    );

    return () => {
      tween.scrollTrigger?.kill();
      tween.kill();
    };
  }, []);

  return ref;
}
