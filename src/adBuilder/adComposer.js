import { coverCanvas, layoutFacets, drawFacets } from '../components/ui/facetMosaic';
import { rampTime, rampRush, RAMP_FLOOR_3D } from '../utils/speedRamp';
import { resolveDesignPalette } from '../render/resolvedPalette';
import { SCENE_DURATION, SEAM_LEAD } from './adTimeline';
import { createLockup, LOCKUP_BAND } from './lockup';

// Draws any frame of an ad from its time alone -- the preview and the MP4 export both call
// draw(ctx, t), so the file is exactly what was previewed (the studio's rule for its own
// animations). One composer per output size: the preview's runs the flight's cached path, the
// export's runs it `exact`, which redraws every plate every frame at full resolution.
//
// A frame is up to three layers: the flight (always running -- behind the products it keeps drifting
// slowly behind the products, so the artwork never freezes), the product photo, and the
// brand lockup.

// Meta's Reels safe zone: the top 14% and bottom 35% of the frame sit under Instagram's own UI
// (the header, the caption and the audio line), so nothing that has to be read goes there.
export const SAFE_TOP = 0.14;
export const SAFE_BOTTOM = 0.35;

// How fast the flight's own clock runs behind the products, against real time. It slows on into
// the seam, nearly stopped there, and builds again after it -- this keeps it a drift, not a rush.
const BG_DRIFT = 0.35;
// Slow push-in over a product's time on screen. There is deliberately no pulse on the beat: one
// was tried and rejected on sight (Aaron, 2026-10-06: "weird and creepy") -- a garment, and worse a
// person, throbbing to the music reads as breathing, not rhythm.
const PUSH = { full: 0.05, layer: 0.03 };
// A floating product bobs and rocks once every two bars.
const BOB = 0.006;
const ROCK = (0.5 * Math.PI) / 180;
// The outgoing product breaks apart over the first part of a cut while the next assembles.
const BREAK_FRACTION = 0.6;

const FLOAT_MAX_WIDTH = 0.84;
const CARD_MAX_WIDTH = 0.8;
const clamp01 = x => (x < 0 ? 0 : x > 1 ? 1 : x);

// The bands of the frame (fractions of its height) the lockup and the products occupy. Products
// keep clear of the lockup, so the text never sits on a product.
function frameBands(position, showText) {
  const top = SAFE_TOP;
  const bottom = 1 - SAFE_BOTTOM;
  if (!showText) return { lockupTop: 0, product: [top + 0.01, bottom] };
  if (position === 'bottom') {
    return { lockupTop: bottom - LOCKUP_BAND, product: [top + 0.01, bottom - LOCKUP_BAND - 0.012] };
  }
  return { lockupTop: top + 0.004, product: [top + 0.004 + LOCKUP_BAND + 0.012, bottom] };
}

// The opaque bounds of an image with transparency, and whether it runs off the image's bottom
// edge -- Printful frames its on-model shots at mid-thigh, so a person ends in a hard edge there.
function analyseAlpha(img) {
  const s = Math.min(1, 512 / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.round(img.naturalWidth * s));
  const h = Math.max(1, Math.round(img.naturalHeight * s));
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, w, h);
  const d = ctx.getImageData(0, 0, w, h).data;
  let x0 = w, y0 = h, x1 = -1, y1 = -1, clear = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const a = d[(y * w + x) * 4 + 3];
      if (a < 24) {
        clear++;
        continue;
      }
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (x1 < 0) return { x: 0, y: 0, w: img.naturalWidth, h: img.naturalHeight, transparent: false, toBottom: false };
  const k = 1 / s;
  return {
    x: x0 * k,
    y: y0 * k,
    w: (x1 - x0 + 1) * k,
    h: (y1 - y0 + 1) * k,
    // A photo with no real transparency is placed like a card without the panel.
    transparent: clear / (w * h) > 0.02,
    toBottom: y1 >= h - 2
  };
}

