import React, { useEffect, useRef } from 'react';
import { gsap } from 'gsap/all';
import { DURATION_BASE } from '../../utils/motionTokens';

// Site nav's mobile menu toggle -- three bars morphing into an X, GSAP-driven like every
// other icon-state transition in the app (Wordmark's hover cycle, CloseButton's morph)
// rather than a plain CSS transition, so it fits the same "icons animate deliberately"
// feel. transformOrigin is set per-bar to its own center so the rotate reads as the bar
// pivoting in place, not swinging from the SVG's corner.
export default function HamburgerIcon({ open, size = 20 }) {
  const topRef = useRef(null);
  const midRef = useRef(null);
  const botRef = useRef(null);

  useEffect(() => {
    // transformOrigin: '50% 50%' pivots each bar around its own bounding-box center (GSAP
    // computes this from the <line>'s actual geometry via getBBox) -- an inline CSS
    // transform-origin in viewBox px coordinates looked right on paper but rotated around
    // the wrong point in practice, since a bare <line> has no CSS box for a px-based
    // origin to resolve against, so it read as a chevron instead of a centered X.
    if (open) {
      gsap.to(topRef.current, { duration: DURATION_BASE, y: 6, rotate: 45, transformOrigin: '50% 50%', ease: 'power2.inOut' });
      gsap.to(botRef.current, { duration: DURATION_BASE, y: -6, rotate: -45, transformOrigin: '50% 50%', ease: 'power2.inOut' });
      gsap.to(midRef.current, { duration: DURATION_BASE * 0.6, autoAlpha: 0, ease: 'power2.inOut' });
    } else {
      gsap.to(topRef.current, { duration: DURATION_BASE, y: 0, rotate: 0, transformOrigin: '50% 50%', ease: 'power2.inOut' });
      gsap.to(botRef.current, { duration: DURATION_BASE, y: 0, rotate: 0, transformOrigin: '50% 50%', ease: 'power2.inOut' });
      gsap.to(midRef.current, {
        duration: DURATION_BASE,
        autoAlpha: 1,
        delay: DURATION_BASE * 0.35,
        ease: 'power2.inOut'
      });
    }
  }, [open]);

  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <line ref={topRef} x1="3" y1="6" x2="21" y2="6" />
      <line ref={midRef} x1="3" y1="12" x2="21" y2="12" />
      <line ref={botRef} x1="3" y1="18" x2="21" y2="18" />
    </svg>
  );
}
