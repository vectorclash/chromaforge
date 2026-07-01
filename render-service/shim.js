// Makes generateArtwork.js/renderArtwork.js/Generate*.js -- written for a real browser --
// runnable unmodified in plain Node. We import those files directly (no copy, no port) so
// there is zero drift risk between what a customer's mockup showed and what gets printed.
//
// Two things those files need that Node doesn't provide natively:
//   1. `document.createElement('canvas')` -- backed here by @napi-rs/canvas, a Node canvas
//      library using the same Skia rendering engine real Chrome uses internally. Verified
//      this session: every globalCompositeOperation value the renderer uses (multiply,
//      screen, overlay, destination-atop, lighten, darken, hard-light) matches expected
//      blend math pixel-for-pixel under this library.
//   2. `window.createjs` -- GeometricShape.js is the one file that uses createjs/EaselJS
//      (Stage, Shape, gradient fill + composite operation) rather than plain Canvas2D.
//      Loaded here from this project's actual createjs.min.js (the same file index.html
//      serves -- read directly from ../public, not copied, so it can't drift) via Node's
//      `vm` module, which lets the bundle run as if it were a real browser <script> tag
//      (a plain `require`/`import` breaks it -- the bundle relies on implicit-global
//      assignment behavior that only works when evaluated against a `window`-as-global
//      object, not inside a module's function-scoped `this`).
//      Verified this session: Stage/Shape construction and gradient-fill rendering produce
//      correct, non-blank, correctly-colored output under this exact shim.

import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvas } from '@napi-rs/canvas';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Stage's constructor wires up mouse/touch event listeners for interactivity we'll never
// use in a one-shot server render -- these just need to exist and not throw, not do
// anything.
function patchCanvas(canvas) {
  canvas.addEventListener = () => {};
  canvas.removeEventListener = () => {};
  canvas.style = {};
  return canvas;
}

function createElement(tag) {
  return tag === 'canvas' ? patchCanvas(createCanvas(1, 1)) : {};
}

const sandbox = {};
sandbox.window = sandbox;
sandbox.self = sandbox;
sandbox.document = { createElement, addEventListener: () => {}, removeEventListener: () => {} };
sandbox.navigator = { userAgent: 'node' };
sandbox.console = console;
sandbox.performance = { now: () => Date.now() };
sandbox.requestAnimationFrame = cb => setTimeout(cb, 16);
sandbox.cancelAnimationFrame = id => clearTimeout(id);
sandbox.setTimeout = setTimeout;
sandbox.clearTimeout = clearTimeout;
sandbox.setInterval = setInterval;
sandbox.clearInterval = clearInterval;
vm.createContext(sandbox);

const createjsPath = path.join(__dirname, '..', 'public', 'createjs.min.js');
vm.runInContext(fs.readFileSync(createjsPath, 'utf8'), sandbox);

// Install onto the real Node global scope -- generateArtwork.js/renderArtwork.js/
// Generate*.js are imported as normal ES modules below (in render.js), not run inside the
// vm context above, so they need `window`/`document`/createjs as real globals, exactly as
// a browser provides them implicitly to every <script>.
global.window = global;
global.window.createjs = sandbox.createjs;
global.document = { createElement, addEventListener: () => {}, removeEventListener: () => {} };
// Recent Node versions define a built-in, read-only `navigator` global -- redefine rather
// than assign so this doesn't throw regardless of Node version.
Object.defineProperty(global, 'navigator', {
  value: sandbox.navigator,
  writable: true,
  configurable: true
});

export { createCanvas, patchCanvas };
