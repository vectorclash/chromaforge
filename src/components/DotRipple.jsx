import React, { useEffect, useRef } from 'react';
import tinycolor from 'tinycolor2';
import { gsap } from 'gsap/all';

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
const RIPPLE_CYCLE = 1.6;

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
