import React, { useRef, useEffect, useLayoutEffect, useState } from 'react';
import { gsap } from 'gsap';
import { DURATION_FAST, DURATION_SLOW } from '../utils/motionTokens';
import { rampTime, rampRush, RAMP_FLOOR_3D } from '../utils/speedRamp';
import { logoState } from '../utils/logoIntro';

// 3D animation preview: mounts a WebGL canvas and drives the deterministic tunnel scene
// (src/animation3d/tunnelScene.js) with a single looping GSAP timeline, mirroring
// AnimationPreview's contract (paused/onClick, atomic pause/play). three.js and the
// scene module are dynamically imported so they stay out of the main bundle until 3D
// mode is actually used.
//
// The timeline tweens a plain proxy time value and setTime(t) does all the work — the
// scene has no internal clock, so pausing, scrubbing, and the exporter's fixed-step
// rendering all agree on what any given t looks like.
//
// ONE renderer lives for the whole mount, and a changed scene is built BEHIND the one on
// screen and swapped in when ready (Aaron, 2026-09-29: changing Duration kept "rerendering and
// sometimes going black"). Before, every Duration click tore down the WebGL renderer, made a
// new one -- recompiling every shader -- rebuilt the scene and faded it in from black, so each
// click blacked the preview out for the length of a rebuild, and a run of clicks queued rebuild
// after rebuild. Now: quick successive changes are debounced into one build, the current scene
// keeps playing while the next one builds, and the loop keeps its place across the swap. Only
// a new DESIGN fades in over the loader; any other change CROSSFADES, both scenes playing, over
// SWAP_FADE (2026-09-30, Aaron: changing Duration still "feels weird changing the animation").
// A straight swap cut the stars and colour fields -- laid out along the loop's length, so a new
// Duration re-lays them -- from one frame to the next. It resumes at the same cycle FRACTION, so
// the ramp's pacing carries straight through; matching the camera's place among the plates
// instead was tried and dropped, since near the loop ends, where the warp crawls, a fraction of a
// plate is a large slice of the cycle and a +/-1s Duration step jumped the pacing by up to half a
// cycle. The speed ramp touches only the timeline, so toggling it does not rebuild the scene.
const REBUILD_DEBOUNCE_MS = 220;
const SWAP_FADE = DURATION_SLOW;

// The outgoing scene keeps playing on its own clock while it fades out over the incoming one.
// It renders into an offscreen target, which is then drawn over the frame at its opacity.
function drawGhost(s, ramp) {
  const { ghost, fader, renderer } = s;
  if (!ghost || !fader || !renderer) return;
  const t = (ghost.p0 * ghost.duration + (gsap.ticker.time - ghost.t0)) % ghost.duration;
  ghost.world.setTime(
    ramp ? rampTime(t, ghost.duration, RAMP_FLOOR_3D) : t,
    ramp ? rampRush(t, ghost.duration) : 0,
    ghost.logo ? logoState(t, ghost.duration, ramp) : null
  );
  renderer.getDrawingBufferSize(fader.size);
  if (fader.target.width !== fader.size.x || fader.target.height !== fader.size.y) {
    fader.target.setSize(fader.size.x, fader.size.y);
  }
  renderer.setRenderTarget(fader.target);
  ghost.world.render(renderer);
  renderer.setRenderTarget(null);
  fader.material.uniforms.uOpacity.value = ghost.opacity.value;
  const autoClear = renderer.autoClear;
  renderer.autoClear = false;
  renderer.render(fader.scene, fader.camera);
  renderer.autoClear = autoClear;
}

function endGhost(s) {
  if (!s.ghost) return;
  s.ghost.tween?.kill();
  s.ghost.world.dispose();
  s.ghost = null;
}

