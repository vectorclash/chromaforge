import { coverCanvas, layoutFacets } from '../components/ui/facetMosaic';
import { rampTime, rampRush, RAMP_FLOOR_3D } from '../utils/speedRamp';
import { resolveDesignPalette } from '../render/resolvedPalette';
import { SCENE_DURATION, SEAM_LEAD, AD_FPS, AD_WIDTH, AD_HEIGHT, adLayout } from './adTimeline';
import { createLockup } from './lockup';
import { createShutter } from './shutter';
import { createCutShader } from './cutShader';

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
export { SAFE_TOP, SAFE_BOTTOM } from './adTimeline';

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
// Motion blur on the products and the lockup: how long the shutter is open, as a fraction of a frame
// (1 is a full 360 degrees, the explainer's Heavy). Never the flight: it is rendered once per frame,
// sharp, and the rest is averaged over it (flight blur was tried and rejected, 2026-10-30).
const SHUTTER = 1;

// A glass cut's shared path: the most one figure is scaled to meet the other, and how far it pushes
// in at the middle.
const MATCH_MAX = 1.6;
const MATCH_PUSH = 0.05;

const FLOAT_MAX_WIDTH = 0.84;
const CARD_MAX_WIDTH = 0.8;

// The opaque bounds of an image with transparency, and whether it runs off the image's bottom
// edge -- Printful frames its on-model shots at mid-thigh, so a person ends in a hard edge there.
export function analyseAlpha(img) {
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
 * `exportWidth`/`exportHeight`: the size the ad exports at, for the layered preview's full-size
 * lockup layer (the preview itself draws at half that). `blurSamples`: moments averaged per
 * frame for motion blur, at most, fewer for the live preview; under 2 turns it off.
 * @param {{ design: { seed: string, colors?: string[], settings?: any }, width: number, height: number, exact: boolean, layered?: boolean, exportWidth?: number, exportHeight?: number, blurSamples?: number }} o
 */
export async function createAdComposer({
  design,
  width,
  height,
  exact,
  layered = false,
  exportWidth = AD_WIDTH,
  exportHeight = AD_HEIGHT,
  blurSamples = exact ? 16 : 6
}) {
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
  const lockupScale = layered ? exportWidth / width : 1;
  // Where the lockup and products go at this size (adLayout); a 9:16 frame is laid out as before
  // sizes. `U` is the frame width the shadows and corners were authored against: a 9:16 frame's
  // own width, and the lockup's equivalent on the others.
  const frame = adLayout(width, height);
  const U = 1080 * frame.unit;
  const palette = resolveDesignPalette(design);
  const lockup = await createLockup({
    width: width * lockupScale,
    height: height * lockupScale,
    unit: frame.unit * lockupScale,
    cx: frame.lockup.cx * lockupScale,
    palette
  });
  let lockupCanvas = null;
  if (layered) {
    lockupCanvas = document.createElement('canvas');
    lockupCanvas.width = exportWidth;
    lockupCanvas.height = lockup.bandHeight;
    Object.assign(lockupCanvas.style, {
      position: 'absolute',
      left: '0',
      width: '100%',
      height: `${(lockup.bandHeight / exportHeight) * 100}%`,
      pointerEvents: 'none'
    });
  }

  const renderer = new WebGLRenderer({ antialias: true });
  let world = null;
  let glass = null;
  let released = false;
  // Idempotent: the export releases it before flushing the encoder, and again in its finally.
  const release = () => {
    if (released) return;
    released = true;
    glass?.dispose();
    glass = null;
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
      exact,
      renderer
    });
    await world.ready;
  } catch (e) {
    release();
    throw e;
  }

  // A cut between products: the lattice's panes, spreading from this point.
  const layout = layoutFacets(width, height, ...frame.facets);
  try {
    glass = createCutShader({ width, height, unit: frame.unit, layout, origin: frame.facets, palette });
  } catch (e) {
    release();
    throw e;
  }
  if (layered) {
    // Its own layer over the flight, for the same reason the flight has one, and out of the page
    // between cuts: an empty full-frame layer still costs a composite every frame.
    Object.assign(glass.canvas.style, { position: 'absolute', inset: '0', width: '100%', height: '100%', display: 'none' });
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

  // Whether a photo's product stands clear of its left and right edges, so it can be placed on
  // the flight without a straight edge showing.
  function freeStanding(img) {
    const b = analyseAlpha(img);
    const w = img.naturalWidth;
    return b.transparent && (b.x > 0.01 * w || b.x + b.w < 0.99 * w);
  }

  // A product photo placed on a transparent full frame, once; every frame then draws it with
  // that frame's motion. `origin` is the point it scales and rocks about. `covers` says it hides
  // everything under it once it has landed.
  function buildSprite(img, fit, place) {
    const { x0, x1 } = place.product;
    const areaW = x1 - x0;
    const areaX = (x0 + x1) / 2;
    if (fit === 'full' && place.landscape && freeStanding(img)) {
      // Full frame on a landscape frame, for a cutout: the photo at the frame's full height, in
      // the products' column. Cover-cropped, a square photo would lose two fifths of its height --
      // an on-model shot cut off at the chest and the knees. A photo that runs off its own sides
      // (a close-up, opaque or nearly) still covers the frame: fitted, it was a square with a hard
      // edge through the flight.
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const s = height / img.naturalHeight;
      const w = img.naturalWidth * s;
      const cx = Math.min(Math.max(areaX, w / 2), width - w / 2);
      const g = canvas.getContext('2d');
      g.imageSmoothingQuality = 'high';
      g.drawImage(img, cx - w / 2, 0, w, height);
      return { kind: 'full', canvas, origin: [cx, height / 2], floats: false, covers: coversFrame(canvas) };
    }
    if (fit === 'full') {
      const canvas = coverCanvas(img, width, height);
      return { kind: 'full', canvas, origin: [width / 2, height / 2], floats: false, covers: coversFrame(canvas) };
    }
    const c = document.createElement('canvas');
    c.width = width;
    c.height = height;
    const ctx = c.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    const bandTop = place.product.y0;
    const bandBottom = place.product.y1;
    const bandH = bandBottom - bandTop;
    const iw = img.naturalWidth;
    const ih = img.naturalHeight;
    let origin;
    let floats = true;

    if (fit === 'card') {
      const s = Math.min((areaW * CARD_MAX_WIDTH) / iw, bandH / ih);
      const w = iw * s;
      const h = ih * s;
      const x = areaX - w / 2;
      const y = (bandTop + bandBottom) / 2 - h / 2;
      const r = U * 0.03;
      ctx.save();
      ctx.shadowColor = 'rgba(0, 0, 0, 0.45)';
      ctx.shadowBlur = U * 0.05;
      ctx.shadowOffsetY = U * 0.015;
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
      origin = [areaX, y + h / 2];
    } else {
      // Cutout: placed by its own opaque bounds, not the photo's padding.
      const b = analyseAlpha(img);
      const anchored = b.transparent && b.toBottom;
      ctx.save();
      ctx.shadowColor = 'rgba(0, 0, 0, 0.42)';
      if (anchored) {
        // An on-model shot rises out of the bottom edge, its head just under the lockup.
        const s = Math.min((height - bandTop) / b.h, (areaW * 0.96) / b.w);
        const dx = areaX - (b.x + b.w / 2) * s;
        const dy = height - (b.y + b.h) * s;
        ctx.shadowBlur = U * 0.03;
        ctx.drawImage(img, dx, dy, iw * s, ih * s);
        origin = [areaX, height];
        floats = false;
      } else {
        const s = Math.min((areaW * FLOAT_MAX_WIDTH) / b.w, bandH / b.h);
        const dx = areaX - (b.x + b.w / 2) * s;
        const dy = (bandTop + bandBottom) / 2 - (b.y + b.h / 2) * s;
        ctx.shadowBlur = U * 0.04;
        ctx.shadowOffsetY = U * 0.022;
        if (b.transparent) {
          ctx.drawImage(img, dx, dy, iw * s, ih * s);
        } else {
          // A photo with no transparency of its own floats as a plain rounded rectangle.
          ctx.beginPath();
          ctx.roundRect(dx, dy, iw * s, ih * s, U * 0.02);
          ctx.fillStyle = '#000';
          ctx.fill();
          ctx.shadowColor = 'transparent';
          ctx.clip();
          ctx.drawImage(img, dx, dy, iw * s, ih * s);
        }
        origin = [areaX, (bandTop + bandBottom) / 2];
      }
      ctx.restore();
    }
    return { kind: 'layer', canvas: c, origin, floats, covers: false };
  }

  const images = new Map(); // url -> decoded Image, so a layout change re-places without reloading
  let sprites = [];
  // Only the latest call lands: decodes finish in any order, and an older list arriving last
  // would put photos the ad no longer has back on screen, in the new list's slots.
  let photosToken = 0;
  /** @param {Array<{ url: string, fit?: string }>} photos */
  async function setPhotos(photos, { position = 'top', showText = true } = {}) {
    const token = ++photosToken;
    const place = adLayout(width, height, position, showText);
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
    sprites = photos.map(({ fit }, i) => {
      const sprite = buildSprite(imgs[i], fit || 'cutout', place);
      return { ...sprite, figure: figureOf(sprite.canvas) };
    });
    glass.setImages(sprites.map(sp => sp.canvas));
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
  function productPose(i, t, timeline) {
    const sp = sprites[i];
    const seg = timeline.products[i];
    const landed = seg.start + seg.transition;
    const kind = sp.kind === 'full' ? 'full' : 'layer';
    const phase = ((t - seg.start) / (2 * timeline.bar)) * 2 * Math.PI;
    return {
      s: 1 + (PUSH[kind] * Math.max(0, t - landed)) / Math.max(0.001, seg.end - landed),
      dy: sp.floats ? Math.sin(phase) * BOB * height : 0,
      rot: sp.floats ? Math.sin(phase + 1) * ROCK : 0
    };
  }

  function drawProduct(ctx, i, t, timeline) {
    const sp = sprites[i];
    const { s, dy, rot } = productPose(i, t, timeline);
    const [ox, oy] = sp.origin;
    ctx.save();
    ctx.translate(ox, oy + dy);
    ctx.rotate(rot);
    ctx.scale(s, s);
    ctx.translate(-ox, -oy);
    ctx.drawImage(sp.canvas, 0, 0);
    ctx.restore();
  }

  // Where a placed photo's figure is, as a centre and a size, for a glass cut to line two up.
  function figureOf(canvas) {
    const sw = Math.ceil(width / 8);
    const sh = Math.ceil(height / 8);
    const c = document.createElement('canvas');
    c.width = sw;
    c.height = sh;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(canvas, 0, 0, sw, sh);
    const d = ctx.getImageData(0, 0, sw, sh).data;
    let x0 = sw, y0 = sh, x1 = -1, y1 = -1;
    for (let y = 0; y < sh; y++) {
      for (let x = 0; x < sw; x++) {
        if (d[(y * sw + x) * 4 + 3] < 40) continue;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
    if (x1 < 0) return { x: width / 2, y: height / 2, size: height };
    return { x: ((x0 + x1 + 1) / 2) * 8, y: ((y0 + y1 + 1) / 2) * 8, size: Math.hypot(x1 - x0 + 1, y1 - y0 + 1) * 8 };
  }

  // Which product is up at time t, or -1 during the flight.
  function productAt(t, timeline) {
    const products = timeline.products.slice(0, sprites.length);
    for (let k = products.length - 1; k >= 0; k--) if (t >= products[k].start) return k;
    return -1;
  }
  const isCutting = (i, t, timeline) => t - timeline.products[i].start < timeline.products[i].transition;

  // An opaque photo that has landed covers everything, flight included.
  function flightShowsAt(t, timeline) {
    const i = productAt(t, timeline);
    return i < 0 || !sprites[i].covers || isCutting(i, t, timeline);
  }

  // How many moments an exposure needs: as many as it takes for a landed product's slow drift to
  // move about a pixel between them, so its photo is not redrawn 16 times to move one pixel, and all
  // of them across a cut. A drift under a quarter of a pixel needs no blur at all.
  function momentsFor(t, open, timeline) {
    if (blurSamples < 2) return 1;
    const t0 = t - open / 2;
    const t1 = t + open / 2;
    const i = productAt(t0, timeline);
    if (i !== productAt(t1, timeline)) return blurSamples;
    if (i < 0) return 1;
    if (isCutting(i, t0, timeline)) return blurSamples;
    const a = productPose(i, t0, timeline);
    const b = productPose(i, t1, timeline);
    const [ox, oy] = sprites[i].origin;
    const reach = Math.hypot(Math.max(ox, width - ox), Math.max(oy, height - oy));
    const moved = reach * (Math.abs(b.s - a.s) + Math.abs(b.rot - a.rot)) + Math.abs(b.dy - a.dy);
    return moved < 0.25 ? 1 : Math.min(blurSamples, Math.ceil(moved) + 1);
  }

  const exposeProducts = createShutter(width, height);

  // The cut under way at this exposure: the product arriving, whichever end of the exposure it shows
  // at. Moments outside the cut clamp, to the whole old photo or the whole new.
  function cutAt(t, open, moments, timeline) {
    const exposed = moments > 1 ? open : 0;
    for (const at of [t + exposed / 2, t - exposed / 2]) {
      const i = productAt(at, timeline);
      if (i >= 0 && isCutting(i, at, timeline)) return i;
    }
    return -1;
  }

  function drawCut(ctx, t, open, moments, i, timeline) {
    const seg = timeline.products[i];
    const pose = (k, at) => {
      const { s, dy, rot } = productPose(k, at, timeline);
      return { x: sprites[k].origin[0], y: sprites[k].origin[1], dy, s, rot };
    };
    const to = sprites[i].figure;
    const from = i > 0 ? sprites[i - 1].figure : null;
    // How far one figure is from the other's size, held so a close-up after a full figure stays a
    // change of framing rather than a zoom through the whole cut.
    const ratio = from ? Math.min(MATCH_MAX, Math.max(1 / MATCH_MAX, to.size / from.size)) : 1;
    glass.draw(t, open, moments, i > 0 ? sprites[i - 1].canvas : null, sprites[i].canvas, at => {
      const progress = Math.min(1, Math.max(0, (at - seg.start) / seg.transition));
      const g = progress * progress * (3 - 2 * progress);
      // Both on one path, and a slight push through the middle of it.
      const push = 1 + MATCH_PUSH * Math.sin(Math.PI * g);
      return {
        progress,
        matchAt: from ? [from.x + (to.x - from.x) * g, from.y + (to.y - from.y) * g] : [to.x, to.y],
        from: from ? { ...pose(i - 1, at), match: [from.x, from.y, ratio ** g * push] } : null,
        to: { ...pose(i, at), match: [to.x, to.y, ratio ** (g - 1) * push] }
      };
    });
    if (!layered) ctx.drawImage(glass.canvas, 0, 0, width, height);
  }

  function showCutLayer(on) {
    if (!layered) return;
    const parent = renderer.domElement.parentNode;
    if (on && glass.canvas.parentNode !== parent && parent) renderer.domElement.after(glass.canvas);
    glass.canvas.style.display = on ? '' : 'none';
  }

  /**
   * @param {CanvasRenderingContext2D} ctx  a width x height canvas
   * @param {number} t  seconds into the ad
   * @param {{ timeline: ReturnType<typeof import('./adTimeline').adTimeline>, overlay: { text: string, position: string, show: boolean } }} o
   */
  function draw(ctx, t, { timeline, overlay }) {
    if (layered) ctx.clearRect(0, 0, width, height);
    const open = SHUTTER / AD_FPS;
    const moments = momentsFor(t, open, timeline);
    const exposed = moments > 1 ? open : 0;
    // Once per frame, sharp, whatever the products do over it -- and if any of the exposure shows it.
    if (flightShowsAt(t - exposed / 2, timeline) || flightShowsAt(t + exposed / 2, timeline)) drawFlight(ctx, t, timeline);
    const cut = cutAt(t, open, moments, timeline);
    showCutLayer(cut >= 0);
    const i = productAt(t, timeline);
    if (cut >= 0) {
      drawCut(ctx, t, open, moments, cut, timeline);
    } else if (i >= 0 && moments > 1) {
      ctx.drawImage(exposeProducts(t, open, moments, (moment, at) => drawProduct(moment, i, at, timeline)), 0, 0);
    } else if (i >= 0) {
      drawProduct(ctx, i, t, timeline);
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
      top: adLayout(width, height, overlay.position, true).lockup.top * lockupScale,
      shutter: blurSamples >= 2 ? { samples: blurSamples, open: SHUTTER / AD_FPS } : undefined
    };
    if (!lc) return lockup.draw(ctx, t, o);
    // The layer covers the band, from a margin above the lockup's top.
    const at = Math.round(o.top) - lockup.margin;
    if (at !== lockupTop) {
      lockupTop = at;
      lockupCanvas.style.top = `${(at / exportHeight) * 100}%`;
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
