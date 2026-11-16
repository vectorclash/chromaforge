// How an instant product photo's new print arrives (ProductPhoto; useCrossfadeImage's
// `reveal: 'print'`): it RESOLVES -- comes into focus out of a blur, rising a little, the site's own
// entrance motion -- confined to the fabric by the calibration's mask, so the model, the background
// and the garment's edges never move, only the print. On the product page's main photo the print
// ASSEMBLES out of facets instead (ProductPhoto + FacetSwap's `assemble`, WebGL); every other surface
// uses this, since twenty shop cards cannot each have a WebGL context.
//
// Chosen by Aaron (2026-11-15) from a round of options tried on the real pages: a top-to-bottom
// "print pass" sweep (shipped first, then "I'm not sure that I like it"), press, develop, expose and
// iris; facets on the hero and this everywhere else won. Opacity, filter and transform only, which
// the compositor runs -- the shop can have twenty of these at once.
//
// `wrap` is the `.print-wrap` element (its first child the photo), carrying `--fabric-mask` (set by
// ProductPhoto; `.print-wrap[data-arriving]` in components.css applies it). Calls `done` when
// finished, unless cancelled first: returns a cancel function.
const DURATION_MS = 700;
const EASE = 'cubic-bezier(0.16, 1, 0.3, 1)';

export function printIn(wrap, done) {
  const photo = wrap?.firstElementChild;
  if (!wrap || !photo || typeof wrap.animate !== 'function' || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
    done?.();
    return () => {};
  }
  wrap.setAttribute('data-arriving', '');
  const timing = { duration: DURATION_MS, easing: EASE };
  const a = wrap.animate(
    [
      { opacity: 0, filter: 'blur(14px)' },
      { opacity: 1, filter: 'blur(0px)' }
    ],
    timing
  );
  const b = photo.animate([{ transform: 'translateY(2.5%)' }, { transform: 'translateY(0)' }], timing);
  let cancelled = false;
  a.onfinish = () => {
    if (cancelled) return;
    wrap.removeAttribute('data-arriving');
    done?.();
  };
  return () => {
    cancelled = true;
    a.cancel();
    b.cancel();
    wrap.removeAttribute('data-arriving');
  };
}
