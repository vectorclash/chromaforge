import React, { useCallback, useEffect, useRef, useState } from 'react';
import { gsap } from 'gsap';
import { useStudio } from '../../context/StudioContext';
import { DURATION_FAST, DURATION_HOLD, DURATION_SLOW } from '../../utils/motionTokens';
import logoUrl from '../../assets/images/logo.svg';
import starUrl from '../../assets/images/star-sprite-large.png';

// The About section's second image: the amorphous blob from the 2021 design, reused as a
// live MASK over a real generated design, with the Chromaforge logo as its centrepiece and
// the project's own star sprite as flares.
//
// The silhouette is a union of 14 discs recovered from that illustration's own alpha by
// greedy largest-inscribed-circle fitting (IoU 0.962 against the real shape). Discs rather
// than the original bitmap deliberately: a disc list can be perturbed by noise every frame,
// which is the whole reason the edge can drift. A mask bitmap could only be translated or
// scaled.
//
// The "gem" at the centre of the 2021 art was always the logo, so this draws the actual
// logo.svg rather than an imitation of it.

// Normalised to the blob's own box: x/r are fractions of its width, y of its height.
const DISCS = [
  { x: 0.56923, y: 0.49454, r: 0.2277 },
  { x: 0.26462, y: 0.44809, r: 0.20606 },
  { x: 0.39385, y: 0.69945, r: 0.14923 },
  { x: 0.77538, y: 0.56557, r: 0.12391 },
  { x: 0.88154, y: 0.48907, r: 0.11903 },
  { x: 0.07846, y: 0.37978, r: 0.06505 },
  { x: 0.72308, y: 0.74863, r: 0.06154 },
  { x: 0.08154, y: 0.53552, r: 0.05448 },
  { x: 0.31385, y: 0.12295, r: 0.05077 },
  { x: 0.77846, y: 0.77049, r: 0.04897 },
  { x: 0.10154, y: 0.62022, r: 0.04787 },
  { x: 0.10154, y: 0.27596, r: 0.0407 },
  { x: 0.12923, y: 0.68579, r: 0.04006 },
  { x: 0.50308, y: 0.84973, r: 0.03916 }
];

const BLOB_W = 650; // the silhouette's own reference box; all sizes below are in this space
const BLOB_H = 366;
const OUTLINE = '#210042'; // sampled from the 2021 illustration's own edge pixels
const MOTION_AMOUNT = 1; // the "subtle" level; 2.4 was tried and read as too busy
// Two ceilings, deliberately different, where there used to be one at 1100 doing both jobs.
//
// CANVAS_CAP bounds the backing store, which carries the outline, the logo, the flares and
// the edge stars -- all hard-edged, and all of it was aliasing badly at 1:1 device pixels.
// It is drawn at 2x the device ratio and downsampled by the browser, same as AboutShirts.
// Cheap: these are a few dozen draw calls per frame, so more pixels costs GPU fill, not
// main-thread work.
//
// ART_CAP bounds the generated ARTWORK, and is not the same number because that cost is not
// the same kind. renderDesignBlob runs generateArtwork/renderArtwork synchronously on the
// main thread, so its pixels are paid as a frozen rAF loop (see the render effect, and the
// stall the highDensity flag caused there at 2.79Mpx). Raising this to match the canvas
// would land right on that figure. At 1500 it is 1.29Mpx -- about 1.9x what it was, still
// less than half the size that stalled -- and gets upscaled ~1.4x into the canvas. That
// tradeoff only works because the artwork is a soft generative composition, where a gentle
// upscale is invisible, while the hard edges that actually looked broken are the ones now
// being supersampled.
const SUPERSAMPLE = 2;
const CANVAS_CAP = 2200;
const ART_CAP = 1500;

