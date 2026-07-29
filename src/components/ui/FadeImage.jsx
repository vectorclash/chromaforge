import React, { useEffect, useState } from 'react';

// Drop-in replacement for a plain <img> wherever the src comes from a network fetch
// (thumbnails, mockups, catalog photos) instead of the JS bundle -- shows a pulsing
// skeleton over the parent's own background until the image decodes, then cross-fades it
// in instead of popping straight from nothing to fully rendered. Needs a `relative`
// ancestor to position against, which every call site already has (the aspect-square
// card wrapper). Resets on `src` change so it replays for slots that swap images in place
// (e.g. ProductPage's hero mockup), not just on first mount.
//
// ...EXCEPT when the browser already has the image decoded, which is the fix for a real bug
// Aaron caught live (2026-07-29): flipping a print option back to a combination already
// generated restores the mockup instantly from useMockup's cache, but the hero still blanked
// to a pulsing skeleton and faded back in, reading as an unexplained dim on what should be an
// instant swap. The skeleton exists to cover real network latency, and there is none to cover
// here -- it was invented delay on a deliberate user action.
// `probe.complete` is true SYNCHRONOUSLY for an image already in the HTTP/memory cache, so
// this resolves before a blank frame can paint. Deliberately does NOT remove reveal()'s
// two-frame defer below: that still makes a genuinely-new image fade rather than pop, and it
// now only runs when the image really did have to be fetched.
function isAlreadyDecoded(src) {
  if (!src || typeof window === 'undefined') return false;
  const probe = new window.Image();
  probe.src = src;
  return probe.complete && probe.naturalWidth > 0;
}

export default function FadeImage({ src, alt = '', className = '', onLoad, onError, ...props }) {
  // Same check for the initial value, so a cached image is never blank even on first mount.
  const [loaded, setLoaded] = useState(() => isAlreadyDecoded(src));

  useEffect(() => {
    setLoaded(isAlreadyDecoded(src));
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
