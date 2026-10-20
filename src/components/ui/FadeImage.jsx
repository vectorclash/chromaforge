import React, { useEffect, useRef, useState } from 'react';

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

// How many times a thumbnail is re-requested before its card gives up on it. Supabase Storage
// answers a burst of requests with 429 Too Many Requests (seen in its edge logs, 2026-10-19), and
// the cards treat any error as "no thumbnail" and hide the image -- a black square until a reload.
// A refused request is worth asking again shortly; a genuinely missing thumbnail (a design saved
// before thumbnails existed) just costs a few extra 404s before it hides.
export const THUMBNAIL_RETRIES = 3;
const RETRY_DELAYS_MS = [1500, 4000, 9000];

export default function FadeImage({ src, alt = '', className = '', onLoad, onError, retries = 0, ...props }) {
  // Which retry is showing. A retry re-requests with a query string, so neither the browser nor a
  // cache can hand back the refused response; the image is the same object either way.
  const [attempt, setAttempt] = useState(0);
  useEffect(() => setAttempt(0), [src]);
  const shownSrc = attempt && src ? `${src}${src.includes('?') ? '&' : '?'}retry=${attempt}` : src;
  const retryTimer = useRef(null);
  useEffect(() => () => clearTimeout(retryTimer.current), []);
  // Same check for the initial value, so a cached image is never blank even on first mount.
  const [loaded, setLoaded] = useState(() => isAlreadyDecoded(src));
  // Whether this image actually had to be fetched, i.e. whether there was a blank state for
  // the reveal to play out of. An image that was already decoded appears at full opacity with
  // no animation at all -- same instant-swap rule as the skeleton above, and the reason the
  // reveal is keyed on this rather than on `loaded`, which is true immediately for a cached
  // image and would animate a swap that should be instant.
  const [revealing, setRevealing] = useState(false);

  useEffect(() => {
    setLoaded(isAlreadyDecoded(src));
    setRevealing(false);
  }, [src]);

  // A same-origin/cached/blob src (e.g. the studio's own canvas-render preview) can fire
  // onLoad before the browser ever paints the opacity-0 frame, so React batches both
  // states into one commit and the fade never visibly plays. Deferring two frames
  // guarantees the unloaded state actually paints first, so the transition always runs.
  // No-op once the image is already showing. `onLoad` still fires for an image that was
  // served from cache and therefore mounted at full opacity, and without this guard that
  // would start the reveal on something the user is already looking at -- the invented-delay
  // bug described above, in a new place.
  const reveal = () => {
    if (loaded) return;
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        setLoaded(true);
        setRevealing(true);
      })
    );
  };

  const handleError = e => {
    if (attempt < retries) {
      const next = attempt + 1;
      clearTimeout(retryTimer.current);
      retryTimer.current = setTimeout(() => setAttempt(next), RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)]);
      return;
    }
    reveal();
    onError?.(e);
  };

  // WebKit does not fire `error` for an image whose request already failed before the element
  // existed -- the URL's failure is cached (here: the probe above and the gallery's preload both
  // got a 429 first), so the <img> mounts already `complete` with no pixels and React never hears
  // about it. Neither the retry nor the caller's own fallback then ran, and the card sat at
  // opacity 0 over its dark background: the "black thumbnail" (Aaron, Safari, 2026-10-19;
  // reproduced in Playwright's WebKit, not Chromium). So the element's own state is checked after
  // every render that changes its source, and an already-failed or already-loaded image is
  // handled as if its event had arrived.
  const imgRef = useRef(null);
  useEffect(() => {
    const img = imgRef.current;
    if (!img || !img.complete || !img.getAttribute('src')) return;
    if (img.naturalWidth > 0) reveal();
    else handleError({ target: img, currentTarget: img });
    // Deliberately keyed on the source alone: this stands in for one load/error event per source.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shownSrc]);

  return (
    <>
      {!loaded && <div className="absolute inset-0 animate-pulse bg-ink-700" />}
      <img
        ref={imgRef}
        src={shownSrc}
        alt={alt}
        onLoad={e => {
          reveal();
          onLoad?.(e);
        }}
        onError={handleError}
        // No `transition-opacity` here: it collided with call sites that pass their own
        // `transition-*` (see --animate-image-reveal in tailwind.css). The reveal is an
        // animation, and it is applied ONLY when the image really had to load -- an
        // already-decoded one just renders, with nothing to fade.
        className={`${className} ${loaded ? (revealing ? 'animate-image-reveal' : '') : 'opacity-0'}`}
        {...props}
      />
    </>
  );
}
