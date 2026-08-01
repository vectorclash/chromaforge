import React, { useEffect, useRef, useState } from 'react';
import { makeRng, randomSeed } from '../../render/prng';
import { paintShirtFill } from './aboutShirtFill';
import starLargeUrl from '../../assets/images/star-sprite-large.png';
import starSmallUrl from '../../assets/images/star-sprite-small.png';
import shirtSvg from '../../assets/images/shirt-solid-full.svg?raw';
import { drawAboutBackground } from './aboutBackground';

// The About section's printed-garment image: the 2021 illustration's background with its row
// of shirts redrawn live and scrolled as an infinite carousel, so it animates alongside
// AboutBlob instead of sitting static beside it.
//
// The shirts are MASKS, not pictures. There is one fixed image behind them (aboutShirtFill.js)
// and each shirt is an aperture onto whatever part of it that shirt currently covers, so the
// content flows through the row as it scrolls. This replaced six separately-generated artworks
// cycled one per shirt -- see that module's header for why, and note the consequence: the row
// is periodic over one pitch (SECONDS_PER_STEP) rather than over six of them, which is the
// deliberate tradeoff for matching the original illustration's look.
//
// The shirts are NOT masked to the hexagon field and their overhang is not trimmed -- the
// composition deliberately lets them cross it and run off the canvas edge, exactly as the
// original does with its rightmost shirt.
//
// Geometry measured off the original artwork: shirt width 138, top edge y=129, pitch 142.5,
// first shirt at x=84, in the image's own 650x366 space. Kept normalised so they survive any
// render size. Re-verified by stroking the outline below over the original -- it traces all
// four shirts.
const BOX_W = 650;
const BOX_H = 366;
const ASPECT = BOX_W / BOX_H;

// The shirt is Font Awesome's `shirt` (solid) glyph -- the exact shape the 2021 illustration
// was built from, which is why the row traces the original so precisely. Taken from the SVG
// asset itself rather than copied inline, so the file in assets/ stays the single source of
// truth for the silhouette.
//
// A previous version approximated this shape with hand-fitted bezier/arc parameters (IoU
// 0.959 against a mask extracted from the original). That is gone: it was only ever a
// reconstruction of a shape we now have exactly.
const SHIRT_PATH = shirtSvg.match(/\sd="([^"]+)"/)[1];
// The glyph's real ink bounds inside its 640x640 viewBox, measured by rasterising the path
// and reading the alpha extents. NOT the viewBox -- the artwork is inset within it, and
// scaling by the viewBox would leave the shirt floating small inside its box.
const SHIRT_BBOX = { x: 13.5, y: 96, w: 613, h: 479.5 };
const SHIRT_ASPECT = SHIRT_BBOX.w / SHIRT_BBOX.h; // 1.2784

const SHIRT = {
  w: 138 / BOX_W,
  // Height follows from the width and the glyph's own aspect rather than being measured
  // independently. The measurement said 109 and this says 107.9 -- within 1%, which is the
  // check that the original really is this glyph, and taking it from the path means the row
  // can never be drawn stretched.
  h: 138 / SHIRT_ASPECT / BOX_H,
  top: 129 / BOX_H,
  pitch: 142.5 / BOX_W,
  first: 84 / BOX_W
};

// Enough shirts to span the canvas plus one beyond each edge, so the row never shows a gap
// as it scrolls and a shirt is always sliding in before the previous one has left.
const COUNT = 8;
const SECONDS_PER_STEP = 4.5; // how long one shirt takes to travel one pitch
// The row fades out into the canvas edges instead of being cut off at them. Applied to the
// SHIRTS ONLY, not the backdrop: the hexagons are a fixed composition that ends where it
// ends, and fading them would just make the illustration look like it was printed badly.
// A fraction of the canvas width, so the fade is the same on any screen.
const EDGE_FADE = 0.11;
// Drawn at 2x the device's own pixel ratio and downsampled by the browser. Rendering at 1:1
// device pixels -- which is what "retina correct" usually means -- is not enough here: almost
// everything in this image is sub-pixel detail (dust specks land on 1-3 device px, the flare
// spikes are 2px wide, the shirt outline is hairline), and at 1:1 all of it aliases into
// stair-stepping. Supersampling is what antialiases it.
//
// Affordable because the backdrop is painted once into a cached canvas (see aboutBackground)
// and only the shirt row is redrawn per frame -- so 4x the pixels is 4x a handful of
// drawImage calls, not 4x a full repaint of the illustration.
const SUPERSAMPLE = 2;
const RENDER_CAP = 2400; // backing-store ceiling; 448 CSS x 2 dpr x 2 leaves headroom
// Maps the glyph's own units onto a shirt box on the canvas. Uniform scale, because the box's
// height is derived from the glyph's aspect above -- which is what lets the outline be
// stroked under this transform without the line width going oval.
function shirtTransform(ctx, x, y, w, h) {
  ctx.translate(x, y);
  ctx.scale(w / SHIRT_BBOX.w, h / SHIRT_BBOX.h);
  ctx.translate(-SHIRT_BBOX.x, -SHIRT_BBOX.y);
}

