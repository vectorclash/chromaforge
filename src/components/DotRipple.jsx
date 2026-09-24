import React, { useEffect, useRef, useState } from 'react';
import tinycolor from 'tinycolor2';
import { gsap } from 'gsap/all';
import { DURATION_FAST, DURATION_HOLD } from '../utils/motionTokens';

// Colored rings rippling outward through a dot-grid mask (each .dot-ripple layer is a
// dot pattern used as a MASK over an expanding ring gradient -- see components.css). Any
// host that defines the --dot-* custom properties (currently: the compact hero panel,
// MobileNav's background, SiteFooter's background) can mount this. Two layers run half a
// cycle apart so the ripple reads as continuous waves rather than pulse-gap-pulse.
// Started as the hero's own loading indicator (see components.css comments for that
// history) -- now reused wherever a background crossfade needs something live to look at
// during its blank hold instead of a static grid sitting there permanently. Callers
// mount/unmount this on their own loading flag; it doesn't track one itself, and leaves
// no trace once unmounted (no persistent dot grid of its own).
//
// MobileNav/SiteFooter's crossfade hold (useCrossfadeImage) lasts exactly
// DURATION_FAST (fade the old image out) + DURATION_HOLD (blank pause) before the new
// one starts revealing -- tying the cycle to those same tokens, rather than an
// independent guess, is what makes the ripple's timing land inside that window instead
// of the previous fixed 1.6s (which didn't even complete one cycle). Note this is the
// per-LAYER cycle, not the visible pulse rate: with two layers offset half a cycle apart,
// a new ring starts every RIPPLE_CYCLE/2, so the hold window sees exactly two visible
// pulses when RIPPLE_CYCLE itself equals the full window (confirmed live -- setting this
// to HOLD_WINDOW/2 instead read as four pulses, not two, for exactly that reason).
//
// That "exactly two" used to be a coincidence of timing rather than a guarantee, and it
// showed: the layers repeated forever, so a third ring started the instant the window ran
// a hair past RIPPLE_CYCLE, painting a few center dots before the host unmounted. Measured,
// the margin was 8ms (window 1192ms vs cycle 1200ms) -- which is why it appeared "every now
// and then", and most often on mobile, where a single slow frame is enough to cross it.
// Each layer therefore runs ONE ring and stops (no repeat), which makes the count
// structural: two pulses, however long a caller keeps this mounted.
//
// Deliberately unconditional, including for DisplayCanvas's hero loader, whose mount window
// is the only variable one (render time + DURATION_HOLD, rather than a fixed crossfade
// hold). A `loop` option for that case was built and then dropped as unnecessary: the two
// rings are offset half a cycle, so layer 1 is still traveling until 1.8s, well past every
// hero window measured (1.15-1.25s, and barely moved by 6x CPU throttling since the fixed
// hold dominates). Worth knowing if that ever changes: past ~1.8s the grid goes still until
// the artwork lands, so a much slower generate would want its own indicator rather than a
// repeat here -- a repeat would bring the cut-off ring straight back.
//
// It changed (2026-09-23): the hero's FIRST load waits ~1.8s for its artwork, and interactive
// renders now run in steps across frames (render/renderQueue.js), so the single pass ended with
// a third of the wait still to go and the hero sat still (Aaron: "the hero loading animation
// stops a third of the way through"). The answer is `active` -- a continuous mode, not a repeat:
// while `active`, each layer launches a fresh ring (fresh colours) as its last one clears the
// corners; when it goes false no new ring starts and the ones in flight run out to the edge and
// fade as normal. The cut-off the repeat caused came from the HOST unmounting mid-ring, so a
// caller using `active` keeps this mounted and lets the rings finish on their own.
//
// And the one-shot mode is GONE (2026-09-23): SiteFooter and MobileNav were its last users, and
// their hold stopped being fixed the moment Generate became a shared cycle
// (utils/generationCycle.js) -- a surface now holds until every visible render has landed, which
// on a phone is several times the old window, so the menu's ripple ran its two rings and then sat
// still for the rest of the wait (Aaron: "the loading dots stop after two pulses and it takes
// twice that"). Every host now passes `active`, and mounts through useRippleMount so the
// component outlives the hold by exactly as long as its last ring needs.
const HOLD_WINDOW = DURATION_FAST + DURATION_HOLD;
const RIPPLE_CYCLE = HOLD_WINDOW;
// Longest a ring can still be travelling after `active` goes false: one launched on the very
// last frame of the hold runs a full cycle. The pending half-cycle start of the second layer
// re-checks `active` and never fires.
const RIPPLE_TAIL_MS = RIPPLE_CYCLE * 1000 + 100;

