import { useCallback, useEffect, useRef, useState } from 'react';

// Makes a horizontally-scrollable strip follow the cursor's position instead of requiring
// an explicit scroll/drag gesture to discover it has more content -- hovering near the
// right edge eases the strip toward its max scroll, the left edge eases it back. Only
// engages on real pointer devices (`hover: hover` + `pointer: fine`); touch devices are
// untouched since native swipe-scrolling there is already the intuitive gesture.
//
// `enabled` lets a caller hold off engaging this until its content has actually settled --
// e.g. ProductPage's artwork strip appends a batch of saved-design thumbnails after an async
// fetch, each fading/sliding in with a stagger (see tailwind.css's fade-slide-up). Without
// gating, a user hovering near an edge at that exact moment gets the auto-scroll animating
// scrollLeft at the same time new items are sliding into the strip -- confirmed live to read
// as genuinely messy, not just a one-off glitch. Passing `enabled={false}` while the caller's
// content is still loading, then flipping it true once settled, avoids that collision. Kept
// as a boolean rather than tracking "loaded" internally since only the caller knows what
// "settled" means for its own content.
//
// Returns a callback ref (not a plain ref object) deliberately: the strip this attaches to
// is often behind a loading/data-fetch gate, so the DOM node doesn't exist on first render.
// Backed by useState (not useRef) so the effect below can react to the node actually
// attaching, and can re-run when `enabled` flips after the node is already mounted.
export function useHoverScroll(enabled = true) {
  const [el, setEl] = useState(null);
  const targetRef = useRef(0);

  const ref = useCallback(node => setEl(node), []);

  useEffect(() => {
    if (!el || !enabled) return undefined;
    if (!window.matchMedia('(hover: hover) and (pointer: fine)').matches) return undefined;

    targetRef.current = el.scrollLeft;

    // The outer 12% of either edge snaps fully to that end -- without this, reaching the
    // true min/max scroll needs the cursor at the exact pixel edge of the strip, which
    // never quite happens in practice, so the last item could never cleanly settle into
    // view. The middle 76% still maps proportionally, just rescaled to fill 0..1. (A wider
    // 18% snap zone + halved speed was tried and reverted -- confirmed live it read as
    // unnatural and made the strip feel like it never fully reached the left edge, since
    // the slower easing just took too long to visually converge.)
    //
    // The right edge targets a small overshoot past the true max (not the full
    // el.scrollWidth) -- scrollWidth minus clientWidth is an unreliable way to compute the
    // true max scrollLeft once the strip has its own padding (a known box-model quirk:
    // trailing padding isn't consistently folded into scrollWidth), and assigning scrollLeft
    // past the real max always clamps to it exactly, so overshooting sidesteps the
    // arithmetic instead of trying to replicate the browser's own clamping logic. The
    // overshoot needs to be small, though: confirmed live that targeting the *entire*
    // el.scrollWidth (effectively the strip's whole visible width past the real max) keeps
    // the eased delta artificially large for the whole final approach, so the speed cap
    // below dominates the entire way in and the strip slams into the physical scroll limit
    // at full speed instead of decelerating into it -- a small overshoot still guarantees
    // landing exactly on the true max, but lets the delta (and therefore the easing) shrink
    // to something small near the end so it actually decelerates.
    const EDGE = 0.12;
    const EDGE_OVERSHOOT = 24;
    const onMouseMove = e => {
      const rect = el.getBoundingClientRect();
      const raw = (e.clientX - rect.left) / rect.width;
      if (raw <= EDGE) {
        targetRef.current = 0;
      } else if (raw >= 1 - EDGE) {
        targetRef.current = el.scrollWidth - el.clientWidth + EDGE_OVERSHOOT;
      } else {
        const ratio = (raw - EDGE) / (1 - 2 * EDGE);
        targetRef.current = ratio * (el.scrollWidth - el.clientWidth);
      }
    };

    // Capped at MAX_STEP px/frame -- without it, re-entering the strip far from where the
    // cursor last left it (rolling off, moving elsewhere, rolling back on) produces a huge
    // delta that DECAY then closes fastest at its very first frame, reading as a sudden
    // lurch toward the cursor rather than a smooth glide. Capping the speed makes a big
    // re-target glide in at a steady rate and only ease near the end, which is what actually
    // looks calm -- DECAY alone (no cap) was confirmed live to feel chaotic exactly when
    // moving between spots, even though it converges smoothly for any single short hop.
    const DECAY = 0.1;
    const MAX_STEP = 16;
    let rafId;
    const tick = () => {
      const delta = targetRef.current - el.scrollLeft;
      if (Math.abs(delta) < 1) {
        el.scrollLeft = targetRef.current;
      } else {
        const step = delta * DECAY;
        el.scrollLeft += Math.sign(step) * Math.min(Math.abs(step), MAX_STEP);
      }
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);

    el.addEventListener('mousemove', onMouseMove);
    return () => {
      el.removeEventListener('mousemove', onMouseMove);
      cancelAnimationFrame(rafId);
    };
  }, [el, enabled]);

  return ref;
}