export default function AboutShirts({ className = '' }) {
  const hostRef = useRef(null);
  const canvasRef = useRef(null);
  const spritesRef = useRef({ large: null, small: null });
  // One seed per mount: the facets and stars in the fill differ on every page load, but stay
  // put for as long as anyone is looking at the row -- including across resizes, which rebuild
  // the fill at the new size from this same seed rather than reshuffling it.
  const fillSeedRef = useRef(randomSeed());
  const fillRef = useRef(null);
  const visibleRef = useRef(true);
  const redrawRef = useRef(null);
  const [failed, setFailed] = useState(false);

  // The hexagon backdrop is drawn procedurally (see aboutBackground.js) rather than loaded as
  // a PNG -- the PSD it came from is lost, so a rebuilt vector version is the only form that
  // can still be edited. Only the two star sprites are loaded.
  useEffect(() => {
    let cancelled = false;
    const load = src =>
      new Promise((resolve, reject) => {
        const el = new Image();
        el.onload = () => resolve(el);
        el.onerror = reject;
        el.src = src;
      });
    Promise.all([load(starLargeUrl), load(starSmallUrl)])
      .then(([large, small]) => {
        if (cancelled) return;
        spritesRef.current = { large, small };
        redrawRef.current?.();
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

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
    // Built once per mount rather than at module scope: Path2D is a browser API and this
    // module is imported by the home page's bundle, not only by a live canvas.
    const shirtPath = new Path2D(SHIRT_PATH);
    const makeCanvas = (cw, ch) => {
      const c = document.createElement('canvas');
      c.width = cw;
      c.height = ch;
      return c;
    };
    // The row is composited through its own layer so the edge fade can be a mask over the
    // finished shirts. Faded per shirt instead, each one would fade on its own schedule as it
    // crossed the boundary -- and the drop shadows, which are drawn in a separate pass from
    // the fill they belong to, would fade out of step with them.
    const layer = makeCanvas(1, 1);
    const lctx = layer.getContext('2d');
    // Set on resize and whenever the backdrop's own contents change (the star sprites
    // arriving rebuilds it), so the next frame restores the whole canvas instead of only the
    // strip the shirts move through.
    let needsFullPaint = true;

    // The strip the row can touch: the shirt box plus the drop shadow's reach on each side.
    // Everything outside it is backdrop that never changes.
    // Snapped to WHOLE canvas pixels, which is not cosmetic. Both users of this rect blit with
    // it -- the backdrop restore and the layer composite -- and a fractional edge makes
    // drawImage resample, blending the boundary row against what is outside the rect (nothing,
    // on the transparent layer). That left a faint dark hairline running the full width of the
    // canvas just below the shirt row. It also kept the two from agreeing: the backdrop already
    // floor/ceil'd its own copy, so the strip being restored and the strip being drawn over
    // were off by a pixel.
    function shirtBand(W, H) {
      const pad = 0.07 * SHIRT.w * W + 0.02 * SHIRT.h * H + 2;
      const y = Math.max(0, Math.floor(SHIRT.top * H - pad));
      const bottom = Math.min(H, Math.ceil(SHIRT.top * H + SHIRT.h * H + pad));
      return { y, h: bottom - y };
    }

    function draw(t) {
      const W = canvas.width;
      const H = canvas.height;
      if (!W || !H) return;
      const S = W / BOX_W;
      const band = shirtBand(W, H);
      // `t` also drives the named flares' twinkle -- they are the one part of the backdrop
      // that is no longer cached, and they restore/redraw their own boxes inside this call.
      drawAboutBackground(ctx, W, H, spritesRef.current, makeCanvas, needsFullPaint ? null : band, t);
      needsFullPaint = false;

      // The fill every shirt is a window onto: built once per size into a cached canvas, from
      // this mount's own seed. It needs the star sprites, which load async, so the row simply
      // doesn't draw until they land -- a beat later than the backdrop, and the backdrop is
      // waiting on the same two images anyway.
      const sprites = spritesRef.current;
      if (!sprites.large || !sprites.small) return;
      let fill = fillRef.current;
      if (!fill || fill.width !== W || fill.height !== H) {
        fill = makeCanvas(W, H);
        paintShirtFill(fill.getContext('2d'), W, H, sprites, makeCanvas, makeRng(fillSeedRef.current), {
          y: SHIRT.top,
          h: SHIRT.h
        });
        fillRef.current = fill;
      }

      if (layer.width !== W || layer.height !== H) {
        layer.width = W;
        layer.height = H;
      } else {
        lctx.clearRect(0, band.y, W, band.h);
      }

      const pitch = SHIRT.pitch * W;
      const travelled = (t / SECONDS_PER_STEP) * pitch;
      const offset = travelled % pitch;
      const w = SHIRT.w * W;
      const h = SHIRT.h * H;
      const y = SHIRT.top * H;

      for (let i = -1; i < COUNT - 1; i++) {
        const x = SHIRT.first * W + i * pitch - offset;

        lctx.save();
        // Shadow on the silhouette itself, so it travels with the shirt rather than being
        // baked into the background where it would sit still while the shirt moved.
        // Blur and offset are deliberately NOT divided by the transform's scale: per spec
        // they are applied in the output bitmap's space, not the current user space.
        lctx.shadowColor = 'rgba(0,0,0,0.45)';
        lctx.shadowBlur = 0.07 * w;
        lctx.shadowOffsetY = 0.02 * h;
        lctx.fillStyle = '#000';
        shirtTransform(lctx, x, y, w, h);
        lctx.fill(shirtPath);
        lctx.restore();

        lctx.save();
        shirtTransform(lctx, x, y, w, h);
        lctx.clip(shirtPath);
        // This is the mask: back to device space and blit the ONE fill canvas at 1:1, so the
        // shirt shows whatever part of the fixed image it currently sits over. The clip
        // survives the transform reset -- it is held in device space once set.
        lctx.setTransform(1, 0, 0, 1, 0, 0);
        lctx.drawImage(fill, 0, 0);
        lctx.restore();

        lctx.save();
        shirtTransform(lctx, x, y, w, h);
        lctx.strokeStyle = 'rgba(24,21,32,0.55)';
        // Line width IS in user space, so it has to be pre-divided by the scale to come out
        // at the intended thickness on screen.
        lctx.lineWidth = Math.max(1, 1.4 * S) / (w / SHIRT_BBOX.w);
        lctx.stroke(shirtPath);
        lctx.restore();
      }

      // Erased from the edges with destination-OUT over just the two fade bands, rather than
      // kept with a destination-in pass over the whole canvas. Same result, but it touches
      // 22% of the pixels instead of 100% -- which matters at the supersampled size, where a
      // full-canvas composite per frame is 4x what it used to be.
      const fade = EDGE_FADE * W;
      lctx.save();
      lctx.globalCompositeOperation = 'destination-out';
      for (const [from, to] of [[0, fade], [W, W - fade]]) {
        const g = lctx.createLinearGradient(from, 0, to, 0);
        g.addColorStop(0, '#000');
        g.addColorStop(1, 'rgba(0,0,0,0)');
        lctx.fillStyle = g;
        lctx.fillRect(Math.min(from, to), band.y, fade, band.h);
      }
      lctx.restore();
      ctx.drawImage(layer, 0, band.y, W, band.h, 0, band.y, W, band.h);
    }

    function resize() {
      const rect = host.getBoundingClientRect();
      if (!rect.width) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2) * SUPERSAMPLE;
      const w = Math.min(RENDER_CAP, Math.round(rect.width * dpr));
      canvas.width = w;
      canvas.height = Math.round(w / ASPECT);
      canvas.style.height = `${Math.round(rect.width / ASPECT)}px`;
      needsFullPaint = true;
      fillRef.current = null;
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

    const io = new IntersectionObserver(
      entries => {
        visibleRef.current = entries[0]?.isIntersecting ?? true;
      },
      { root: host.closest('.overflow-y-auto') || null, rootMargin: '120px' }
    );
    io.observe(host);

    redrawRef.current = () => {
      // The sprites or a new artwork just landed. Both change the cached backdrop, so this
      // frame has to restore all of it, not just the band.
      needsFullPaint = true;
      draw(lastT);
    };
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
