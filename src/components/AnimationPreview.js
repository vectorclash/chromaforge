import React, { useRef, useEffect } from 'react';
import { gsap } from 'gsap';
import './AnimationPreview.scss';

const FADE     = 3.0;  // seconds for each opacity transition (in or out)
const SPACING  = 2.0;  // seconds between frame starts — less than FADE so 3 frames overlap
const SCALE_END = 1.45;

// Vary transform origin per frame for a parallax-like feel
const ORIGINS = [
  'center center',
  '55% 45%',
  '45% 55%',
  '52% 48%',
  '48% 52%',
];

export default function AnimationPreview({ frames, onClick }) {
  const imgRefs  = useRef([]);
  const killRef  = useRef(false);
  const timersRef = useRef([]);

  useEffect(() => {
    if (!frames || frames.length === 0) return;

    const imgs = imgRefs.current.filter(Boolean);
    if (imgs.length !== frames.length) return;

    killRef.current = false;

    // Each frame is on screen for 2 * FADE seconds total.
    // A new frame starts every SPACING seconds (< FADE), so 3 frames are always overlapping.
    const totalVisible = 2 * FADE;

    // Frame 0 starts fully opaque — no fade from black
    gsap.set(imgs, { opacity: 0, scale: 1, transformOrigin: 'center center' });
    gsap.set(imgs[0], { opacity: 1 });

    function showFrame(i, skipFadeIn = false) {
      if (killRef.current) return;

      const img    = imgs[i];
      const origin = ORIGINS[i % ORIGINS.length];

      gsap.set(img, { scale: 1, transformOrigin: origin });

      gsap.to(img, {
        scale:    SCALE_END,
        duration: totalVisible,
        ease:     'none',
      });

      if (!skipFadeIn) {
        gsap.to(img, {
          opacity:  1,
          duration: FADE,
          ease:     'power1.inOut',
        });
      }

      // Start the next frame after SPACING seconds — before this frame peaks,
      // so there are always 3 frames visible simultaneously
      const t1 = gsap.delayedCall(SPACING, () => {
        if (killRef.current) return;
        showFrame((i + 1) % imgs.length);
      });

      // Begin fading this frame out at its peak (FADE seconds after it started)
      const t2 = gsap.delayedCall(FADE, () => {
        if (killRef.current) return;
        gsap.to(img, {
          opacity:  0,
          duration: FADE,
          ease:     'power1.inOut',
        });
      });

      timersRef.current.push(t1, t2);
    }

    // Skip fade-in for frame 0 — it starts already fully visible
    showFrame(0, true);

    return () => {
      killRef.current = true;
      timersRef.current.forEach(t => t.kill());
      timersRef.current = [];
      gsap.killTweensOf(imgs);
    };
  }, [frames]);

  return (
    <div className="animation-preview" onClick={onClick}>
      {frames.map((src, i) => (
        <img
          key={i}
          src={src}
          alt=""
          className="animation-frame"
          ref={el => (imgRefs.current[i] = el)}
        />
      ))}
    </div>
  );
}
