import React, { useRef, useEffect, useLayoutEffect } from 'react';
import { gsap } from 'gsap';
import { DURATION_SLOW } from '../utils/motionTokens';
import { rampTime } from '../utils/speedRamp';
import { logoState, LOGO_SCREEN_FRACTION } from '../utils/logoIntro';
import { drawLogoMark } from '../render/renderLogoMark';

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
  speedRamp   = false,
  logoMark    = null
}) {
  const containerRef = useRef(null);
  const imgRefs   = useRef([]);
  const starRefs  = useRef([]);
  const tlRef     = useRef(null);
  const tickerRef = useRef(null);
  const killRef   = useRef(false);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const logoCanvasRef = useRef(null);
  // The LINEAR (unwarped) clock. Under speedRamp the timeline's own playhead is already
  // warped by the 2D floor, and the logo needs its own floor (see utils/logoIntro), so the
  // driver below publishes the pre-warp clock here rather than the logo re-deriving it.
  const linearClockRef = useRef(0);

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
          linearClockRef.current = clock;
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

  // The logo mark's own ticker, separate from the speedRamp driver above because it must
  // run in BOTH modes -- that driver only exists when the ramp is on. It never touches the
  // timeline; it only reads a clock and paints its own canvas, so the two can't fight over
  // the playhead.
  useEffect(() => {
    const canvas = logoCanvasRef.current;
    if (!logoMark || !canvas || !frames?.length) return;

    const period = frames.length * spacing;
    const ctx = canvas.getContext('2d');

    // THE LAYER IS THE COST, NOT THE PAINTING (measured 2026-08-13, Aaron: the framerate
    // suffers since the logo landed). A full-viewport canvas sitting over the frame stack is
    // composited every single frame whether or not anything was ever drawn into it, and the
    // mark is absent for most of a cycle (two LOGO_WINDOW-long windows; measured at the
    // default duration with the ramp on, it is on screen 39% of wall time -- the windows are
    // 0.5s of WARPED time each, which stretches near the seam where the ramp is at its floor,
    // so this is far more than the 10% the raw numbers suggest). At devicePixelRatio
    // 2 that empty layer is 2880x1800 and it DOUBLED the preview's median frame time -- 8.4ms
    // to 16.6ms, 71fps to 62fps -- against a build with the toggle off. Forcing the element to
    // display:none while the mark is absent restored 8.5ms / 69fps with the toggle still on,
    // which is what identifies the layer rather than the draw calls as the cost (shrinking it
    // to 1x1 recovered the same, so it is not the clear or the strokes).
    //
    // So the element is only in the layer tree while the mark is actually on screen.
    let shown = true;
    const show = wanted => {
      if (shown === wanted) return;
      shown = wanted;
      canvas.style.display = wanted ? '' : 'none';
    };
    show(false);

    // Measured on the transition into a window rather than every painted frame: reading
    // clientWidth forces a synchronous layout, and it cannot have changed while the element
    // was display:none anyway (it reports 0 there, which is also why this must run AFTER
    // show(true) and not before).
    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.round(canvas.clientWidth * dpr);
      const h = Math.round(canvas.clientHeight * dpr);
      if (w > 0 && h > 0 && (canvas.width !== w || canvas.height !== h)) {
        canvas.width = w;
        canvas.height = h;
      }
    };

    const paint = () => {
      if (killRef.current || pausedRef.current) return;
      // Under the ramp the timeline's playhead is warped by the 2D floor; without it the
      // playhead IS the linear clock. Either way logoIntro applies its own warp from here.
      const linear = speedRamp ? linearClockRef.current : tlRef.current?.time() ?? 0;
      const state = logoState(linear, period, speedRamp);

      // Skip repaints once it has been cleared -- the mark is absent for most of a cycle,
      // and clearing an empty canvas every frame is pure waste.
      if (!state) {
        if (shown) {
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          show(false);
        }
        return;
      }

      if (!shown) {
        show(true);
        resize();
      }

      ctx.clearRect(0, 0, canvas.width, canvas.height);
      drawLogoMark(ctx, logoMark, {
        cx: canvas.width / 2,
        cy: canvas.height / 2,
        size: Math.min(canvas.width, canvas.height) * LOGO_SCREEN_FRACTION * state.scale,
        draw: state.draw,
        alpha: state.alpha
      });
    };

    // Covers a resize that lands mid-window, when the element is already visible and the
    // transition measurement has been and gone. A resize BETWEEN windows needs nothing: the
    // element is display:none, this no-ops on its zero size, and entering the next window
    // re-measures anyway.
    window.addEventListener('resize', resize);
    gsap.ticker.add(paint);
    return () => {
      window.removeEventListener('resize', resize);
      gsap.ticker.remove(paint);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      canvas.style.display = '';
    };
  }, [logoMark, frames, spacing, speedRamp]);

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
      {/* Above the frame stack, and pointer-events-none so the whole preview stays one
          click target (onClick lives on the container). */}
      {logoMark && (
        <canvas
          ref={logoCanvasRef}
          className="animation-logo pointer-events-none absolute top-0 left-0 z-[2] h-full w-full"
        />
      )}
    </div>
  );
}
