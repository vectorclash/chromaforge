// Makes and caches instant mockups in the browser (the compositing itself is instantMockup.js,
// which stays free of browser and Supabase imports so Node can check it against real mockups).
//
// One photo per (product, view, design, print options), made once and shared: the homepage
// carousel repeats every card several times over, and the shop grid, the carousel and a product
// page can all want the same t-shirt at once. The panel renders behind them are shared too, per
// placement: a product page's five views of the tee come from three renders, and the card the
// visitor clicked to get there has usually made two of them already.
//
// The renders go through the SAME path a real mockup does -- renderAndUploadPrintFiles with
// capRenderStrategy -- only kept instead of uploaded. So the instant photo shows exactly the
// panels, mirroring, geometry choices, pocket crops and labels a Printful mockup or the order
// would, never a second idea of them.
import { composeInstantMockup } from './instantMockup';
import { INSTANT_MOCKUPS } from './instantMockupIndex';
import { renderAndUploadPrintFiles, capRenderStrategy } from './printful';
import { frontPlacementKey, hideUnsubmittedViews } from './printfulPlacements';
import { MAX_VIEWS, orderViews } from './printfulViewPolicy';
import { PRODUCT_MOCKUP_CONFIG } from './printfulMockupConfig';
import { MODEL_GROUPS_BY_PRODUCT } from './printfulMockupStyleGroups';
import { PRIORITY_DEFAULT, PRIORITY_LOW } from '../render/renderOffThread';
import { NEBULA_PIXELS_LITE } from '../render/nebula';

// The long edge each print file is rendered at. The photo is 1000px and shows a panel at up to
// ~940px (the flat front); measured against real mockups, rendering at 685, 1000 and 2000 gives
// the same error, so this is the cheapest size that never upsamples. The quarter-area nebula for
// the same reason: at these sizes it cannot be told apart, and every surface then shares renders.
const RENDER_LONG_EDGE = 1000;
// Kept photos (object URLs of ~100KB JPEGs) and kept render sets (decoded pixels, a few MB each).
// The oldest is released past these.
const MAX_PHOTOS = 48;
const MAX_RENDER_SETS = 4;

export function hasInstantMockup(productId) {
  return !!INSTANT_MOCKUPS[String(productId)];
}

// CONFIGURATIONS. A product's photos can differ by variant (the tote's bag colour, the pillow's
// size) and by stitch colour, so it is calibrated once per distinct photo set; each configuration
// lists the variants it covers and the stitch colour it was photographed with (see
// scripts/calibrate-instant-mockup.mjs). The default is the one the shop card shows.
function configOf(productId, configId) {
  const configs = INSTANT_MOCKUPS[String(productId)]?.configs;
  if (!configs) return null;
  return configs.find(c => c.id === configId) || configs.find(c => c.default) || configs[0];
}

export function defaultInstantConfig(productId) {
  return configOf(productId, null)?.id ?? null;
}

// The configuration photographed for this variant and stitch colour, or null -- in which case the
// product page shows that selection the Printful way. A null stitch matches any.
export function instantConfigFor(productId, variantId, stitch) {
  const configs = INSTANT_MOCKUPS[String(productId)]?.configs;
  if (!configs) return null;
  return (
    configs.find(c => (!variantId || c.variants.includes(variantId)) && (!stitch || !c.stitch || c.stitch === stitch))?.id ?? null
  );
}

// A surface name ('card': the shop's on-model front) or a view id, within a configuration.
function resolveView(productId, viewOrSurface, configId) {
  const config = configOf(productId, configId);
  if (!config) return null;
  if (viewOrSurface === 'card') return config.card;
  return config.views.some(v => v.id === String(viewOrSurface)) ? String(viewOrSurface) : null;
}

export function instantCardViewId(productId, configId = null) {
  return configOf(productId, configId)?.card ?? null;
}

