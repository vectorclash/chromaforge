import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { NavLink } from 'react-router-dom';
import { gsap } from 'gsap/all';
import { useAuth } from '../../context/AuthContext';
import { useStudio } from '../../context/StudioContext';
import { useCrossfadeImage } from '../../hooks/useCrossfadeImage';
import ShirtIcon from '../buttons/ShirtIcon';
import HexagonIcon from '../buttons/HexagonIcon';
import FadeImage from './FadeImage';
import MiniGenerator from './MiniGenerator';
import { DURATION_BASE, DURATION_FAST, DURATION_SLOW_MS as CROSSFADE_MS } from '../../utils/motionTokens';

// Portrait-ish crop -- this panel fills a phone screen, unlike SiteFooter's wide banner
// strip, so the render is requested closer to a phone's own aspect ratio rather than
// reusing the footer's 1600x500.
const BG_RENDER_WIDTH = 900;
const BG_RENDER_HEIGHT = 1600;

function HomeIcon({ size = 22, className = '' }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M3 11.5 12 4l9 7.5" />
      <path d="M5 10v10h14V10" />
    </svg>
  );
}

const itemClass = ({ isActive }) =>
  'mobile-nav-item flex items-center gap-3 border-b border-hairline py-5 font-display text-2xl font-bold transition active:opacity-60 ' +
  (isActive ? 'text-text' : 'text-text-secondary');

