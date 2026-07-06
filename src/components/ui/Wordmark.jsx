import React, { useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { gsap, SplitText } from 'gsap/all';
import logo from '../../assets/images/logo.svg';

gsap.registerPlugin(SplitText);

// Shared hover-cycle behind every CHROMA/FORGE wordmark on the site (site header/footer via
// the default export below, plus the studio's own <h1> wordmark in DisplayCanvas.jsx via
// StudioWordmark) -- FORGE snaps instantly (plain CSS, no transition) to CHROMA's own
// resting white while CHROMA cycles the full color wheel per character. Each char's cycle is phase-offset from
// its neighbors -- via gsap's stagger, which gives each char its own independently-repeating
// tween started a beat after the previous one -- so the wheel never lines up flat across the
// word; it reads as a wave sweeping through, not the whole word flashing one color at a time.
// Hue rotation is done via CSS `filter: hue-rotate()` on a fixed saturated base color rather
// than animating `color` through interpolated RGB stops: one continuous, GPU-cheap property
// instead of manually stepping through a gradient every frame. On mouse-leave CHROMA snaps
// back instantly too -- `gsap.set` with `clearProps`, not an animated tween back to
// hue-rotate(0). Returns the mouse handlers rather than owning a DOM element itself since
// callers wrap wildly different things (a router <Link> here, a plain onClick <h1> in the
// studio) and non-bubbling onMouseEnter/onMouseLeave need to sit on whatever the full
// hoverable area actually is, not just the text span.
function useWordmarkHover() {
  const chromaRef = useRef(null);
  const splitRef = useRef(null);
  const tweenRef = useRef(null);

  useEffect(() => {
    splitRef.current = new SplitText(chromaRef.current, { type: 'chars' });
    return () => {
      tweenRef.current?.kill();
      splitRef.current?.revert();
    };
  }, []);

  const onMouseEnter = () => {
    const chars = splitRef.current?.chars;
    if (!chars?.length) return;
    tweenRef.current?.kill();
    gsap.set(chars, { color: 'hsl(0, 100%, 55%)', filter: 'hue-rotate(0deg)' });
    tweenRef.current = gsap.to(chars, {
      filter: 'hue-rotate(360deg)',
      duration: 2.6,
      ease: 'none',
      repeat: -1,
      stagger: { each: 0.1 }
    });
  };

  const onMouseLeave = () => {
    tweenRef.current?.kill();
    tweenRef.current = null;
    const chars = splitRef.current?.chars;
    if (!chars?.length) return;
    gsap.set(chars, { clearProps: 'color,filter' });
  };

  return { chromaRef, onMouseEnter, onMouseLeave };
}

// The CHROMA/FORGE text itself -- just the two words, no wrapping link/heading, so it can
// drop into either the site chrome's <Link> or the studio's plain <h1>.
function WordmarkMark({ chromaRef, bClassName = '' }) {
  return (
    <span>
      <span ref={chromaRef}>CHROMA</span>
      <b className={bClassName}>FORGE</b>
    </span>
  );
}

// Site chrome wordmark (SiteHeader, SiteFooter) -- a router <Link> home, styled via Tailwind.
export default function Wordmark({ className = '', onClick }) {
  const { chromaRef, onMouseEnter, onMouseLeave } = useWordmarkHover();
  return (
    <Link
      to="/"
      onClick={onClick}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      className={`group inline-flex items-center gap-2 font-display tracking-tight text-text ${className}`}
    >
      <img src={logo} alt="" className="h-[1em] w-auto" />
      <WordmarkMark chromaRef={chromaRef} bClassName="font-black text-accent-soft group-hover:text-text" />
    </Link>
  );
}

// Studio wordmark (DisplayCanvas.jsx) -- plain onClick navigation, not a router <Link> (the
// studio is a single-page canvas app that navigates via a prop callback), styled entirely
// through components.css's `.controls-inner .row h1`/`h1 b` rules rather than Tailwind
// classes -- see that file for the matching instant-grey `:hover b` rule.
export function StudioWordmark({ onNavigate }) {
  const { chromaRef, onMouseEnter, onMouseLeave } = useWordmarkHover();
  return (
    <h1
      onClick={() => onNavigate?.('/')}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      style={{ cursor: 'pointer' }}
    >
      <img src={logo} alt="" />
      <WordmarkMark chromaRef={chromaRef} />
    </h1>
  );
}
