import { generateArtwork } from '../render/generateArtwork';
import renderArtwork from '../render/renderArtwork';
import { resolveDesignPalette } from '../render/resolvedPalette';
import { getGeometrySettings, getGeometryPresence } from '../render/designSettings';
import { coverCanvas } from '../components/ui/facetMosaic';
import { rampTime, rampRush, RAMP_FLOOR_3D } from '../utils/speedRamp';
import { encodeMp4 } from '../lib/videoEncode';
import { analyseAlpha } from './adComposer';

// Feed posts: a single image, or a carousel of up to 10 slides, at Instagram's tallest feed shape.
// Each slide is a pure function of the design (and, for a photo slide, its photo), so the preview
// and the posted file are the same picture. The flight clip is the one slide that is a video.

export const FEED_W = 1080;
export const FEED_H = 1350;
// The Flight mode's clip: the flight on its own, posted as a Reel (Instagram has no other kind of
// single-video post), so at a Reel's 9:16. The scene composes for the shape it is rendered at, so
// this is its own composition, not the 4:5 slide with sky added.
export const FLIGHT_W = 1080;
export const FLIGHT_H = 1920;
export const isFlightOnly = slides => slides.length === 1 && slides[0].type === 'flight';
// Instagram's carousel limit through the API (the app itself allows 20).
export const MAX_SLIDES = 10;
// The flight clip is one whole loop of its scene, so the carousel's own looping never shows a cut.
// Each flight slide carries its own length, ramp and object share (`seconds`, `ramp`, `objects`);
// a slide without them -- every one saved before they existed -- is a 6s ramped loop at the
// design's own odds, exactly as before.
export const DEFAULT_CLIP_SECONDS = 6;
// 3s is Instagram's shortest Reel; carousel videos run to 60s, but past ~15s a loop of this scene
// only repeats its plates (the content length caps and the camera laps it).
export const CLIP_LENGTHS = [3, 4, 6, 8, 10, 15];
// Share of the flight's plates that carry geometry -- the 3D scene's reading of `chance`, which
// also thickens the cage. A stored design states no odds, so it resolves to the legacy 0.4.
export const OBJECT_SHARES = [0.2, 0.4, 0.6, 0.8, 1];
const CLIP_FPS = 30;
// Under the API's 25 Mbps ceiling for video, with headroom.
const CLIP_BITRATE = 16_000_000;
// Artwork renders at twice the slide's size and is downscaled, so the fine star field resolves
// instead of aliasing (the studio's density floor, for the same reason).
const SUPERSAMPLE = 2;
// The close-up is the artwork at this many times the slide's size, cropped to one slide.
const MACRO_ZOOM = 3;

export const SLIDE_LABELS = {
  art: 'Artwork',
  photo: 'Photo',
  macro: 'Close-up',
  flight: 'Flight clip',
  seed: 'Seed card'
};

let nextId = 1;
export const makeSlide = (type, url = null) => ({
  id: `s${Date.now().toString(36)}${nextId++}`,
  type,
  ...(url ? { url } : {})
});

// "One design, every angle": the artwork, every chosen photo set into it, a close-up, the flight
// and the seed card -- capped at the API's 10.
export function everyAngleSlides(photoUrls) {
  const photos = photoUrls.slice(0, MAX_SLIDES - 4).map(u => makeSlide('photo', u));
  return [makeSlide('art'), ...photos, makeSlide('macro'), makeSlide('flight'), makeSlide('seed')];
}

// A flight slide's options -- or the Flight mode's, which take the same shape -- resolved: what
// it states, else the defaults.
export function flightOptions(slide, design) {
  return {
    seconds: slide?.seconds ?? DEFAULT_CLIP_SECONDS,
    ramp: slide?.ramp ?? true,
    objects: slide?.objects ?? getGeometrySettings(design?.settings).chance
  };
}

// The design the flight is built from, with the slide's object share as its odds. The design's
// own geometry layer (the first plate) must not move with them, so a design that states nothing
// about it is pinned to what its own odds give -- otherwise new odds would re-flip that coin too.
function flightSceneDesign(design, objects) {
  const geometry = design.settings?.geometry ?? {};
  if (objects === getGeometrySettings(design.settings).chance) return design;
  let present = getGeometryPresence(design.settings);
  if (present === null) {
    present = !!generateArtwork(design.seed, 320, 320, design.colors || [], design.settings ?? null)
      .geometryConfig;
  }
  return {
    ...design,
    settings: { ...design.settings, geometry: { ...geometry, present, chance: objects } }
  };
}

