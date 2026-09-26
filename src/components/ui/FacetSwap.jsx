import { useEffect, useLayoutEffect, useRef } from 'react';
import { makeRng } from '../../render/prng';

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
// MOCKUP LAYER comment in ProductPage for the rule this keeps. Reduced motion never gets here
// (ProductPage skips the intro, and a swap checks for itself). A new run mid-flight jumps the
// current one to its end first, so fast tapping never queues animations.

const SWAP_MS = 440;
// The completion is the bigger moment, after a wait of ~15s, so it takes a little longer.
const INTRO_MS = 560;
// Triangle start times are spread over the first SPREAD of the run by distance from the origin,
// and each takes EACH of it to land. SPREAD + EACH = 1, so the last one lands exactly at the end.
const SPREAD = 0.55;
const EACH = 0.45;
const GRID = 6;
// Full device resolution up to 3x: capping lower made the untouched outgoing photo visibly soften
// for the length of the swap on a 3x phone, since it is the canvas, not the <img>, on screen then.
const MAX_DPR = 3;
// The incoming photo is already preloaded by the time its URL arrives, so this only guards a
// cache miss; past it the run gives up and the photo arrives the ordinary way.
const LOAD_TIMEOUT_MS = 300;

// One fixed lattice: a 6x6 grid with jittered interior points and alternating diagonals, like the
// artwork's own facets. Edge points stay on the edge so the mosaic always covers the frame.
const LATTICE = (() => {
  const rng = makeRng('facet-swap');
  const jitter = 0.32 / GRID;
  const pts = [];
  for (let r = 0; r <= GRID; r++) {
    pts.push([]);
    for (let c = 0; c <= GRID; c++) {
      const edge = r === 0 || c === 0 || r === GRID || c === GRID;
      const j = edge ? 0 : jitter;
      pts[r].push([c / GRID + (rng() - 0.5) * j, r / GRID + (rng() - 0.5) * j]);
    }
  }
  const tris = [];
  for (let r = 0; r < GRID; r++) {
    for (let c = 0; c < GRID; c++) {
      const a = pts[r][c], b = pts[r][c + 1], d = pts[r + 1][c], e = pts[r + 1][c + 1];
      if ((r + c) % 2) tris.push([a, b, e], [a, e, d]);
      else tris.push([a, b, d], [b, e, d]);
    }
  }
  return tris;
})();

const clamp01 = x => (x < 0 ? 0 : x > 1 ? 1 : x);
// Overshoots past 1 and settles, which is the "pop".
const easeOutBack = p => {
  const c1 = 1.9;
  const c3 = c1 + 1;
  return 1 + c3 * (p - 1) ** 3 + c1 * (p - 1) ** 2;
};

// Mirrors the hero <img>'s object-cover, so the canvas's frames register with the photo it
// covers and hands back to.
function coverCanvas(img, width, height) {
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  const scale = Math.max(width / img.naturalWidth, height / img.naturalHeight);
  const sw = width / scale;
  const sh = height / scale;
  ctx.drawImage(img, (img.naturalWidth - sw) / 2, (img.naturalHeight - sh) / 2, sw, sh, 0, 0, width, height);
  return c;
}

const drawable = img => img && img.complete && img.naturalWidth > 0;
const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

