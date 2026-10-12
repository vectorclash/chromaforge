import { generateArtwork } from '../render/generateArtwork';
import renderArtwork from '../render/renderArtwork';
import { resolveDesignPalette } from '../render/resolvedPalette';
import { coverCanvas } from '../components/ui/facetMosaic';
import { rampTime, rampRush, RAMP_FLOOR_3D } from '../utils/speedRamp';
import { encodeMp4 } from '../lib/videoEncode';
import { analyseAlpha } from './adComposer';

// Feed posts: a single image, or a carousel of up to 10 slides, at Instagram's tallest feed shape.
// Each slide is a pure function of the design (and, for a photo slide, its photo), so the preview
// and the posted file are the same picture. The flight clip is the one slide that is a video.

export const FEED_W = 1080;
export const FEED_H = 1350;
// Instagram's carousel limit through the API (the app itself allows 20).
export const MAX_SLIDES = 10;
// The flight clip is one whole loop of a 6s scene, so the carousel's own looping never shows a cut.
export const CLIP_SECONDS = 6;
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

// The 3D flight at the slide's shape, one whole loop, ramped like every other flight. Built at
// `width` x `height`; the caller draws it with world.render(renderer).
export async function createFlightLoop(design, width, height, { exact = false } = {}) {
  const [{ WebGLRenderer }, { createTunnelScene, warmTunnelStars }] = await Promise.all([
    import('three'),
    import('../animation3d/tunnelScene')
  ]);
  await warmTunnelStars(CLIP_SECONDS);
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
      seed: design.seed,
      colors: design.colors || [],
      settings: design.settings ?? null,
      duration: CLIP_SECONDS,
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
      const tt = ((t % CLIP_SECONDS) + CLIP_SECONDS) % CLIP_SECONDS;
      world.setTime(rampTime(tt, CLIP_SECONDS, RAMP_FLOOR_3D), rampRush(tt, CLIP_SECONDS), null);
      world.render(renderer);
    },
    dispose
  };
}

// The flight clip as a silent MP4.
/**
 * @param {{ seed: string, colors?: string[], settings?: any }} design
 * @param {{ onProgress?: (f: number) => void }} [opts]
 */
export async function renderFlightClip(design, opts = {}) {
  const { onProgress } = opts;
  const releases = [];
  try {
    const loop = await createFlightLoop(design, FEED_W, FEED_H, { exact: true });
    releases.push(loop.dispose);
    const totalFrames = CLIP_SECONDS * CLIP_FPS;
    return await encodeMp4({
      width: FEED_W,
      height: FEED_H,
      fps: CLIP_FPS,
      totalFrames,
      bitrate: CLIP_BITRATE,
      releases,
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
      out.push({ type: 'video', blob: await renderFlightClip(design, { onProgress: report }) });
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