// "Standing in its own artwork": one photo, as a single image post.
export const singlePhotoSlides = photoUrl =>
  photoUrl ? [makeSlide('photo', photoUrl)] : [makeSlide('art')];

const canvas = (w, h) => {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
};

/** @param {{ seed: string, colors?: string[], settings?: any }} design */
function renderArt(design, w, h, ss = SUPERSAMPLE) {
  const big = renderArtwork(
    generateArtwork(design.seed, w * ss, h * ss, design.colors || [], design.settings ?? null)
  );
  if (ss === 1) return big;
  const out = canvas(w, h);
  const ctx = out.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(big, 0, 0, w, h);
  big.width = 0;
  big.height = 0;
  return out;
}

// A product photo set into the design it carries. A Printful cutout is placed by its own opaque
// bounds -- an on-model shot (cut off at mid-thigh) rises from the bottom edge, anything else
// floats in the middle with a shadow -- and the artwork behind is dimmed a little so the garment
// reads against the same pattern. A photo with no transparency covers the slide.
function drawPhotoSlide(ctx, design, img, w, h) {
  ctx.drawImage(renderArt(design, w, h), 0, 0);
  const b = analyseAlpha(img);
  // A subject that runs off the photo's top or sides is a cropped close-up (Printful's "Product
  // details" shots), not a whole product: placed as one, it was scaled to the slide's width and
  // left a hard straight edge across the middle of the slide (Aaron, 2026-10-12: "feel odd"). It
  // fills the slide instead, any gaps in the cutout showing the artwork behind. Running off the
  // BOTTOM alone is an on-model shot, which rises from the bottom edge below.
  const tol = 0.01;
  const cropped =
    b.y <= img.naturalHeight * tol ||
    b.x <= img.naturalWidth * tol ||
    b.x + b.w >= img.naturalWidth * (1 - tol);
  if (!b.transparent || cropped) {
    if (b.transparent) {
      ctx.fillStyle = 'rgba(8, 6, 14, 0.22)';
      ctx.fillRect(0, 0, w, h);
      ctx.shadowColor = 'rgba(0, 0, 0, 0.5)';
      ctx.shadowBlur = w * 0.03;
    }
    ctx.drawImage(coverCanvas(img, w, h), 0, 0);
    ctx.shadowColor = 'transparent';
    return;
  }
  ctx.fillStyle = 'rgba(8, 6, 14, 0.22)';
  ctx.fillRect(0, 0, w, h);
  ctx.save();
  ctx.imageSmoothingQuality = 'high';
  ctx.shadowColor = 'rgba(0, 0, 0, 0.55)';
  ctx.shadowBlur = w * 0.04;
  let s;
  let dx;
  let dy;
  if (b.toBottom) {
    s = Math.min((h * 0.9) / b.h, (w * 0.98) / b.w);
    dx = w / 2 - (b.x + b.w / 2) * s;
    dy = h - (b.y + b.h) * s;
  } else {
    s = Math.min((w * 0.84) / b.w, (h * 0.86) / b.h);
    dx = w / 2 - (b.x + b.w / 2) * s;
    dy = h / 2 - (b.y + b.h / 2) * s;
    ctx.shadowOffsetY = w * 0.012;
  }
  ctx.drawImage(img, dx, dy, img.naturalWidth * s, img.naturalHeight * s);
  ctx.restore();
}

