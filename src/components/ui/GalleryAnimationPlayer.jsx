// A saved animation, playable in the gallery modal -- on request. The modal always opens on the
// thumbnail; this is the layer a play button mounts over it. The flight is built from its one
// design in a few ms, held behind the hexagon loader until its strokes are fully drawn, as the
// studio does it, then faded in as the loader fades out.
//
// Unmounting (closing the modal, or moving to another design) tears the scene down.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { gsap } from 'gsap';
import Animation3DPreview from '../Animation3DPreview';
import HexagonLoader, { HEXAGON_DRAWN } from '../HexagonLoader';
import { DURATION_SLOW } from '../../utils/motionTokens';
import { flightDesignOf, storedVideo } from '../../lib/savedAnimation';
import { resolveDesignPalette } from '../../render/resolvedPalette';
import { generateLogoMark } from '../../render/generateLogoMark';
import { logoBackdrop3D, darkInkFor } from '../../render/logoInk';

export default function GalleryAnimationPlayer({ data, onError }) {
  const video = useMemo(() => storedVideo(data), [data]);
  const [paused, setPaused] = useState(false);
  const [ready, setReady] = useState(false);
  // The loader leaves by fading out as the animation arrives, not by vanishing (see below)
  const [loaderGone, setLoaderGone] = useState(false);
  const loaderRef = useRef(null);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  const design = useMemo(() => flightDesignOf(data), [data]);
  // The mark flies through the loop seam only if it did when saved; same seed, palette and ink
  // rules as the studio (DisplayCanvas.logoMarkConfig, render/logoInk). Its ink comes from the real
  // seam frame, measured asynchronously; the mark waits for it rather than switching ink mid-play.
  const [ink, setInk] = useState(null);
  useEffect(() => {
    if (!video.logoMark || !design?.seed) return;
    let live = true;
    logoBackdrop3D(design, video.cycleDuration).then(l => live && setInk(darkInkFor(l)));
    return () => {
      live = false;
    };
  }, [video.logoMark, video.cycleDuration, design]);
  const logoMark = useMemo(() => {
    if (!video.logoMark || !design?.seed || ink === null) return null;
    return generateLogoMark(design, { palette: resolveDesignPalette(design), darkInk: ink });
  }, [video.logoMark, design, ink]);
  // With the mark on, wait for its ink before building, so the scene is built once
  const waitingForInk = video.logoMark && ink === null;
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
  useEffect(() => {
    if (!design) onErrorRef.current?.(new Error('Not a playable animation'));
  }, [design]);

  return (
    <div
      className="absolute inset-0 z-[1] cursor-pointer"
      onClick={() => ready && setPaused(p => !p)}
      role="button"
      aria-label={paused ? 'Play' : 'Pause'}
    >
      {design && !waitingForInk && (
        <Animation3DPreview
          design={design}
          cycleDuration={video.cycleDuration}
          paused={paused}
          speedRamp={video.speedRamp}
          logoMark={logoMark}
          revealAt={revealAt}
          onSceneReady={() => setReady(true)}
          onInitError={e => onErrorRef.current?.(e)}
        />
      )}

      {!loaderGone && (
        <div ref={loaderRef} className="pointer-events-none absolute inset-0 z-[2] flex flex-col items-center justify-center gap-3 bg-black/45">
          <HexagonLoader />
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
