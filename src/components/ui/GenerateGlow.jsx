import React, { useEffect, useRef } from 'react';
import tinycolor from 'tinycolor2';
import { gsap } from 'gsap/all';
import { DURATION_FAST, DURATION_SLOW } from '../../utils/motionTokens';

const spin = () => tinycolor('#CCFF00').spin(Math.random() * 360).toHexString();

// The same colorful blurred-glow language as HexagonLoader's `.hexagon-glow` -- the
// studio's own "something is generating" cue -- so every previewUrl-driven crossfade
// (MiniGenerator, MobileNav, ProductPage's design tile) reads as the SAME generator
// mid-work as the full studio during its fade-out/hold/fade-in, instead of a matching
// fade timing with nothing to look at during the hold. Always mounted (not conditionally
// rendered) so toggling `active` off can ease opacity out instead of the DOM node being
// yanked out mid-pulse. `active` is meant to be the crossfade hook's `holding` flag (fade-
// out + blank hold only, NOT the fade-in) -- it flips false right as the artwork's own
// fade-in starts, so this fade-out uses DURATION_SLOW/power2.inOut to match that tween
// exactly and finish at the same instant the artwork reaches full opacity, rather than
// lingering after the reveal is already done. The scale pulse only runs while active;
// re-rolls its hue triplet each time it (re)activates, echoing HexagonLoader's per-cycle
// color re-roll. `blurClass` lets each container pick a blur radius proportionate to its
// own size (a 108px thumbnail vs. a full mobile-nav panel need very different amounts for
// the same visual weight).
export default function GenerateGlow({ active, blurClass = 'blur-xl' }) {
  const glowRef = useRef(null);
  const pulseRef = useRef(null);

  useEffect(() => {
    const el = glowRef.current;
    if (active) {
      gsap.set(el, {
        backgroundImage: `linear-gradient(42deg, ${spin()}, ${spin()}, ${spin()})`,
        scale: 0.6
      });
      gsap.to(el, { opacity: 0.85, duration: DURATION_FAST, ease: 'power2.out' });
      pulseRef.current = gsap.to(el, {
        scale: 1,
        duration: 0.5,
        yoyo: true,
        repeat: -1,
        ease: 'power2.inOut'
      });
    } else {
      pulseRef.current?.kill();
      pulseRef.current = null;
      gsap.to(el, { opacity: 0, duration: DURATION_SLOW, ease: 'power2.inOut' });
    }
    return () => {
      pulseRef.current?.kill();
    };
  }, [active]);

  return (
    <div
      ref={glowRef}
      aria-hidden
      className={`pointer-events-none absolute inset-0 z-[1] rounded-full mix-blend-screen will-change-transform opacity-0 ${blurClass}`}
    />
  );
}