export default function FacetSwap({ src, enabled, intro = false, onIntroEnd, originSelector }) {
  const canvasRef = useRef(null);
  const prevSrcRef = useRef(null);
  const enabledRef = useRef(enabled);
  const onIntroEndRef = useRef(onIntroEnd);
  const runRef = useRef(null);
  // Decoded photos by URL. The outgoing photo has to be drawable SYNCHRONOUSLY when a swap
  // starts, and a fresh Image for even a cached URL is not reliably complete until a later task
  // -- so every URL this layer shows gets an Image here when it arrives, and is long loaded by the
  // time it is the one being swapped away from.
  const imagesRef = useRef(new Map());

  const imageFor = url => {
    const cache = imagesRef.current;
    let img = cache.get(url);
    if (!img) {
      img = new Image();
      img.src = url;
      cache.set(url, img);
      // A product shows at most eight views; keep a little over one run's worth.
      if (cache.size > 12) cache.delete(cache.keys().next().value);
    }
    return img;
  };

  const hide = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.style.visibility = '';
    // Releases the backing store -- up to ~12MB at 3x on a desktop-sized hero.
    canvas.width = 0;
    canvas.height = 0;
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

  const play = (kind, fromImg, toImg) => {
    const canvas = canvasRef.current;
    const box = canvas.parentElement.getBoundingClientRect();
    const dpr = Math.min(MAX_DPR, window.devicePixelRatio || 1);
    const W = Math.max(1, Math.round(box.width * dpr));
    const H = Math.max(1, Math.round(box.height * dpr));
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');
    const from = fromImg ? coverCanvas(fromImg, W, H) : null;
    // A swap's first frame is the outgoing photo, painted before this commit reaches the screen,
    // so the <img> switching to the new URL underneath is never seen.
    if (from) ctx.drawImage(from, 0, 0);
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

    const tris = LATTICE.map(pts => {
      const p = pts.map(([x, y]) => [x * W, y * H]);
      const cx = (p[0][0] + p[1][0] + p[2][0]) / 3;
      const cy = (p[0][1] + p[1][1] + p[2][1]) / 3;
      const xs = p.map(q => q[0]);
      const ys = p.map(q => q[1]);
      const bx = Math.max(0, Math.floor(Math.min(...xs)) - 2);
      const by = Math.max(0, Math.floor(Math.min(...ys)) - 2);
      return {
        p,
        cx,
        cy,
        bx,
        by,
        bw: Math.min(W, Math.ceil(Math.max(...xs)) + 2) - bx,
        bh: Math.min(H, Math.ceil(Math.max(...ys)) + 2) - by,
        d: Math.hypot(cx - ox, cy - oy)
      };
    });
    const maxD = Math.max(...tris.map(t => t.d)) || 1;

    const duration = kind === 'intro' ? INTRO_MS : SWAP_MS;
    const run = { kind, raf: 0, reported: false };
    runRef.current = run;
    const waitStart = performance.now();
    let to = null;
    let t0 = 0;

    const frame = now => {
      if (runRef.current !== run) return;
      if (!to) {
        if (drawable(toImg)) {
          to = coverCanvas(toImg, W, H);
          t0 = now;
        } else if (now - waitStart > LOAD_TIMEOUT_MS) {
          // Not played: the page falls back to the layer's ordinary fade.
          reportIntroEnd(run, false);
          finish();
          return;
        } else {
          run.raf = requestAnimationFrame(frame);
          return;
        }
      }
      const t = clamp01((now - t0) / duration);
      if (from) ctx.drawImage(from, 0, 0);
      else ctx.clearRect(0, 0, W, H);
      for (const tr of tris) {
        const p = clamp01((t - (tr.d / maxD) * SPREAD) / EACH);
        if (p <= 0) continue;
        // 1.012 at rest so neighbours overlap and no hairline of what is underneath shows
        // between them.
        const s = easeOutBack(p) * 1.012;
        ctx.save();
        ctx.globalAlpha = Math.min(1, p * 2.5);
        ctx.translate(tr.cx, tr.cy);
        ctx.scale(s, s);
        ctx.translate(-tr.cx, -tr.cy);
        ctx.beginPath();
        ctx.moveTo(tr.p[0][0], tr.p[0][1]);
        ctx.lineTo(tr.p[1][0], tr.p[1][1]);
        ctx.lineTo(tr.p[2][0], tr.p[2][1]);
        ctx.closePath();
        ctx.save();
        ctx.clip();
        ctx.drawImage(to, tr.bx, tr.by, tr.bw, tr.bh, tr.bx, tr.by, tr.bw, tr.bh);
        ctx.restore();
        // A glint along the facet's edges while it lands.
        if (p < 1) {
          ctx.globalAlpha = (1 - p) * 0.9;
          ctx.strokeStyle = '#ffffff';
          ctx.lineWidth = (1.5 * dpr) / Math.max(0.2, s);
          ctx.lineJoin = 'round';
          ctx.stroke();
        }
        ctx.restore();
      }
      if (t < 1) run.raf = requestAnimationFrame(frame);
      else if (kind === 'swap') finish();
      // The intro's last frame covers everything. Hold it until the page has the <img> showing
      // underneath -- the `intro` effect below takes it down in that same commit.
      else reportIntroEnd(run, true);
    };
    run.raf = requestAnimationFrame(frame);
  };

  useLayoutEffect(() => {
    onIntroEndRef.current = onIntroEnd;
  });

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
      finish();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intro]);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => finish, []);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className="pointer-events-none invisible absolute inset-0 h-full w-full"
    />
  );
}