// The artwork at MACRO_ZOOM times, cropped to the busiest slide-sized window -- edges and stars,
// not a flat stretch of gradient. Chosen by measuring a small copy, so it is the same crop every
// time for the same design.
function drawMacroSlide(ctx, design, w, h) {
  const big = renderArt(design, w * MACRO_ZOOM, h * MACRO_ZOOM, 1);
  const k = 8;
  const sw = Math.round(big.width / k);
  const sh = Math.round(big.height / k);
  const small = canvas(sw, sh);
  const sctx = small.getContext('2d', { willReadFrequently: true });
  sctx.drawImage(big, 0, 0, sw, sh);
  const d = sctx.getImageData(0, 0, sw, sh).data;
  const cw = Math.round(w / k);
  const ch = Math.round(h / k);
  let best = { e: -1, x: 0, y: 0 };
  for (let y = 0; y + ch <= sh; y += 8) {
    for (let x = 0; x + cw <= sw; x += 8) {
      let e = 0;
      for (let yy = y; yy < y + ch - 1; yy += 3) {
        for (let xx = x; xx < x + cw - 1; xx += 3) {
          const i = (yy * sw + xx) * 4;
          const r = i + 4;
          const u = i + sw * 4;
          e +=
            Math.abs(d[i] - d[r]) +
            Math.abs(d[i + 1] - d[r + 1]) +
            Math.abs(d[i] - d[u]) +
            Math.abs(d[i + 2] - d[u + 2]);
        }
      }
      if (e > best.e) best = { e, x, y };
    }
  }
  ctx.drawImage(big, best.x * k, best.y * k, w, h, 0, 0, w, h);
  big.width = 0;
  big.height = 0;
}

// The seed and palette, over the artwork darkened almost to black. Laid out from the INK of each
// line (measureText's actual bounding boxes), not from hand-picked baselines, so every gap is the
// gap the eye sees: a label sits the same distance above whatever it names, the three sections are
// spaced on one rhythm, and every line's left edge of ink lines up with the swatches. The seed is
// measured from its own ink: a box reserved for descenders left a seed with no p or q floating
// 25px further from the palette than one with them. The block is centred, a little above true centre, in the space
// above the URL, which sits on the bottom margin.
const SEED_CARD = {
  margin: 120,
  labelGap: 26, // label ink to the ink of what it names
  sectionGap: 100, // between seed, palette and the line about it
  swatchH: 128,
  swatchGap: 12,
  hexGap: 20, // swatch to its hex code
  bodyLeading: 54,
  opticalLift: 0.06 // of the free space, moved from below the block to above it
};

