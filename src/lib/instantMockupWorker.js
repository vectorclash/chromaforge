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
import { fetchRetry } from '../utils/fetchRetry';

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
// Decoded calibration views, least recently used first -- bounded by BYTES, like the renders below
// (2026-11-27). A view's maps decode to ~11-16MB, and this used to keep the last 30 views however
// big: shop -> zip hoodie -> shop -> track jacket -> shop -> windbreaker holds ~360MB of maps here
// alone, beside 160MB of renders, which is the moment Aaron's iPhone dropped the page and reloaded
// it. VIEW_BUDGET still holds the biggest product page's whole strip (the track jacket's 8 views,
// ~127MB) or a desktop shop's screenful of cards; anything older is decoded again if it is needed
// again, from the browser's cache, in the worker.
const VIEW_BUDGET = 150e6;
const MAX_VIEWS = 30;
const views = new Map();
let viewBytes = 0;
function loadView(base, meta) {
  const key = `${base}|${meta.files.base}`;
  if (!views.has(key)) {
    const entry = { bytes: 0 };
    entry.promise = Promise.all(
      MAPS.map(name =>
        // The underlay maps exist only on views with a transparent label, the edge map only on
        // views with a seam.
        !meta.files[name] ? null : fetchRetry(`${base}/${meta.files[name]}`).then(r => {
          if (!r.ok) throw new Error(`${meta.files[name]}: ${r.status}`);
          return r.blob().then(pixelsOf);
        })
      )
    ).then(maps => ({ ...meta, ...Object.fromEntries(MAPS.map((n, i) => [n, maps[i]])) }));
    entry.promise.then(
      view => {
        if (views.get(key) !== entry) return;
        entry.bytes = MAPS.reduce((sum, n) => sum + (view[n] ? view[n].data.byteLength : 0), 0);
        viewBytes += entry.bytes;
        trimViews(entry);
      },
      () => {
        if (views.get(key) === entry) views.delete(key);
      }
    );
    views.set(key, entry);
    trimViews(entry);
  }
  const entry = views.get(key);
  // Most recently used goes to the back of the eviction order.
  views.delete(key);
  views.set(key, entry);
  return entry.promise;
}
// The newest stays even if it alone is over budget. A view still decoding counts 0 until it lands.
function trimViews(keep) {
  for (const [key, old] of views) {
    if ((viewBytes <= VIEW_BUDGET && views.size <= MAX_VIEWS) || old === keep) break;
    views.delete(key);
    viewBytes -= old.bytes;
  }
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
