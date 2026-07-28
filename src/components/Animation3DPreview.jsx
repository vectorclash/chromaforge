import React, { useRef, useEffect, useLayoutEffect, useState } from 'react';
import { gsap } from 'gsap';
import { DURATION_SLOW } from '../utils/motionTokens';
import { rampTime, rampRush, RAMP_FLOOR_3D } from '../utils/speedRamp';

// 3D animation preview: mounts a WebGL canvas and drives the deterministic tunnel scene
// (src/animation3d/tunnelScene.js) with a single looping GSAP timeline, mirroring
// AnimationPreview's contract (paused/onClick, atomic pause/play). three.js and the
// scene module are dynamically imported so they stay out of the main bundle until 3D
// mode is actually used.
//
// The timeline tweens a plain proxy time value and setTime(t) does all the work — the
// scene has no internal clock, so pausing, scrubbing, and the exporter's fixed-step
// rendering all agree on what any given t looks like.
export default function Animation3DPreview({ design, cycleDuration, paused = false, speedRamp = false, onClick, onInitError }) {
  const containerRef = useRef(null);
  const tlRef = useRef(null);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!design) return;
    let cancelled = false;
    let renderer = null;
    let world = null;
    let resizeTimer = null;
    setReady(false);

    (async () => {
      try {
      const [{ WebGLRenderer }, { createTunnelScene }] = await Promise.all([
        import('three'),
        import('../animation3d/tunnelScene')
      ]);
      if (cancelled) return;

      const container = containerRef.current;
      const w = container.clientWidth;
      const h = container.clientHeight;

      renderer = new WebGLRenderer({ antialias: true });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      renderer.setSize(w, h);
      renderer.domElement.classList.add('absolute', 'top-0', 'left-0', 'h-full', 'w-full');
      container.appendChild(renderer.domElement);

      world = createTunnelScene({
        seed: design.seed,
        colors: design.colors || [],
        settings: design.settings ?? null,
        duration: cycleDuration,
        width: w,
        height: h
      });

      // Wait for the star sprite textures to decode so the entrance fade-in shows the
      // full scene, not a starless first beat (same async-decode gotcha as the export).
      await world.ready;
      if (cancelled) return;

      const proxy = { t: 0 };
      const tl = gsap.timeline({ repeat: -1, paused: pausedRef.current });
      tl.to(proxy, {
        t: cycleDuration,
        duration: cycleDuration,
        ease: 'none',
        onUpdate: () => {
          // The tween stays linear; the speed ramp is applied as a time WARP into
          // setTime -- the same rampTime the exporter uses, so preview and MP4 match.
          // RAMP_FLOOR_3D must match what exportAnimationVideo passes for 3D, or the
          // preview and the exported file would ramp differently.
          // rush drives the FOV/vanishing-point speed enhancement, from the same clock.
          world.setTime(
            speedRamp ? rampTime(proxy.t, cycleDuration, RAMP_FLOOR_3D) : proxy.t,
            speedRamp ? rampRush(proxy.t, cycleDuration) : 0
          );
          renderer.render(world.scene, world.camera);
        }
      });
      tlRef.current = tl;

      // First frame + fade-in (same entrance treatment as the 2D preview)
      world.setTime(0);
      renderer.render(world.scene, world.camera);
      setReady(true);
      gsap.fromTo(container, { opacity: 0 }, { opacity: 1, duration: DURATION_SLOW, ease: 'power2.inOut' });
      } catch (e) {
        // WebGL context creation can genuinely fail (GPU blocklists, headless/remote
        // sessions, exhausted contexts) -- without this, the user gets a black screen and
        // an unhandled rejection. Let the parent fall back to 2D mode instead.
        console.error('[Chromaforge 3D] preview init failed:', e);
        if (!cancelled) onInitError?.(e);
      }
    })();

    const onResize = () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        const container = containerRef.current;
        if (!container || !renderer || !world) return;
        const w = container.clientWidth;
        const h = container.clientHeight;
        renderer.setSize(w, h);
        world.setSize(w, h);
        renderer.render(world.scene, world.camera);
      }, 150);
    };
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);

    return () => {
      cancelled = true;
      clearTimeout(resizeTimer);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('orientationchange', onResize);
      tlRef.current?.kill();
      tlRef.current = null;
      world?.dispose();
      if (renderer) {
        renderer.dispose();
        renderer.domElement.remove();
      }
    };
  }, [design, cycleDuration, speedRamp]);

  useLayoutEffect(() => {
    if (paused) {
      tlRef.current?.pause();
    } else {
      tlRef.current?.play();
    }
  }, [paused]);

  return (
    <div
      className={
        'animation-preview-3d absolute top-0 left-0 z-[1] h-full w-full cursor-pointer bg-black' +
        (ready ? '' : ' opacity-0')
      }
      ref={containerRef}
      onClick={onClick}
    />
  );
}
