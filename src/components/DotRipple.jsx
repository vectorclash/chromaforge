import React, { useEffect, useRef } from 'react';
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
// It changed (2026-09-23): the hero's FIRST load waits ~1.8s for its artwork, so the single
// pass ended with a third of the wait still to go and the hero sat still (Aaron: "the hero loading animation
// stops a third of the way through"). The answer is `active` -- a continuous mode, not a repeat:
// while `active`, rings keep launching; when it goes false no new ring starts and the ones in
// flight run out to the edge and fade as normal. The cut-off the repeat caused came from the HOST
// unmounting mid-ring, so a caller using `active` keeps this mounted and lets the rings finish on
// their own. Hosts that pass nothing (SiteFooter, MobileNav: a fixed crossfade hold) keep the
// one-shot behaviour above.
//
// THE CONTINUOUS MODE KEEPS ONE BEAT, and the hero's reveal lands on it (2026-10-01, Aaron: "sometimes
// I see one ring, usually two. I just want all loading states to feel consistent"). Measured before:
// the count drifted with render time (the hero held a flat second AFTER its artwork was ready, so a
// render past ~200ms let a third ring start just before the reveal -- most phone Generates), and the
// first two rings could bunch to 164ms apart and read as ONE: the first launched on the tick after the
// hero's long render task, the second at a fixed time from the start. Now:
//   - Rings launch on a CHAINED beat, RIPPLE_BEAT after the previous launch actually happened, so a
//     stall delays every later ring equally and can never bunch them.
//   - `onBeat(n)` (n = rings launched so far in this loading) is asked before each launch; returning
//     false ends the loading on that beat instead of launching. The hero reveals its artwork there
//     (DisplayCanvas.onHeroRippleBeat), so a Generate is always two evenly spaced rings and then the
//     artwork arriving exactly where a third would have started -- the same phrase the footer and
//     MobileNav play over their fixed two-beat hold. The studio's hexagon loader follows the same rule
//     (reveal no earlier than the loader's own phrase, see loaderShown).
const HOLD_WINDOW = DURATION_FAST + DURATION_HOLD;
const RIPPLE_CYCLE = HOLD_WINDOW;
// Two layers, so a new ring every half cycle
export const RIPPLE_BEAT = RIPPLE_CYCLE / 2;

const spun = () =>
  tinycolor('#CCFF00')
    .spin(Math.random() * 360)
    .toHexString();

