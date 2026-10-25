// The page's side of the render worker (render/renderWorker.js): renders a design to an encoded
// JPEG off the main thread, so a Generate never freezes the page while the artwork is drawn.
//
// renderOffThread(...) resolves with a Blob, or with null when the worker is unavailable (no
// OffscreenCanvas 2D, or the worker failed) -- the caller then renders on the page as before, so
// nothing depends on the worker existing.
//
// The worker rebuilds the config from the call that made it (generateArtwork's non-enumerable
// `generatedBy`) rather than receiving the config: a design's resolved star field alone is ~100k
// objects, and copying it across would cost the page more than drawing it.

// ─── Render log (components/ui/RenderLog.jsx; off unless localStorage cf-debug:render = 1) ───
// Every render this module and the page fallbacks make, with where its time went, so a device
// that misbehaves can be read rather than guessed at.
const LOG = [];
const LOG_LISTENERS = new Set();
export function renderLogEnabled() {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem('cf-debug:render') === '1';
  } catch {
    return false;
  }
}
export function logRender(entry) {
  if (!renderLogEnabled()) return;
  LOG.push({ at: performance.timeOrigin + performance.now(), ...entry });
  if (LOG.length > 40) LOG.shift();
  for (const fn of LOG_LISTENERS) fn(LOG);
}
export function subscribeRenderLog(fn) {
  LOG_LISTENERS.add(fn);
  fn(LOG);
  return () => LOG_LISTENERS.delete(fn);
}
export function renderWorkerStatus() {
  const base = failed ? `worker OFF (${failReason || 'unsupported'})` : WORKER ? 'worker on' : 'worker not started';
  return geometryInPieces() ? `${base} · geo in pieces` : base;
}

// Whether the worker draws a big geometry layer in pieces (GeometricShape's drawGeometryInBatches).
// Behind a flag until it is confirmed on an iPhone (2026-10-25): ?geobatch=1 on any URL turns it on
// and is remembered, ?geobatch=0 turns it off. Read on every render, so it takes effect at once.
export function geometryInPieces() {
  try {
    const q = new URLSearchParams(location.search).get('geobatch');
    if (q === '1') localStorage.setItem('cf-debug:geobatch', '1');
    if (q === '0') localStorage.removeItem('cf-debug:geobatch');
    return localStorage.getItem('cf-debug:geobatch') === '1';
  } catch {
    return false;
  }
}
let failReason = '';

let WORKER = null;
let failed = false;
let nextId = 0;
const JOBS = new Map();

function supported() {
  try {
    return typeof Worker !== 'undefined' && typeof OffscreenCanvas !== 'undefined' && !!new OffscreenCanvas(1, 1).getContext('2d');
  } catch {
    return false;
  }
}

function worker() {
  if (WORKER || failed) return WORKER;
  if (!supported()) {
    failed = true;
    failReason = 'no OffscreenCanvas 2D';
    return null;
  }
  try {
    WORKER = new Worker(new URL('./renderWorker.js', import.meta.url), { type: 'module' });
    WORKER.onmessage = e => {
      const done = JOBS.get(e.data.id);
      JOBS.delete(e.data.id);
      done?.(e.data);
    };
    WORKER.onerror = err => {
      console.warn('[render] worker failed, rendering on the page:', err.message);
      failed = true;
      failReason = String(err.message || 'worker error').slice(0, 80);
      WORKER = null;
      for (const done of JOBS.values()) done({ error: 'worker failed' });
      JOBS.clear();
    };
  } catch {
    failed = true;
    WORKER = null;
  }
  return WORKER;
}

/** True when `config` can be rebuilt in the worker (it came straight from generateArtwork). */
export function canRenderOffThread(config) {
  const g = config && config.generatedBy;
  return !!g && g[1] === config.width && g[2] === config.height && !failed;
}

/**
 * Renders a design off the main thread. `args` are generateArtwork's arguments; `out` is the
 * encoded image wanted ({ width, height, quality }), which may be smaller than the generated
 * size (a density-floor render). Resolves with a JPEG Blob, or null to render on the page.
 * `priority` orders the worker's queue (higher first; see renderWorker.js).
 */
// Queue order in the render worker (higher first). AMBIENT: the surfaces that change as one on
// a fixed beat (StudioContext.ambientRender). SHIRT: the homepage shirt's three textures, which
// must be ready by the hero's reveal -- the shirt commits its new sheet on that beat, and a sheet
// still queued behind the hero showed a blank (first load) or a lagging shirt (Aaron, 2026-10-19).
// DEFAULT: the hero and everything else. LOW: below the fold (the homepage About blob), which
// must never delay the hero.
export const PRIORITY_AMBIENT = 3;
export const PRIORITY_SHIRT = 2;
export const PRIORITY_DEFAULT = 1;
export const PRIORITY_LOW = 0;
export function renderOffThread(args, out, priority = PRIORITY_DEFAULT) {
  const w = worker();
  if (!w) return Promise.resolve(null);
  return new Promise(resolve => {
    const id = ++nextId;
    const sentAt = performance.timeOrigin + performance.now();
    JOBS.set(id, msg => {
      const t = msg.timing;
      logRender({
        size: `${out.width}x${out.height}`,
        priority,
        path: msg.error ? 'worker FAILED' : 'worker',
        wait: t ? Math.round(t.startAt - sentAt) : null,
        phases: t ? `ld${t.load} gen${t.gen} neb${t.nebula} geo${t.geometry ?? 0} draw${t.draw} enc${t.encode}` : '',
        total: Math.round(performance.timeOrigin + performance.now() - sentAt)
      });
      if (msg.error) {
        // a render that fails in the worker will fail the same way next time: stop asking it
        console.warn('[render] worker job failed, rendering on the page from now on:', msg.error);
        failed = true;
        failReason = String(msg.error).split('\n')[0].slice(0, 80);
        return resolve(null);
      }
      if (import.meta.env?.DEV) console.info(`[render] ${out.width}x${out.height} in the worker, ${msg.ms}ms`);
      resolve(msg.blob);
    });
    w.postMessage({ id, args, out, priority, geoBatch: geometryInPieces(), createjsUrl: new URL('/createjs.min.js', location.href).href });
  });
}

/** renderOffThread for a config from generateArtwork, at its own size. */
export function renderConfigOffThread(config, quality) {
  if (!canRenderOffThread(config)) return Promise.resolve(null);
  return renderOffThread(config.generatedBy, { width: config.width, height: config.height, quality });
}
