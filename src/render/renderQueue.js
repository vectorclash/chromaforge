// Interactive renders, broken up so the page keeps animating while they run.
//
// A Generate re-renders the design for every surface that shows it -- the studio/hero canvas at
// full size, then the shared preview, the footer band, the 3D shirt's texture pieces, the About
// blob. Profiled on the homepage, that was two unbroken blocks of main-thread work of ~370ms and
// ~510ms, almost all of it canvas compositing (renderArtwork's drawImage calls). Nothing can be
// painted during a block, so every JS-driven animation froze for its length and resumed with a
// jump -- most visibly the 3D shirt's shader transition (Aaron: "the pause in animation reads as
// a glitch").
//
// Two things fix it, both here:
//   1. Each render yields for a frame between its LAYERS (renderArtworkInSteps), so no single
//      stretch of work is longer than one layer.
//   2. Renders run ONE AT A TIME, in the order they were asked for. Before, every surface's
//      render ran inside the same effect flush; interleaved stepwise renders would instead all
//      hold their full-size canvases at once, which is a memory spike on exactly the devices
//      (phones) that already fail at these canvas sizes.
// The work is the same and the output is byte-identical; it just takes a little longer end to
// end, which is the trade Aaron asked for ("that just gives the user more time to enjoy the
// animations we built").
//
// Browser-only. render-service and anything producing a print file use the synchronous
// renderArtwork and never come through here. And none of this applies during a page load --
// see "Two pathways" below.
import renderArtwork, { renderArtworkInSteps } from './renderArtwork';

// A pause that is guaranteed to include a paint: rAF runs just before the next frame is drawn,
// and a timeout queued from inside it runs just after. A bare setTimeout(0) does not promise a
// frame in between, and a microtask never yields at all.
export function nextFrame() {
  return new Promise(resolve => {
    requestAnimationFrame(() => setTimeout(resolve, 0));
  });
}

/** @type {{ job: () => unknown, resolve: (v: any) => void, reject: (e: any) => void }[]} */
const jobs = [];
let running = false;

function pump() {
  if (running || jobs.length === 0) return;
  running = true;
  const { job, resolve, reject } = jobs.shift();
  Promise.resolve()
    .then(job)
    .then(resolve, reject)
    .finally(() => {
      running = false;
      pump();
    });
}

// Queues `job` behind every render already waiting, and resolves with its result. A job that
// throws rejects its own promise without stalling the jobs behind it.
//
// `priority` puts it at the FRONT of what is waiting (never interrupting what is running). It
// exists for StudioContext's shared 480px preview: React runs a child's effects before its
// parent's, so on a Generate the footer band, the shirt's texture pieces and the About blob all
// queued ahead of the preview -- and the preview is what the mini generator's thumbnail shows
// and what ends its spinner. It is ~30ms of work; it should never wait on ~1s of other surfaces.
/**
 * @template T
 * @param {() => T | Promise<T>} job
 * @param {{ priority?: boolean }} [options]
 * @returns {Promise<T>}
 */
export function enqueueRender(job, { priority = false } = {}) {
  return new Promise((resolve, reject) => {
    const entry = { job, resolve, reject };
    if (priority) jobs.unshift(entry);
    else jobs.push(entry);
    pump();
  });
}

// ── Two pathways: fast on load, stepwise after ─────────────────────────────────────────────
// Stepwise rendering is the right trade for an interaction -- a Generate, a slider -- where the
// page is already on screen and its animations are the thing being looked at. It is the WRONG
// trade for a page load. Measured on real GPU raster (an M4 Max, ANGLE/Metal), where the drawing
// itself is quick: a homepage load renders ~13 surfaces, and splitting each into layers and
// strips with a frame between every piece took the last of them from ~1.6s to ~3.0s. Aaron:
// "having the initial site load take 4 times longer just isn't acceptable considering how fast
// it was before". (It did not show on the CPU-rasterized headless Chromium first used to
// measure this, where the drawing is slow enough to hide the frame waits -- measure render
// timing on real GPU raster, `--use-angle=metal`, not the default SwiftShader.)
//
// So a page load runs the way it always did: every render synchronous, straight through, the
// instant it is asked for. A FAST WINDOW is open at startup and reopened by every route change
// (openFastWindow); it closes once renders have gone quiet for FAST_IDLE_MS -- the load's burst
// is over -- or immediately when the user starts a generate (endFastWindow, called by
// utils/afterFeedback). Everything after that is stepwise.
const FAST_IDLE_MS = 1000;
let fastWindow = true;
let idleTimer = 0;

function armIdleClose() {
  clearTimeout(idleTimer);
  idleTimer = window.setTimeout(() => {
    fastWindow = false;
  }, FAST_IDLE_MS);
}

// A load (or a route change, which mounts a new page's surfaces) is starting.
export function openFastWindow() {
  fastWindow = true;
  armIdleClose();
}

// The user has asked for work -- from here on, keep the page animating.
export function endFastWindow() {
  clearTimeout(idleTimer);
  fastWindow = false;
}

// renderArtwork, on whichever pathway applies. Stepwise renders are queued (see enqueueRender);
// a fast render runs synchronously at the call, exactly as every render did before either
// existed -- it does not wait behind the queue, and it draws into its own canvas, so a stepwise
// render still in flight is unaffected. Hidden documents (a background tab) get no frames at
// all, so a stepwise render there runs straight through rather than waiting on a paint that
// never comes.
/**
 * @param {object} config
 * @param {{ priority?: boolean }} [options]
 * @returns {Promise<HTMLCanvasElement>}
 */
export function renderArtworkQueued(config, options) {
  if (fastWindow) {
    armIdleClose();
    try {
      return Promise.resolve(renderArtwork(config));
    } catch (err) {
      return Promise.reject(err);
    }
  }
  return enqueueRender(async () => {
    if (document.hidden) return renderArtwork(config);
    await nextFrame();
    return renderArtworkInSteps(config, () => (document.hidden ? Promise.resolve() : nextFrame()));
  }, options);
}

// The window is open from startup; start its idle clock so a page that renders nothing at all
// still settles into the stepwise pathway.
if (typeof window !== 'undefined') armIdleClose();