// Whether a host should have a DotRipple mounted for a loading flag: from the moment `active`
// goes true until the rings in flight when it goes false have finished. Unmounting AT the flag
// is what used to cut a ring off mid-screen; staying mounted forever would keep two full-size
// masked layers in the tree of a footer or menu that is almost never loading.
export function useRippleMount(active) {
  const [mounted, setMounted] = useState(!!active);
  useEffect(() => {
    if (active) {
      setMounted(true);
      return undefined;
    }
    const id = window.setTimeout(() => setMounted(false), RIPPLE_TAIL_MS);
    return () => window.clearTimeout(id);
  }, [active]);
  return mounted || !!active;
}

const spun = () =>
  tinycolor('#CCFF00')
    .spin(Math.random() * 360)
    .toHexString();

// `introDelay` (ms, or null) holds the ripple back to its beat in the homepage hero's
// entrance -- the ripple sits on the dot grid, so appearing before the grid does is exactly
// the pop that entrance exists to remove. Every other host passes nothing and is unchanged.
// It rides the wrapper, not the layers: those already carry a GSAP opacity fade of their own.
function DotRipple({ introDelay = null, active }) {
  const mount = useRef(null);
  const activeRef = useRef(active);
  activeRef.current = active;
  const startRef = useRef(null);

  useEffect(() => {
    const layers = [...mount.current.querySelectorAll('.dot-ripple')];
    const maxR = Math.hypot(mount.current.offsetWidth, mount.current.offsetHeight) / 2;
    // Where the ring starts dimming, from the host (--ripple-falloff-start, components.css) so the
    // menu's and footer's fainter ripple can dim sooner than the hero's. getPropertyValue returns
    // '' when unset (CSS var() fallbacks don't apply to JS reads), hence the explicit default.
    const falloffStartRaw = getComputedStyle(mount.current).getPropertyValue('--ripple-falloff-start').trim();
    const falloffStart = falloffStartRaw ? parseFloat(falloffStartRaw) : 0.5;
    const running = layers.map(() => null);
    const pending = [];

    const ring = i => {
      const layer = layers[i];
      layer.style.setProperty('--ripple-c1', spun());
      layer.style.setProperty('--ripple-c2', spun());
      const proxy = { r: 0 };
      running[i] = gsap.to(proxy, {
        r: maxR,
        duration: RIPPLE_CYCLE,
        ease: 'none',
        onUpdate: () => {
          layer.style.setProperty('--ripple-r', proxy.r + 'px');
          const t = proxy.r / maxR;
          const intensity = t <= falloffStart ? 1 : Math.max(0, 1 - (t - falloffStart) / (1 - falloffStart));
          layer.style.setProperty('--ripple-intensity', intensity);
        },
        // The next ring only launches if the host still wants it -- this is the whole stop.
        onComplete: () => {
          running[i] = null;
          if (activeRef.current) ring(i);
        }
      });
    };

    // (Re)start: each idle layer launches half a cycle after the previous, so the waves read
    // as continuous. A layer still finishing its last ring just carries on into the next.
    startRef.current = () => {
      layers.forEach((layer, i) => {
        if (running[i]) return;
        gsap.fromTo(layer, { opacity: 0 }, { opacity: 1, duration: 0.4 });
        pending.push(gsap.delayedCall((i * RIPPLE_CYCLE) / layers.length, () => {
          if (activeRef.current && !running[i]) ring(i);
        }));
      });
    };
    if (activeRef.current) startRef.current();

    return () => {
      startRef.current = null;
      running.forEach(t => t?.kill());
      pending.forEach(t => t.kill());
      layers.forEach(layer => gsap.killTweensOf(layer));
    };
  }, []);

  useEffect(() => {
    if (active) startRef.current?.();
  }, [active]);

  return (
    <div
      className={
        'dot-ripple-mount' + (introDelay === null ? '' : ' hero-intro animate-hero-fade-in')
      }
      style={introDelay === null ? undefined : { animationDelay: `${introDelay}ms` }}
      aria-hidden
      ref={mount}
    >
      <div className="dot-ripple" />
      <div className="dot-ripple" />
    </div>
  );
}

export default DotRipple;