export default function Animation3DPreview({ design, cycleDuration, paused = false, speedRamp = false, logoMark = null, revealAt = 0, onClick, onInitError, onSceneReady }) {
  const containerRef = useRef(null);
  // Everything the effects share, kept off React state so a swap never re-renders mid-frame
  const live = useRef({
    renderer: null,
    world: null,
    worldDuration: 0,
    worldLogo: null,
    worldDesign: null,
    tl: null,
    progress: 0,
    draw: null,
    // The outgoing scene during a crossfade, and what draws it over the incoming one
    ghost: null,
    fader: null
  });
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const speedRampRef = useRef(speedRamp);
  speedRampRef.current = speedRamp;
  const onInitErrorRef = useRef(onInitError);
  onInitErrorRef.current = onInitError;
  const revealAtRef = useRef(revealAt);
  revealAtRef.current = revealAt;
  const onSceneReadyRef = useRef(onSceneReady);
  onSceneReadyRef.current = onSceneReady;
  const [rendererReady, setRendererReady] = useState(false);
  const [ready, setReady] = useState(false);

  // (Re)start the loop on the current world, from a given fraction of the cycle
  function startTimeline(fromProgress) {
    const s = live.current;
    const { world, renderer, worldDuration: duration, worldLogo: mark } = s;
    if (!world || !renderer) return;
    s.tl?.kill();
    const ramp = speedRampRef.current;
    const proxy = { t: 0 };
    const draw = () => {
      // The tween stays linear; the speed ramp is applied as a time WARP into setTime -- the
      // same rampTime the exporter uses, so preview and MP4 match. RAMP_FLOOR_3D must match
      // what exportAnimationVideo passes for 3D. rush drives the FOV/vanishing-point speed
      // enhancement, from the same clock. The logo mark takes the LINEAR clock: logoIntro
      // applies its own warp with its own floor, because 3D's 0.03 floor would leave the mark
      // hanging at its frame-1 pose for seconds of wall time at the seam.
      s.progress = proxy.t / duration;
      world.setTime(
        ramp ? rampTime(proxy.t, duration, RAMP_FLOOR_3D) : proxy.t,
        ramp ? rampRush(proxy.t, duration) : 0,
        mark ? logoState(proxy.t, duration, ramp) : null
      );
      world.render(renderer);
      if (s.ghost) drawGhost(s, ramp);
    };
    s.draw = draw;
    const tl = gsap.timeline({ repeat: -1, paused: pausedRef.current });
    tl.to(proxy, { t: duration, duration, ease: 'none', onUpdate: draw });
    tl.time(Math.min(0.999, Math.max(0, fromProgress)) * duration);
    s.tl = tl;
    // Draw the frame at the resume point now; paused timelines never fire onUpdate. At
    // progress 0 this is the seam frame, which carries the logo mark's full-strength pose.
    proxy.t = tl.time();
    draw();
  }

  // The renderer: once per mount
  useEffect(() => {
    let cancelled = false;
    let resizeTimer = null;
    const s = live.current;

    (async () => {
      try {
        const THREE = await import('three');
        const { WebGLRenderer } = THREE;
        const container = containerRef.current;
        if (cancelled || !container) return;
        // No canvas MSAA: the frame is assembled in render targets and the canvas only ever
        // receives a full-screen copy and the logo plane (whose texture has transparent padding),
        // so multisampling it bought nothing but GPU memory and a resolve per frame.
        const renderer = new WebGLRenderer({ antialias: false });
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        renderer.setSize(container.clientWidth, container.clientHeight);
        renderer.domElement.classList.add('absolute', 'top-0', 'left-0', 'h-full', 'w-full');
        container.appendChild(renderer.domElement);
        s.renderer = renderer;
        // The crossfade's pass: the outgoing scene's frame, drawn over at an opacity. Raw values
        // in, raw values out (no colour-space conversion), like the scene's own copy pass.
        const material = new THREE.ShaderMaterial({
          uniforms: { uFrame: { value: null }, uOpacity: { value: 1 } },
          vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
          fragmentShader:
            'uniform sampler2D uFrame; uniform float uOpacity; varying vec2 vUv; void main() { gl_FragColor = vec4(texture2D(uFrame, vUv).rgb, uOpacity); }',
          transparent: true,
          depthTest: false,
          depthWrite: false
        });
        const target = new THREE.WebGLRenderTarget(1, 1);
        material.uniforms.uFrame.value = target.texture;
        const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
        quad.frustumCulled = false;
        const scene = new THREE.Scene();
        scene.add(quad);
        s.fader = { target, material, quad, scene, camera: new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1), size: new THREE.Vector2() };
        setRendererReady(true);
      } catch (e) {
        // WebGL context creation can genuinely fail (GPU blocklists, headless/remote
        // sessions, exhausted contexts) -- without this, the user gets a black screen and
        // an unhandled rejection. Let the parent fall back to 2D mode instead.
        console.error('[Chromaforge 3D] preview init failed:', e);
        if (!cancelled) onInitErrorRef.current?.(e);
      }
    })();

    const onResize = () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        const container = containerRef.current;
        if (!container || !s.renderer || !s.world) return;
        const w = container.clientWidth;
        const h = container.clientHeight;
        s.renderer.setSize(w, h);
        s.world.setSize(w, h);
        s.world.render(s.renderer);
      }, 150);
    };
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);

    return () => {
      cancelled = true;
      clearTimeout(resizeTimer);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('orientationchange', onResize);
      s.tl?.kill();
      s.tl = null;
      endGhost(s);
      if (s.fader) {
        s.fader.target.dispose();
        s.fader.material.dispose();
        s.fader.quad.geometry.dispose();
        s.fader = null;
      }
      s.world?.dispose();
      s.world = null;
      if (s.renderer) {
        s.renderer.dispose();
        // dispose() alone leaves the WebGL context alive until GC. Measured before this
        // component kept one renderer per mount: 20 Generates left 16 contexts live (Chrome's
        // cap), with Chrome evicting the oldest; forced GC freed none of them.
        s.renderer.forceContextLoss();
        s.renderer.domElement.remove();
        s.renderer = null;
      }
    };
  }, []);

  // The scene: built behind the one on screen, then swapped in. logoMark is a construction
  // input (the plane is added at build time); DisplayCanvas memoizes it, so it is stable.
  useEffect(() => {
    if (!design || !rendererReady) return;
    const s = live.current;
    let cancelled = false;
    let built = null;
    const first = !s.world;

    // A NEW SEED (Generate, a share link) is a new piece: it builds straight away and plays the
    // fade/loader/reveal below. The same seed with an edited palette or geometry slider is the
    // same piece reshaped, so it swaps in place like a Duration change -- debounced, keeping the
    // loop's position, no fade. Compared by seed, not object: every edit makes a new design
    // object, and treating those as new pieces blinked the flight out and restarted its loop
    // on every slider release.
    const newDesign = s.worldDesign?.seed !== design.seed;
    const nextFrame = () => new Promise(r => requestAnimationFrame(() => r()));
    // A Generate (a new design replacing one on screen) plays like a 2D Generate: the current
    // scene fades out over the studio's hexagon loader, the new one is built behind it, and it
    // is revealed no earlier than revealAt -- the end of the loader's cycle -- so the loader
    // always plays through rather than flashing for the ~20ms a build takes. The first scene
    // (entering the Animation tab, turning 3D on) has nothing to fade out but holds the same way.
    const container = containerRef.current;
    const fadeOut = !first && newDesign
      ? new Promise(r => gsap.to(container, { opacity: 0, duration: DURATION_FAST, ease: 'power2.inOut', onComplete: r, onInterrupt: r }))
      : null;
    const timer = setTimeout(async () => {
      try {
        const { createTunnelScene, warmTunnelStars } = await import('../animation3d/tunnelScene');
        if (fadeOut) {
          // Build only once the old scene is hidden, so the build's main-thread time can't hitch
          // the fade, and stop drawing a scene nobody can see
          await fadeOut;
          if (!cancelled) s.tl?.pause();
        } else if (newDesign) {
          await nextFrame();
          await nextFrame();
        }
        // The star layout in slices first, so the build below is a short task, not a ~500ms one
        await warmTunnelStars(cycleDuration);
        if (cancelled || !s.renderer) return;
        built = createTunnelScene({
          seed: design.seed,
          colors: design.colors || [],
          settings: design.settings ?? null,
          duration: cycleDuration,
          width: container.clientWidth,
          height: container.clientHeight,
          logoMark
        });
        // Wait for the star sprites to decode, so the swap never shows a starless frame
        await built.ready;
        if (first || newDesign) {
          // One draw while still hidden compiles the new scene's shaders now, over the loader,
          // instead of as a hitch on the first frame of the fade-in.
          built.setTime(0, 0, null);
          built.render(s.renderer);
          // revealAt is on GSAP's clock, the one the loader animates on: GSAP pauses through a
          // long stall rather than jumping ahead, so a wall-clock wait would let a stall eat into
          // the loader's cycle and cut it off (Aaron saw half a cycle on the first press).
          await new Promise(r => {
            const check = () => {
              if (cancelled || gsap.ticker.time >= revealAtRef.current) {
                gsap.ticker.remove(check);
                r();
              }
            };
            gsap.ticker.add(check);
            check();
          });
        }
        if (cancelled) {
          built.dispose();
          return;
        }
        const old = s.world;
        const resumeAt = newDesign ? 0 : s.progress;
        // The same piece reshaped crossfades while playing; a new design has already faded out,
        // and a paused preview has nothing to fade between, so those swap straight
        endGhost(s);
        if (old && !newDesign && !pausedRef.current && s.fader) {
          const opacity = { value: 1 };
          s.ghost = { world: old, duration: s.worldDuration, logo: s.worldLogo, p0: s.progress, t0: gsap.ticker.time, opacity };
          s.ghost.tween = gsap.to(opacity, { value: 0, duration: SWAP_FADE, ease: 'power2.inOut', onComplete: () => endGhost(s) });
        } else {
          old?.dispose();
        }
        s.world = built;
        s.worldDuration = cycleDuration;
        s.worldLogo = logoMark;
        s.worldDesign = design;
        built = null;
        startTimeline(resumeAt);
        if (first || newDesign) {
          setReady(true);
          gsap.fromTo(container, { opacity: 0 }, { opacity: 1, duration: DURATION_SLOW, ease: 'power2.inOut' });
        }
        onSceneReadyRef.current?.();
      } catch (e) {
        console.error('[Chromaforge 3D] scene build failed:', e);
        built?.dispose();
        built = null;
        onSceneReadyRef.current?.(); // never leave the Generate button stuck
        // ...nor the previous scene faded out behind a loader that has now gone
        if (!cancelled && fadeOut && s.world) {
          if (!pausedRef.current) s.tl?.play();
          gsap.to(container, { opacity: 1, duration: DURATION_SLOW, ease: 'power2.inOut' });
        }
        if (!cancelled && first) onInitErrorRef.current?.(e);
      }
    }, first || newDesign ? 0 : REBUILD_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [design, cycleDuration, logoMark, rendererReady]);

  // The speed ramp only changes how the loop is played, never the scene
  useEffect(() => {
    if (live.current.world) startTimeline(live.current.progress);
  }, [speedRamp]);

  useLayoutEffect(() => {
    if (paused) {
      live.current.tl?.pause();
      // A crossfade cannot finish while nothing draws, so it ends here instead of freezing mid-mix
      if (live.current.ghost) {
        endGhost(live.current);
        live.current.draw?.();
      }
    } else {
      live.current.tl?.play();
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
