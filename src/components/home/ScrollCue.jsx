import React, { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { HERO_REVEAL, heroIntroEnabled, heroRevealStarted, subscribeHeroReveal } from '../../utils/heroIntro';
import { isScrollLocked, subscribeScrollLock } from '../../hooks/useScrollLock';
import { track } from '../../lib/track';

// A chevron at the foot of the homepage hero that hops, lands with a small squash, and drops a
// spectrum-coloured echo of itself on each landing (2026-11-16, Aaron: the 11-14 "Scroll" word
// over a running hairline "feels a bit aggressive"). The hero fills the screen, and ad visitors
// were leaving it without finding anything below. Transforms and opacity only.
//
// - Arrives LAST in the hero's entrance (HERO_REVEAL.cue), once what it points past is there.
// - Shown only at the top of the page; it drops away down the page on the
//   first scroll and rises back up, with a small overshoot, when you return.
// - Never covers the controls. On a short screen (an iPhone SE, Safari with its toolbar up) the
//   panel's foot can reach the bottom of the visible screen, so `fit` measures: the full cue,
//   then a smaller one, then nothing.
// - Tapping it scrolls to the About section.
const CLEARANCE = 12;
// Mirrors `.hero-scroll-cue-mark`'s animation-range in components.css.
const FADE_BY = 0.25;
const SUPPORTS_TIMELINE =
  typeof CSS !== 'undefined' && CSS.supports?.('animation-timeline: scroll()');

export default function ScrollCue() {
  const ref = useRef(null);
  const markRef = useRef(null);
  const gradientId = `cue-spectrum-${useId().replace(/:/g, '')}`;
  // A restored scroll position skips the hero's entrance (heroIntro.js), so the reveal signal
  // this would wait for may never come; such a mount just shows the cue once back at the top.
  const [revealed, setRevealed] = useState(() => heroRevealStarted() || !heroIntroEnabled());
  const [atTop, setAtTop] = useState(() => typeof window === 'undefined' || window.scrollY <= 40);
  const [fit, setFit] = useState('full'); // 'full' | 'short' | 'none'
  // Only the first appearance waits for its beat; fading back in after a scroll is immediate.
  const [delay, setDelay] = useState(() => (heroRevealStarted() || !heroIntroEnabled() ? 0 : HERO_REVEAL.cue));

  useEffect(() => {
    if (revealed) return undefined;
    return subscribeHeroReveal(() => setRevealed(true));
  }, [revealed]);

  useEffect(() => {
    let raf = 0;
    const update = () => {
      raf = 0;
      // A locked page reports scroll 0 (useScrollLock): keep what it had rather than reappear.
      if (isScrollLocked()) return;
      const progress = Math.min(1, Math.max(0, window.scrollY / (window.innerHeight * FADE_BY)));
      setAtTop(progress < 1);
      if (progress > 0) setDelay(0);
      if (!SUPPORTS_TIMELINE && markRef.current) markRef.current.style.opacity = String(1 - progress);
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(update);
    };
    update();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    const unsubscribe = subscribeScrollLock(onScroll);
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      unsubscribe();
      cancelAnimationFrame(raf);
    };
  }, []);

  // Try each size in turn against the lowest control, writing the class directly so each try
  // can be measured in the same frame; React state records the result.
  const measure = useCallback(() => {
    const el = ref.current;
    const lowest = document.querySelector('.controls-compact .go-to-studio-btn');
    if (!el || !lowest) return;
    const floor = lowest.getBoundingClientRect().bottom + CLEARANCE;
    el.classList.remove('is-short');
    if (el.getBoundingClientRect().top >= floor) return setFit('full');
    el.classList.add('is-short');
    if (el.getBoundingClientRect().top >= floor) return setFit('short');
    setFit('none');
  }, []);

  useLayoutEffect(() => {
    measure();
  }, [measure, revealed]);

  useEffect(() => {
    let raf = 0;
    const onResize = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(measure);
    };
    window.addEventListener('resize', onResize);
    // Webfonts loading late can change the panel's height.
    document.fonts?.ready?.then(measure).catch(() => {});
    return () => {
      window.removeEventListener('resize', onResize);
      cancelAnimationFrame(raf);
    };
  }, [measure]);

  // `shown` is the entrance and the fit; the scroll fade rides the mark inside, so the two never
  // fight over one opacity. `atTop` only decides whether the faded-out cue can still be clicked.
  const shown = revealed && fit !== 'none';
  const live = shown && atTop;

  const onClick = () => {
    track('scroll_cue_click');
    const next = document.getElementById('about');
    if (!next) return;
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    window.scrollTo({
      top: next.getBoundingClientRect().top + window.scrollY,
      behavior: reduce ? 'auto' : 'smooth'
    });
  };

  return (
    <button
      ref={ref}
      type="button"
      className={
        'hero-scroll-cue' +
        (shown ? ' is-shown' : '') +
        (live ? '' : ' is-inert') +
        (fit === 'short' ? ' is-short' : '')
      }
      style={{ '--cue-delay': `${delay}ms` }}
      onClick={onClick}
      aria-label="Scroll to see more"
      tabIndex={live ? 0 : -1}
    >
      <svg ref={markRef} className="hero-scroll-cue-mark" viewBox="0 0 24 14" aria-hidden focusable="false">
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stopColor="#4c00ff" />
            <stop offset="0.3" stopColor="#ff0059" />
            <stop offset="0.55" stopColor="#ffbb00" />
            <stop offset="0.75" stopColor="#eaff00" />
            <stop offset="1" stopColor="#00e5ff" />
          </linearGradient>
        </defs>
        <path className="hero-scroll-cue-echo" d="M3 3 L12 11 L21 3" stroke={`url(#${gradientId})`} />
        <path className="hero-scroll-cue-chevron" d="M3 3 L12 11 L21 3" />
      </svg>
    </button>
  );
}
