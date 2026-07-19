import React, { useEffect, useRef } from 'react';
import tinycolor from 'tinycolor2';
import { gsap } from 'gsap/all';

// Loading indicator for the compact homepage hero: colored rings ripple outward from the
// panel's center through the ambient dot grid (each .hero-dot-ripple layer is the same
// dot pattern used as a MASK over an expanding ring gradient -- see components.css).
// Replaces HexagonLoader in the hero only: on mobile the stacked shirt+buttons panel sat
// directly on top of the centered hexagon, while the dot grid is the one layer guaranteed
// visible AROUND the panel. Two layers run half a cycle apart so the ripple reads as
// continuous waves rather than pulse-gap-pulse.
const RIPPLE_CYCLE = 1.6;

const spun = () =>
  tinycolor('#CCFF00')
    .spin(Math.random() * 360)
    .toHexString();

function HeroDotRipple() {
  const mount = useRef(null);

  useEffect(() => {
    const layers = mount.current.querySelectorAll('.hero-dot-ripple');
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
    <div className="hero-dot-ripple-mount" aria-hidden ref={mount}>
      <div className="hero-dot-ripple" />
      <div className="hero-dot-ripple" />
    </div>
  );
}

export default HeroDotRipple;
