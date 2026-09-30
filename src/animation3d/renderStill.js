// One frame of a 3D flight as an image -- a saved 3D animation's gallery thumbnail.
//
// Imports three.js and the scene lazily: StudioContext (which saves thumbnails) is in the main
// bundle, and three is ~185KB gzip that nobody who never saves a 3D animation should pay for.
// Renders through the exact path (`exact: true`, the one the MP4 exporter uses), so the still is
// a real frame of the flight at full quality rather than a preview-cache approximation.
import { rampTime, rampRush, RAMP_FLOOR_3D } from '../utils/speedRamp';

// Where in the cycle the still is taken, as a fraction of it. The seam frame: compared across
// 0-0.5 on three designs, it is the moment the first plate fills the view, so it reads most like
// the 2D artwork, while by 0.3 the rush streaks are across the frame (2026-09-30).
export const STILL_AT = 0;

// Renders the frame and hands its canvas to `consume`, releasing everything afterwards.
/**
 * @param {{ seed: string, colors?: string[], settings?: any }} design
 * @param {{ duration: number, speedRamp?: boolean, width: number, height: number, at?: number }} opts
 * @param {(canvas: HTMLCanvasElement) => any} consume
 */
async function withStill(design, { duration, speedRamp = true, width, height, at = STILL_AT }, consume) {
  const [{ WebGLRenderer }, { createTunnelScene }] = await Promise.all([import('three'), import('./tunnelScene')]);
  const canvas = document.createElement('canvas');
  const renderer = new WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
  let world = null;
  try {
    renderer.setPixelRatio(1);
    renderer.setSize(width, height, false);
    world = createTunnelScene({
      seed: design.seed,
      colors: design.colors || [],
      settings: design.settings ?? null,
      duration,
      width,
      height,
      exact: true
    });
    await world.ready;
    const t = at * duration;
    world.setTime(speedRamp ? rampTime(t, duration, RAMP_FLOOR_3D) : t, speedRamp ? rampRush(t, duration) : 0, null);
    world.render(renderer);
    return await consume(canvas);
  } finally {
    world?.dispose();
    renderer.dispose();
    // dispose() alone leaves the context alive until GC -- see Animation3DPreview
    renderer.forceContextLoss();
  }
}

/**
 * @param {{ seed: string, colors?: string[], settings?: any }} design
 * @param {{ duration: number, speedRamp?: boolean, width: number, height: number, at?: number, type?: string, quality?: number }} opts
 */
export function render3DStill(design, { type = 'image/jpeg', quality = 0.92, ...opts }) {
  return withStill(
    design,
    /** @type {any} */ (opts),
    canvas =>
      new Promise((resolve, reject) =>
        canvas.toBlob(blob => (blob ? resolve(blob) : reject(new Error('3D still encode failed.'))), type, quality)
      )
  );
}

// The frame's pixels, for measuring it (render/logoInk). Copied through a 2D canvas, which is
// the portable way to read a WebGL canvas the right way up.
export function render3DStillPixels(design, opts) {
  return withStill(design, opts, canvas => {
    const c2 = document.createElement('canvas');
    c2.width = canvas.width;
    c2.height = canvas.height;
    const ctx = c2.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(canvas, 0, 0);
    return ctx.getImageData(0, 0, c2.width, c2.height);
  });
}
