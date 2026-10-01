// A saved animation, playable in the gallery modal -- on request. The modal always opens on the
// thumbnail; this is the layer a play button mounts over it, for either kind (lib/savedAnimation):
//
//   3D: the flight is built from its one design in a few ms, held behind the hexagon loader until
//       its strokes are fully drawn, as the studio does it, then faded in as the loader fades out.
//   2D: every frame is rebuilt from its seed (seconds, and ~20-30 decoded images of memory), which
//       is why nothing plays until someone asks. Frames are square here -- the modal is -- and
//       generated at DISPLAY_RENDER_CAP; phones keep the studio's smaller raster copies.
//
// Unmounting (closing the modal, or moving to another design) cancels a build in progress and
// releases every frame made.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { gsap } from 'gsap';
import AnimationPreview from '../AnimationPreview';
import Animation3DPreview from '../Animation3DPreview';
import HexagonLoader, { HEXAGON_DRAWN } from '../HexagonLoader';
import { DURATION_SLOW } from '../../utils/motionTokens';
import { is3DAnimation, storedVideo } from '../../lib/savedAnimation';
import { generateArtwork } from '../../render/generateArtwork';
import renderArtwork from '../../render/renderArtwork';
import { renderFrames, renderStarFrames, animTiming, AnimationBuildCancelled } from '../../render/animationFrames';
import { DISPLAY_RENDER_CAP } from '../../render/scale';
import { resolveDesignPalette } from '../../render/resolvedPalette';
import { generateLogoMark } from '../../render/generateLogoMark';
import { logoBackdrop2D, logoBackdrop3D, darkInkFor } from '../../render/logoInk';
import { isMobileDevice } from '../../utils/device';

// Frames are generated at DISPLAY_RENDER_CAP (so a frame's fine stars resolve cleanly, see
// scale.js) and, on a phone, stored at the studio's mobile raster -- 30 decoded 2000px frames is
// ~480MB, which is what gets a phone tab killed (see DisplayCanvas's ANIM_LIMITS note).
const FRAME_SIZE = DISPLAY_RENDER_CAP;
const MOBILE_RASTER = 1440;

function rasterize(canvas) {
  if (!isMobileDevice() || canvas.width <= MOBILE_RASTER) return canvas;
  const small = document.createElement('canvas');
  small.width = MOBILE_RASTER;
  small.height = Math.round((canvas.height * MOBILE_RASTER) / canvas.width);
  const ctx = small.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(canvas, 0, 0, small.width, small.height);
  return small;
}

