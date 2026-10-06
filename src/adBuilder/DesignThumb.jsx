import React, { useEffect, useRef, useState } from 'react';

// A saved design's thumbnail, drawn ONCE at the size it is shown and kept as a small canvas.
//
// The stored thumbnails are 640px, and these tiles are 73px. As plain <img>s, Safari rescaled every
// visible one each time it repainted the panel -- and while the preview played it repainted the
// panel every frame, so the preview ran at 20fps with the grid on screen, 9fps once more had
// loaded, and 60 the moment the grid was scrolled away (Aaron, 2026-10-06; Chrome and Firefox never
// showed it). Drawn down once, a repaint costs next to nothing whatever the browser does.
//
// Loaded only as it nears the visible part of its scroller, like loading="lazy" was.
const DPR = Math.min(2, typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1);

export default function DesignThumb({ src, size }) {
  const ref = useRef(null);
  const [near, setNear] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      entries => {
        if (entries.some(e => e.isIntersecting)) {
          setNear(true);
          io.disconnect();
        }
      },
      { root: el.closest('.ad-scroll'), rootMargin: '200px' }
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (!near) return;
    let cancelled = false;
    const img = new Image();
    img.decoding = 'async';
    img.src = src;
    img
      .decode()
      .then(() => {
        const canvas = ref.current;
        if (cancelled || !canvas) return;
        const px = Math.round(size * DPR);
        canvas.width = px;
        canvas.height = px;
        const ctx = canvas.getContext('2d');
        ctx.imageSmoothingQuality = 'high';
        // Cover crop, as object-cover did.
        const s = Math.min(img.naturalWidth, img.naturalHeight);
        ctx.drawImage(
          img,
          (img.naturalWidth - s) / 2,
          (img.naturalHeight - s) / 2,
          s,
          s,
          0,
          0,
          px,
          px
        );
      })
      .catch(() => {
        /* a missing thumbnail stays an empty tile, as a broken <img> did */
      });
    return () => {
      cancelled = true;
      img.src = '';
    };
  }, [near, src, size]);

  return <canvas ref={ref} width={1} height={1} className="h-full w-full bg-neutral-800" />;
}