async function drawSeedSlide(ctx, design, w, h) {
  const u = w / 1080;
  const L = Object.fromEntries(
    Object.entries(SEED_CARD).map(([k, v]) => [k, k === 'opticalLift' ? v : v * u])
  );
  const MONO = 'ui-monospace, "SF Mono", Menlo, Consolas, monospace';
  const F = {
    label: `700 ${28 * u}px Quicksand, sans-serif`,
    seed: `500 ${128 * u}px ${MONO}`,
    hex: `500 ${26 * u}px ${MONO}`,
    body: `400 ${38 * u}px Quicksand, sans-serif`,
    url: `400 ${46 * u}px Exo, sans-serif`
  };
  await Promise.all([
    document.fonts.load(`700 ${28 * u}px Quicksand`),
    document.fonts.load(`400 ${38 * u}px Quicksand`),
    document.fonts.load(`400 ${46 * u}px Exo`)
  ]);
  ctx.drawImage(renderArt(design, w, h), 0, 0);
  ctx.fillStyle = 'rgba(14, 11, 22, 0.86)';
  ctx.fillRect(0, 0, w, h);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';

  const ink = (font, text, spacing = 0) => {
    ctx.font = font;
    ctx.letterSpacing = `${spacing}px`;
    const m = ctx.measureText(text);
    ctx.letterSpacing = '0px';
    return {
      asc: m.actualBoundingBoxAscent,
      desc: m.actualBoundingBoxDescent,
      left: m.actualBoundingBoxLeft
    };
  };
  // Draws `text` with the top of `box` at y and its ink starting exactly at the margin.
  const put = (font, text, y, box, color, spacing = 0) => {
    const own = ink(font, text, spacing);
    ctx.font = font;
    ctx.letterSpacing = `${spacing}px`;
    ctx.fillStyle = color;
    ctx.fillText(text, L.margin + own.left, y + box.asc);
    ctx.letterSpacing = '0px';
  };

  const tracking = 0.18 * 28 * u;
  // The seed spans the same width as the swatch row, so the two edges line up. Every seed is
  // eight monospace characters, so this is one size for every design.
  {
    ctx.font = F.seed;
    const m = ctx.measureText(design.seed);
    const inkW = m.actualBoundingBoxLeft + m.actualBoundingBoxRight;
    F.seed = `500 ${Math.min(200 * u, (128 * u * (w - 2 * L.margin)) / inkW)}px ${MONO}`;
  }
  const pal = resolveDesignPalette(design);
  const hexes = pal.map(c => c.replace(/^#/, '').toUpperCase().slice(0, 6));
  const box = {
    seedLabel: ink(F.label, 'SEED', tracking),
    paletteLabel: ink(F.label, 'PALETTE', tracking),
    seed: ink(F.seed, design.seed),
    hex: ink(F.hex, '0123456789ABCDEF'),
    body: ink(F.body, 'Ebdhkpqy,'),
    url: ink(F.url, 'chromaforge.app')
  };
  const hgt = b => b.asc + b.desc;

  // Heights of the three sections, then the block they make.
  const seedH = hgt(box.seedLabel) + L.labelGap + hgt(box.seed);
  const paletteH = hgt(box.paletteLabel) + L.labelGap + L.swatchH + L.hexGap + hgt(box.hex);
  const bodyH = box.body.asc + L.bodyLeading + box.body.desc;
  const blockH = seedH + L.sectionGap + paletteH + L.sectionGap + bodyH;
  const urlTop = h - L.margin - hgt(box.url);
  const free = urlTop - L.margin - blockH;
  let y = L.margin + free / 2 - free * L.opticalLift;

  const LABEL = 'rgba(255, 255, 255, 0.55)';
  put(F.label, 'SEED', y, box.seedLabel, LABEL, tracking);
  y += hgt(box.seedLabel) + L.labelGap;
  put(F.seed, design.seed, y, box.seed, '#ffffff');
  y += hgt(box.seed) + L.sectionGap;

  put(F.label, 'PALETTE', y, box.paletteLabel, LABEL, tracking);
  y += hgt(box.paletteLabel) + L.labelGap;
  const inner = w - 2 * L.margin;
  const sw = (inner - L.swatchGap * (pal.length - 1)) / pal.length;
  pal.forEach((c, i) => {
    const x = L.margin + i * (sw + L.swatchGap);
    ctx.fillStyle = c;
    ctx.beginPath();
    ctx.roundRect(x, y, sw, L.swatchH, 6 * u);
    ctx.fill();
    // A hairline, so a swatch as dark as the card (a #202020 stop) still reads as a swatch.
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.16)';
    ctx.lineWidth = 1.5 * u;
    ctx.stroke();
    ctx.font = F.hex;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.6)';
    const own = ink(F.hex, hexes[i]);
    ctx.font = F.hex;
    ctx.fillText(hexes[i], x + own.left, y + L.swatchH + L.hexGap + box.hex.asc);
  });
  y += L.swatchH + L.hexGap + hgt(box.hex) + L.sectionGap;

  const BODY = 'rgba(255, 255, 255, 0.82)';
  put(F.body, 'Eight characters rebuild this piece', y, box.body, BODY);
  put(F.body, 'at any size, on anything.', y + L.bodyLeading, box.body, BODY);

  put(F.url, 'chromaforge.app', urlTop, box.url, '#ffffff');
}

// A still slide as a canvas. `img` is the photo slide's decoded image. The flight is a video and
// is drawn by its own player (FeedPreview) or renderFlightClip.
export async function renderStillSlide(slide, design, img, w = FEED_W, h = FEED_H) {
  const c = canvas(w, h);
  const ctx = c.getContext('2d');
  if (slide.type === 'art') ctx.drawImage(renderArt(design, w, h), 0, 0);
  else if (slide.type === 'photo') drawPhotoSlide(ctx, design, img, w, h);
  else if (slide.type === 'macro') drawMacroSlide(ctx, design, w, h);
  else if (slide.type === 'seed') await drawSeedSlide(ctx, design, w, h);
  else throw new Error(`Not a still slide: ${slide.type}`);
  return c;
}

export const canvasToJpeg = c =>
  new Promise((resolve, reject) =>
    c.toBlob(
      b => (b ? resolve(b) : reject(new Error('The slide could not be encoded.'))),
      'image/jpeg',
      0.93
    )
  );

