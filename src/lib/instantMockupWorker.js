// The instant mockup's heavy work, off the page: decoding the calibration maps and the artwork
// renders, compositing (instantMockup.js) and encoding the finished photo. On a phone one photo is
// ~100ms of pixel work, and a product page makes five of them; on the page that froze everything
// at the moment the visitor was watching the print change. The page (instantMockupStore.js) only
// ever receives finished JPEG Blobs.
//
// Messages, each answered with { id, blob } / { id, blank, mask } or { id, error }:
//   { id, type: 'compose', base, view: { meta }, sources: [{ key, blob } | null per placement] }
//   { id, type: 'blank', base, view: { meta }, placements }
// `base` is the absolute URL of the product's calibration folder; `meta` its manifest entry for the
// view. Sources are keyed so a render shared by several views is decoded once.
import { composeInstantMockup } from './instantMockup';

async function pixelsOf(blob) {
  const bitmap = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  const { width, height } = bitmap;
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  return { width, height, data: ctx.getImageData(0, 0, width, height).data };
}

const MAPS = ['base', 'gain', 'gamma', 'place', 'uv', 'uvplace', 'underplace', 'underuv', 'edge'];
const views = new Map();
function loadView(base, meta) {
  const key = `${base}|${meta.files.base}`;
  if (!views.has(key)) {
    const promise = Promise.all(
      MAPS.map(name =>
        // The underlay maps exist only on views with a transparent label, the edge map only on
        // views with a seam.
        !meta.files[name] ? null : fetch(`${base}/${meta.files[name]}`).then(r => {
          if (!r.ok) throw new Error(`${meta.files[name]}: ${r.status}`);
          return r.blob().then(pixelsOf);
        })
      )
    ).then(maps => ({ ...meta, ...Object.fromEntries(MAPS.map((n, i) => [n, maps[i]])) }));
    views.set(key, promise);
    promise.catch(() => views.delete(key));
    // A shop page's worth of views; the oldest goes past it.
    while (views.size > 30) views.delete(views.keys().next().value);
  }
  return views.get(key);
}

// Decoded renders by key, kept for a few designs' worth of views -- bounded by BYTES, not count:
// a product page's renders are up to 2500px (about 25MB decoded, a third more with its mip
// levels), a shop card's 1000px.
const sources = new Map();
const SOURCE_BUDGET = 160e6;
let sourceBytes = 0;
function sourcePixels(source) {
  if (!source) return Promise.resolve(null);
  if (!sources.has(source.key)) {
    const entry = { bytes: 0, promise: pixelsOf(source.blob) };
    entry.promise.then(px => {
      entry.bytes = px.width * px.height * 4 * 1.34;
      sourceBytes += entry.bytes;
      // The newest stays even if it alone is over budget.
      for (const [key, old] of sources) {
        if (sourceBytes <= SOURCE_BUDGET || old === entry) break;
        sources.delete(key);
        sourceBytes -= old.bytes;
      }
    }, () => sources.delete(source.key));
    sources.set(source.key, entry);
  }
  const entry = sources.get(source.key);
  // Most recently used goes to the back of the eviction order.
  sources.delete(source.key);
  sources.set(source.key, entry);
  return entry.promise;
}

async function encode(width, height, data, type, quality) {
  const canvas = new OffscreenCanvas(width, height);
  canvas.getContext('2d').putImageData(new ImageData(data, width, height), 0, 0);
  return canvas.convertToBlob({ type, quality });
}

const WHITE = { width: 1, height: 1, data: new Uint8ClampedArray([255, 255, 255, 255]) };

self.onmessage = async e => {
  const { id, type, base } = e.data;
  try {
    const view = await loadView(base, e.data.view);
    if (type === 'compose') {
      const pixels = await Promise.all(e.data.sources.map(sourcePixels));
      const blob = await encode(view.width, view.height, composeInstantMockup(view, pixels), 'image/jpeg', 0.9);
      self.postMessage({ id, blob });
    } else if (type === 'blank') {
      const blank = await encode(
        view.width,
        view.height,
        composeInstantMockup(view, Array.from({ length: e.data.placements }, () => WHITE)),
        'image/jpeg',
        0.9
      );
      const mask = new Uint8ClampedArray(view.width * view.height * 4);
      const [cx, cy, cw, ch] = view.crop;
      for (let y = 0; y < ch; y++) {
        for (let x = 0; x < cw; x++) {
          const i = (y * cw + x) * 4;
          if (!view.place.data[i]) continue;
          const o = ((cy + y) * view.width + cx + x) * 4;
          mask[o] = mask[o + 1] = mask[o + 2] = mask[o + 3] = 255;
        }
      }
      self.postMessage({ id, blank, mask: await encode(view.width, view.height, mask, 'image/png') });
    }
  } catch (err) {
    self.postMessage({ id, error: String(err?.message || err) });
  }
};