// Flares inside the blob, and the much larger ones that straddle its edge. Sizes are in the
// blob's own 650-wide space and scale with it.
const INNER_FLARES = [
  { c: '#ff2fa0', size: 76, a: 0.95 },
  { c: '#37e6ff', size: 58, a: 0.9 },
  { c: '#ffe066', size: 46, a: 0.85 },
  { c: '#37e6ff', size: 36, a: 0.8 },
  { c: '#ffffff', size: 30, a: 0.9 }
];
const EDGE_STARS = [
  { disc: 8, c: '#ff3b30', size: 210, a: 0.85 },
  { disc: 4, c: '#37e6ff', size: 180, a: 0.8 },
  { disc: 2, c: '#ffe066', size: 165, a: 0.75 }
];

function hash01(i) {
  const a = Math.sin(i * 127.1 + 311.7) * 43758.5453;
  return a - Math.floor(a);
}

// Per-disc motion character. One shared speed made the whole silhouette breathe in lockstep,
// which reads as a single shape scaling rather than a cluster of bubbles. Position drift also
// scales with 1/sqrt(r) so the small satellite discs travel further than the big body ones --
// that asymmetry is what makes the edge look alive.
//
// Radius amplitude is a FRACTION of each disc's own radius, never an absolute figure: an
// absolute one exceeded the smallest disc's radius at higher motion levels and produced a
// negative radius, which throws from arc().
const MOTION = DISCS.map((d, i) => {
  const h1 = hash01(i);
  const h2 = hash01(i + 50);
  const h3 = hash01(i + 90);
  const boost = Math.min(2.2, 0.34 / Math.sqrt(d.r));
  return {
    speed: 0.45 + h1 * 1.15,
    phase: h2 * Math.PI * 2,
    drift: h3 * Math.PI * 2,
    ampRFrac: 0.1 + h2 * 0.14,
    ampX: (0.004 + h3 * 0.007) * boost,
    ampY: (0.006 + h1 * 0.01) * boost
  };
});

// The canvas is deliberately LARGER than the silhouette, because the edge stars overflow it
// and the outline plus the wobble push slightly past it too. These margins are measured, not
// picked: for every disc at its maximum wobble (in BOTH directions -- evaluating only the
// positive one is what left the top star clipped) plus half the outline stroke, and for each
// edge star's full sprite box, this records how far past each side anything reaches.
//
// Per-side rather than one symmetric inset: the overflow is very uneven (109px right against
// 14px left), so a symmetric margin would have to satisfy the worst side on every side and
// would shrink the blob to 64% of the canvas instead of 84%.
const MARGIN = (() => {
  let l = 0;
  let r = 0;
  let t = 0;
  let b = 0;
  const note = (x0, x1, y0, y1) => {
    l = Math.max(l, -x0);
    r = Math.max(r, x1 - BLOB_W);
    t = Math.max(t, -y0);
    b = Math.max(b, y1 - BLOB_H);
  };
  // Every combination of drift signs, since sin/cos swing both ways and the extreme that
  // matters differs per side.
  const corners = i => {
    const d = DISCS[i];
    const m = MOTION[i];
    const out = [];
    for (const sx of [-1, 1]) {
      for (const sy of [-1, 1]) {
        out.push({
          x: (d.x + sx * m.ampX * MOTION_AMOUNT) * BLOB_W,
          y: (d.y + sy * m.ampY * MOTION_AMOUNT) * BLOB_H,
          r: d.r * (1 + m.ampRFrac * MOTION_AMOUNT) * BLOB_W
        });
      }
    }
    return out;
  };
  DISCS.forEach((_, i) => {
    for (const c of corners(i)) {
      const R = c.r + 2.5; // + half the 5px outline stroke at this reference width
      note(c.x - R, c.x + R, c.y - R, c.y + R);
    }
  });
  const cx = 0.45 * BLOB_W;
  const cy = 0.5 * BLOB_H;
  for (const o of EDGE_STARS) {
    for (const c of corners(o.disc)) {
      const vx = c.x - cx;
      const vy = c.y - cy;
      const L = Math.hypot(vx, vy) || 1;
      const sx = c.x + (vx / L) * c.r * 0.85;
      const sy = c.y + (vy / L) * c.r * 0.85;
      const half = o.size / 2;
      note(sx - half, sx + half, sy - half, sy + half);
    }
  }
  const PAD = 8; // a little slack so a sprite's outermost pixel never sits exactly on the edge
  return { l: l + PAD, r: r + PAD, t: t + PAD, b: b + PAD };
})();

