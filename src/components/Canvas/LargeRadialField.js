import RadialGradient from './RadialGradient';

// Written as steps, one per blob, for the same reason as renderArtwork's renderSteps: it is the
// single heaviest layer at studio size (~150ms of unbroken work in a profile of the homepage
// Generate), so the stepwise compositor pauses between blobs as well as between layers. The
// blobs draw onto this layer's OWN canvas, so a pause between them leaves no shared state
// half-set. LargeRadialField below runs the steps straight through, unchanged.
/** @returns {Generator<undefined, HTMLCanvasElement, unknown>} */
export function* largeRadialFieldSteps(config) {
  let canvas = document.createElement('canvas');
  let context = canvas.getContext('2d');

  canvas.width = config.width;
  canvas.height = config.height;

  for (let i = 0; i < config.radGradients.length; i++) {
    context.globalCompositeOperation = 'overlay';

    // GenerateLargeRadialField stores alpha as rng().toFixed(2) -- a string. Browsers
    // coerce that to a number when assigned to globalAlpha; some non-browser canvas
    // implementations (e.g. server-side rendering) don't, and silently leave globalAlpha
    // at its default of 1 instead. Number(...) here matches the coercion renderArtwork.js
    // already does for overlayAlpha, so every environment behaves the same way.
    context.globalAlpha = Number(config.radGradients[i].alpha);

    let radGrad = RadialGradient(
      config.radGradSize,
      config.radGradSize,
      config.radGradients[i].colors
    );

    context.drawImage(
      radGrad,
      config.radGradients[i].x,
      config.radGradients[i].y,
      config.radGradients[i].size,
      config.radGradients[i].size
    );
    yield;
  }

  return canvas;
}

export default function LargeRadialField(config) {
  const steps = largeRadialFieldSteps(config);
  let step = steps.next();
  while (!step.done) step = steps.next();
  return step.value;
}
