import React, { useRef, useEffect } from 'react';
import { gsap } from 'gsap';
import './AnimationPreview.scss';

const FADE      = 5.0;   // seconds for each opacity transition (in or out)
const SPACING   = 3.5;   // seconds between frame starts — 6 frames × 3.5s = 21s cycle
const SCALE_END = 1.45;

// Star overlay — STAR_PERIOD = 3 × 7s = 21s, aligns exactly with the main cycle
// so both layers loop seamlessly. Each star is visible for 16s, spanning ~4 background
// transitions, acting as persistent connective tissue between scenes.
const STAR_FADE      = 8.0;
const STAR_SPACING   = 7.0;
const STAR_SCALE_END = 1.15;
const STAR_MAX_OPACITY = 0.6;

const ORIGINS = [
  'center center',
  '55% 45%',
  '45% 55%',
  '52% 48%',
  '48% 52%',
];

const STAR_ORIGINS = [
  'center center',
  '48% 52%',
  '52% 48%',
];

export default function AnimationPreview({ frames, starFrames = [], onClick }) {
  const imgRefs   = useRef([]);
  const starRefs  = useRef([]);
  const killRef   = useRef(false);
  const timersRef = useRef([]);

  useEffect(() => {
    if (!frames || frames.length === 0) return;

    const imgs     = imgRefs.current.filter(Boolean);
    const starImgs = starRefs.current.filter(Boolean);
    if (imgs.length !== frames.length) return;

    killRef.current = false;

    const totalVisible     = 2 * FADE;
    const starTotalVisible = 2 * STAR_FADE;

    // ── Main frames ──────────────────────────────────────────────────────────
    gsap.set(imgs, { opacity: 0, scale: 1, transformOrigin: 'center center' });
    gsap.set(imgs[0], { opacity: 1 });

    function showFrame(i, skipFadeIn = false) {
      if (killRef.current) return;

      const img    = imgs[i];
      const origin = ORIGINS[i % ORIGINS.length];

      gsap.set(img, { scale: 1, transformOrigin: origin });
      gsap.to(img, { scale: SCALE_END, duration: totalVisible, ease: 'none' });

      if (!skipFadeIn) {
        gsap.to(img, { opacity: 1, duration: FADE, ease: 'power1.inOut' });
      }

      const t1 = gsap.delayedCall(SPACING, () => {
        if (killRef.current) return;
        showFrame((i + 1) % imgs.length);
      });

      const t2 = gsap.delayedCall(FADE, () => {
        if (killRef.current) return;
        gsap.to(img, { opacity: 0, duration: FADE, ease: 'power1.inOut' });
      });

      timersRef.current.push(t1, t2);
    }

    showFrame(0, true);

    // ── Star overlay ──────────────────────────────────────────────────────────
    if (starImgs.length > 0) {
      gsap.set(starImgs, { opacity: 0, scale: 1, transformOrigin: 'center center' });
      gsap.set(starImgs[0], { opacity: STAR_MAX_OPACITY });

      function showStar(i, skipFadeIn = false) {
        if (killRef.current) return;

        const img    = starImgs[i];
        const origin = STAR_ORIGINS[i % STAR_ORIGINS.length];

        gsap.set(img, { scale: 1, transformOrigin: origin });
        gsap.to(img, { scale: STAR_SCALE_END, duration: starTotalVisible, ease: 'none' });

        if (!skipFadeIn) {
          gsap.to(img, { opacity: STAR_MAX_OPACITY, duration: STAR_FADE, ease: 'power1.inOut' });
        }

        const t1 = gsap.delayedCall(STAR_SPACING, () => {
          if (killRef.current) return;
          showStar((i + 1) % starImgs.length);
        });

        const t2 = gsap.delayedCall(STAR_FADE, () => {
          if (killRef.current) return;
          gsap.to(img, { opacity: 0, duration: STAR_FADE, ease: 'power1.inOut' });
        });

        timersRef.current.push(t1, t2);
      }

      showStar(0, true);
    }

    return () => {
      killRef.current = true;
      timersRef.current.forEach(t => t.kill());
      timersRef.current = [];
      gsap.killTweensOf([...imgs, ...starImgs]);
    };
  }, [frames, starFrames]);

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
      {starFrames.map((src, i) => (
        <img
          key={`star-${i}`}
          src={src}
          alt=""
          className="animation-star"
          ref={el => (starRefs.current[i] = el)}
        />
      ))}
    </div>
  );
}
