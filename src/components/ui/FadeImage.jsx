import React, { useEffect, useState } from 'react';

// Drop-in replacement for a plain <img> wherever the src comes from a network fetch
// (thumbnails, mockups, catalog photos) instead of the JS bundle -- shows a pulsing
// skeleton over the parent's own background until the image decodes, then cross-fades it
// in instead of popping straight from nothing to fully rendered. Needs a `relative`
// ancestor to position against, which every call site already has (the aspect-square
// card wrapper). Resets on `src` change so it replays for slots that swap images in place
// (e.g. ProductPage's hero mockup), not just on first mount.
export default function FadeImage({ src, alt = '', className = '', onLoad, onError, ...props }) {
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    setLoaded(false);
  }, [src]);

  // A same-origin/cached/blob src (e.g. the studio's own canvas-render preview) can fire
  // onLoad before the browser ever paints the opacity-0 frame, so React batches both
  // states into one commit and the fade never visibly plays. Deferring two frames
  // guarantees the unloaded state actually paints first, so the transition always runs.
  const reveal = () => requestAnimationFrame(() => requestAnimationFrame(() => setLoaded(true)));

  return (
    <>
      {!loaded && <div className="absolute inset-0 animate-pulse bg-ink-700" />}
      <img
        src={src}
        alt={alt}
        onLoad={e => {
          reveal();
          onLoad?.(e);
        }}
        onError={e => {
          reveal();
          onError?.(e);
        }}
        className={`${className} transition-opacity duration-500 ${loaded ? 'opacity-100' : 'opacity-0'}`}
        {...props}
      />
    </>
  );
}