const CANVAS_W = BLOB_W + MARGIN.l + MARGIN.r;
const CANVAS_H = BLOB_H + MARGIN.t + MARGIN.b;
const ASPECT = CANVAS_W / CANVAS_H;
// Where the blob's own box sits inside the canvas, as fractions.
const BOX = {
  x: MARGIN.l / CANVAS_W,
  y: MARGIN.t / CANVAS_H,
  w: BLOB_W / CANVAS_W,
  h: BLOB_H / CANVAS_H
};

// Maps the blob's normalised coordinates into its box inside the canvas.
function discsAt(t, amount, W, H) {
  return DISCS.map((d, i) => {
    const m = MOTION[i];
    const a = t * m.speed + m.phase;
    const b = t * m.speed * 0.63 + m.drift;
    const nx = d.x + Math.sin(b) * m.ampX * amount;
    const ny = d.y + Math.cos(a * 0.8 + m.drift) * m.ampY * amount;
    const osc = Math.sin(a) * 0.65 + Math.sin(b * 1.7) * 0.35;
    const nr = Math.max(d.r * 0.12, d.r * (1 + osc * m.ampRFrac * amount));
    return {
      x: (BOX.x + nx * BOX.w) * W,
      y: (BOX.y + ny * BOX.h) * H,
      r: nr * BOX.w * W
    };
  });
}

