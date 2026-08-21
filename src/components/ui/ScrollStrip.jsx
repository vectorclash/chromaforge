import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';

// A horizontal strip that scrolls, tells you it scrolls, and lets you drag it.
//
// Built for ProductPage's mockup filmstrip, which can hold anywhere from 1 to 8 thumbnails
// depending on the product (the reversible bucket hat returns four views per face). Three
// earlier shapes were tried and rejected, and the reasons are worth keeping:
//
//   - A plain `overflow-x-auto` strip with `.no-scrollbar` (what the filmstrip used to be, and
//     what the artwork picker and shop carousel still use). It hides the scrollbar and with it
//     any hint that more exists, so 8 thumbnails on a 360px phone simply looked cut off.
//   - `flex-wrap`. Nothing is hidden, but the last row ends wherever it ends. 8 wraps to a tidy
//     4+4 at 360px; it is 5 that leaves a lone orphan, and 8 at 390px that breaks a ragged 5+3.
//   - A non-interactive progress bar. Aaron tried to grab it on sight -- and if it looks like a
//     scrollbar, it has to be one, or the affordance is a lie.
//
// So: one row, a fade on whichever edge is actually hiding something, and a draggable scrollbar
// with a hit area far larger than its 4px visual. On touch you could always swipe the contents
// directly; this adds the desktop half, where a mouse drag over images does nothing at all.
//
// Everything is inert when the content fits -- no fade, no bar -- so short strips look exactly
// as they did before.
export default function ScrollStrip({ children, className = '', railClassName = '' }) {
  const viewportRef = useRef(null);
  const railRef = useRef(null);
  const trackRef = useRef(null);
  const thumbRef = useRef(null);
  // How far the fade reaches at full strength. Kept in JS because the fade is proportional --
  // it eases out over the last few pixels of travel rather than snapping off at the end.
  const FADE_PX = 28;

  const update = useCallback(() => {
    const rail = railRef.current;
    const viewport = viewportRef.current;
    if (!rail || !viewport) return;
    const max = rail.scrollWidth - rail.clientWidth;
    const overflows = max > 1;
    // Fade only the edge that is hiding something, and only while it hides it: no left fade
    // until you have scrolled away from the start, and the right fade reaches zero exactly as
    // the last item comes fully into view.
    const left = overflows ? Math.min(rail.scrollLeft, FADE_PX) : 0;
    const right = overflows ? Math.min(Math.max(max - rail.scrollLeft, 0), FADE_PX) : 0;
    viewport.style.setProperty('--fade-l', `${left}px`);
    viewport.style.setProperty('--fade-r', `${right}px`);

    const track = trackRef.current;
    const thumb = thumbRef.current;
    if (!track || !thumb) return;
    track.hidden = !overflows;
    if (!overflows) return;
    thumb.style.width = `${(rail.clientWidth / rail.scrollWidth) * 100}%`;
    thumb.style.left = `${(rail.scrollLeft / rail.scrollWidth) * 100}%`;
  }, []);

  // Geometry has to be re-read whenever the CONTENT changes, not just the box: swapping a
  // product's 8 thumbnails for another's 2 leaves the rail exactly the same size, so a
  // ResizeObserver on it never fires. Running on every render is a handful of layout reads on
  // a component that re-renders rarely, and it is what keeps the bar honest.
  useLayoutEffect(update);

  useEffect(() => {
    const rail = railRef.current;
    const track = trackRef.current;
    if (!rail) return undefined;

    rail.addEventListener('scroll', update, { passive: true });
    const observer = new ResizeObserver(update);
    observer.observe(rail);

    let grabOffset = null;
    const thumbWidth = () => track.clientWidth * (rail.clientWidth / rail.scrollWidth);
    const scrollToPointer = clientX => {
      const box = track.getBoundingClientRect();
      const usable = box.width - thumbWidth();
      if (usable <= 0) return;
      const ratio = (clientX - box.left - grabOffset) / usable;
      rail.scrollLeft = Math.max(0, Math.min(1, ratio)) * (rail.scrollWidth - rail.clientWidth);
    };
    const onDown = event => {
      const box = track.getBoundingClientRect();
      const thumbLeft = (rail.scrollLeft / rail.scrollWidth) * box.width;
      const localX = event.clientX - box.left;
      const onThumb = localX >= thumbLeft && localX <= thumbLeft + thumbWidth();
      // Grabbing the thumb keeps its offset so it doesn't jump under the finger; clicking bare
      // track centres it on the pointer and then drags from there.
      grabOffset = onThumb ? localX - thumbLeft : thumbWidth() / 2;
      // Scroll snapping fights a dragged scrollbar -- it yanks the rail to the nearest item on
      // every pointermove, which feels like the control is resisting you. Suspended for the
      // drag, restored on release.
      rail.style.scrollSnapType = 'none';
      track.setPointerCapture(event.pointerId);
      scrollToPointer(event.clientX);
      event.preventDefault();
    };
    const onMove = event => {
      if (grabOffset !== null) scrollToPointer(event.clientX);
    };
    const onUp = event => {
      if (grabOffset === null) return;
      grabOffset = null;
      rail.style.scrollSnapType = '';
      try {
        track.releasePointerCapture(event.pointerId);
      } catch {
        /* the pointer can already be gone (cancelled gesture, element re-rendered) */
      }
    };
    track?.addEventListener('pointerdown', onDown);
    track?.addEventListener('pointermove', onMove);
    track?.addEventListener('pointerup', onUp);
    track?.addEventListener('pointercancel', onUp);

    return () => {
      rail.removeEventListener('scroll', update);
      observer.disconnect();
      track?.removeEventListener('pointerdown', onDown);
      track?.removeEventListener('pointermove', onMove);
      track?.removeEventListener('pointerup', onUp);
      track?.removeEventListener('pointercancel', onUp);
    };
  }, [update]);

  return (
    <div className={`scroll-strip ${className}`}>
      <div className="scroll-strip-viewport" ref={viewportRef}>
        <div className={`scroll-strip-rail ${railClassName}`} ref={railRef}>
          {children}
        </div>
      </div>
      {/* aria-hidden because it is a redundant POINTER affordance: the strip's own children are
          focusable buttons, and focusing one scrolls it into view natively, so keyboard users
          already have a complete path. Claiming role="scrollbar" would promise arrow-key
          handling this doesn't implement. */}
      <div className="scroll-strip-track" ref={trackRef} aria-hidden="true">
        <div className="scroll-strip-thumb" ref={thumbRef} />
      </div>
    </div>
  );
}