// The calibrated views a configuration's filmstrip shows, as { id, name }, by the same rules the
// Printful flow applies to Printful's photos (useMockup): the order printfulViewPolicy gives them
// (flats, then close-ups, then on-model), capped at MAX_VIEWS, and -- on the reversible bucket hat
// -- the inside faces only when a genuinely different second design is on them (with one design
// they are the outside photos again; the hat returns 18 views in all). On-model views are named
// "Front on model" and so on, as the Edge Function names Printful's (a suffix, so the angle order
// still reads the start of the name).
const orderedViews = new Map();
export function instantViews(productId, configId = null, { showsSecondary = false } = {}) {
  const config = configOf(productId, configId);
  if (!config) return [];
  const key = `${productId}:${config.id}:${showsSecondary}`;
  if (!orderedViews.has(key)) {
    const pid = String(productId);
    const named = config.views.map(v => ({
      id: v.id,
      display_name: v.group && v.group === MODEL_GROUPS_BY_PRODUCT[pid] ? `${v.name} on model` : v.name,
      generator_mockup_id: Number(v.id)
    }));
    const placements = config.placements || [];
    const secondary = PRODUCT_MOCKUP_CONFIG[pid]?.secondaryDesign?.placements || [];
    // Labels never name a view (they carry the word "inside" on the hat, which kept its inside faces).
    const worthShowing = placements
      .filter(p => !p.startsWith('label_') && (showsSecondary || !secondary.includes(p)))
      .map(p => [p, 0]);
    const shown = hideUnsubmittedViews(named, worthShowing, {
      available_placements: Object.fromEntries(placements.map(p => [p, p]))
    });
    // A product may pick its strip by hand (PRODUCT_MOCKUP_CONFIG's instantViewPick -- the
    // reversible hat): exactly those photos, in that order, the inside ones only with a second design.
    const pick = PRODUCT_MOCKUP_CONFIG[pid]?.instantViewPick;
    const byId = new Map(named.map(v => [v.id, v]));
    const ordered = pick
      ? [...pick.outside, ...(showsSecondary ? pick.inside : [])].map(id => byId.get(id)).filter(Boolean)
      : orderViews(shown, showsSecondary ? MAX_VIEWS * 2 : MAX_VIEWS, pid);
    orderedViews.set(
      key,
      ordered.map(v => ({ id: v.id, name: v.display_name }))
    );
  }
  return orderedViews.get(key);
}

const manifests = new Map();
function loadManifest(productId) {
  const id = String(productId);
  if (!manifests.has(id)) {
    const promise = fetch(`/instant-mockups/${id}/manifest.json`).then(r => {
      if (!r.ok) throw new Error(`instant mockup manifest ${id}: ${r.status}`);
      return r.json();
    });
    manifests.set(id, promise);
    promise.catch(() => manifests.delete(id));
  }
  return manifests.get(id);
}

