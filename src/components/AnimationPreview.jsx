import React, { useRef, useEffect, useLayoutEffect } from 'react';
import { gsap } from 'gsap';
import { DURATION_SLOW } from '../utils/motionTokens';
import { rampTime } from '../utils/speedRamp';

const SCALE_END        = 1.45;
const STAR_SCALE_END   = 1.15;
const STAR_MAX_OPACITY = 0.8;

const DEFAULT_FADE        = 5.0;
const DEFAULT_SPACING     = 3.5;
const DEFAULT_STAR_FADE   = 8.0;
const DEFAULT_STAR_SPACING = 7.0;

// The zoom-in scale during each frame's fade must be anchored dead-center -- the
// generator centers coherent geometry exactly on the image's own center (confirmed via
// direct bounding-box measurement in GenerateGeometricShape), so any transform-origin
// off of 'center center' makes that geometry visibly drift away from true center as the
// frame scales up to SCALE_END. A per-frame offset origin used to be varied here for
// subtle handheld-camera-style variety, but that drift read as a bug (geometric elements
// off-center), not a feature -- every frame now anchors on the true center, always.
const CENTER_ORIGIN = 'center center';

export default function AnimationPreview({
  frames,
  starFrames = [],
  onClick,
  fade        = DEFAULT_FADE,
  spacing     = DEFAULT_SPACING,
  starFade    = DEFAULT_STAR_FADE,
  starSpacing = DEFAULT_STAR_SPACING,
  paused      = false,
  speedRamp   = false
}) {
  const containerRef = useRef(null);
  const imgRefs   = useRef([]);
  const starRefs  = useRef([]);
  const tlRef     = useRef(null);
  const tickerRef = useRef(null);
  const killRef   = useRef(false);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  useEffect(() => {
    if (!frames || frames.length === 0) return;

    const imgs     = imgRefs.current.filter(Boolean);
    const starImgs = starRefs.current.filter(Boolean);
    if (imgs.length !== frames.length) return;

    killRef.current = false;
    let cancelled = false;

    const startAnimation = () => {
      if (cancelled || killRef.current) return;

      gsap.fromTo(containerRef.current, { opacity: 0 }, { opacity: 1, duration: DURATION_SLOW, ease: 'power2.inOut' });

      gsap.set(imgs, { opacity: 0, scale: 1, transformOrigin: 'center center' });
      gsap.set(imgs[0], { opacity: 1 });

      // Single timeline for both layers so pause/play is always atomic —
      // two separate timelines record different resume timestamps and can
      // briefly diverge on the first rAF tick after play() is called.
      // With speedRamp on, the timeline never self-plays: a gsap.ticker driver
      // below scrubs tl.time() through the same rampTime warp the exporter uses,
      // so the eased preview and the eased MP4 stay motion-identical.
      const tl = gsap.timeline({ paused: speedRamp || pausedRef.current });
      tlRef.current = tl;

      // ── Main frames ──────────────────────────────────────────────────────────
      let nextTime = 0;

      function showFrame(i, skipFadeIn = false) {
        if (killRef.current) return;
        const img = imgs[i];
        const t   = nextTime;

        tl.set(img, { scale: 1, transformOrigin: CENTER_ORIGIN }, t);
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
      if (starImgs.length > 0) {
        gsap.set(starImgs, { opacity: 0, scale: 1, transformOrigin: 'center center' });
        gsap.set(starImgs[0], { opacity: STAR_MAX_OPACITY });

        let starNextTime = 0;

        function showStar(i, skipFadeIn = false) {
          if (killRef.current) return;
          const img = starImgs[i];
          const t   = starNextTime;

          tl.set(img, { scale: 1, transformOrigin: CENTER_ORIGIN }, t);
          tl.to(img, { scale: STAR_SCALE_END, duration: 2 * starFade, ease: 'none' }, t);
          if (!skipFadeIn) {
            tl.to(img, { opacity: STAR_MAX_OPACITY, duration: starFade, ease: 'power1.inOut' }, t);
          }
          tl.to(img, { opacity: 0, duration: starFade, ease: 'power1.inOut' }, t + starFade);

          starNextTime = t + starSpacing;
          tl.call(() => showStar((i + 1) % starImgs.length), null, t + starSpacing);
        }

        showStar(0, true);
      }

      if (speedRamp) {
        // Ticker driver: accumulate linear wall-clock time while playing, then set
        // the timeline's playhead to its warped position. rampTime is monotonic and
        // continuous across cycles, so tl only ever moves forward and the lazily
        // self-appending tl.call frames still fire in order. The cycle period is the
        // full loop length (frames * spacing == starFrames * starSpacing), matching
        // the exporter's PERIOD.
        const period = frames.length * spacing;
        let clock = 0;
        const tick = (time, deltaTime) => {
          if (killRef.current || pausedRef.current) return;
          clock += deltaTime / 1000;
          const target = rampTime(clock, period);
          // Walk to the target in <=spacing hops instead of one jump. GSAP clamps
          // tl.time() to the timeline's CURRENT duration, and this timeline only
          // grows when the tl.call() one `spacing` ahead fires and appends the next
          // frame -- so a single hop longer than `spacing` gets capped, and the
          // preview silently falls behind the export it is supposed to match
          // (measured: it caps at one frame per tick until it catches up). At the
          // ramp's ~3.2x peak that needs only a ~38fps device on the densest
          // frames/duration the UI allows, so it is reachable, not theoretical.
          // Each hop fires the pending call and extends the timeline before the
          // next one. `spacing` is the smaller of the two chains' steps
          // (starSpacing >= spacing always, since starFrames <= frames), so
          // bounding by it covers the star overlay's calls too.
          let t = tl.time();
          while (target - t > spacing) {
            t += spacing;
            tl.time(t, false);
          }
          tl.time(target, false);
        };
        tickerRef.current = tick;
        gsap.ticker.add(tick);
      }
    };

    // Wait for all image bitmaps to be decoded before starting the animation.
    // Blob URL images decode asynchronously — if GSAP makes a frame visible before
    // its bitmap is ready, the browser paints black. With 40+ frames the decode
    // queue is larger and this race becomes reliably reproducible.
    Promise.all([
      ...imgs.map(el => el.decode().catch(() => {})),
      ...starImgs.map(el => el.decode().catch(() => {})),
    ]).then(startAnimation);

    return () => {
      cancelled = true;
      killRef.current = true;
      if (tickerRef.current) {
        gsap.ticker.remove(tickerRef.current);
        tickerRef.current = null;
      }
      tlRef.current?.kill();
      tlRef.current = null;
    };
  }, [frames, starFrames, fade, spacing, starFade, starSpacing, speedRamp]);

  useLayoutEffect(() => {
    // With speedRamp on, the ticker driver owns the playhead (the timeline itself
    // stays paused) -- pausing is just the driver skipping ticks, so never play() it.
    if (tickerRef.current) return;
    if (paused) {
      tlRef.current?.pause();
    } else {
      tlRef.current?.play();
    }
  }, [paused]);

  return (
    <div
      className="animation-preview absolute top-0 left-0 z-[1] h-full w-full cursor-pointer bg-black"
      ref={containerRef}
      onClick={onClick}
    >
      {frames.map((src, i) => (
        <img
          key={i}
          src={src}
          alt=""
          className="animation-frame absolute top-0 left-0 h-full w-full object-cover opacity-0"
          ref={el => (imgRefs.current[i] = el)}
        />
      ))}
      {starFrames.map((src, i) => (
        <img
          key={`star-${i}`}
          src={src}
          alt=""
          className="animation-star absolute top-0 left-0 h-full w-full object-cover opacity-0"
          ref={el => (starRefs.current[i] = el)}
        />
      ))}
    </div>
  );
}
