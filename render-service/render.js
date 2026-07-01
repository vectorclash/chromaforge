// Renders a design at a given resolution using the render pipeline bundled (by build.js,
// see its header comment) from the main app's actual ../src/render files -- not copied or
// ported by hand, so server-rendered print files can never drift from what a customer's
// mockup showed. shim.js (imported first, for its side effects) is what makes that
// pipeline runnable outside a real browser. Run `npm run build` before starting this
// service (or after any change to ../src/render) to regenerate generated/render-lib.js.
import './shim.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadImage } from '@napi-rs/canvas';
import { generateArtwork, GENERATOR_VERSION, renderArtwork } from './generated/render-lib.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ASSETS_DIR = path.join(__dirname, '..', 'src', 'assets', 'images');

// Mirrors StudioContext.jsx's LoadQueue -- but renderArtwork only ever calls
// images.getResult(id), so a plain object satisfying that one method is enough; no need
// for createjs's real (browser-XHR-based) LoadQueue here.
let imagesPromise = null;
function loadStarImages() {
  if (!imagesPromise) {
    imagesPromise = Promise.all([
      loadImage(fs.readFileSync(path.join(ASSETS_DIR, 'star-sprite-large.png'))),
      loadImage(fs.readFileSync(path.join(ASSETS_DIR, 'star-sprite-small.png')))
    ]).then(([large, small]) => ({
      getResult: id => (id === 'star-large' ? large : id === 'star-small' ? small : null)
    }));
  }
  return imagesPromise;
}

// design = { seed, colors, generatorVersion }. Caller (server.js) is responsible for
// checking generatorVersion against GENERATOR_VERSION before calling this -- this function
// always renders with whatever code is currently loaded, same as the rest of the app.
export async function renderDesign({ seed, colors, width, height }) {
  const images = await loadStarImages();
  const config = generateArtwork(seed, width, height, colors);
  const canvas = renderArtwork(config, images);
  return canvas.toBuffer('image/png');
}

export { GENERATOR_VERSION };
