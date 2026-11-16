import { useEffect, useImperativeHandle, useLayoutEffect, useRef } from 'react';
import { coverCanvas, layoutFacets, drawFacets, FACET_SWAP_MS, FACET_INTRO_MS } from './facetMosaic';
import { logRender, renderLogEnabled } from '../../render/renderOffThread';
import { createFacetGl } from './facetGl';

// The product page's mockup photo arriving: the view assembles out of triangles that pop in, in
// the same faceted geometry the artwork is made of. Aaron picked it from a five-way comparison
// run on a real zip-hoodie mockup (2026-09-26): https://claude.ai/artifact/L6dNn2L76gfeLvNGz6Mnmg
//
// Two kinds of run, both a canvas laid over the hero that exists only while it plays:
//
//   - SWAP, on a camera-angle switch between two photos already on screen (`enabled`). The canvas
//     is OPAQUE for the whole run: its first frame is the outgoing photo drawn in full, painted in
//     the same commit that swaps the <img> underneath to the new URL, so that swap is never seen.
//     Grows from the thumbnail that was picked.
//   - INTRO, when a generation the customer watched completes (`intro`, decided by ProductPage).
//     Nothing is drawn under the triangles, so the loading screen stays visible in the gaps as the
//     mockup assembles over it -- growing from the centre, where the loader sits. The <img> is
//     held invisible for the run (ProductPage keeps it at opacity 0 while `intro` is true); when
//     the last triangle lands the canvas covers the whole frame, `onIntroEnd(true)` tells the
//     page, and the canvas holds that final frame until the page has switched the <img> on
//     underneath it. Both happen in one commit, so the handover is never painted.
//
// So the mockup layer never runs a visible animation of its own while this plays -- see the
// MOCKUP LAYER comment in ProductPage for the rule this keeps.
//
// THE OUTGOING PHOTO IS A REAL <img>, NOT A CANVAS COPY, AND A RUN ENDS BY FADING (2026-11-15,
// Aaron: on a thumbnail click the photo "seems to move up and to the left, like one or two pixels,
// and then moves back into place"). Two separate shifts, both measured:
//   - Safari draws an <img> and a canvas copy of the same picture up to a device pixel apart, even
//     in a bare page with an integer-sized box (Chromium matches exactly) -- so a first frame that
//     REDREW the outgoing photo on the canvas jumped by that much the moment a swap began. The
//     outgoing photo is now the cached, already-decoded image element itself, laid over the slot
//     for the run, so it is rasterised exactly as it was a frame earlier; the canvas only carries
//     the landing triangles, over it.
//   - Every landed triangle is drawn 1.2% oversized about its centre (so no hairline shows between
//     neighbours), which moves its content up to a pixel -- so the last canvas frame is NOT the
//     photo underneath, in any browser, and hiding the canvas snapped it back. A finished run now
//     fades the canvas out (FADE_OUT_MS) over the photo it was standing in for. An interrupted run
//     still clears at once.
//
// Reduced motion never gets here (ProductPage skips the intro, and a swap checks for itself). A new
// run mid-flight jumps the current one to its end first, so fast tapping never queues animations.
//
// NOTHING IS DECODED INSIDE A RUN (2026-11-15, Aaron: frames dropped "now and again" during the
// transition). A photo only loaded is decoded by its first draw, on the main thread, in the run's
// first frame -- 4-5ms measured in WebKit for a 1000px photo, more on a phone. Every photo this
// layer may be asked to show (`warm`: the other views of the product) is decoded ahead with
// img.decode(), off the main thread, and a run waits a frame or two for a decode still under way
// rather than forcing it. Under ?renderlog=1 each run logs its size, first-frame cost and worst
// frame gap beside the log's own stall list.
const FADE_OUT_MS = 180;
// How long a run waits for its photo's decode before drawing it anyway.
const DECODE_WAIT_MS = 120;
//
// NOTHING ACCUMULATES ACROSS RUNS (same day: "it seems to happen after i've changed the image a
// bunch of times"). Each run used to draw its incoming photo into a NEW full-size canvas
// (6.5MB at 2x, 15MB at 3x), never reused and left to the garbage collector -- 131 of them after
// 120 swaps, measured -- and canvas memory sits outside the JS heap, so it is collected late and
// all at once, mid-run. Those canvases are now kept per photo (a return to a view draws nothing
// new), at most COVER_CACHE of them, and an evicted one is released explicitly (width 0). The
// decoded photos are likewise held only for the views on screen: a new design's `warm` set
// drops the previous design's.
const COVER_CACHE = 3;

