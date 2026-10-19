import { useEffect } from 'react';

// Freezes the page behind a full-screen overlay (the modals, MobileNav's takeover).
//
// This became necessary on 2026-08-11, when html/body stopped being `overflow: hidden` so
// that iOS Safari would minimize its toolbar on scroll (see tailwind.css). Before that the
// document could never scroll anywhere, because the studio's own lock had been left applied
// site-wide -- so no overlay here had, or needed, a scroll lock. Scoping that lock back to
// the studio is what made overlay locking a real requirement.
//
// `position: fixed` on the body, not `overflow: hidden`: iOS Safari happily touch-scrolls a
// body that is merely `overflow: hidden`, which is the whole failure mode this exists to
// prevent. Fixing the body is what actually pins it, at the cost of having to save and
// restore the scroll offset by hand -- a fixed body reports scroll position 0, so without
// the restore, closing any modal would dump you at the top of the page.
//
// Reference-counted because overlays legitimately stack (ProductPage can raise a
// ConfirmDialog over the artwork picker); the last one out restores. The count also absorbs
// React StrictMode's deliberate mount/unmount/remount in development, which would otherwise
// unlock a page that is still covered.

// A locked page reports scroll position 0 (see below), which is a lie that any
// scroll-driven effect will act on -- ScrollTrigger reads it as "scrolled back to the top"
// and rewinds every homepage reveal, so closing a modal replayed the whole cascade
// (measured: opacity 1 -> 0.004 while open, easing back over ~600ms after close). Effects
// that must sit out a lock subscribe here rather than trying to detect it themselves.
const listeners = new Set();

export function subscribeScrollLock(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function isScrollLocked() {
  return lockCount > 0;
}

let lockCount = 0;
let savedScrollY = 0;
let keptScrollbar = false;

function lockBody() {
  if (lockCount++ > 0) return;
  // Before the body moves, so nothing sees the intermediate scroll position.
  listeners.forEach(fn => fn(true));
  savedScrollY = window.scrollY;
  // Keep the page the SAME WIDTH while locked. With a classic (non-overlay) scrollbar -- desktop
  // Safari with a mouse attached, Windows -- fixing the body removed the scrollbar, the page got
  // ~15px wider, and everything laid out again at the new width, then again when it came back:
  // and things that size to their box (the About blob asks for a fresh render at its new size)
  // did real work twice, during the menu's own fade. In Safari that read as the menu stalling
  // on the way in and popping on the way out (Aaron, 2026-10-19). Holding the root's scrollbar
  // track in place keeps every width, fixed elements included. Overlay scrollbars take no
  // width, so nothing is done for them.
  const scrollbar = window.innerWidth - document.documentElement.clientWidth;
  keptScrollbar = scrollbar > 0;
  if (keptScrollbar) document.documentElement.style.overflowY = 'scroll';
  const { style } = document.body;
  style.position = 'fixed';
  style.top = `-${savedScrollY}px`;
  style.left = '0';
  style.right = '0';
  style.width = '100%';
}

function unlockBody() {
  lockCount = Math.max(0, lockCount - 1);
  if (lockCount > 0) return;
  const { style } = document.body;
  style.position = '';
  style.top = '';
  style.left = '';
  style.right = '';
  style.width = '';
  if (keptScrollbar) document.documentElement.style.overflowY = '';
  keptScrollbar = false;
  // Instant, not smooth -- this is restoring where the user already was, not a navigation.
  window.scrollTo(0, savedScrollY);
  // After the restore, so a resuming effect reads the real position rather than the 0 the
  // fixed body was still reporting a statement ago.
  listeners.forEach(fn => fn(false));
}

export function useScrollLock(active) {
  useEffect(() => {
    if (!active) return undefined;
    lockBody();
    return unlockBody;
  }, [active]);
}

export default useScrollLock;
