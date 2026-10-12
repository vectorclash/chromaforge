import React, { useEffect, useRef, useState } from 'react';
import {
  FEED_W,
  FEED_H,
  CLIP_SECONDS,
  SLIDE_LABELS,
  createFlightLoop,
  renderStillSlide
} from './feedPost';

// The feed post as Instagram shows it: one slide at a time in a 4:5 frame, with the carousel's
// count and dots. Still slides are rendered at full size by the same function the post uses, so
// the preview is the file. The flight clip plays live from the 3D scene (cached path) instead of
// being encoded, which only happens on export.

// The flight, looping, at preview size.
function FlightPlayer({ design }) {
  const host = useRef(null);
  const [error, setError] = useState(null);
  const key = JSON.stringify(design);
  useEffect(() => {
    let loop = null;
    let raf = 0;
    let cancelled = false;
    setError(null);
    createFlightLoop(design, FEED_W / 2, FEED_H / 2)
      .then(l => {
        if (cancelled) return l.dispose();
        loop = l;
        Object.assign(l.canvas.style, { width: '100%', height: '100%', display: 'block' });
        host.current?.appendChild(l.canvas);
        const t0 = performance.now();
        const tick = now => {
          l.draw((now - t0) / 1000);
          raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
      })
      .catch(e => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      loop?.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return (
    <div ref={host} className="absolute inset-0">
      {error && (
        <p className="flex h-full items-center justify-center p-6 text-center text-sm text-red-300">
          {error}
        </p>
      )}
    </div>
  );
}

export default function FeedPreview({ slides, design, images, index, onIndex, showIg }) {
  // url of each rendered still, by slide content; cleared when the design changes.
  const cache = useRef(new Map());
  const designKey = design ? JSON.stringify(design) : '';
  const [, bump] = useState(0);
  const [failed, setFailed] = useState(null);

  useEffect(() => {
    const c = cache.current;
    return () => {
      for (const v of c.values()) if (v.url) URL.revokeObjectURL(v.url);
      c.clear();
    };
  }, [designKey]);

  // Keyed by the design too, so a render that finishes after the design changed lands under a key
  // nothing asks for, rather than as the new design's slide.
  const keyOf = s => `${designKey}|${s.type}|${s.url ?? ''}`;
  const slide = slides[index] ?? null;
  const liveDesign = useRef(designKey);
  liveDesign.current = designKey;

  // Render the slide on screen, then its neighbours, one at a time. A render that has started
  // always finishes and is kept: a new run of this effect (a photo arriving, the slide changing)
  // skips the slide it finds in progress, so throwing that result away left it on "Rendering…".
  useEffect(() => {
    if (!design || !slides.length) return;
    let cancelled = false;
    const order = [index, index + 1, index - 1].filter(i => i >= 0 && i < slides.length);
    (async () => {
      for (const i of order) {
        const s = slides[i];
        const key = keyOf(s);
        if (s.type === 'flight' || cache.current.has(key)) continue;
        if (s.type === 'photo' && !images.get(s.url)) continue;
        cache.current.set(key, { url: null });
        try {
          const c = await renderStillSlide(s, design, images.get(s.url) ?? null);
          const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.9));
          c.width = 0;
          if (!blob) throw new Error('The slide could not be encoded.');
          if (!key.startsWith(`${liveDesign.current}|`)) {
            cache.current.delete(key);
            return;
          }
          cache.current.set(key, { url: URL.createObjectURL(blob) });
          bump(n => n + 1);
        } catch (e) {
          cache.current.delete(key);
          if (!cancelled) setFailed(e.message);
        }
        // Let the page breathe between renders.
        await new Promise(r => setTimeout(r, 0));
        if (cancelled) return;
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [designKey, index, slides.map(keyOf).join(','), images]);

  const shown = slide && cache.current.get(keyOf(slide))?.url;
  const n = slides.length;

  return (
    <div className="flex w-full flex-col items-center gap-3">
      <div
        className="w-[min(100%,calc(70dvh*0.8))] overflow-hidden rounded-xl bg-black shadow-2xl"
        style={{ maxWidth: 600 }}
      >
        {showIg && (
          <div className="flex items-center gap-2.5 px-3 py-2.5 text-sm font-bold text-white">
            <span className="h-7 w-7 rounded-full bg-gradient-to-br from-fuchsia-500 to-amber-300" />
            chromaforge.app
            <span className="ml-auto tracking-widest text-neutral-500">···</span>
          </div>
        )}
        <div className="relative isolate" style={{ aspectRatio: `${FEED_W} / ${FEED_H}` }}>
          {!design && (
            <p className="absolute inset-0 flex items-center justify-center p-8 text-center text-sm text-neutral-400">
              Choose a design to start.
            </p>
          )}
          {design && !slide && (
            <p className="absolute inset-0 flex items-center justify-center p-8 text-center text-sm text-neutral-400">
              Add a slide.
            </p>
          )}
          {design && slide?.type === 'flight' && <FlightPlayer design={design} />}
          {design && slide && slide.type !== 'flight' && shown && (
            <img
              src={shown}
              alt={SLIDE_LABELS[slide.type]}
              className="absolute inset-0 h-full w-full animate-fade-in"
            />
          )}
          {design && slide && slide.type !== 'flight' && !shown && (
            <p className="absolute left-3 top-3 rounded bg-black/60 px-2 py-1 text-xs text-neutral-300">
              {slide.type === 'photo' && !images.get(slide.url)
                ? 'Loading the photo…'
                : 'Rendering…'}
            </p>
          )}
          {n > 1 && (
            <span className="absolute right-3 top-3 rounded-full bg-black/60 px-2.5 py-0.5 text-xs font-bold tabular-nums text-white">
              {index + 1}/{n}
            </span>
          )}
          {index > 0 && (
            <button
              type="button"
              onClick={() => onIndex(index - 1)}
              aria-label="Previous slide"
              className="absolute left-2 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-full bg-white/85 font-black text-black"
            >
              ‹
            </button>
          )}
          {index < n - 1 && (
            <button
              type="button"
              onClick={() => onIndex(index + 1)}
              aria-label="Next slide"
              className="absolute right-2 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-full bg-white/85 font-black text-black"
            >
              ›
            </button>
          )}
          {showIg && (
            // The profile grid shows a 3:4 crop of a 4:5 post: a little off each side.
            <div
              className="pointer-events-none absolute inset-y-0 border-x-2 border-dashed border-sky-300/70"
              style={{
                left: `${((1 - (FEED_H * 0.75) / FEED_W) / 2) * 100}%`,
                right: `${((1 - (FEED_H * 0.75) / FEED_W) / 2) * 100}%`
              }}
            />
          )}
        </div>
        <div className="flex items-center justify-center gap-1.5 py-2.5">
          {n > 1 &&
            slides.map((s, i) => (
              <button
                key={s.id}
                type="button"
                aria-label={`Slide ${i + 1}`}
                onClick={() => onIndex(i)}
                className={`h-1.5 w-1.5 rounded-full ${i === index ? 'bg-sky-400' : 'bg-neutral-600'}`}
              />
            ))}
        </div>
      </div>
      <p className="text-xs text-neutral-500">
        {slide?.type === 'flight'
          ? `Flight clip: a ${CLIP_SECONDS}s loop, rendered in full when you export or post.`
          : showIg
            ? 'The dashed lines show the 3:4 crop the profile grid uses.'
            : ' '}
      </p>
      {failed && <p className="text-xs text-red-300">A slide failed to render: {failed}</p>}
    </div>
  );
}
