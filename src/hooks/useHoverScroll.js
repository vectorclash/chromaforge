import { useCallback, useRef } from 'react';

// Makes a horizontally-scrollable strip follow the cursor's position instead of requiring
// an explicit scroll/drag gesture to discover it has more content -- hovering near the
// right edge eases the strip toward its max scroll, the left edge eases it back. Only
// engages on real pointer devices (`hover: hover` + `pointer: fine`); touch devices are
// untouched since native swipe-scrolling there is already the intuitive gesture.
//
// Returns a callback ref (not a plain ref object) deliberately: the strip this attaches to
// is often behind a loading/data-fetch gate, so the DOM node doesn't exist on first render.
// A `useEffect([ref])` would only ever see `ref.current === null` on that first render and
// never re-fire once the real node mounts, since the ref *object's* identity never changes.
// A callback ref is invoked by React exactly when the node attaches/detaches, sidestepping
// that timing gap entirely.
export function useHoverScroll() {
  const targetRef = useRef(0);
  const cleanupRef = useRef(null);

  return useCallback(el => {
    if (cleanupRef.current) {
      cleanupRef.current();
      cleanupRef.current = null;
    }
    if (!el) return;
    if (!window.matchMedia('(hover: hover) and (pointer: fine)').matches) return;

    targetRef.current = el.scrollLeft;

    // The outer 12% of either edge snaps fully to that end -- without this, reaching the
    // true min/max scroll needs the cursor at the exact pixel edge of the strip, which
    // never quite happens in practice, so the last item could never cleanly settle into
    // view. The middle 76% still maps proportionally, just rescaled to fill 0..1.
    //
    // The edges target 0 / el.scrollWidth specifically (not 0 / scrollWidth-clientWidth)
    // -- scrollWidth minus clientWidth is an unreliable way to compute the true max
    // scrollLeft once the strip has its own padding (a known box-model quirk: trailing
    // padding isn't consistently folded into scrollWidth). Assigning scrollLeft past the
    // real max always clamps to it exactly, so deliberately overshooting sidesteps the
    // arithmetic instead of trying to replicate the browser's own clamping logic.
    const EDGE = 0.12;
    const onMouseMove = e => {
      const rect = el.getBoundingClientRect();
      const raw = (e.clientX - rect.left) / rect.width;
      if (raw <= EDGE) {
        targetRef.current = 0;
      } else if (raw >= 1 - EDGE) {
        targetRef.current = el.scrollWidth;
      } else {
        const ratio = (raw - EDGE) / (1 - 2 * EDGE);
        targetRef.current = ratio * (el.scrollWidth - el.clientWidth);
      }
    };

    let rafId;
    const tick = () => {
      const delta = targetRef.current - el.scrollLeft;
      // The lerp only ever approaches its target asymptotically, and the decay rate this
      // used (0.08/frame) was so slow that closing the last few px from a few hundred px
      // away took over a second of continuously-held hovering -- nobody's mouse is that
      // still that long, so in real use it never visibly finished, leaving the edge a few
      // px short permanently. 0.25/frame converges in a few hundred ms; the 1px snap
      // threshold (instead of 0.5) just means it commits to "done" a moment sooner, well
      // under what's perceptible.
      el.scrollLeft = Math.abs(delta) < 1 ? targetRef.current : el.scrollLeft + delta * 0.25;
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);

    el.addEventListener('mousemove', onMouseMove);
    cleanupRef.current = () => {
      el.removeEventListener('mousemove', onMouseMove);
      cancelAnimationFrame(rafId);
    };
  }, []);
}