// Raw pixels, never colour-managed or premultiplied: the maps are numbers, not pictures.
async function pixelsOf(source) {
  const bitmap = await createImageBitmap(source, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  const { width, height } = bitmap;
  const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(width, height) : document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close?.();
  return { width, height, data: ctx.getImageData(0, 0, width, height).data };
}

// The view's maps decoded on the page -- only when the worker is unavailable (see composeView).
const views = new Map();
function loadView(productId, configId, viewId) {
  const key = `${productId}:${configId}:${viewId}`;
  if (!views.has(key)) {
    const promise = loadManifest(productId).then(async manifest => {
      const meta = manifest.configs[configId]?.views[viewId];
      if (!meta) throw new Error(`instant mockup ${key}: no such view`);
      const [base, gain, gamma, place, uv, uvplace, underplace, underuv, edge] = await Promise.all(
        ['base', 'gain', 'gamma', 'place', 'uv', 'uvplace', 'underplace', 'underuv', 'edge'].map(name =>
          !meta.files[name] ? null : fetch(`/instant-mockups/${productId}/${meta.files[name]}`)
            .then(r => {
              if (!r.ok) throw new Error(`instant mockup ${meta.files[name]}: ${r.status}`);
              return r.blob();
            })
            .then(pixelsOf)
        )
      );
      return { ...meta, base, gain, gamma, place, uv, uvplace, underplace, underuv, edge };
    });
    views.set(key, promise);
    promise.catch(() => views.delete(key));
  }
  return views.get(key);
}

// The design's identity, the way isSameDesign reads it.
function designKey(design) {
  return `${design.seed}|${(design.colors || []).join(',')}|${JSON.stringify(design.settings ?? null)}`;
}

function optionsKey(o) {
  const opts = o || {};
  return JSON.stringify([
    opts.geometryPlacements ? [...opts.geometryPlacements].sort() : null,
    opts.geometryLayout ?? null,
    opts.sizeFrame ?? null,
    opts.geometryScale ?? 1,
    !!opts.legSymmetry,
    opts.legWrap ?? null,
    opts.mirrorPlacements ?? null,
    opts.labelOutsideRegion ?? null,
    opts.labelInsideRegion ?? null,
    opts.logo ?? true,
    opts.secondaryDesign ? designKey(opts.secondaryDesign) : null
  ]);
}

// What a photo shows apart from WHICH view it is: two keys equal here are the same design and
// options seen from different angles.
export function instantContentKey(design, options) {
  return design?.seed ? `${designKey(design)}:${optionsKey(options)}` : null;
}

// `detail`: the product page's photos, made from print files rendered at the size the views need
// (see renderEdges) -- a different photo from the shop card's of the same view.
export function instantMockupKey(productId, design, options, viewOrSurface = 'card', configId = null, detail = false) {
  const config = configOf(productId, configId);
  const viewId = resolveView(productId, viewOrSurface, config?.id);
  const content = instantContentKey(design, options);
  return config && viewId && content ? `${productId}:${config.id}:${viewId}:${detail ? 'd' : 'c'}:${content}` : null;
}

// The long edge each placement is rendered at. Shop cards and the carousel: RENDER_LONG_EDGE. The
// product page: the most any view of the configuration needs (the calibration's `need` -- a
// close-up enlarges a print file several times, and drawn from a 1000px render it came out soft
// and blocky), so one render per print file serves every view of the filmstrip.
const edgesMemo = new WeakMap();
function renderEdges(c, detail) {
  if (!detail) return null;
  if (!edgesMemo.has(c)) {
    // Per print file, so placements cut from one sheet (every panel of the track jacket) share
    // one render instead of drawing the sheet at two sizes.
    const byFile = {};
    for (const v of Object.values(c.views)) {
      for (const [i, edge] of Object.entries(v.need || {})) {
        const file = c.placements[i].printfileId;
        byFile[file] = Math.max(byFile[file] || RENDER_LONG_EDGE, edge);
      }
    }
    const edges = {};
    for (const p of c.placements) if (byFile[p.printfileId]) edges[p.key] = byFile[p.printfileId];
    edgesMemo.set(c, edges);
  }
  return edgesMemo.get(c);
}

// Rendered print files, per (product, design, options): each placement's render as a promise of
// { key, blob } -- so a view needing a placement another view already asked for waits on that
// render, and the worker, given the key, decodes a render shared by several views once.
const renderSets = new Map();
let nextSourceId = 0;
function placementSources(productId, config, design, options, keys, renderDesignBlob, priority, edges = null) {
  // Per configuration as well: the pillow's sizes are different print files.
  const setKey = `${productId}:${config.variantId}:${instantContentKey(design, options)}`;
  let set = renderSets.get(setKey);
  if (set) {
    renderSets.delete(setKey);
  } else {
    set = new Map();
    while (renderSets.size >= MAX_RENDER_SETS) renderSets.delete(renderSets.keys().next().value);
  }
  renderSets.set(setKey, set);
  // Each placement at its render size (`edges`, else RENDER_LONG_EDGE): one batch per size.
  const edgeOf = k => (edges && edges[k]) || RENDER_LONG_EDGE;
  const slot = k => `${k}@${edgeOf(k)}`;
  const missing = keys.filter(k => !set.has(slot(k)));
  const all = config.placements.map(p => [p.key, p.printfileId]);
  const printfileSpecs = {
    printfiles: [
      ...new Map(config.placements.map(p => [p.printfileId, { printfile_id: p.printfileId, width: p.width, height: p.height }])).values()
    ],
    variant_printfiles: [{ variant_id: config.variantId, placements: Object.fromEntries(all) }]
  };
  const keep = blob => blob;
  for (const edge of new Set(missing.map(edgeOf))) {
    const group = missing.filter(k => edgeOf(k) === edge);
    const wanted = new Set(group);
    // A pocket is cropped from the front's render, so its batch needs the front's entry.
    if (wanted.has('pocket')) wanted.add(frontPlacementKey(all));
    const entries = all.filter(([key]) => wanted.has(key));
    const batch = renderAndUploadPrintFiles(entries, {
      printfileSpecs,
      design,
      renderOne: capRenderStrategy(renderDesignBlob, {
        sink: keep,
        cap: edge,
        renderOptions: { priority, nebulaPixels: NEBULA_PIXELS_LITE }
      }),
      labelSink: keep,
      // A hidden logo is a fully CLEAR mark here rather than none: the compositor draws a label
      // pixel as the mark over the measured print beneath it, so a clear mark shows just the print.
      // With no file at all those pixels would be left as the blank garment -- a white patch.
      hiddenLogo: clearMark,
      allEntries: all,
      ...options
    });
    // One key per distinct render (both sleeves share one).
    const ids = new Map();
    for (const key of group) {
      const source = batch.then(blobs => {
        const blob = blobs[key];
        if (!blob) return null;
        if (!ids.has(blob)) ids.set(blob, `src${++nextSourceId}`);
        return { key: ids.get(blob), blob };
      });
      set.set(slot(key), source);
      // A failed render must not stay cached as the answer.
      source.catch(() => {
        if (set.get(slot(key)) === source) set.delete(slot(key));
      });
    }
  }
  return Promise.all(keys.map(k => set.get(slot(k))));
}

let clearMarkBlob = null;
function clearMark() {
  if (!clearMarkBlob) {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 8;
    clearMarkBlob = new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
  }
  return clearMarkBlob;
}

function encode(width, height, data, type = 'image/jpeg') {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d').putImageData(new ImageData(data, width, height), 0, 0);
  return new Promise((resolve, reject) =>
    canvas.toBlob(b => {
      canvas.width = 0;
      canvas.height = 0;
      if (b) resolve(b);
      else reject(new Error('instant mockup encode failed'));
    }, type, 0.9)
  );
}

// The worker that does the pixel work (instantMockupWorker.js), or null where it cannot run --
// no module workers or no OffscreenCanvas 2D (Safari before 16.4) -- or after it has failed once,
// in which case everything is done on the page, as before.
let WORKER = null;
let workerFailed = typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined';
let nextJob = 0;
const jobs = new Map();
function worker() {
  if (workerFailed) return null;
  if (WORKER) return WORKER;
  try {
    WORKER = new Worker(new URL('./instantMockupWorker.js', import.meta.url), { type: 'module' });
    WORKER.onmessage = e => {
      const job = jobs.get(e.data.id);
      jobs.delete(e.data.id);
      if (!job) return;
      if (e.data.error) job.reject(new Error(e.data.error));
      else job.resolve(e.data);
    };
    WORKER.onerror = err => {
      console.warn('[instant mockup] worker failed, compositing on the page:', err.message);
      workerFailed = true;
      WORKER = null;
      for (const job of jobs.values()) job.reject(new Error('worker failed'));
      jobs.clear();
    };
  } catch {
    workerFailed = true;
  }
  return WORKER;
}
function inWorker(message) {
  const w = worker();
  if (!w) return null;
  return new Promise((resolve, reject) => {
    const id = ++nextJob;
    jobs.set(id, { resolve, reject });
    w.postMessage({ id, base: new URL(`/instant-mockups/${message.productId}`, location.href).href, ...message });
  });
}

// One view composed with these sources (per placement, { key, blob } or null), as a JPEG Blob.
const decodedOnPage = new Map();
async function composeView(productId, configId, viewId, manifest, sources) {
  const meta = manifest.configs[configId].views[viewId];
  const job = inWorker({ type: 'compose', productId, view: meta, sources });
  if (job) {
    try {
      return (await job).blob;
    } catch (err) {
      if (!workerFailed) throw err;
    }
  }
  const view = await loadView(productId, configId, viewId);
  const pixels = await Promise.all(
    sources.map(src => {
      if (!src) return null;
      if (!decodedOnPage.has(src.key)) {
        decodedOnPage.set(src.key, pixelsOf(src.blob));
        while (decodedOnPage.size > 8) decodedOnPage.delete(decodedOnPage.keys().next().value);
      }
      return decodedOnPage.get(src.key);
    })
  );
  return encode(view.width, view.height, composeInstantMockup(view, pixels));
}

// The view with no print at all -- the blank shirt -- and a mask of where the fabric is, both made
// from the calibration alone (no render), once per view. A design change shows the blank shirt
// between two prints, and the "printing" shimmer is confined to the fabric by the mask.
const WHITE = { width: 1, height: 1, data: new Uint8ClampedArray([255, 255, 255, 255]) };
const blanks = new Map();
const blanksReady = new Map();
function blankKey(productId, viewOrSurface, configId) {
  const config = configOf(productId, configId);
  const viewId = resolveView(productId, viewOrSurface, config?.id);
  return viewId ? `${productId}:${config.id}:${viewId}` : null;
}
// The blank and mask if they are already made, else null -- so a card mounts showing its blank.
export function peekInstantBlank(productId, viewOrSurface = 'card', configId = null) {
  const key = blankKey(productId, viewOrSurface, configId);
  return (key && blanksReady.get(key)) || null;
}
export function requestInstantBlank(productId, viewOrSurface = 'card', configId = null) {
  const config = configOf(productId, configId);
  const viewId = resolveView(productId, viewOrSurface, config?.id);
  if (!viewId) return Promise.resolve(null);
  const key = `${productId}:${config.id}:${viewId}`;
  if (!blanks.has(key)) {
    const promise = loadManifest(productId).then(async manifest => {
      const c = manifest.configs[config.id];
      const job = inWorker({ type: 'blank', productId, view: c.views[viewId], placements: c.placements.length });
      if (job) {
        try {
          const { blank, mask } = await job;
          return { blank: URL.createObjectURL(blank), mask: URL.createObjectURL(mask) };
        } catch (err) {
          if (!workerFailed) throw err;
        }
      }
      const view = await loadView(productId, config.id, viewId);
      const blank = await encode(view.width, view.height, composeInstantMockup(view, c.placements.map(() => WHITE)));
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
      const maskBlob = await encode(view.width, view.height, mask, 'image/png');
      return { blank: URL.createObjectURL(blank), mask: URL.createObjectURL(maskBlob) };
    });
    blanks.set(key, promise);
    promise.then(
      b => blanksReady.set(key, b),
      err => {
        console.warn('instant blank failed', err);
        blanks.delete(key);
      }
    );
  }
  return blanks.get(key).catch(() => null);
}

const photos = new Map(); // key -> { promise, url, blob }

// The finished photo's URL if it has already been made, else null -- lets a surface mount
// already showing it instead of popping it in a frame later.
export function peekInstantMockup(key) {
  return (key && photos.get(key)?.url) || null;
}

// The finished photo as a JPEG Blob, for uploading (Stripe's line-item image), or null.
export function instantMockupBlob(key) {
  return (key && photos.get(key)?.blob) || null;
}

// The photo's object URL (cached), or null for a product with no calibration. `renderDesignBlob`
// is StudioContext's. `background` puts the renders behind everything else in the render queue
// -- right for shop cards, which are never the thing the visitor is waiting on.
export function requestInstantMockup(
  productId,
  design,
  options,
  renderDesignBlob,
  { view = 'card', background = false, config: configId = null, detail = false } = {}
) {
  const key = instantMockupKey(productId, design, options, view, configId, detail);
  if (!key) return Promise.resolve(null);
  const existing = photos.get(key);
  if (existing) {
    // Most recently used goes to the back of the eviction order.
    photos.delete(key);
    photos.set(key, existing);
    return existing.promise.catch(() => null);
  }
  const entry = { url: null, blob: null, promise: null };
  entry.promise = (async () => {
    const config = configOf(productId, configId);
    const viewId = resolveView(productId, view, config.id);
    const manifest = await loadManifest(productId);
    const c = manifest.configs[config.id];
    const keys = c.views[viewId].shown.map(i => c.placements[i].key);
    const rendered = await placementSources(
      productId,
      c,
      design,
      options,
      keys,
      renderDesignBlob,
      background ? PRIORITY_LOW : PRIORITY_DEFAULT,
      renderEdges(c, detail)
    );
    const sources = c.placements.map(p => (keys.includes(p.key) ? rendered[keys.indexOf(p.key)] : null));
    const blob = await composeView(productId, config.id, viewId, manifest, sources);
    // Evicted while it was being made: nothing would ever release it.
    if (photos.get(key) !== entry) return null;
    entry.blob = blob;
    entry.url = URL.createObjectURL(blob);
    return entry.url;
  })();
  photos.set(key, entry);
  entry.promise.catch(err => {
    console.warn('instant mockup failed', err);
    if (photos.get(key) === entry) photos.delete(key);
  });
  while (photos.size > MAX_PHOTOS) {
    const [oldKey, old] = photos.entries().next().value;
    photos.delete(oldKey);
    if (old.url) URL.revokeObjectURL(old.url);
  }
  return entry.promise.catch(() => null);
}
