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

let lockCount = 0;
let savedScrollY = 0;

function lockBody() {
  if (lockCount++ > 0) return;
  savedScrollY = window.scrollY;
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
  // Instant, not smooth -- this is restoring where the user already was, not a navigation.
  window.scrollTo(0, savedScrollY);
}

export function useScrollLock(active) {
  useEffect(() => {
    if (!active) return undefined;
    lockBody();
    return unlockBody;
  }, [active]);
}

export default useScrollLock;
