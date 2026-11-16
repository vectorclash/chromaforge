// The "print pass": a photo laid down top to bottom with a soft leading edge -- how an instant
// product photo's new print arrives (ProductPhoto, useCrossfadeImage's `reveal: 'sweep'`).
//
// TRANSFORMS ONLY, so the compositor runs it with no repaint (2026-11-15, Aaron: the shop "kind of
// slows down a little bit" with that many cards updating). The first version animated a mask
// gradient's stops through a CSS variable, which repainted a 1000px photo every frame on every card
// sweeping at once. Now the element is a WRAPPER (`.sweep-wrap`) that is 20% taller than the photo,
// with a static fade over that extra 20% at its bottom; it slides down from above while the photo
// inside slides up by exactly as much, so the photo stays put and the wrapper's edge -- feather
// first -- travels down across it. At rest the feather hangs below the card, clipped.
//
// `wrap` is the `.sweep-wrap` element; its first child the photo. Calls `done` when finished, unless
// cancelled first: returns a cancel function.
export const SWEEP_EASE = 'cubic-bezier(0.45, 0, 0.55, 1)'; // ~ power2.inOut

export function sweepIn(wrap, durationMs, done) {
  const photo = wrap?.firstElementChild;
  if (!wrap || !photo || typeof wrap.animate !== 'function') {
    done?.();
    return () => {};
  }
  wrap.setAttribute('data-sweeping', '');
  const timing = { duration: durationMs, easing: SWEEP_EASE };
  const a = wrap.animate([{ transform: 'translateY(-100%)' }, { transform: 'translateY(0)' }], timing);
  // The photo is 1/1.2 of the wrapper's height, so the wrapper's -100% is 120% of the photo.
  const b = photo.animate([{ transform: 'translateY(120%)' }, { transform: 'translateY(0)' }], timing);
  let cancelled = false;
  a.onfinish = () => {
    if (cancelled) return;
    wrap.removeAttribute('data-sweeping');
    done?.();
  };
  return () => {
    cancelled = true;
    a.cancel();
    b.cancel();
    wrap.removeAttribute('data-sweeping');
  };
}