export default function AboutBlob({ className = '' }) {
  const { currentDesign, previewUrl, queueReady, renderDesignBlob } = useStudio();
  const hostRef = useRef(null);
  const canvasRef = useRef(null);
  const artRef = useRef(null);
  const assetsRef = useRef({ logo: null, star: null, tint: new Map() });
  const visibleRef = useRef(true);
  // Lets the async loaders repaint. Necessary because under prefers-reduced-motion there is
  // no rAF loop at all, so the one static frame would otherwise be painted before the assets
  // and the artwork have arrived, and never repainted.
  const redrawRef = useRef(null);
  // Reveal state. `alphaRef` is the one-time entrance; `mixRef` crossfades old artwork to
  // new without the blob ever leaving.
  const alphaRef = useRef({ v: 0 });
  const mixRef = useRef({ v: 0 });
  const incomingRef = useRef(null);
  // A newly rendered design waits here until the shared reveal beat arrives, and the beat
  // waits here if it arrives first -- either order is possible, so whichever lands last
  // triggers the crossfade.
  const readyArtRef = useRef(null);
  const armedRef = useRef(false);
  const beatRef = useRef(null);
  const seenPreviewRef = useRef(null);
  const [failed, setFailed] = useState(false);

  // Crossfades the artwork inside the blob, holding the silhouette, logo and stars on screen
  // throughout. Deliberately NOT useCrossfadeImage's fade-out / blank-hold / fade-in: that is
  // right for surfaces which ARE an image, but a second of empty page where the blob had been
  // reads as breakage. TshirtPreview hit this exact wall -- its dip-out/return was rejected
  // and replaced by a texture-level crossfade that never removes the shirt.
  //
  // Both artworks are opaque and fill the same rect, the outgoing one at full alpha
  // underneath, so nothing shows through mid-fade and no backing colour is needed.
  const crossfadeTo = useCallback(img => {
    incomingRef.current = img;
    gsap.killTweensOf(mixRef.current);
    mixRef.current.v = 0;
    gsap.to(mixRef.current, {
      v: 1,
      duration: DURATION_SLOW,
      ease: 'power2.inOut',
      onUpdate: () => redrawRef.current?.(),
      onComplete: () => {
        artRef.current = incomingRef.current;
        incomingRef.current = null;
        mixRef.current.v = 0;
        redrawRef.current?.();
      }
    });
  }, []);

  const commit = useCallback(() => {
    if (!armedRef.current || !readyArtRef.current) return;
    const img = readyArtRef.current;
    readyArtRef.current = null;
    armedRef.current = false;
    crossfadeTo(img);
  }, [crossfadeTo]);

  // The reveal is driven by StudioContext.previewUrl, NOT by currentDesign. currentDesign
  // changes the instant Generate is clicked and this component's own small render finishes
  // long before the studio's full-size one, so keying off it swapped the artwork early and
  // out of step with every other surface -- the same misalignment TshirtPreview was rejected
  // for. previewUrl is the beat MiniGenerator, the footer and the mobile nav all reveal on.
  //
  // Offset by DURATION_FAST + DURATION_HOLD so the crossfade STARTS exactly when their
  // fade-in starts and ends with it, having spent their fade-out and hold showing the
  // previous design instead of nothing.
  useEffect(() => {
    if (!previewUrl) return;
    if (seenPreviewRef.current === null) {
      seenPreviewRef.current = previewUrl;
      return;
    }
    if (previewUrl === seenPreviewRef.current) return;
    seenPreviewRef.current = previewUrl;
    if (!artRef.current) return; // nothing on screen yet -- the entrance path covers it
    beatRef.current?.kill();
    armedRef.current = false;
    beatRef.current = gsap.delayedCall(DURATION_FAST + DURATION_HOLD, () => {
      armedRef.current = true;
      commit();
    });
  }, [previewUrl, commit]);

  const startReveal = useCallback(
    img => {
      if (!artRef.current) {
        // First artwork: nothing to cross from, so the whole composition eases in once. Until
        // then draw() paints nothing, rather than an empty outline waiting to be filled.
        artRef.current = img;
        gsap.killTweensOf(alphaRef.current);
        gsap.fromTo(
          alphaRef.current,
          { v: 0 },
          { v: 1, duration: DURATION_SLOW, ease: 'power2.inOut', onUpdate: () => redrawRef.current?.() }
        );
        return;
      }
      readyArtRef.current = img;
      commit();
    },
    [commit]
  );

  useEffect(
    () => () => {
      gsap.killTweensOf(alphaRef.current);
      gsap.killTweensOf(mixRef.current);
      beatRef.current?.kill();
    },
    []
  );

  // Load the two static assets once. The logo is an SVG drawn straight to canvas, which
  // browsers handle natively since it carries no external references.
  useEffect(() => {
    let cancelled = false;
    const load = src =>
      new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = src;
      });
    Promise.all([load(logoUrl), load(starUrl)])
      .then(([logo, star]) => {
        if (cancelled) return;
        assetsRef.current.logo = logo;
        assetsRef.current.star = star;
        redrawRef.current?.();
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Re-render the artwork whenever the design changes.
  //
  // Deliberately WITHOUT highDensity. It was used here at first and caused a visible stall:
  // renderDesignBlob runs generateArtwork/renderArtwork synchronously on the main thread, so
  // the cost lands as a frozen rAF loop -- the blob's drift visibly stopped, resumed, and only
  // then crossfaded. highDensity forces generation at DISPLAY_RENDER_CAP (a 2000px long edge,
  // 2.79Mpx here) regardless of the output size, which is ~12x the 480x480 the ambient preview
  // every other surface shows costs.
  //
  // That flag is opt-in precisely so hot paths which re-render on every design change don't
  // pay it (see its comment in StudioContext) -- this is one of those paths, so opting in was
  // the mistake. At 1100px wide the composition is still denser than the shared 480px preview
  // the footer and mini generator display, so nothing here looks sparser than its neighbours.
  useEffect(() => {
    if (!queueReady || !currentDesign) return;
    let cancelled = false;
    let url = null;
    // Generated at the CANVAS's aspect, not the blob's. The discs extend a little past the
    // blob's own box (the rightmost reaches 1.0006 of it before any wobble), so artwork drawn
    // only into that box leaves those slivers empty and the page shows through. Filling the
    // whole canvas always covers the clip, and generating at the aspect it will be drawn at
    // keeps the composition undistorted -- generateArtwork is ratio-aware, so this is a
    // recompose for that ratio rather than a stretch of another one.
    const width = ART_CAP;
    const height = Math.round(width / ASPECT);
    renderDesignBlob(currentDesign, width, height)
      .then(blob => {
        if (cancelled) return null;
        url = URL.createObjectURL(blob);
        return new Promise((resolve, reject) => {
          const img = new Image();
          img.onload = () => resolve(img);
          img.onerror = reject;
          img.src = url;
        });
      })
      .then(img => {
        if (cancelled || !img) return;
        startReveal(img);
      })
      .catch(() => {
        /* leave the previous artwork in place rather than blanking the panel */
      })
      .finally(() => {
        if (url) URL.revokeObjectURL(url);
      });
    return () => {
      cancelled = true;
    };
  }, [currentDesign, queueReady, renderDesignBlob, startReveal]);

  useEffect(() => {
    const host = hostRef.current;
    const canvas = canvasRef.current;
    if (!host || !canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      setFailed(true);
      return;
    }

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    // Tinting the project's own star sprite rather than drawing a synthetic flare: the sprite
    // is dark-with-alpha and StarField.js uses it as a mask, so its alpha already carries the
    // exact four-point flare and falloff. Cached per colour+size; the sizes are stable.
    function tinted(color, size) {
      const { tint, star } = assetsRef.current;
      const key = `${color}:${size}`;
      let c = tint.get(key);
      if (c) return c;
      c = document.createElement('canvas');
      c.width = size;
      c.height = size;
      const g = c.getContext('2d');
      g.drawImage(star, 0, 0, size, size);
      g.globalCompositeOperation = 'source-in';
      g.fillStyle = color;
      g.fillRect(0, 0, size, size);
      tint.set(key, c);
      return c;
    }

    function placeFlare(rnd, discs) {
      const d = discs[Math.floor(rnd() * 5)];
      const ang = rnd() * Math.PI * 2;
      const rad = Math.sqrt(rnd()) * d.r * 0.78;
      return { x: d.x + Math.cos(ang) * rad, y: d.y + Math.sin(ang) * rad };
    }

    function draw(t) {
      const { logo, star } = assetsRef.current;
      const W = canvas.width;
      const H = canvas.height;
      if (!W || !H) return;
      const S = (W * BOX.w) / BLOB_W;
      ctx.clearRect(0, 0, W, H);
      // Nothing is drawn before the first artwork lands -- otherwise the outline, logo and
      // stars would sit there as an empty shell waiting to be filled. `A` is the one-time
      // entrance only; after that it rests at 1 and the crossfade is `mix`.
      const A = alphaRef.current.v;
      if (!artRef.current || A <= 0) return;

      const discs = discsAt(t, reduced ? 0 : MOTION_AMOUNT, W, H);

      // Stroke every disc, then paint the artwork over the interior -- what survives is the
      // union's outer edge, with the interior arcs covered.
      ctx.strokeStyle = OUTLINE;
      ctx.lineWidth = 5 * S;
      ctx.lineJoin = 'round';
      ctx.globalAlpha = A;
      for (const d of discs) {
        ctx.beginPath();
        ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2);
        ctx.stroke();
      }

      ctx.save();
      ctx.beginPath();
      for (const d of discs) {
        ctx.moveTo(d.x + d.r, d.y);
        ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2);
      }
      ctx.clip();
      ctx.globalAlpha = A;
      ctx.drawImage(artRef.current, 0, 0, W, H);
      if (incomingRef.current && mixRef.current.v > 0) {
        ctx.globalAlpha = A * mixRef.current.v;
        ctx.drawImage(incomingRef.current, 0, 0, W, H);
      }
      if (star) {
        let s = 12345;
        const rnd = () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296);
        for (const f of INNER_FLARES) {
          const size = Math.round(f.size * S);
          if (size < 2) continue;
          const { x, y } = placeFlare(rnd, discs);
          ctx.globalAlpha = f.a * A;
          ctx.drawImage(tinted(f.c, size), x - size / 2, y - size / 2);
        }
        ctx.globalAlpha = A;
      }
      ctx.restore();

      // Unclipped, so these spill past the silhouette and tie it to the page. Anchored to a
      // disc and pushed outward from the blob's centroid, so they ride the same motion as the
      // edge they overlap instead of the blob sliding underneath them.
      if (star) {
        const cx = 0.45 * W;
        const cy = 0.5 * H;
        for (const o of EDGE_STARS) {
          const d = discs[o.disc];
          const vx = d.x - cx;
          const vy = d.y - cy;
          const L = Math.hypot(vx, vy) || 1;
          const size = Math.round(o.size * S);
          if (size < 2) continue;
          ctx.globalAlpha = o.a * A;
          ctx.drawImage(
            tinted(o.c, size),
            d.x + (vx / L) * d.r * 0.85 - size / 2,
            d.y + (vy / L) * d.r * 0.85 - size / 2
          );
        }
        ctx.globalAlpha = 1;
      }

      if (logo) {
        const lh = H * BOX.h * 0.62;
        const lw = (logo.naturalWidth / logo.naturalHeight) * lh;
        ctx.save();
        ctx.globalAlpha = 0.88 * A;
        ctx.shadowColor = 'rgba(0,0,0,0.55)';
        ctx.shadowBlur = 18 * S;
        ctx.drawImage(
          logo,
          (BOX.x + 0.53 * BOX.w) * W - lw / 2,
          (BOX.y + 0.5 * BOX.h) * H - lh / 2,
          lw,
          lh
        );
        ctx.restore();
      }
    }

    function resize() {
      const rect = host.getBoundingClientRect();
      if (!rect.width) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2) * SUPERSAMPLE;
      const cssW = rect.width;
      const w = Math.min(CANVAS_CAP, Math.round(cssW * dpr));
      canvas.width = w;
      canvas.height = Math.round(w / ASPECT);
      canvas.style.height = `${Math.round(cssW / ASPECT)}px`;
      draw(lastT);
    }

    let raf = 0;
    let start = null;
    let lastT = 0;
    function frame(ts) {
      if (start === null) start = ts;
      lastT = (ts - start) / 1000;
      if (visibleRef.current) draw(lastT);
      raf = requestAnimationFrame(frame);
    }

    const ro = new ResizeObserver(resize);
    ro.observe(host);
    resize();

    // Off-screen the canvas keeps its last frame but stops burning rAF time -- this sits in a
    // long scrolling page and is usually not on screen. Root is the real scroll ancestor, not
    // the viewport: html/body are overflow:hidden site-wide (the studio needs a locked
    // full-bleed canvas), so the homepage scrolls its own div -- the same
    // closest('.overflow-y-auto') lookup useScrollTriggerReveal and GalleryPage both do.
    const io = new IntersectionObserver(
      entries => {
        visibleRef.current = entries[0]?.isIntersecting ?? true;
      },
      { root: host.closest('.overflow-y-auto') || null, rootMargin: '120px' }
    );
    io.observe(host);

    redrawRef.current = () => draw(lastT);

    if (reduced) {
      draw(0);
    } else {
      raf = requestAnimationFrame(frame);
    }

    return () => {
      redrawRef.current = null;
      if (raf) cancelAnimationFrame(raf);
      ro.disconnect();
      io.disconnect();
    };
  }, []);

  if (failed) return null;

  return (
    <div ref={hostRef} className={className}>
      <canvas ref={canvasRef} className="block w-full" aria-hidden="true" />
    </div>
  );
}
