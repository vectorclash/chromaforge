// The nebula field for a print, split across the machine's cores (2026-10-19).
//
// The field is ~145 Perlin evaluations per pixel at a fixed ~520k pixels (src/render/nebula.js,
// NEBULA_PIXELS), and without a GPU it was computed on one thread: measured on a real Fly
// performance-2x, it added ~8s to EVERY print file (a t-shirt sleeve 1.5s -> 9.7s, a whole
// t-shirt checkout 7.1s -> 19.1s). Each pixel is independent, so the rows are shared out to
// worker threads, which write straight into one SharedArrayBuffer. They run the very same
// nebula2dRows from the bundled render code, so the field is identical to the single-thread one.
//
// The pool is made once per process and kept: a render is one request at a time per machine
// (fly.toml's hard_limit = 1), so the threads are idle between fields, not competing.
import { Worker, isMainThread, parentPort } from 'node:worker_threads';
import os from 'node:os';

const THREADS = Math.max(1, Math.min(8, os.availableParallelism ? os.availableParallelism() : os.cpus().length));

if (!isMainThread) {
  const { nebula2dRows } = await import('./generated/render-lib.js');
  parentPort.on('message', ({ id, loc, w, h, oct, y0, y1, buffer }) => {
    const out = new Float32Array(buffer, y0 * w * 4, (y1 - y0) * w);
    nebula2dRows(loc, w, h, oct, y0, y1, out);
    parentPort.postMessage({ id });
  });
}

let pool = null;
let nextId = 0;
const waiting = new Map();
function threads() {
  if (pool) return pool;
  pool = Array.from({ length: THREADS }, () => {
    const t = new Worker(new URL(import.meta.url));
    t.on('message', ({ id }) => {
      const done = waiting.get(id);
      waiting.delete(id);
      done?.(true);
    });
    // A thread that dies must not leave its field waiting forever (that would hang the print
    // request): every pending job resolves as failed, the pool is dropped, and the caller gets
    // null -- nebula.js then computes the field on this thread, the way it always could.
    t.on('error', err => {
      console.error('[nebula] thread failed, computing the field on the main thread:', err);
      pool = null;
      for (const done of waiting.values()) done(false);
      waiting.clear();
    });
    t.unref(); // never what keeps the process alive
    return t;
  });
  return pool;
}

/** The field for nebula.js's prepareNebulaWithField, computed on every core (null if a thread failed). */
export async function nebulaFieldThreaded(loc, w, h, oct) {
  const buffer = new SharedArrayBuffer(w * h * 4);
  const workers = threads();
  // Interleaved bands rather than one block per thread: the field costs more where the clouds
  // are, so equal blocks can leave one thread with most of the work.
  const band = Math.max(1, Math.ceil(h / (workers.length * 8)));
  const jobs = [];
  let i = 0;
  for (let y0 = 0; y0 < h; y0 += band, i++) {
    const y1 = Math.min(h, y0 + band);
    const id = ++nextId;
    jobs.push(new Promise(resolve => waiting.set(id, resolve)));
    workers[i % workers.length].postMessage({ id, loc, w, h, oct, y0, y1, buffer });
  }
  // Held while a field is in flight, released after: idle threads never keep the process alive,
  // but a running job must (unref'd throughout, a caller with nothing else open exited mid-job).
  workers.forEach(t => t.ref());
  let ok;
  try {
    ok = (await Promise.all(jobs)).every(Boolean);
  } finally {
    workers.forEach(t => t.unref());
  }
  return ok ? new Float32Array(buffer) : null;
}

export { THREADS as NEBULA_THREADS };