// DRAWN WITH WEBGL (facetGl.js), with this 2D drawing as the fallback where WebGL is unavailable
// (2026-11-15, Aaron, Safari: every transition dropped 2-6 frames, worst ~40ms; smooth in Firefox and
// Chromium). Narrowed on his machine with test modes: a quarter of the pixels, no glints and half the
// triangles all still dropped, the canvas drawn once and left up did not -- so it was Safari
// redrawing a 2D canvas at all (~70 clipped image draws a frame), not anything the drawing could trim.

// Full device resolution up to 3x: capping lower made the landing photo visibly soften on a 3x
// phone, since it is the canvas, not the <img>, on screen while it lands.
const MAX_DPR = 3;
// The incoming photo is already preloaded by the time its URL arrives, so this only guards a
// cache miss; past it the run gives up and the photo arrives the ordinary way.
const LOAD_TIMEOUT_MS = 300;

const clamp01 = x => (x < 0 ? 0 : x > 1 ? 1 : x);

// coverCanvas's crop drawn into an existing canvas (resized only if it must be).
function drawCover(img, W, H, canvas) {
  if (canvas.width !== W || canvas.height !== H) {
    canvas.width = W;
    canvas.height = H;
  }
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, W, H);
  ctx.imageSmoothingQuality = 'high';
  const iw = img.naturalWidth || img.width;
  const ih = img.naturalHeight || img.height;
  const scale = Math.max(W / iw, H / ih);
  const sw = W / scale;
  const sh = H / scale;
  ctx.drawImage(img, (iw - sw) / 2, (ih - sh) / 2, sw, sh, 0, 0, W, H);
  return canvas;
}
const drawable = img => img && img.complete && img.naturalWidth > 0;
const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

