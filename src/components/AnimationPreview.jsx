import React, { useRef, useEffect } from 'react';
import { gsap } from 'gsap';
import './AnimationPreview.scss';

// Visual constants — not timing, so they stay fixed regardless of frame count / duration
const SCALE_END        = 1.45;
const STAR_SCALE_END   = 1.15;
const STAR_MAX_OPACITY = 0.8;

// Default timing — matches getAnimTiming() output for frameCount=6, cycleDuration=21
const DEFAULT_FADE        = 5.0;
const DEFAULT_SPACING     = 3.5;
const DEFAULT_STAR_FADE   = 8.0;
const DEFAULT_STAR_SPACING = 7.0;

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

export default function AnimationPreview({
  frames,
  starFrames = [],
  onClick,
  fade        = DEFAULT_FADE,
  spacing     = DEFAULT_SPACING,
  starFade    = DEFAULT_STAR_FADE,
  starSpacing = DEFAULT_STAR_SPACING,
  paused      = false
}) {
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

    const totalVisible     = 2 * fade;
    const starTotalVisible = 2 * starFade;

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
        gsap.to(img, { opacity: 1, duration: fade, ease: 'power1.inOut' });
      }

      const t1 = gsap.delayedCall(spacing, () => {
        if (killRef.current) return;
        showFrame((i + 1) % imgs.length);
      });

      const t2 = gsap.delayedCall(fade, () => {
        if (killRef.current) return;
        gsap.to(img, { opacity: 0, duration: fade, ease: 'power1.inOut' });
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
          gsap.to(img, { opacity: STAR_MAX_OPACITY, duration: starFade, ease: 'power1.inOut' });
        }

        const t1 = gsap.delayedCall(starSpacing, () => {
          if (killRef.current) return;
          showStar((i + 1) % starImgs.length);
        });

        const t2 = gsap.delayedCall(starFade, () => {
          if (killRef.current) return;
          gsap.to(img, { opacity: 0, duration: starFade, ease: 'power1.inOut' });
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
  }, [frames, starFrames, fade, spacing, starFade, starSpacing]);

  useEffect(() => {
    const imgs     = imgRefs.current.filter(Boolean);
    const starImgs = starRefs.current.filter(Boolean);
    const allImgs  = [...imgs, ...starImgs];

    if (paused) {
      gsap.getTweensOf(allImgs).forEach(t => t.pause());
      timersRef.current.forEach(t => t.pause());
    } else {
      gsap.getTweensOf(allImgs).forEach(t => t.resume());
      timersRef.current.forEach(t => t.resume());
    }
  }, [paused]);

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