// Full-screen mobile nav takeover -- replaces the old sub-`sm` header, which hid Shop/
// Gallery below the `sm` breakpoint with no fallback at all (only the wordmark and
// account chip stayed reachable). SiteHeader owns the open/close state and its own
// HamburgerIcon toggle button (kept fixed above this overlay); this component is purely
// the panel content + its own enter/exit choreography.
//
// Stays mounted through its own exit animation instead of unmounting the instant `open`
// flips false, so closing gets a real fade instead of a hard cut.
//
// Entrance reuses the site's existing `fade-slide-up` CSS keyframe (same one Gallery/Shop
// card grids stagger in with) rather than a bespoke GSAP timeline -- an earlier version
// chained two overlapping GSAP tweens (panel fade, then an offset-started item stagger)
// which read as uneven/laggy ("starts slow then speeds up") because the two phases had
// different durations that didn't line up. One panel-level fade (GSAP, since it also
// needs a reverse for the close) plus the CSS keyframe's own per-item `animation-delay`
// stagger is simpler and matches everywhere else in the app that staggers a list in.
export default function MobileNav({ open, onClose }) {
  const { user, avatarUrl } = useAuth();
  const { currentDesign, renderDesignBlob, queueReady } = useStudio();
  const [mounted, setMounted] = useState(open);
  const [bgUrl, setBgUrl] = useState(null);
  const panelRef = useRef(null);

  useEffect(() => {
    if (open) setMounted(true);
  }, [open]);

  // Same live-artwork-as-background treatment as SiteFooter -- re-renders the current
  // design from its own seed/colors (not a screenshot) whenever it changes, so the panel
  // reads as part of the same generative-art site instead of a plain settings sheet.
  useEffect(() => {
    if (!mounted || !queueReady) return;
    let cancelled = false;
    renderDesignBlob(currentDesign, BG_RENDER_WIDTH, BG_RENDER_HEIGHT)
      .then(blob => {
        if (cancelled) return;
        const url = URL.createObjectURL(blob);
        setBgUrl(prev => {
          if (prev) URL.revokeObjectURL(prev);
          return url;
        });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [mounted, currentDesign, queueReady, renderDesignBlob]);

  const { shown, incoming, fadingIn } = useCrossfadeImage(bgUrl, CROSSFADE_MS);

  useEffect(() => {
    if (!mounted || !panelRef.current) return;
    if (open) {
      gsap.fromTo(panelRef.current, { autoAlpha: 0 }, { autoAlpha: 1, duration: DURATION_BASE, ease: 'power1.out' });
    } else {
      // Faster than the open tween -- closing should feel snappy, not a mirror of the
      // entrance.
      gsap.to(panelRef.current, {
        autoAlpha: 0,
        duration: DURATION_FAST,
        ease: 'power1.in',
        onComplete: () => setMounted(false)
      });
    }
  }, [open, mounted]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = e => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  if (!mounted) return null;

  // Portaled straight to <body> rather than rendered in place -- SiteHeader sits inside
  // SiteLayout's own scrolling container, a sibling of SiteFooter's crossfading background
  // images. Those images' opacity/transition animations get their own compositing layer,
  // and in Chromium that layer intermittently painted *above* this panel's `fixed z-10`
  // despite correct DOM stacking order and a correct full-viewport getBoundingClientRect --
  // confirmed live via elementFromPoint probing (the footer's wordmark link, not this
  // panel, was hit-tested near the bottom of the screen while this panel was open).
  // Portaling to `document.body` makes this the last element in the body, sidestepping
  // that layer-ordering bug entirely instead of chasing z-index/isolation properties that
  // didn't fix it (isolate was tried and made no difference -- removed).
  return createPortal(
    <div
      ref={panelRef}
      role="dialog"
      aria-modal="true"
      aria-label="Site navigation"
      className="fixed inset-0 z-10 flex flex-col overflow-y-auto bg-ink-950 pt-24 sm:hidden"
    >
      {/* Active artwork as the panel's background, same treatment as SiteFooter -- 75%
          opacity image, crossfaded between designs, dark gradient over it for contrast. */}
      {shown && (
        <div className="pointer-events-none absolute inset-0 z-0 opacity-75">
          <img src={shown} alt="" className="absolute inset-0 h-full w-full object-cover" />
          {incoming && (
            <img
              src={incoming}
              alt=""
              className={
                'absolute inset-0 h-full w-full object-cover transition-opacity ' +
                (fadingIn ? 'opacity-100' : 'opacity-0')
              }
              style={{ transitionDuration: `${CROSSFADE_MS}ms` }}
            />
          )}
          <div className="absolute inset-0 bg-gradient-to-t from-ink-950 via-ink-950/80 to-ink-950/40" />
        </div>
      )}
      <nav className="relative z-10 flex flex-col px-6">
        {[
          { to: '/', label: 'Home', icon: <HomeIcon /> },
          { to: '/shop', label: 'Shop', icon: <ShirtIcon size={20} /> },
          { to: '/gallery', label: 'Gallery', icon: null },
          {
            to: '/account',
            label: user ? 'Account' : 'Sign in',
            icon: (
              <span className="relative inline-flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded-full bg-ink-700">
                {avatarUrl ? (
                  <FadeImage src={avatarUrl} alt="" className="h-full w-full object-cover" />
                ) : (
                  <HexagonIcon size={16} className="text-text-secondary" />
                )}
              </span>
            )
          }
        ].map(({ to, label, icon }, i) => (
          <NavLink
            key={to}
            to={to}
            onClick={onClose}
            className={itemClass}
            style={{ animation: 'var(--animate-fade-slide-up)', animationDelay: `${i * 0.06}s` }}
          >
            {icon}
            {label}
          </NavLink>
        ))}
      </nav>
      {/* The floating MiniGenerator widget is hidden on mobile (SiteLayout) in favor of
          this docked instance -- one generate/save surface instead of two competing for
          the same small screen. Shown here on every route, including "/" -- HomePage's
          hero is the same generator, but scrolled away from it this is the only way back
          to generate/save on a small screen without also closing the menu first. */}
      <div
        className="relative z-10 px-6 pb-10 pt-8"
        style={{ animation: 'var(--animate-fade-slide-up)', animationDelay: '0.24s' }}
      >
        <MiniGenerator inline />
      </div>
    </div>,
    document.body
  );
}