// `introDelay` (ms, or null) holds the ripple back to its beat in the homepage hero's
// entrance -- the ripple sits on the dot grid, so appearing before the grid does is exactly
// the pop that entrance exists to remove. Every other host passes nothing and is unchanged.
// It rides the wrapper, not the layers: those already carry a GSAP opacity fade of their own.
function DotRipple({ introDelay = null, active, onBeat = null }) {
  const mount = useRef(null);
  const continuous = active !== undefined;
  const activeRef = useRef(active);
  activeRef.current = active;
  const onBeatRef = useRef(onBeat);
  onBeatRef.current = onBeat;
  const startRef = useRef(null);

  useEffect(() => {
    if (!continuous) return undefined;
    const layers = [...mount.current.querySelectorAll('.dot-ripple')];
    const maxR = Math.hypot(mount.current.offsetWidth, mount.current.offsetHeight) / 2;
    const falloffStartRaw = getComputedStyle(mount.current).getPropertyValue('--ripple-falloff-start').trim();
    const falloffStart = falloffStartRaw ? parseFloat(falloffStartRaw) : 0.5;
    const running = layers.map(() => null);
    const launchedAt = layers.map(() => -Infinity);
    let next = null;
    let count = 0;

    const ring = i => {
      const layer = layers[i];
      running[i]?.kill();
      launchedAt[i] = gsap.ticker.time;
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
        onComplete: () => {
          running[i] = null;
        }
      });
    };

    // One beat: ask the host, then launch on whichever layer is free (or has the oldest ring --
    // only possible when a new loading starts while the last one's rings are still out).
    const beat = () => {
      next = null;
      if (!activeRef.current) return;
      if (onBeatRef.current && onBeatRef.current(count) === false) return;
      let i = running.findIndex(t => !t);
      if (i < 0) i = launchedAt.indexOf(Math.min(...launchedAt));
      // A loading's first ring on each layer fades the layer in, as it always has
      if (count < layers.length && !running[i]) gsap.fromTo(layers[i], { opacity: 0 }, { opacity: 1, duration: 0.4 });
      ring(i);
      count++;
      // Chained from THIS launch, never from the start: see the header
      next = gsap.delayedCall(RIPPLE_BEAT, beat);
    };

    // (Re)start a loading: its own count. The first ring launches on the next TICK, not here: this
    // runs from a React effect, usually right after the hero's long render task, when GSAP's clock
    // has not yet caught up -- a beat scheduled from that stale time fired ~150ms early and
    // squeezed the first two rings together.
    startRef.current = () => {
      count = 0;
      // Re-activated before the last loading's pending beat fired: that beat carries on the cadence
      if (!next) next = gsap.delayedCall(0, beat);
    };
    if (activeRef.current) startRef.current();

    return () => {
      startRef.current = null;
      running.forEach(t => t?.kill());
      next?.kill();
      layers.forEach(layer => gsap.killTweensOf(layer));
    };
  }, [continuous]);

  useEffect(() => {
    if (continuous && active) startRef.current?.();
  }, [continuous, active]);

  useEffect(() => {
    if (continuous) return undefined;
    const layers = mount.current.querySelectorAll('.dot-ripple');
    // Out to the layer's half-diagonal so the ring fully clears the corners before reset.
    const maxR = Math.hypot(mount.current.offsetWidth, mount.current.offsetHeight) / 2;
    // Fraction of that travel where the color intensity starts dimming toward 0 -- reads
    // from the host (--ripple-falloff-start, see components.css) instead of a fixed 0.5 so
    // MobileNav/SiteFooter's narrower, already-faint-under-a-dark-overlay ripple can start
    // dimming sooner/harder than the hero's without a second code path. getPropertyValue
    // returns '' when unset (CSS var() fallbacks don't apply to JS reads), hence the
    // explicit default here.
    const falloffStartRaw = getComputedStyle(mount.current).getPropertyValue('--ripple-falloff-start').trim();
    const falloffStart = falloffStartRaw ? parseFloat(falloffStartRaw) : 0.5;
    const tweens = [];

    layers.forEach((layer, i) => {
      // Each ring is colored once, at mount. This used to also run on every repeat, back
      // when the layers looped -- with one ring per layer there is no repeat to recolor on,
      // and a fresh spin per mount still means consecutive generates never look alike.
      layer.style.setProperty('--ripple-c1', spun());
      layer.style.setProperty('--ripple-c2', spun());
      const proxy = { r: 0 };
      tweens.push(
        gsap.to(proxy, {
          r: maxR,
          duration: RIPPLE_CYCLE,
          delay: (i * RIPPLE_CYCLE) / layers.length,
          // One ring per layer -- see the header: this is what makes "exactly two pulses"
          // structural rather than a coincidence of the mount window's length.
          repeat: 0,
          ease: 'none',
          onUpdate: () => {
            layer.style.setProperty('--ripple-r', proxy.r + 'px');
            // Full color through the first falloffStart fraction of the travel, then
            // linearly dims to nothing by the time the ring reaches the corners -- keeps
            // the pulse from reading as uniformly intense corner-to-corner.
            const t = proxy.r / maxR;
            const intensity = t <= falloffStart ? 1 : Math.max(0, 1 - (t - falloffStart) / (1 - falloffStart));
            layer.style.setProperty('--ripple-intensity', intensity);
          },
        }),
        gsap.fromTo(layer, { opacity: 0 }, { opacity: 1, duration: 0.4 })
      );
    });

    return () => tweens.forEach(t => t.kill());
  }, [continuous]);

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
