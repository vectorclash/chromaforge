// One stock master, rendered and handed to ffmpeg: the loop behind the Stock master panel's "Render
// now" (StockRender.jsx) and the queue's runner (stockRunner.js), so the two can never render
// differently. It owns the GPU-reset recovery (animation3d/stockRender.js's StockContextLost): a
// reset rebuilds the renderer and redraws the frame it happened on, which comes out identical.
import { flightSceneDesign } from './feedPost';
import { stockStart, stockFrame, stockFinish, stockCancel } from './devApi';

// GPU resets survived in one render before giving up. Each one rebuilds the renderer -- the scene
// and the nebula bake, a second or two -- and redraws the frame.
export const MAX_RESETS = 5;

export class StockCancelled extends Error {
  constructor() {
    super('cancelled');
    this.name = 'StockCancelled';
  }
}

/**
 * @param {{ design: any, objects: number, opts: any, name: string, dir?: string, format: string,
 *   onProgress?: (p: { phase: string, frame: number, total: number, resets: number, drawn?: number,
 *     drawTime?: number, started?: number }) => void, cancelled?: () => boolean }} job
 *   `opts`: createStockRenderer's options. `dir`: a folder under .ads/stock (a pack).
 * @returns {Promise<{ file: string, bytes: number, frames: number, took: number, resets: number }>}
 */
export async function renderStockJob({ design, objects, opts, name, dir, format, onProgress = () => {}, cancelled = () => false }) {
  const { createStockRenderer, StockContextLost } = await import('../animation3d/stockRender');
  const sceneDesign = flightSceneDesign(design, objects);
  let r = null;
  let id = null;
  let resets = 0;
  let pending = null; // the previous frame's upload, overlapped with drawing the next
  const total = Math.round(opts.seconds * opts.fps);
  onProgress({ phase: 'building', frame: 0, total, resets });
  // Builds a renderer, through any GPU resets during the build itself
  const build = async () => {
    for (;;) {
      try {
        return await createStockRenderer(sceneDesign, opts);
      } catch (e) {
        if (!(e instanceof StockContextLost) || ++resets > MAX_RESETS) throw e;
        await new Promise(res => setTimeout(res, 1500));
      }
    }
  };
  try {
    r = await build();
    ({ id } = await stockStart({ name, dir, width: opts.width, height: opts.height, fps: opts.fps, format }));
    const started = performance.now();
    let drawn = 0; // frames drawn since `started`, for the rate (a reset's rebuild is not a frame)
    let drawTime = 0;
    for (let f = 0; f < r.frames; ) {
      if (cancelled()) throw new StockCancelled();
      const t0 = performance.now();
      let buf;
      try {
        buf = r.frameRgb48(f);
      } catch (e) {
        if (!(e instanceof StockContextLost) || ++resets > MAX_RESETS) throw e;
        // The GPU reset the context: nothing from it is trusted. Rebuild and draw frame f again
        // (its nebula offsets are keyed to f, so it comes out as it would have).
        console.warn(`[stock] GPU reset at frame ${f}; rebuilding (${resets}/${MAX_RESETS})`);
        onProgress({ phase: 'recovering', frame: f, total: r.frames, resets });
        r.dispose();
        r = null;
        await new Promise(res => setTimeout(res, 1500));
        r = await build();
        continue;
      }
      drawTime += performance.now() - t0;
      drawn++;
      if (pending) await pending;
      pending = stockFrame(id, buf);
      f++;
      onProgress({ phase: 'rendering', frame: f, total: r.frames, started, drawn, drawTime, resets });
      // let the page paint (and a cancel land) before the next frame's synchronous draw
      await new Promise(res => setTimeout(res, 0));
    }
    if (pending) await pending;
    pending = null;
    r.dispose();
    r = null;
    onProgress({ phase: 'encoding', frame: total, total, resets });
    const done = await stockFinish(id);
    id = null;
    return { file: done.file, bytes: done.bytes, frames: done.frames, took: (performance.now() - started) / 1000, resets };
  } catch (e) {
    await pending?.catch(() => {});
    if (id) await stockCancel(id).catch(() => {});
    if (e instanceof StockContextLost) {
      throw new Error(`the GPU reset ${resets} times, so the render stopped. Close other GPU-heavy tabs and try again.`, { cause: e });
    }
    throw e;
  } finally {
    r?.dispose();
  }
}
