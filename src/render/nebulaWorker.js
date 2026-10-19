// The nebula's worker: computes a design's mask off the main thread (see prepareNebula in
// render/nebula.js). It runs the very same functions the synchronous path does -- placement, the
// field (GPU through an OffscreenCanvas when the browser allows WebGL2 in a worker, else the CPU),
// the tone curve, the pools -- so the mask is the same whichever thread made it.
import { nebulaRGBA, placement } from './nebula';
import { detailNoiseData } from './nebulaDetail';

const scope = /** @type {any} */ (self); // a DedicatedWorkerGlobalScope; tsc types `self` as Window

scope.onmessage = e => {
  const { id, job, cpu } = e.data;
  if (e.data.detail) {
    const data = detailNoiseData();
    scope.postMessage({ id, data }, [data.buffer]);
    return;
  }
  if (e.data.placement) {
    const { seed, cover } = e.data.placement;
    try {
      scope.postMessage({ id, loc: placement(seed, cover) });
    } catch (err) {
      scope.postMessage({ id, error: String(err) });
    }
    return;
  }
  try {
    const t0 = performance.now();
    const info = { gpu: false };
    const { rgba, w, h } = nebulaRGBA(job, { gpu: !cpu, info });
    scope.postMessage({ id, rgba, w, h, gpu: info.gpu, ms: Math.round(performance.now() - t0) }, [rgba.buffer]);
  } catch (err) {
    scope.postMessage({ id, error: String(err && err.message ? err.message : err) });
  }
};