// The 3D flight at the slide's shape, one whole loop, ramped like every other flight unless the
// slide turns the ramp off (then the camera flies at constant speed, rush 0, as the studio does).
// Built at `width` x `height`; the caller draws it with world.render(renderer).
export async function createFlightLoop(
  design,
  width,
  height,
  { exact = false, seconds = DEFAULT_CLIP_SECONDS, ramp = true, objects = undefined } = {}
) {
  const sceneDesign = objects === undefined ? design : flightSceneDesign(design, objects);
  const [{ WebGLRenderer }, { createTunnelScene, warmTunnelStars }] = await Promise.all([
    import('three'),
    import('../animation3d/tunnelScene')
  ]);
  await warmTunnelStars(seconds);
  const renderer = new WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(1);
  renderer.setSize(width, height, false);
  let world = null;
  const dispose = () => {
    world?.dispose();
    world = null;
    renderer.dispose();
    // dispose() alone leaves the context alive until GC -- see Animation3DPreview
    renderer.forceContextLoss();
    renderer.domElement.remove();
  };
  try {
    world = createTunnelScene({
      seed: sceneDesign.seed,
      colors: sceneDesign.colors || [],
      settings: sceneDesign.settings ?? null,
      duration: seconds,
      width,
      height,
      exact
    });
    await world.ready;
  } catch (e) {
    dispose();
    throw e;
  }
  return {
    canvas: renderer.domElement,
    // t in seconds, wrapped to the loop.
    draw(t) {
      const tt = ((t % seconds) + seconds) % seconds;
      if (ramp) world.setTime(rampTime(tt, seconds, RAMP_FLOOR_3D), rampRush(tt, seconds), null);
      else world.setTime(tt, 0, null);
      world.render(renderer);
    },
    dispose
  };
}

// One frame of the flight at `t` seconds into its loop, exact, as a JPEG: the Flight mode's cover.
// Copied out of WebGL in the same task it was drawn, before the browser can clear the buffer.
export async function renderFlightFrame(design, slide, t, width, height) {
  const loop = await createFlightLoop(design, width, height, {
    exact: true,
    ...flightOptions(slide, design)
  });
  const out = canvas(width, height);
  try {
    loop.draw(t);
    out.getContext('2d').drawImage(loop.canvas, 0, 0);
  } finally {
    loop.dispose();
  }
  const blob = await canvasToJpeg(out);
  out.width = 0;
  out.height = 0;
  return blob;
}

// The flight clip as an MP4, with the slide's own options: silent, unless the Flight mode hands it
// a take of music exactly its length.
/**
 * @param {{ seed: string, colors?: string[], settings?: any }} design
 * @param {{ onProgress?: (f: number) => void, slide?: any, width?: number, height?: number,
 *   audio?: AudioBuffer | null, audioMaxBitrate?: number }} [opts]
 */
export async function renderFlightClip(design, opts = {}) {
  const {
    onProgress,
    slide = null,
    width = FEED_W,
    height = FEED_H,
    audio = null,
    audioMaxBitrate = Infinity
  } = opts;
  const options = flightOptions(slide, design);
  const releases = [];
  try {
    const loop = await createFlightLoop(design, width, height, { exact: true, ...options });
    releases.push(loop.dispose);
    const totalFrames = Math.round(options.seconds * CLIP_FPS);
    return await encodeMp4({
      width,
      height,
      fps: CLIP_FPS,
      totalFrames,
      bitrate: CLIP_BITRATE,
      releases,
      audio,
      audioMaxBitrate,
      renderFrame: f => {
        loop.draw(f / CLIP_FPS);
        return loop.canvas;
      },
      onFrame: f => onProgress?.(f / totalFrames)
    });
  } finally {
    for (const release of releases.reverse()) {
      try {
        release();
      } catch {
        /* already released */
      }
    }
  }
}

// Every slide as a file, in order: JPEGs, and an MP4 for the flight.
/**
 * @param {(p: { label: string, progress: number }) => void} [onProgress]
 * @returns {Promise<Array<{ type: string, blob: Blob }>>}
 */
export async function renderSlideFiles(slides, design, images, onProgress = () => {}) {
  const out = [];
  for (let i = 0; i < slides.length; i++) {
    const s = slides[i];
    const report = f =>
      onProgress({
        label: `Slide ${i + 1} of ${slides.length}: ${SLIDE_LABELS[s.type]}`,
        progress: (i + f) / slides.length
      });
    report(0);
    if (s.type === 'flight') {
      out.push({
        type: 'video',
        blob: await renderFlightClip(design, { onProgress: report, slide: s })
      });
    } else {
      const c = await renderStillSlide(s, design, images.get(s.url) ?? null);
      out.push({ type: 'image', blob: await canvasToJpeg(c) });
      c.width = 0;
      c.height = 0;
    }
  }
  return out;
}

export async function loadImage(url) {
  const img = new Image();
  img.src = url;
  await img.decode();
  return img;
}
