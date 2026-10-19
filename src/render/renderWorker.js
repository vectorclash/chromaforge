// The artwork's render worker: builds and draws a design entirely off the page's thread, and
// hands back an encoded image (render/renderOffThread.js is the page's side).
//
// Why (2026-10-19, Aaron: Generate "just stops and loses a beat and then continues", worst on his
// iPhone): renderArtwork is synchronous canvas work -- ~100k star specks blitted, every layer
// composited, the nebula scaled up -- and done on the page it froze the old artwork's fade-out, the
// loader and everything else for the length of the render, once for the hero and once more for
// each surface showing the design. Here it costs the page nothing but receiving a Blob.
//
// It runs the very same render code the page and render-service do, made to work without a page
// the same way render-service/shim.js does it in Node: `document.createElement('canvas')` gives an
// OffscreenCanvas, and createjs (GeometricShape's EaselJS) is loaded from the same
// public/createjs.min.js the page uses, evaluated as a classic script so its implicit globals land
// on the worker's global scope.
const scope = /** @type {any} */ (self);

function patchCanvas(canvas) {
  // EaselJS's Stage wires DOM listeners (OffscreenCanvas is an EventTarget, so those are real and
  // harmless); nebulaGpu tags its canvas through `dataset`, and Stage touches `style`.
  canvas.dataset = {};
  canvas.style = {};
  return canvas;
}
scope.window = scope;
scope.document = {
  createElement: tag => (tag === 'canvas' ? patchCanvas(new OffscreenCanvas(1, 1)) : { style: {} }),
  addEventListener() {},
  removeEventListener() {}
};
if (!scope.requestAnimationFrame) {
  scope.requestAnimationFrame = cb => setTimeout(() => cb(performance.now()), 16);
  scope.cancelAnimationFrame = id => clearTimeout(id);
}

let ready = null;
function load(createjsUrl) {
  if (!ready)
    ready = (async () => {
      const src = await (await fetch(createjsUrl)).text();
      (0, eval)(src); // global scope, as a <script> tag would run it
      // Imported only after the shim and createjs are in place.
      const [{ generateArtwork }, { default: renderArtwork }, { prepareNebulaHere }] = await Promise.all([
        import('./generateArtwork'),
        import('./renderArtwork'),
        import('./nebula')
      ]);
      return { generateArtwork, renderArtwork, prepareNebulaHere };
    })();
  return ready;
}

// One render at a time, highest `priority` first, then in the order asked. The surfaces that
// mirror the design in small (mini generator, footer band, mobile nav -- renderOffThread's
// AMBIENT) go before the hero: they reveal together on a fixed beat from the click, while the
// hero is held for its own loader beat anyway and has the slack. Messages arriving in one burst
// (a Generate asks for every surface in the same task) are all read before the first is chosen.
const waiting = [];
let running = false;
let scheduled = false;
const now = () => performance.timeOrigin + performance.now(); // epoch ms, comparable with the page's
scope.onmessage = e => {
  e.data.recvAt = now();
  waiting.push(e.data);
  if (!running && !scheduled) {
    scheduled = true;
    setTimeout(pump, 0);
  }
};
async function pump() {
  scheduled = false;
  running = true;
  while (waiting.length) {
    let best = 0;
    for (let i = 1; i < waiting.length; i++) if ((waiting[i].priority || 0) > (waiting[best].priority || 0)) best = i;
    await handle(waiting.splice(best, 1)[0]);
  }
  running = false;
}

async function handle({ id, createjsUrl, args, out, recvAt }) {
  try {
    const startAt = now();
    const { generateArtwork, renderArtwork, prepareNebulaHere } = await load(createjsUrl);
    const t1 = now();
    const config = generateArtwork(...args);
    const t2 = now();
    await prepareNebulaHere(config);
    const t3 = now();
    let canvas = renderArtwork(config);
    if (out.width !== canvas.width || out.height !== canvas.height) {
      // a density-floor render, downsampled to the size asked for (same aspect, so no crop)
      const small = new OffscreenCanvas(out.width, out.height);
      small.getContext('2d').drawImage(canvas, 0, 0, out.width, out.height);
      canvas.width = 0;
      canvas.height = 0;
      canvas = small;
    }
    const t4 = now();
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: out.quality });
    canvas.width = 0;
    canvas.height = 0;
    const t5 = now();
    const r = x => Math.round(x);
    scope.postMessage({
      id,
      blob,
      ms: r(t5 - startAt),
      // for the on-page render log (components/ui/RenderLog.jsx)
      timing: { recvAt, startAt, load: r(t1 - startAt), gen: r(t2 - t1), nebula: r(t3 - t2), draw: r(t4 - t3), encode: r(t5 - t4) }
    });
  } catch (err) {
    scope.postMessage({ id, error: String(err && err.stack ? err.stack : err) });
  }
}
