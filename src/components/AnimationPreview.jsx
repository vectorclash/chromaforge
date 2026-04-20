import React, { useRef, useEffect } from 'react';
import { gsap } from 'gsap';
import './AnimationPreview.scss';

const SCALE_END        = 1.45;
const STAR_SCALE_END   = 1.15;
const STAR_MAX_OPACITY = 0.8;

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
  const tlRef     = useRef(null);
  const starTlRef = useRef(null);
  const killRef   = useRef(false);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  useEffect(() => {
    if (!frames || frames.length === 0) return;

    const imgs     = imgRefs.current.filter(Boolean);
    const starImgs = starRefs.current.filter(Boolean);
    if (imgs.length !== frames.length) return;

    killRef.current = false;

    // ── Main frames ──────────────────────────────────────────────────────────
    gsap.set(imgs, { opacity: 0, scale: 1, transformOrigin: 'center center' });
    gsap.set(imgs[0], { opacity: 1 });

    const tl = gsap.timeline({ paused: pausedRef.current });
    tlRef.current = tl;

    let nextTime = 0;

    function showFrame(i, skipFadeIn = false) {
      if (killRef.current) return;
      const img    = imgs[i];
      const origin = ORIGINS[i % ORIGINS.length];
      const t      = nextTime;

      tl.set(img, { scale: 1, transformOrigin: origin }, t);
      tl.to(img, { scale: SCALE_END, duration: 2 * fade, ease: 'none' }, t);
      if (!skipFadeIn) {
        tl.to(img, { opacity: 1, duration: fade, ease: 'power1.inOut' }, t);
      }
      tl.to(img, { opacity: 0, duration: fade, ease: 'power1.inOut' }, t + fade);

      nextTime = t + spacing;
      tl.call(() => showFrame((i + 1) % imgs.length), null, t + spacing);
    }

    showFrame(0, true);

    // ── Star overlay ──────────────────────────────────────────────────────────
    let starTl = null;
    if (starImgs.length > 0) {
      gsap.set(starImgs, { opacity: 0, scale: 1, transformOrigin: 'center center' });
      gsap.set(starImgs[0], { opacity: STAR_MAX_OPACITY });

      starTl = gsap.timeline({ paused: pausedRef.current });
      starTlRef.current = starTl;

      let starNextTime = 0;

      function showStar(i, skipFadeIn = false) {
        if (killRef.current) return;
        const img    = starImgs[i];
        const origin = STAR_ORIGINS[i % STAR_ORIGINS.length];
        const t      = starNextTime;

        starTl.set(img, { scale: 1, transformOrigin: origin }, t);
        starTl.to(img, { scale: STAR_SCALE_END, duration: 2 * starFade, ease: 'none' }, t);
        if (!skipFadeIn) {
          starTl.to(img, { opacity: STAR_MAX_OPACITY, duration: starFade, ease: 'power1.inOut' }, t);
        }
        starTl.to(img, { opacity: 0, duration: starFade, ease: 'power1.inOut' }, t + starFade);

        starNextTime = t + starSpacing;
        starTl.call(() => showStar((i + 1) % starImgs.length), null, t + starSpacing);
      }

      showStar(0, true);
    }

    return () => {
      killRef.current = true;
      tl.kill();
      starTl?.kill();
      tlRef.current = null;
      starTlRef.current = null;
    };
  }, [frames, starFrames, fade, spacing, starFade, starSpacing]);

  useEffect(() => {
    if (paused) {
      tlRef.current?.pause();
      starTlRef.current?.pause();
    } else {
      tlRef.current?.play();
      starTlRef.current?.play();
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