export default function GalleryAnimationPlayer({ data, onError }) {
  const threeD = is3DAnimation(data);
  const video = useMemo(() => storedVideo(data), [data]);
  const [paused, setPaused] = useState(false);
  const [ready, setReady] = useState(false);
  // The loader leaves by fading out as the animation arrives, not by vanishing (see below)
  const [loaderGone, setLoaderGone] = useState(false);
  const loaderRef = useRef(null);
  const [progress, setProgress] = useState(0);
  const [built, setBuilt] = useState(null); // 2D: { frames, starFrames, timing }
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  const design3D = useMemo(
    () => (threeD ? { seed: data.design.seed, colors: data.design.colors || [], settings: data.design.settings ?? null } : null),
    [threeD, data]
  );
  // The mark flies through the loop seam only if it did when saved; same seed, palette and ink
  // rules as the studio (DisplayCanvas.logoMarkConfig, render/logoInk). 3D's ink comes from its real
  // seam frame, measured asynchronously; the mark waits for it rather than switching ink mid-play.
  const logoSource = threeD ? design3D : data.frames?.[0];
  const [ink3D, setInk3D] = useState(null);
  useEffect(() => {
    if (!video.logoMark || !threeD || !logoSource?.seed) return;
    let live = true;
    logoBackdrop3D(logoSource, video.cycleDuration).then(l => live && setInk3D(darkInkFor(l)));
    return () => {
      live = false;
    };
  }, [video.logoMark, video.cycleDuration, threeD, logoSource]);
  const logoMark = useMemo(() => {
    if (!video.logoMark || !logoSource?.seed) return null;
    const darkInk = threeD ? ink3D : darkInkFor(logoBackdrop2D(logoSource, FRAME_SIZE, FRAME_SIZE));
    if (darkInk === null) return null;
    return generateLogoMark(logoSource, { palette: resolveDesignPalette(logoSource), darkInk });
  }, [video.logoMark, threeD, logoSource, ink3D]);
  // 3D with the mark on waits for its ink before building, so the scene is built once
  const waitingForInk = threeD && video.logoMark && ink3D === null;
  // The studio's handoff (DisplayCanvas.loaderShown): never revealed before the loader's strokes
  // are fully drawn, on GSAP's clock. This loader sits ON TOP of the animation (it dims the
  // thumbnail too), so where the studio's artwork covers its loader, this one fades out over the
  // arriving animation instead -- the same beat, from the other side.
  const [revealAt] = useState(() => gsap.ticker.time + HEXAGON_DRAWN);
  useEffect(() => {
    if (!ready || !loaderRef.current) return undefined;
    const tween = gsap.to(loaderRef.current, { opacity: 0, duration: DURATION_SLOW, ease: 'power2.inOut', onComplete: () => setLoaderGone(true) });
    return () => tween.kill();
  }, [ready]);

  // 2D: rebuild every frame from its seed
  useEffect(() => {
    if (threeD) return;
    let cancelled = false;
    let made = null;
    const isCancelled = () => cancelled;
    (async () => {
      try {
        const configs = data.frames.map(f => generateArtwork(f.seed, FRAME_SIZE, FRAME_SIZE, f.colors || [], f.settings ?? null));
        const starCount = Math.min(Math.max(1, Math.floor(configs.length / 2)), video.starFrameCount ?? Math.ceil(configs.length / 2));
        const frames = await renderFrames(configs.length, i => renderArtwork(configs[i]), {
          rasterize,
          isCancelled,
          onFrame: n => !cancelled && setProgress(n)
        });
        made = frames;
        const palette = configs[0].gradientBackgroundConfig.colors.slice();
        const starFrames = await renderStarFrames(starCount, FRAME_SIZE, FRAME_SIZE, palette, { rasterize, isCancelled });
        made = [...frames, ...starFrames];
        const wait = revealAt - gsap.ticker.time;
        if (wait > 0) await new Promise(r => gsap.delayedCall(wait, r));
        if (cancelled) return;
        setBuilt({ frames, starFrames, timing: animTiming(configs.length, video.cycleDuration, starCount) });
        setReady(true);
      } catch (e) {
        if (e instanceof AnimationBuildCancelled || cancelled) return;
        console.warn('[gallery] animation build failed:', e);
        onErrorRef.current?.(e);
      }
    })();
    return () => {
      cancelled = true;
      made?.forEach(url => URL.revokeObjectURL(url));
    };
    // revealAt is fixed at mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threeD, data, video]);

  const total = threeD ? 0 : data.frames.length;
  const frameCount = total;

  return (
    <div
      className="absolute inset-0 z-[1] cursor-pointer"
      onClick={() => ready && setPaused(p => !p)}
      role="button"
      aria-label={paused ? 'Play' : 'Pause'}
    >
      {threeD ? (
        !waitingForInk && <Animation3DPreview
          design={design3D}
          cycleDuration={video.cycleDuration}
          paused={paused}
          speedRamp={video.speedRamp}
          logoMark={logoMark}
          revealAt={revealAt}
          onSceneReady={() => setReady(true)}
          onInitError={e => onErrorRef.current?.(e)}
        />
      ) : (
        built && (
          <AnimationPreview
            frames={built.frames}
            starFrames={built.starFrames}
            fade={built.timing.fade}
            spacing={built.timing.spacing}
            starFade={built.timing.starFade}
            starSpacing={built.timing.starSpacing}
            paused={paused}
            speedRamp={video.speedRamp}
            logoMark={logoMark}
          />
        )
      )}

      {!loaderGone && (
        <div ref={loaderRef} className="pointer-events-none absolute inset-0 z-[2] flex flex-col items-center justify-center gap-3 bg-black/45">
          <HexagonLoader />
          {!threeD && (
            <span className="font-quicksand text-xs font-semibold tracking-wide text-white/80 tabular-nums">
              Building frame {Math.min(frameCount, progress + 1)} of {frameCount}
            </span>
          )}
        </div>
      )}

      {ready && paused && (
        <div className="pointer-events-none absolute inset-0 z-[2] flex items-center justify-center">
          <PlayGlyph />
        </div>
      )}
    </div>
  );
}

export function PlayGlyph({ size = 64 }) {
  return (
    <span
      className="flex items-center justify-center rounded-full border border-white/20 bg-black/55 backdrop-blur-sm"
      style={{ width: size, height: size }}
    >
      <svg viewBox="0 0 24 24" width={size * 0.4} height={size * 0.4} fill="white" aria-hidden="true">
        <path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.4-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z" />
      </svg>
    </span>
  );
}
