import { coverCanvas, layoutFacets, drawFacets } from '../components/ui/facetMosaic';
import { rampTime, rampRush, RAMP_FLOOR_3D } from '../utils/speedRamp';
import { resolveDesignPalette } from '../render/resolvedPalette';
import { SCENE_DURATION, SEAM_LEAD, AD_WIDTH, AD_HEIGHT } from './adTimeline';
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
// The stretch of the loop the flight shows at full speed: SEAM_LEAD after the seam to SEAM_LEAD
// before it (see drawFlight).
const FLIGHT_WINDOW = SCENE_DURATION - 2 * SEAM_LEAD;
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
  // The preview draws at half size, and its frame is shown stretched to fit the window -- which
  // made the lockup's text and hairline soft. So in the preview the lockup gets a layer of its
  // own at the export's full size, covering only its band of the frame.
  const lockupScale = layered ? AD_WIDTH / width : 1;
  const lockup = await createLockup({
    width: width * lockupScale,
    height: height * lockupScale,
    palette: resolveDesignPalette(design)
  });
  let lockupCanvas = null;
  if (layered) {
    lockupCanvas = document.createElement('canvas');
    lockupCanvas.width = AD_WIDTH;
    lockupCanvas.height = lockup.bandHeight;
    Object.assign(lockupCanvas.style, {
      position: 'absolute',
      left: '0',
      width: '100%',
      height: `${(lockup.bandHeight / AD_HEIGHT) * 100}%`,
      pointerEvents: 'none'
    });
  }

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
    lockupCanvas?.remove();
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
  // The glints outline whole triangles. Over a photo that fills the frame they read as light
  // catching the facets, as on the product page; around a cutout or a card most of each
  // triangle is empty sky, so they drew loose white outlines around the product. Only a photo
  // that covers the frame gets them.
  const glintOf = sprite => (sprite.covers ? glint : 0);
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

  // Whether a full-frame layer hides everything behind it. A Full frame fit is only that for a
  // photo with no transparency: a Printful PNG cutout cover-fitted to the frame is still a person
  // on a clear background, and treating it as opaque left the outgoing product standing behind
  // the incoming one for the whole cut, then popping out, and stopped drawing the flight once it
  // landed. Sampled small, so a clear patch averages below 255 and still counts.
  function coversFrame(canvas) {
    const sw = Math.ceil(width / 8);
    const sh = Math.ceil(height / 8);
    const c = document.createElement('canvas');
    c.width = sw;
    c.height = sh;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(canvas, 0, 0, sw, sh);
    const d = ctx.getImageData(0, 0, sw, sh).data;
    for (let k = 3; k < d.length; k += 4) if (d[k] < 250) return false;
    return true;
  }

  // A product photo placed on a transparent full frame, once; every frame then draws it with
  // that frame's motion. `origin` is the point it scales and rocks about. `covers` says it hides
  // everything under it once it has landed.
  function buildSprite(img, fit, bands) {
    if (fit === 'full') {
      const canvas = coverCanvas(img, width, height);
      const covers = coversFrame(canvas);
      return {
        kind: 'full',
        canvas,
        origin: [width / 2, height / 2],
        floats: false,
        covers,
        visible: covers ? null : coverage(canvas)
      };
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
    return { kind: 'layer', canvas: c, origin, floats, covers: false, visible: coverage(c) };
  }

  const images = new Map(); // url -> decoded Image, so a layout change re-places without reloading
  let sprites = [];
  // Only the latest call lands: decodes finish in any order, and an older list arriving last
  // would put photos the ad no longer has back on screen, in the new list's slots.
  let photosToken = 0;
  /** @param {Array<{ url: string, fit?: string }>} photos */
  async function setPhotos(photos, { position = 'top', showText = true } = {}) {
    const token = ++photosToken;
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
    if (token !== photosToken) return;
    sprites = photos.map(({ fit }, i) => buildSprite(imgs[i], fit || 'cutout', bands));
  }

  // The flight ends SEAM_LEAD before its loop seam, still slowing as the first product arrives,
  // and then carries on at a fraction of real time behind the products.
  //
  // It never reaches back further than SEAM_LEAD AFTER the seam, where the camera is moving at the
  // same pace it lands at: one arc that builds, peaks and slows into the first product. A flight
  // longer than that stretch (FLIGHT_WINDOW) plays it slower rather than start earlier, because
  // starting earlier passes through the seam, where the ramp all but stops the camera -- a long
  // flight at a slow tempo stalled on screen partway through, or opened nearly frozen (4 bars at
  // 110bpm opened at 0.03x; 3 bars at 70bpm stopped 1.8s in). A flight that fits plays exactly as
  // before.
  function drawFlight(ctx, t, timeline) {
    const cut = SCENE_DURATION - SEAM_LEAD;
    const rate = Math.min(1, FLIGHT_WINDOW / timeline.flight);
    const tau =
      t < timeline.flight
        ? cut - timeline.flight * rate + t * rate
        : cut + (t - timeline.flight) * BG_DRIFT;
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
      // An opaque photo that has landed covers everything; nothing else needs drawing.
      if (!cur.covers || cutting) drawFlight(ctx, t, timeline);
      if (cutting) {
        if (i > 0) {
          if (cur.covers) {
            // An opaque frame assembles over the outgoing product as it stands -- by the end of
            // the cut nothing of it shows, so it can simply stop being drawn.
            drawProduct(ctx, i - 1, t, timeline);
          } else {
            const out = clamp01(local / (BREAK_FRACTION * seg.transition));
            drawFacets(ctx, layout, layerAt(0, i - 1, t, timeline), 1 - out, glintOf(sprites[i - 1]), sprites[i - 1].visible);
          }
        }
        drawFacets(ctx, layout, layerAt(1, i, t, timeline), local / seg.transition, glintOf(cur), cur.visible);
      } else {
        drawProduct(ctx, i, t, timeline);
      }
    }

    drawLockup(ctx, t, timeline, overlay);
  }

  let lockupTop = null;
  function drawLockup(ctx, t, timeline, overlay) {
    const lc = lockupCanvas?.getContext('2d');
    if (lc) lc.clearRect(0, 0, lockupCanvas.width, lockupCanvas.height);
    if (!overlay.show) return;
    const products = timeline.products.slice(0, sprites.length);
    // One beat after the first product's downbeat, so the brand arrives on the next beat;
    // with no products, near the end. CHROMA's hue wave runs on every later cut.
    const o = {
      appearAt: products.length ? products[0].start + timeline.beat : timeline.total - 1.5,
      beat: timeline.beat,
      cuts: products.slice(1).map(p => p.start),
      url: overlay.text,
      top: frameBands(overlay.position, true).lockupTop * height * lockupScale
    };
    if (!lc) return lockup.draw(ctx, t, o);
    // The layer covers the band, from a margin above the lockup's top.
    const at = Math.round(o.top) - lockup.margin;
    if (at !== lockupTop) {
      lockupTop = at;
      lockupCanvas.style.top = `${(at / AD_HEIGHT) * 100}%`;
    }
    lockup.draw(lc, t, { ...o, top: o.top - at });
  }

  if (layered) {
    const c = renderer.domElement;
    c.style.position = 'absolute';
    c.style.inset = '0';
    c.style.width = '100%';
    c.style.height = '100%';
  }
  return {
    width,
    height,
    draw,
    setPhotos,
    dispose: release,
    flightCanvas: layered ? renderer.domElement : null,
    lockupCanvas
  };
}
