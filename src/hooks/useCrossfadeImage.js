import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { gsap } from 'gsap/all';
import { DURATION_FAST, DURATION_SLOW, DURATION_HOLD } from '../utils/motionTokens';
import { getCycle, subscribeCycle, trackCycleWork } from '../utils/generationCycle';
import { isBehindOverlay } from '../utils/overlayFocus';

function preloadImage(src) {
  return new Promise(resolve => {
    const img = new Image();
    img.onload = resolve;
    img.onerror = resolve;
    img.src = src;
  });
}

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
//
// A GENERATE is different, and does not go through the per-url reveal above at all. It runs a
// shared cycle (utils/generationCycle.js): the moment Generate is clicked anywhere, every surface
// using this hook fades out and holds its loading state together, and all of them fade the new
// design in together once every surface's render has landed. Without that, each surface began its
// loading state only when ITS new image arrived -- a 480px thumbnail almost at once, the footer's
// 3200x1000 band much later -- and one click read as a ripple of surfaces out of step (Aaron:
// "the footer background and footer generator need to be in sync"). During a cycle an arriving url
// is only decoded, never shown; the cycle's reveal shows it.
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

  // The generate cycle this surface is holding for, and the newest url that arrived during it.
  const cycleRef = useRef(null);
  const instantRef = useRef(instant);
  instantRef.current = instant;
  const stateRef = useRef({ shownSrc, incomingSrc });
  stateRef.current = { shownSrc, incomingSrc };

  const enterCycleRef = useRef(null);
  enterCycleRef.current = id => {
    if (cycleRef.current) {
      cycleRef.current.id = id;
      return;
    }
    epochRef.current += 1;
    const { shownSrc: shownNow, incomingSrc: incomingNow } = stateRef.current;
    gsap.killTweensOf([shownRef.current, incomingRef.current].filter(Boolean));
    // A reveal caught mid fade-in: its image becomes the one that fades out.
    if (incomingNow) {
      setShownSrc(incomingNow);
      setIncomingSrc(null);
    }
    cycleRef.current = { id, target: queuedUrlRef.current, ready: null };
    queuedUrlRef.current = null;
    if (cycleRef.current.target) cycleRef.current.ready = preloadImage(cycleRef.current.target);
    busyRef.current = true;
    if (!shownNow && !incomingNow) return; // nothing on screen yet -- nothing to take down
    setHolding(true);
    const layers = [shownRef.current, incomingRef.current].filter(Boolean);
    gsap.to(layers, { duration: DURATION_FAST, opacity: 0, ease: 'power2.inOut' });
  };

  const exitCycleRef = useRef(null);
  exitCycleRef.current = () => {
    const held = cycleRef.current;
    if (!held) return;
    cycleRef.current = null;
    const epoch = ++epochRef.current;
    const { shownSrc: shownNow } = stateRef.current;
    const finish = () => {
      if (epoch !== epochRef.current) return;
      if (held.target && held.target !== shownNow) {
        setHolding(false);
        setIncomingSrc(held.target); // the fade-in below takes it from here
        return;
      }
      // The design this surface shows did not change (or never arrived): bring it back.
      setHolding(false);
      busyRef.current = false;
      if (shownRef.current) gsap.to(shownRef.current, { duration: DURATION_SLOW, opacity: 1, ease: 'power2.inOut' });
    };
    // Normally long since decoded -- it was preloaded the moment it arrived.
    if (held.ready) held.ready.then(finish);
    else finish();
  };

  useEffect(() => {
    const onCycle = c => {
      if (instantRef.current) return;
      if (c && c.phase === 'loading') enterCycleRef.current(c.id);
      else exitCycleRef.current();
    };
    const current = getCycle();
    if (current && current.phase === 'loading') onCycle(current);
    return subscribeCycle(onCycle);
  }, []);

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
        // Take the newest url if one arrived during the fade-out, rather than the one this
        // reveal started on. That older url may well be DEAD by now -- StudioContext revokes
        // the previous object URL when a new preview replaces it -- and revealing it would
        // be one wasted reveal before the queued one runs anyway.
        const target = queuedUrlRef.current || nextUrl;
        queuedUrlRef.current = null;
        // Preload before revealing -- avoids swapping in a still-decoding frame, same
        // reasoning as DisplayCanvas's own setImage.
        const preload = new Image();
        // onerror runs the SAME continuation, and that is the whole point: this is the only
        // exit from `holding`, so a url that never loads used to leave it true FOREVER --
        // permanently spinning MiniGenerator's refresh icon, holding its Generate button
        // dimmed and disabled, and leaving the thumbnail faded out with the glow up. A
        // revoked blob url is exactly that case, and nothing else in the chain could
        // recover it. Better to reveal a broken layer for one beat (the next generate
        // replaces it) than to strand the widget.
        const proceed = () => {
          if (epoch !== epochRef.current) return;
          gsap.delayedCall(DURATION_HOLD, () => {
            if (epoch !== epochRef.current) return;
            setHolding(false);
            setIncomingSrc(target);
          });
        };
        preload.onload = proceed;
        preload.onerror = proceed;
        preload.src = target;
      }
    });
  };

  useEffect(() => {
    if (!url || url === shownSrc || url === incomingSrc) return;
    if (cycleRef.current && shownSrc) {
      // Held for the cycle's shared reveal; decode it now so the reveal is instant.
      cycleRef.current.target = url;
      // A surface hidden behind a full-screen overlay does not hold the reveal (overlayFocus.js).
      cycleRef.current.ready = trackCycleWork(preloadImage(url), {
        foreground: !isBehindOverlay(shownRef.current)
      });
      return;
    }
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
