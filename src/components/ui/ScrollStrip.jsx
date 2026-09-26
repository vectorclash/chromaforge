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
//
// `dragToScroll` additionally lets a mouse grab the CONTENT and throw it, which the filmstrip
// never needed (its children are photos, and the scrollbar was affordance enough) but a row of
// small chips does -- there, the bar is the only thing on screen that looks grabbable and the
// chips themselves look like buttons that don't move. Opt-in, so the filmstrip is untouched.
//
// `itemSize` ({ max, min }, px) is for a row of EQUAL items, and publishes the width each should
// take as `--strip-item` on the rail. A fixed size can overflow by a SLIVER: 5 filmstrip views
// at 64px need 356px against a 354px rail on a 402px phone, so a scrollbar appeared for 2px of
// travel and the last thumbnail's edge sat under the fade -- a strip that looks mis-sized rather
// than scrollable. With it, a row either fits exactly (items shrink toward `min`) or, when even
// `min` can't fit, the first screenful ends on HALF an item, which reads as "there's more".
// Nothing in between. Chips of varying width (the palette strip) don't use it.
function fitItemSize(rail, { max, min }) {
  const n = rail.children.length;
  if (!n) return null;
  const style = getComputedStyle(rail);
  const gap = parseFloat(style.columnGap) || 0;
  // The fractional box, not clientWidth -- clientWidth rounds, and a rounded-up width is how a
  // row that "fits" ends up a fraction of a pixel over.
  const width =
    rail.getBoundingClientRect().width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
  const floor = px => Math.floor(px * 100) / 100;
  const fit = (width - gap * (n - 1)) / n;
  if (fit >= min) return Math.min(max, floor(fit));
  // k whole items plus half of the next: width = k * (size + gap) + size / 2. The smallest k
  // whose size is <= max gives the largest items that still end on a half.
  const k = Math.ceil((width - max / 2) / (max + gap));
  return Math.max(min, floor((width - k * gap) / (k + 0.5)));
}

