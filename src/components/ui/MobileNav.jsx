import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { NavLink } from 'react-router-dom';
import { gsap } from 'gsap/all';
import { useAuth } from '../../context/AuthContext';
import useScrollLock from '../../hooks/useScrollLock';
import { useStudio } from '../../context/StudioContext';
import { useCrossfadeImage } from '../../hooks/useCrossfadeImage';
import ShirtIcon from '../buttons/ShirtIcon';
import HexagonIcon from '../buttons/HexagonIcon';
import DotRipple from '../DotRipple';
import FadeImage from './FadeImage';
import MiniGenerator from './MiniGenerator';
import { isSameDesign } from '../../render/designSettings';
import { DURATION_BASE, DURATION_FAST } from '../../utils/motionTokens';

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
// flips false, so closing gets a real exit instead of a hard cut.
//
// Entrance reuses the site's existing `fade-slide-up` CSS keyframe (same one Gallery/Shop
// card grids stagger in with) rather than a bespoke GSAP timeline -- an earlier version
// chained two overlapping GSAP tweens (panel fade, then an offset-started item stagger)
// which read as uneven/laggy ("starts slow then speeds up") because the two phases had
// different durations that didn't line up. One panel-level move (GSAP, since it also
// needs a reverse for the close) plus the CSS keyframe's own per-item `animation-delay`
// stagger is simpler and matches everywhere else in the app that staggers a list in.
//
// The panel SLIDES in from the right rather than fading (2026-09-23), because of iOS 26
// Safari's bottom toolbar. A fixed element does not paint under that toolbar; Safari fills
// the strip itself, with the colour of an opaque fixed element at the bottom edge, and it can
// only ever fill it one flat colour. So any moment the panel is partly see-through, the strip
// cannot match the blend above it and reads as a bar -- which is what a fade is for its whole
// length. Established on a real iPhone with a throwaway test page (per-frame fade, CSS fade,
// fading only the background colour, a static 50% panel, no scroll lock): every translucent
// variant showed the bar. Changing the page background colour and holding the scroll lock
// through the fade were both tried first and changed nothing. The panel is now opaque at
// every frame, so there is no blend for the strip to fail to show.
export default function MobileNav({ open, onClose }) {
  const { user, authResolved, avatarUrl } = useAuth();
  const { currentDesign, renderDesignBlob } = useStudio();
  // Keyed on `open`, not `mounted`: the page unfreezes as the close tween starts rather
  // than after it, and on a navigation the unlock's scroll restore lands before
  // SiteLayout's own route-change scroll-to-top (cleanups run before effects in a commit),
  // so following a link still arrives at the top of the new page rather than at the offset
  // the menu was opened from.
  useScrollLock(open);
  const [mounted, setMounted] = useState(open);
  const [bgUrl, setBgUrl] = useState(null);
  // Whether `bgUrl` should appear without the generate choreography -- see the
  // designAtOpenRef note below.
  const [bgInstant, setBgInstant] = useState(false);
  // One-shot background render ahead of the first open -- see the effect below.
  const [prewarm, setPrewarm] = useState(false);
  const mountedRef = useRef(mounted);
  mountedRef.current = mounted;
  const panelRef = useRef(null);
  // Whether this mount of the panel has begun sliding in. Cleared when the close finishes
  // (the panel unmounts then), so each fresh open slides from fully off-screen, while a
  // reopen caught mid-close reverses from wherever it has got to.
  const slideStartedRef = useRef(false);
  const renderedDesignRef = useRef(null);
  // The design that was already current at the moment the panel opened. Anything matching
  // it was generated somewhere the user could already see (the hero or the footer), so
  // catching up to it here is not a generate and must not be narrated as one -- the panel
  // simply opens with the current artwork already in place. A design that arrives *while*
  // the panel is open is a real generate and still gets the full fade-out/hold/fade-in.
  const designAtOpenRef = useRef(null);

  useEffect(() => {
    if (open) {
      designAtOpenRef.current = currentDesign;
      setMounted(true);
    }
    // `currentDesign` is deliberately not a dependency: this must capture what was current
    // at the open, and keep that value while the panel stays open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Same live-artwork-as-background treatment as SiteFooter -- re-renders the current
  // design from its own seed/colors (not a screenshot) whenever it changes, so the panel
  // reads as part of the same generative-art site instead of a plain settings sheet.
  //
  // Skips re-rendering (and thus the crossfade/DotRipple pulse below) if `currentDesign`
  // is the same one already shown -- `mounted` flips true on every open, and without this
  // check that alone re-triggered a full render + crossfade against an unchanged design
  // every time the nav was reopened (user-reported: the loading pulse played even when
  // nothing was generating).
  // The FIRST open used to have no artwork yet: the render below only started once the panel
  // mounted, so the image (and the dark gradient over it) landed partway through the panel's
  // fade and snapped in at full strength (Aaron, on a phone: the background "pops in" on first
  // open, fine after). Every later open already had it and faded in as one piece. So on a
  // phone-width viewport, render the current design once while idle after load; later opens
  // behave exactly as before (re-rendering only while open). Desktop never shows this panel
  // (sm:hidden) and never pays for it.
  useEffect(() => {
    if (!window.matchMedia?.('(max-width: 639.98px)').matches) return undefined;
    const start = () => setPrewarm(true);
    if (window.requestIdleCallback) {
      const id = window.requestIdleCallback(start, { timeout: 4000 });
      return () => window.cancelIdleCallback(id);
    }
    const id = window.setTimeout(start, 1500);
    return () => window.clearTimeout(id);
  }, []);

  useEffect(() => {
    if (!mounted && !(prewarm && !renderedDesignRef.current)) return;
    if (isSameDesign(renderedDesignRef.current, currentDesign)) return;
    let cancelled = false;
    renderDesignBlob(currentDesign, BG_RENDER_WIDTH, BG_RENDER_HEIGHT)
      .then(blob => {
        if (cancelled) return;
        // Only mark the design "rendered" once the blob actually lands -- marking it
        // eagerly (before this resolves) raced with a same-deps effect replay (confirmed
        // live: React StrictMode's mount-effect-cleanup-effect replay, which reruns this
        // exact effect against an unchanged currentDesign): the replay's cleanup cancelled
        // the in-flight render, but since the ref already matched the design, the replay's
        // own isSameDesign check skipped starting a new one -- no render ever completed
        // and the background silently stopped updating on generate.
        renderedDesignRef.current = currentDesign;
        const url = URL.createObjectURL(blob);
        // A render that landed while the panel was closed (the prewarm) was never watched
        // being generated either, so it takes the same no-choreography path.
        setBgInstant(!mountedRef.current || isSameDesign(designAtOpenRef.current, currentDesign));
        setBgUrl(prev => {
          if (prev) URL.revokeObjectURL(prev);
          return url;
        });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [mounted, prewarm, currentDesign, renderDesignBlob]);

  const { shown, incoming, shownRef, incomingRef, holding } = useCrossfadeImage(bgUrl, {
    instant: bgInstant
  });

  useEffect(() => {
    if (!mounted || !panelRef.current) return;
    const el = panelRef.current;
    if (open) {
      const enter = { xPercent: 0, duration: DURATION_BASE, ease: 'power3.out', overwrite: true };
      if (slideStartedRef.current) {
        gsap.to(el, enter);
      } else {
        slideStartedRef.current = true;
        gsap.fromTo(el, { xPercent: 100, x: 0, visibility: 'visible' }, enter);
      }
    } else {
      // Faster than the open tween -- closing should feel snappy, not a mirror of the
      // entrance.
      gsap.to(el, {
        xPercent: 100,
        duration: DURATION_FAST,
        ease: 'power2.in',
        overwrite: true,
        onComplete: () => {
          slideStartedRef.current = false;
          setMounted(false);
        }
      });
    }
  }, [open, mounted]);

  // Backstop for the prewarm: if the artwork still arrives after the panel has started sliding
  // in (a slow phone, or an open before the idle render ran), fade it in rather than snapping
  // it to full strength. A callback ref runs at attach time, before the panel's own entrance
  // effect -- so when the background mounts together WITH the panel the slide has not started
  // and nothing extra happens; it simply arrives with the panel. The fade is safe against the
  // toolbar strip above: the panel under it stays opaque, and the panel is what Safari samples.
  const bgRef = useCallback(node => {
    if (!node || !slideStartedRef.current) return;
    gsap.from(node, { opacity: 0, duration: DURATION_BASE, ease: 'power1.out' });
  }, []);

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
      // Mounts hidden and off-screen: the entrance tween runs in a useEffect, which usually
      // beats the browser's next paint but not always -- without this, roughly 1-in-8 opens
      // painted one frame of the fully-opaque panel in place before the entrance began (a
      // visible pop, user-reported on device). GSAP's inline transform and visibility
      // override this immediately; React re-renders won't reapply it since the style prop's
      // value never changes.
      style={{ visibility: 'hidden', transform: 'translateX(100%)' }}
    >
      {/* Active artwork as the panel's background, same treatment as SiteFooter -- 75%
          opacity image, crossfaded between designs, dark gradient over it for contrast. */}
      {shown && (
        <div ref={bgRef} className="mobile-nav-bg pointer-events-none absolute inset-0 z-0 opacity-75">
          <img ref={shownRef} src={shown} alt="" className="absolute inset-0 h-full w-full object-cover" />
          {incoming && (
            <img
              ref={incomingRef}
              src={incoming}
              alt=""
              className="absolute inset-0 h-full w-full object-cover"
              style={{ opacity: 0 }}
            />
          )}
          {holding && <DotRipple />}
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
            // Withheld until auth resolves rather than guessed -- see SiteHeader's note and
            // AuthContext's authResolved. Both labels are seven characters, so the row holds
            // its width whichever way it lands.
            label: (
              <span
                className={
                  'transition-opacity duration-200 ' + (authResolved ? 'opacity-100' : 'opacity-0')
                }
              >
                {user ? 'Account' : 'Sign in'}
              </span>
            ),
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
          to generate/save on a small screen without also closing the menu first.

          The entrance animation goes on the MiniGenerator itself, NOT on this padding wrapper:
          a wrapper animating opacity is a backdrop root, which left the widget's glass with an
          empty backdrop to filter for the whole 500ms (unblurred artwork showing straight
          through, then snapping to frosted). See MiniGenerator's own note. */}
      <div className="relative z-10 px-6 pb-10 pt-8">
        <MiniGenerator
          inline
          style={{ animation: 'var(--animate-fade-slide-up)', animationDelay: '0.24s' }}
        />
      </div>
    </div>,
    document.body
  );
}