// `layered` is for the PREVIEW: the flight is not copied into the frame but left on its own WebGL
// canvas (`flightCanvas`, which the page shows underneath), and draw() paints everything else onto
// a transparent canvas laid over it. Copying a WebGL canvas into a 2D one every frame is a
// read-back, and in Safari -- which runs canvas and WebGL in a separate GPU process -- that read-back
// is the likeliest reason the whole window crawled while the preview played. The export composites
// into one canvas, as it must.
/**
 * @param {{ design: { seed: string, colors?: string[], settings?: any }, width: number, height: number, exact: boolean, layered?: boolean }} o
 */
export async function createAdComposer({ design, width, height, exact, layered = false }) {
  const [{ WebGLRenderer }, { createTunnelScene, warmTunnelStars }] = await Promise.all([
    import('three'),
    import('../animation3d/tunnelScene')
  ]);
  // The star layout is ~500ms of one task the first time a loop length is seen; warming it in
  // slices keeps the page responsive while the preview builds (see tunnelScene).
  await warmTunnelStars(SCENE_DURATION);
  const lockup = await createLockup({ width, height, palette: resolveDesignPalette(design) });

  const renderer = new WebGLRenderer({ antialias: true });
  let world = null;
  let released = false;
  // Idempotent: the export releases it before flushing the encoder, and again in its finally.
  const release = () => {
    if (released) return;
    released = true;
    world?.dispose();
    world = null;
    renderer.dispose();
    // dispose() alone leaves the context alive until GC -- see Animation3DPreview
    renderer.forceContextLoss();
    renderer.domElement.remove();
  };
  try {
    renderer.setPixelRatio(1);
    renderer.setSize(width, height, false);
    world = createTunnelScene({
      seed: design.seed,
      colors: design.colors || [],
      settings: design.settings ?? null,
      duration: SCENE_DURATION,
      width,
      height,
      exact
    });
    await world.ready;
  } catch (e) {
    release();
    throw e;
  }

  // Facets assemble from the centre. The glint is FacetSwap's 1.5 CSS px, scaled as if the
  // video were shown 390px wide (a phone).
  const layout = layoutFacets(width, height, width / 2, height / 2);
  const glint = (1.5 * width) / 390;
  const scratch = [0, 1].map(() => {
    const c = document.createElement('canvas');
    c.width = width;
    c.height = height;
    return c;
  });

  // Which facets of a layer have anything in them, so a cut draws no glints over empty sky.
  function coverage(canvas) {
    const sw = Math.ceil(width / 12);
    const sh = Math.ceil(height / 12);
    const c = document.createElement('canvas');
    c.width = sw;
    c.height = sh;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(canvas, 0, 0, sw, sh);
    const d = ctx.getImageData(0, 0, sw, sh).data;
    return layout.tris.map(tr => {
      const x0 = Math.floor(tr.bx / 12);
      const y0 = Math.floor(tr.by / 12);
      const x1 = Math.min(sw - 1, Math.ceil((tr.bx + tr.bw) / 12));
      const y1 = Math.min(sh - 1, Math.ceil((tr.by + tr.bh) / 12));
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (d[(y * sw + x) * 4 + 3] > 16) return true;
      return false;
    });
  }

  // A product photo placed on a transparent full frame, once; every frame then draws it with
  // that frame's motion. `origin` is the point it scales and rocks about.
  function buildSprite(img, fit, bands) {
    if (fit === 'full') {
      return { kind: 'full', canvas: coverCanvas(img, width, height), origin: [width / 2, height / 2], floats: false, visible: null };
    }
    const c = document.createElement('canvas');
    c.width = width;
    c.height = height;
    const ctx = c.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    const [bandTop, bandBottom] = bands.product.map(f => f * height);
    const bandH = bandBottom - bandTop;
    const iw = img.naturalWidth;
    const ih = img.naturalHeight;
    let origin;
    let floats = true;

    if (fit === 'card') {
      const s = Math.min((width * CARD_MAX_WIDTH) / iw, bandH / ih);
      const w = iw * s;
      const h = ih * s;
      const x = (width - w) / 2;
      const y = (bandTop + bandBottom) / 2 - h / 2;
      const r = width * 0.03;
      ctx.save();
      ctx.shadowColor = 'rgba(0, 0, 0, 0.45)';
      ctx.shadowBlur = width * 0.05;
      ctx.shadowOffsetY = width * 0.015;
      ctx.beginPath();
      ctx.roundRect(x, y, w, h, r);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.restore();
      ctx.save();
      ctx.beginPath();
      ctx.roundRect(x, y, w, h, r);
      ctx.clip();
      ctx.drawImage(img, x, y, w, h);
      ctx.restore();
      origin = [width / 2, y + h / 2];
    } else {
      // Cutout: placed by its own opaque bounds, not the photo's padding.
      const b = analyseAlpha(img);
      const anchored = b.transparent && b.toBottom;
      ctx.save();
      ctx.shadowColor = 'rgba(0, 0, 0, 0.42)';
      if (anchored) {
        // An on-model shot rises out of the bottom edge, its head just under the lockup.
        const s = Math.min((height - bandTop) / b.h, (width * 0.96) / b.w);
        const dx = width / 2 - (b.x + b.w / 2) * s;
        const dy = height - (b.y + b.h) * s;
        ctx.shadowBlur = width * 0.03;
        ctx.drawImage(img, dx, dy, iw * s, ih * s);
        origin = [width / 2, height];
        floats = false;
      } else {
        const s = Math.min((width * FLOAT_MAX_WIDTH) / b.w, bandH / b.h);
        const dx = width / 2 - (b.x + b.w / 2) * s;
        const dy = (bandTop + bandBottom) / 2 - (b.y + b.h / 2) * s;
        ctx.shadowBlur = width * 0.04;
        ctx.shadowOffsetY = width * 0.022;
        if (b.transparent) {
          ctx.drawImage(img, dx, dy, iw * s, ih * s);
        } else {
          // A photo with no transparency of its own floats as a plain rounded rectangle.
          ctx.beginPath();
          ctx.roundRect(dx, dy, iw * s, ih * s, width * 0.02);
          ctx.fillStyle = '#000';
          ctx.fill();
          ctx.shadowColor = 'transparent';
          ctx.clip();
          ctx.drawImage(img, dx, dy, iw * s, ih * s);
        }
        origin = [width / 2, (bandTop + bandBottom) / 2];
      }
      ctx.restore();
    }
    return { kind: 'layer', canvas: c, origin, floats, visible: coverage(c) };
  }

  const images = new Map(); // url -> decoded Image, so a layout change re-places without reloading
  let sprites = [];
  /** @param {Array<{ url: string, fit?: string }>} photos */
  async function setPhotos(photos, { position = 'top', showText = true } = {}) {
    const bands = frameBands(position, showText);
    const imgs = await Promise.all(
      photos.map(async ({ url }) => {
        if (!images.has(url)) {
          const img = new Image();
          img.src = url;
          await img.decode();
          images.set(url, img);
        }
        return images.get(url);
      })
    );
    sprites = photos.map(({ fit }, i) => buildSprite(imgs[i], fit || 'cutout', bands));
  }

  // The flight ends SEAM_LEAD before its loop seam, still slowing as the first product arrives,
  // and then carries on at a fraction of real time behind the products.
  function drawFlight(ctx, t, timeline) {
    const cut = SCENE_DURATION - SEAM_LEAD;
    const tau = t < timeline.flight ? cut - timeline.flight + t : cut + (t - timeline.flight) * BG_DRIFT;
    world.setTime(rampTime(tau, SCENE_DURATION, RAMP_FLOOR_3D), rampRush(tau, SCENE_DURATION), false);
    world.render(renderer);
    // Same task as the render, so no preserveDrawingBuffer is needed.
    if (!layered) ctx.drawImage(renderer.domElement, 0, 0, width, height);
  }

  // A product's motion at time t: the push-in once it has landed and, for a floating one, a slow
  // bob and rock over two bars.
  function drawProduct(ctx, i, t, timeline) {
    const sp = sprites[i];
    const seg = timeline.products[i];
    const landed = seg.start + seg.transition;
    const kind = sp.kind === 'full' ? 'full' : 'layer';
    const s = 1 + (PUSH[kind] * Math.max(0, t - landed)) / Math.max(0.001, seg.end - landed);
    const phase = ((t - seg.start) / (2 * timeline.bar)) * 2 * Math.PI;
    const dy = sp.floats ? Math.sin(phase) * BOB * height : 0;
    const rot = sp.floats ? Math.sin(phase + 1) * ROCK : 0;
    const [ox, oy] = sp.origin;
    ctx.save();
    ctx.translate(ox, oy + dy);
    ctx.rotate(rot);
    ctx.scale(s, s);
    ctx.translate(-ox, -oy);
    ctx.drawImage(sp.canvas, 0, 0);
    ctx.restore();
  }

  function layerAt(slot, i, t, timeline) {
    const c = scratch[slot];
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, width, height);
    drawProduct(ctx, i, t, timeline);
    return c;
  }

  /**
   * @param {CanvasRenderingContext2D} ctx  a width x height canvas
   * @param {number} t  seconds into the ad
   * @param {{ timeline: ReturnType<typeof import('./adTimeline').adTimeline>, overlay: { text: string, position: string, show: boolean } }} o
   */
  function draw(ctx, t, { timeline, overlay }) {
    if (layered) ctx.clearRect(0, 0, width, height);
    const products = timeline.products.slice(0, sprites.length);
    let i = -1;
    for (let k = products.length - 1; k >= 0; k--) {
      if (t >= products[k].start) {
        i = k;
        break;
      }
    }

    if (i < 0) {
      drawFlight(ctx, t, timeline);
    } else {
      const seg = products[i];
      const local = t - seg.start;
      const cutting = local < seg.transition;
      const cur = sprites[i];
      // A full-frame photo that has landed covers everything; nothing else needs drawing.
      if (cur.kind !== 'full' || cutting) drawFlight(ctx, t, timeline);
      if (cutting) {
        if (i > 0) {
          if (cur.kind === 'full') {
            // A full frame assembles over the outgoing product as it stands.
            drawProduct(ctx, i - 1, t, timeline);
          } else {
            const out = clamp01(local / (BREAK_FRACTION * seg.transition));
            drawFacets(ctx, layout, layerAt(0, i - 1, t, timeline), 1 - out, glint, sprites[i - 1].visible);
          }
        }
        drawFacets(ctx, layout, layerAt(1, i, t, timeline), local / seg.transition, glint, cur.visible);
      } else {
        drawProduct(ctx, i, t, timeline);
      }
    }

    if (overlay.show) {
      // One beat after the first product's downbeat, so the brand arrives on the next beat;
      // with no products, near the end. CHROMA's hue wave runs as it lands and on every later cut.
      const appearAt = products.length ? products[0].start + timeline.beat : timeline.total - 1.5;
      const ripples = [appearAt + 0.15, ...products.slice(1).map(p => p.start)];
      const top = frameBands(overlay.position, true).lockupTop * height;
      lockup.draw(ctx, t, { top, appearAt, ripples, url: overlay.text });
    }
  }

  if (layered) {
    const c = renderer.domElement;
    c.style.position = 'absolute';
    c.style.inset = '0';
    c.style.width = '100%';
    c.style.height = '100%';
  }
  return { width, height, draw, setPhotos, dispose: release, flightCanvas: layered ? renderer.domElement : null };
}