export default function ScrollStrip({
  children,
  className = '',
  railClassName = '',
  dragToScroll = false,
  itemSize = null
}) {
  const viewportRef = useRef(null);
  const railRef = useRef(null);
  const trackRef = useRef(null);
  const thumbRef = useRef(null);
  // How far the fade reaches at full strength. Kept in JS because the fade is proportional --
  // it eases out over the last few pixels of travel rather than snapping off at the end.
  const FADE_PX = 28;
  // Primitives, so a caller passing a fresh { max, min } literal each render doesn't rebuild
  // update() and re-subscribe every listener below.
  const sizeMax = itemSize?.max;
  const sizeMin = itemSize?.min;

  const update = useCallback(() => {
    const rail = railRef.current;
    const viewport = viewportRef.current;
    if (!rail || !viewport) return;
    // Sized first: everything below reads the overflow the new size produces.
    if (sizeMax) {
      const size = fitItemSize(rail, { max: sizeMax, min: sizeMin ?? sizeMax });
      if (size !== null) rail.style.setProperty('--strip-item', `${size}px`);
    }
    const max = rail.scrollWidth - rail.clientWidth;
    const overflows = max > 1;
    // Fade only the edge that is hiding something, and only while it hides it: no left fade
    // until you have scrolled away from the start, and the right fade reaches zero exactly as
    // the last item comes fully into view.
    const left = overflows ? Math.min(rail.scrollLeft, FADE_PX) : 0;
    const right = overflows ? Math.min(Math.max(max - rail.scrollLeft, 0), FADE_PX) : 0;
    viewport.style.setProperty('--fade-l', `${left}px`);
    viewport.style.setProperty('--fade-r', `${right}px`);

    // Only advertise the grab cursor while there is somewhere to go -- on a strip that fits,
    // a grab cursor promises movement that can't happen.
    rail.classList.toggle('is-draggable', dragToScroll && overflows);

    const track = trackRef.current;
    const thumb = thumbRef.current;
    if (!track || !thumb) return;
    track.hidden = !overflows;
    if (!overflows) return;
    thumb.style.width = `${(rail.clientWidth / rail.scrollWidth) * 100}%`;
    thumb.style.left = `${(rail.scrollLeft / rail.scrollWidth) * 100}%`;
  }, [dragToScroll, sizeMax, sizeMin]);

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
    // Drag-to-scroll on the content itself. MOUSE ONLY, deliberately: touch already swipes the
    // rail natively, and claiming the gesture there would take the vertical pan with it -- this
    // strip sits inside the settings panel's own scroller, so a thumb dragged up the screen has
    // to keep scrolling that.
    const DRAG_THRESHOLD = 8;
    let dragPointer = null;
    let dragStartX = 0;
    let dragStartScroll = 0;
    let dragging = false;

    const onRailDown = event => {
      if (event.button !== 0 || event.pointerType !== 'mouse') return;
      if (rail.scrollWidth - rail.clientWidth <= 1) return;
      dragPointer = event.pointerId;
      dragStartX = event.clientX;
      dragStartScroll = rail.scrollLeft;
      dragging = false;
    };
    const onRailMove = event => {
      if (dragPointer !== event.pointerId) return;
      const dx = event.clientX - dragStartX;
      // A press only becomes a drag past the threshold, so a plain click on a child still
      // activates it -- the same tap-vs-drag split TshirtPreview uses to keep its shop link.
      if (!dragging) {
        if (Math.abs(dx) < DRAG_THRESHOLD) return;
        dragging = true;
        rail.classList.add('is-dragging');
        rail.style.scrollSnapType = 'none';
        rail.setPointerCapture(event.pointerId);
      }
      rail.scrollLeft = dragStartScroll - dx;
      event.preventDefault();
    };
    const onRailUp = event => {
      if (dragPointer !== event.pointerId) return;
      dragPointer = null;
      if (!dragging) return;
      dragging = false;
      rail.classList.remove('is-dragging');
      rail.style.scrollSnapType = '';
      try {
        rail.releasePointerCapture(event.pointerId);
      } catch {
        /* the pointer can already be gone (cancelled gesture, element re-rendered) */
      }
      // The release still fires a click on whichever child the drag started over, and that
      // child is a button that would apply a palette nobody asked for. Swallowed once in the
      // CAPTURE phase, which is upstream of both the child's own handler and React's
      // root-level bubble dispatch. Cleared on the next task in case no click follows at all
      // (released outside a child, or the pointer left the strip).
      const swallowClick = clickEvent => {
        clickEvent.stopPropagation();
        clickEvent.preventDefault();
      };
      rail.addEventListener('click', swallowClick, { capture: true, once: true });
      setTimeout(() => rail.removeEventListener('click', swallowClick, { capture: true }), 0);
    };

    if (dragToScroll) {
      rail.addEventListener('pointerdown', onRailDown);
      rail.addEventListener('pointermove', onRailMove);
      rail.addEventListener('pointerup', onRailUp);
      rail.addEventListener('pointercancel', onRailUp);
    }

    track?.addEventListener('pointerdown', onDown);
    track?.addEventListener('pointermove', onMove);
    track?.addEventListener('pointerup', onUp);
    track?.addEventListener('pointercancel', onUp);

    return () => {
      rail.removeEventListener('scroll', update);
      observer.disconnect();
      rail.removeEventListener('pointerdown', onRailDown);
      rail.removeEventListener('pointermove', onRailMove);
      rail.removeEventListener('pointerup', onRailUp);
      rail.removeEventListener('pointercancel', onRailUp);
      track?.removeEventListener('pointerdown', onDown);
      track?.removeEventListener('pointermove', onMove);
      track?.removeEventListener('pointerup', onUp);
      track?.removeEventListener('pointercancel', onUp);
    };
  }, [update, dragToScroll]);

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
