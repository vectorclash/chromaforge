import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { gsap } from 'gsap/all';
import { DURATION_FAST, DURATION_SLOW, DURATION_HOLD } from '../utils/motionTokens';

// Reveals a new image the same deliberate way DisplayCanvas's own artwork does: fade the
// current image out, hold on nothing for a beat, then fade the new one in -- matching its
// setImage()/gsap.to(alpha, power2.inOut) fade-out/fade-in pair and DURATION_HOLD pause
// exactly, rather than a quick simultaneous cross-dissolve. Two stacked <img> refs (not
// one tag's src) because swapping a single tag's src can't fade between old/new content --
// it just pops once the new image decodes. `holding` is true for the fade-out + blank hold
// only -- it flips false the instant the fade-in starts, not when it finishes, so a caller
// layering a GenerateGlow over it can time the glow's own fade-out to run alongside (and
// finish exactly with) the artwork's fade-in, instead of the glow outlasting the reveal.
// Shared by every previewUrl-driven surface (MiniGenerator, SiteFooter, MobileNav,
// ProductPage's design tile) so a regenerate reads the same everywhere in the app that
// mirrors the studio/hero's own artwork.
//
// `instant` (opt-in, per-url) skips the whole reveal and just swaps the image in. It
// exists for surfaces that can be *hidden* while a design changes (MobileNav): replaying
// the generate choreography the next time they open would narrate work the user already
// watched happen somewhere else. The caller decides -- the hook can't tell a fresh
// generate from a catch-up.
export function useCrossfadeImage(url, { instant = false } = {}) {
  const [shownSrc, setShownSrc] = useState(null);
  const [incomingSrc, setIncomingSrc] = useState(null);
  const [holding, setHolding] = useState(false);
  const shownRef = useRef(null);
  const incomingRef = useRef(null);
  const queuedUrlRef = useRef(null);
  const busyRef = useRef(false);
  // Bumped whenever an instant swap pre-empts an in-flight reveal. Every async
  // continuation below captures the value it started under and bails if it no longer
  // matches -- killing the element tweens isn't enough on its own, since the reveal also
  // waits on an image decode and a gsap.delayedCall that outlive them.
  const epochRef = useRef(0);

  // A ref (not a plain function) so the queued-reveal continuation below always calls the
  // latest closure without needing to be listed as an effect dependency.
  const revealRef = useRef(null);
  revealRef.current = nextUrl => {
    const epoch = epochRef.current;
    busyRef.current = true;
    setHolding(true);
    gsap.to(shownRef.current, {
      duration: DURATION_FAST,
      opacity: 0,
      ease: 'power2.inOut',
      onComplete: () => {
        if (epoch !== epochRef.current) return;
        // Preload before revealing -- avoids swapping in a still-decoding frame, same
        // reasoning as DisplayCanvas's own setImage.
        const preload = new Image();
        preload.onload = () => {
          if (epoch !== epochRef.current) return;
          gsap.delayedCall(DURATION_HOLD, () => {
            if (epoch !== epochRef.current) return;
            setHolding(false);
            setIncomingSrc(nextUrl);
          });
        };
        preload.src = nextUrl;
      }
    });
  };

  useEffect(() => {
    if (!url || url === shownSrc || url === incomingSrc) return;
    if (!shownSrc) {
      // First-ever appearance (nothing to fade from) -- show it immediately.
      setShownSrc(url);
      return;
    }
    if (instant) {
      // Abandon anything mid-reveal and reset both layers to their resting state, so the
      // swap can't be undone a moment later by a stale tween completing.
      epochRef.current += 1;
      busyRef.current = false;
      queuedUrlRef.current = null;
      gsap.killTweensOf([shownRef.current, incomingRef.current].filter(Boolean));
      if (shownRef.current) gsap.set(shownRef.current, { opacity: 1 });
      setHolding(false);
      setIncomingSrc(null);
      // Still decode first: this layer is visible, so assigning an undecoded src would
      // hold the previous design on screen and then pop.
      const epoch = epochRef.current;
      const preload = new Image();
      const swap = () => {
        if (epoch !== epochRef.current) return;
        setShownSrc(url);
      };
      preload.onload = swap;
      preload.onerror = swap;
      preload.src = url;
      return;
    }
    if (busyRef.current) {
      queuedUrlRef.current = url;
      return;
    }
    revealRef.current(url);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);

  // Layout effect, not a regular one: the incoming layer must be forced to opacity 0
  // before the browser paints its first frame, or it flashes fully visible for one frame
  // ahead of the fade-in tween below.
  useLayoutEffect(() => {
    if (!incomingSrc || !incomingRef.current) return;
    const epoch = epochRef.current;
    gsap.set(incomingRef.current, { opacity: 0 });
    gsap.to(incomingRef.current, {
      duration: DURATION_SLOW,
      opacity: 1,
      ease: 'power2.inOut',
      onComplete: () => {
        if (epoch !== epochRef.current) return;
        gsap.set(shownRef.current, { opacity: 1 });
        setShownSrc(incomingSrc);
        setIncomingSrc(null);
        busyRef.current = false;
        const queued = queuedUrlRef.current;
        queuedUrlRef.current = null;
        if (queued) revealRef.current(queued);
      }
    });
  }, [incomingSrc]);

  return { shown: shownSrc, incoming: incomingSrc, shownRef, incomingRef, holding };
}
