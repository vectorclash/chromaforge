// The nebula's worker: computes a design's mask off the main thread (see prepareNebula in
// render/nebula.js). It runs the very same functions the synchronous path does -- placement, the
// field (GPU through an OffscreenCanvas when the browser allows WebGL2 in a worker, else the CPU),
// the tone curve, the pools -- so the mask is the same whichever thread made it.
import { nebulaRGBABanded, placement } from './nebula';
import { detailNoiseData } from './nebulaDetail';

const scope = /** @type {any} */ (self); // a DedicatedWorkerGlobalScope; tsc types `self` as Window

// Jobs run one at a time: a mask job now awaits between GPU bands, and two interleaved jobs would
// share the one context's framebuffer.
let queue = Promise.resolve();
scope.onmessage = e => {
  queue = queue.then(() => handle(e.data));
};

async function handle(data) {
  const { id, job, cpu } = data;
  if (data.detail) {
    const detail = detailNoiseData();
    scope.postMessage({ id, data: detail }, [detail.buffer]);
    return;
  }
  if (data.placement) {
    const { seed, cover } = data.placement;
    try {
      scope.postMessage({ id, loc: placement(seed, cover) });
    } catch (err) {
      scope.postMessage({ id, error: String(err) });
    }
    return;
  }
  try {
    const t0 = performance.now();
    const info = { gpu: false, bands: 0, maxBandMs: 0 };
    const { rgba, w, h } = await nebulaRGBABanded(job, { gpu: !cpu, info });
    scope.postMessage({ id, rgba, w, h, gpu: info.gpu, bands: info.bands, maxBandMs: Math.round(info.maxBandMs * 10) / 10, ms: Math.round(performance.now() - t0) }, [rgba.buffer]);
  } catch (err) {
    scope.postMessage({ id, error: String(err && err.message ? err.message : err) });
  }
}