// `ref` (optional) gets { assemble(url, maskUrl, onLanded) -> cancel, release() }: a NEW PRINT
// arriving (ProductPhoto under `?printfx=facet`) -- the photo at `url` assembling from the centre
// over whatever is beneath, confined to `maskUrl`'s opaque pixels (the fabric) so the model and
// background never move. `onLanded` runs when the last triangle has landed; the canvas then holds
// that frame until `release()`, which fades it away over the photo the caller has put underneath.
export default function FacetSwap({ src, enabled, intro = false, onIntroEnd, originSelector, warm = null, ref = null }) {
  const canvasRef = useRef(null);
  // The WebGL canvas and its drawing (null: not tried yet; false: unavailable -- the 2D canvas then).
  const glCanvasRef = useRef(null);
  const glRef = useRef(null);
  // The canvas the current (or last) run is on.
  const activeRef = useRef(null);
  // The WebGL canvas is made on the first run and removed on teardown -- not rendered by React, since
  // a context lost on teardown cannot be had again from the same element, and a component can be
  // torn down and mounted again (StrictMode does exactly that in development).
  const getGl = () => {
    if (glRef.current === false || !canvasRef.current) return null;
    if (glRef.current === null) {
      const canvas = document.createElement('canvas');
      canvas.setAttribute('aria-hidden', 'true');
      canvas.className = canvasRef.current.className;
      glRef.current = createFacetGl(canvas) || false;
      if (!glRef.current) return null;
      canvasRef.current.after(canvas);
      glCanvasRef.current = canvas;
      // A lost context (the GPU reset) falls back to the 2D canvas for the rest of the visit.
      canvas.addEventListener('webglcontextlost', () => (glRef.current = false), { once: true });
    }
    return glRef.current || null;
  };
  // Holds the outgoing photo's own image element for the length of a swap (see the header).
  const holderRef = useRef(null);
  const fadeTimerRef = useRef(0);
  const prevSrcRef = useRef(null);
  const enabledRef = useRef(enabled);
  const onIntroEndRef = useRef(onIntroEnd);
  const runRef = useRef(null);
  // Decoded photos by URL. The outgoing photo has to be drawable SYNCHRONOUSLY when a swap
  // starts, and a fresh Image for even a cached URL is not reliably complete until a later task
  // -- so every URL this layer shows gets an Image here when it arrives, and is long loaded by the
  // time it is the one being swapped away from.
  const imagesRef = useRef(new Map());
  // Cover-fitted copies of photos at the run's canvas size, by `${url}|${W}x${H}` (see header).
  const coversRef = useRef(new Map());
  const coverFor = (img, W, H) => {
    const key = `${img.src}|${W}x${H}`;
    const covers = coversRef.current;
    let c = covers.get(key);
    if (c) {
      covers.delete(key);
    } else if (covers.size >= COVER_CACHE) {
      // Full: the least recently used canvas is redrawn with this photo rather than a new one made
      // -- going round all eight views in order misses a small cache every time, so recycling,
      // not caching, is what stops the allocations.
      const [oldKey, old] = covers.entries().next().value;
      covers.delete(oldKey);
      c = drawCover(img, W, H, old);
    } else {
      c = coverCanvas(img, W, H);
    }
    covers.set(key, c);
    return c;
  };
  const releaseCovers = keep => {
    for (const [key, c] of coversRef.current) {
      if (keep && keep(key.slice(0, key.lastIndexOf('|')))) continue;
      coversRef.current.delete(key);
      c.width = 0;
      c.height = 0;
    }
  };

  const imageFor = url => {
    const cache = imagesRef.current;
    let img = cache.get(url);
    if (!img) {
      img = new Image();
      img.src = url;
      const decoded = img.decode?.();
      if (decoded) decoded.then(() => (img.decoded = true), () => (img.decoded = true));
      else img.decoded = true;
      cache.set(url, img);
      // A product shows at most sixteen views (two designs on the hat); a little over that.
      if (cache.size > 20) cache.delete(cache.keys().next().value);
    }
    return img;
  };

  const hide = () => {
    clearTimeout(fadeTimerRef.current);
    holderRef.current?.replaceChildren();
    for (const canvas of [canvasRef.current, glCanvasRef.current]) {
      if (!canvas) continue;
      canvas.style.visibility = '';
      canvas.style.transition = '';
      canvas.style.opacity = '';
    }
    // Releases the 2D backing store -- up to ~12MB at 3x on a desktop-sized hero. The WebGL canvas
    // keeps its size: resizing it reallocates its drawing buffer, and it is cleared before it shows.
    if (canvasRef.current) {
      canvasRef.current.width = 0;
      canvasRef.current.height = 0;
    }
  };

  const reportIntroEnd = (run, played) => {
    if (run.kind !== 'intro' || run.reported) return;
    run.reported = true;
    onIntroEndRef.current?.(played);
  };

  // Stops whatever is running. An intro cut short still reports its end -- as played, so the
  // page shows the <img> at once rather than starting a fade under whatever replaced the canvas.
  const finish = () => {
    const run = runRef.current;
    if (!run) return;
    runRef.current = null;
    cancelAnimationFrame(run.raf);
    reportIntroEnd(run, true);
    hide();
  };

  // A run that ran to the end: the canvas, whose triangles sit a hair off the photo beneath it,
  // fades away over that photo instead of vanishing from on top of it. The outgoing image goes at
  // once -- the finished canvas covers it entirely.
  const finishSoftly = () => {
    const run = runRef.current;
    if (!run) return;
    runRef.current = null;
    cancelAnimationFrame(run.raf);
    reportIntroEnd(run, true);
    holderRef.current?.replaceChildren();
    const canvas = activeRef.current;
    if (!canvas) return;
    canvas.style.transition = `opacity ${FADE_OUT_MS}ms ease-out`;
    canvas.style.opacity = '0';
    clearTimeout(fadeTimerRef.current);
    fadeTimerRef.current = setTimeout(() => {
      if (!runRef.current) hide();
    }, FADE_OUT_MS + 40);
  };

  const play = (kind, fromImg, toImg, { mask = null, onLanded = null } = {}) => {
    const gl = getGl();
    const canvas = gl ? glCanvasRef.current : canvasRef.current;
    activeRef.current = canvas;
    const box = canvas.parentElement.getBoundingClientRect();
    const dpr = Math.min(MAX_DPR, window.devicePixelRatio || 1);
    const W = Math.max(1, Math.round(box.width * dpr));
    const H = Math.max(1, Math.round(box.height * dpr));
    if (canvas.width !== W || canvas.height !== H) {
      canvas.width = W;
      canvas.height = H;
    }
    const ctx = gl ? null : canvas.getContext('2d');
    if (gl) gl.clear();
    else ctx.clearRect(0, 0, W, H);
    clearTimeout(fadeTimerRef.current);
    canvas.style.transition = '';
    canvas.style.opacity = '';
    // A swap covers the slot with the outgoing photo's own image element, laid in before this
    // commit reaches the screen, so the <img> switching to the new URL underneath is never seen --
    // and since it is an <img> like the one it covers, it lands on exactly the same pixels.
    if (fromImg && holderRef.current) {
      fromImg.alt = '';
      Object.assign(fromImg.style, { position: 'absolute', inset: '0', width: '100%', height: '100%', objectFit: 'cover' });
      holderRef.current.replaceChildren(fromImg);
    }
    canvas.style.visibility = 'visible';

    // A swap grows from the thumbnail that was picked (bottom-centre if there isn't one on
    // screen); the intro from the centre, where the loader was.
    let ox = W / 2;
    let oy = H / 2;
    if (kind === 'swap') {
      const o = originSelector ? document.querySelector(originSelector)?.getBoundingClientRect() : null;
      ox = o ? (o.left + o.width / 2 - box.left) * dpr : W / 2;
      oy = o ? (o.top + o.height / 2 - box.top) * dpr : H;
    }

    const layout = layoutFacets(W, H, ox, oy);

    const duration = kind === 'swap' ? FACET_SWAP_MS : FACET_INTRO_MS;
    const run = { kind, raf: 0, reported: false };
    runRef.current = run;
    const waitStart = performance.now();
    let to = null;
    let t0 = 0;
    const stats = renderLogEnabled() ? { first: 0, worst: 0, slow: 0, last: 0 } : null;

    const frame = now => {
      if (runRef.current !== run) return;
      if (stats) {
        if (stats.last) {
          const gap = now - stats.last;
          if (gap > stats.worst) stats.worst = gap;
          if (gap > 20) stats.slow++;
        }
        stats.last = now;
      }
      if (!to) {
        // An assembling print also waits for its fabric mask: drawn without one, the triangles
        // covered the whole photo -- the model included.
        const maskReady = !mask || (drawable(mask) && mask.decoded);
        if (drawable(toImg) && maskReady && (toImg.decoded || now - waitStart > DECODE_WAIT_MS)) {
          const c0 = performance.now();
          if (gl) {
            gl.setImage(toImg, W, H);
            gl.setMask(mask && drawable(mask) ? mask : null);
            to = true;
          } else to = coverFor(toImg, W, H);
          if (stats) stats.first = performance.now() - c0;
          t0 = now;
        } else if (now - waitStart > LOAD_TIMEOUT_MS) {
          // Not played: the page falls back to the layer's ordinary fade -- and an assembling
          // print hands over at once, or the caller would keep the photo hidden.
          reportIntroEnd(run, false);
          finish();
          if (kind === 'assemble') onLanded?.();
          return;
        } else {
          run.raf = requestAnimationFrame(frame);
          return;
        }
      }
      const t = clamp01((now - t0) / duration);
      const glint = 1.5 * dpr;
      if (gl) gl.draw(layout, t, glint, W, H);
      else {
        ctx.clearRect(0, 0, W, H);
        drawFacets(ctx, layout, to, t, glint);
      }
      if (stats && t >= 1) {
        logRender({
          size: `${W}x${H}`,
          priority: '-',
          path: `facet ${kind} ${gl ? 'gl' : '2d'}`,
          wait: Math.round(t0 - waitStart),
          phases: `first ${stats.first.toFixed(1)} worst ${Math.round(stats.worst)} slow ${stats.slow}`,
          total: Math.round(now - waitStart)
        });
      }
      if (t < 1) run.raf = requestAnimationFrame(frame);
      else if (kind === 'swap') finishSoftly();
      // An assembled print holds its last frame until the caller releases it.
      else if (kind === 'assemble') onLanded?.();
      // The intro's last frame covers everything. Hold it until the page has the <img> showing
      // underneath -- the `intro` effect below takes it down in that same commit.
      else reportIntroEnd(run, true);
    };
    run.raf = requestAnimationFrame(frame);
  };

  useLayoutEffect(() => {
    onIntroEndRef.current = onIntroEnd;
  });

  useImperativeHandle(
    ref,
    () => ({
      assemble(url, maskUrl, onLanded) {
        finish();
        if (!canvasRef.current || reducedMotion()) {
          onLanded?.();
          return () => {};
        }
        play('assemble', null, imageFor(url), { mask: maskUrl ? imageFor(maskUrl) : null, onLanded });
        const run = runRef.current;
        return () => {
          if (runRef.current === run) finish();
        };
      },
      release() {
        if (runRef.current?.kind === 'assemble') finishSoftly();
      }
    }),
    // imageFor/finish/play/finishSoftly only touch refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  useLayoutEffect(() => {
    enabledRef.current = enabled;
    if (!enabled && runRef.current?.kind === 'swap') finish();
    // finish only touches refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  useLayoutEffect(() => {
    const prev = prevSrcRef.current;
    prevSrcRef.current = src;
    finish();
    if (!src) return;
    const toImg = imageFor(src);
    const fromImg = prev ? imagesRef.current.get(prev) : null;
    if (!canvasRef.current || !enabledRef.current || !drawable(fromImg) || reducedMotion()) return;
    play('swap', fromImg, toImg);
    // imageFor/finish/play only touch refs; originSelector is a constant at the one call site.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src]);

  useLayoutEffect(() => {
    if (intro) {
      if (!src || !canvasRef.current) {
        onIntroEndRef.current?.(false);
        return;
      }
      finish();
      play('intro', null, imageFor(src));
    } else if (runRef.current?.kind === 'intro') {
      // The page has the <img> showing underneath the finished frame by now (see the header).
      finishSoftly();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intro]);

  // Decode the photos a swap may be asked to show before it is (see the header).
  const warmKey = warm ? warm.filter(Boolean).join('\n') : '';
  useEffect(() => {
    if (!warmKey) return;
    const urls = warmKey.split('\n');
    // Only this set's photos (and whatever is on screen or running) stay decoded.
    const keep = new Set([...urls, prevSrcRef.current]);
    for (const url of [...imagesRef.current.keys()]) {
      if (!keep.has(url) && !runRef.current) imagesRef.current.delete(url);
    }
    releaseCovers(url => keep.has(url));
    for (const url of urls) imageFor(url);
  }, [warmKey]);

  useEffect(
    () => () => {
      finish();
      releaseCovers(null);
      // Every WebGL context is force-lost on teardown (CLAUDE.md, check-leaks.mjs).
      if (glRef.current) glRef.current.dispose();
      glCanvasRef.current?.remove();
      glCanvasRef.current = null;
      glRef.current = null;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  return (
    <>
      {/* Filled imperatively for a swap's length; React never renders into it. */}
      <div ref={holderRef} aria-hidden="true" className="pointer-events-none absolute inset-0" />
      <canvas
        ref={canvasRef}
        aria-hidden="true"
        className="pointer-events-none invisible absolute inset-0 h-full w-full"
      />

    </>
  );
}
