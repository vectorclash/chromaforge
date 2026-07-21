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
const HOLD_WINDOW = DURATION_FAST + DURATION_HOLD;
const RIPPLE_CYCLE = HOLD_WINDOW;

const spun = () =>
  tinycolor('#CCFF00')
    .spin(Math.random() * 360)
    .toHexString();

function DotRipple() {
  const mount = useRef(null);

  useEffect(() => {
    const layers = mount.current.querySelectorAll('.dot-ripple');
    // Out to the layer's half-diagonal so the ring fully clears the corners before reset.
    const maxR = Math.hypot(mount.current.offsetWidth, mount.current.offsetHeight) / 2;
    const tweens = [];

    layers.forEach((layer, i) => {
      const recolor = () => {
        layer.style.setProperty('--ripple-c1', spun());
        layer.style.setProperty('--ripple-c2', spun());
      };
      recolor();
      const proxy = { r: 0 };
      tweens.push(
        gsap.to(proxy, {
          r: maxR,
          duration: RIPPLE_CYCLE,
          delay: (i * RIPPLE_CYCLE) / layers.length,
          repeat: -1,
          ease: 'none',
          onUpdate: () => layer.style.setProperty('--ripple-r', proxy.r + 'px'),
          onRepeat: recolor,
        }),
        gsap.fromTo(layer, { opacity: 0 }, { opacity: 1, duration: 0.4 })
      );
    });

    return () => tweens.forEach(t => t.kill());
  }, []);

  return (
    <div className="dot-ripple-mount" aria-hidden ref={mount}>
      <div className="dot-ripple" />
      <div className="dot-ripple" />
    </div>
  );
}

export default DotRipple;
