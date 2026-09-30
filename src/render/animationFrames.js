// Building a 2D animation's frames: shared by the studio (DisplayCanvas) and the gallery modal's
// play button, so both build the same way.
//
// Measured 2026-09-30 (20 frames + 10 star frames, 3840x2160, desktop GPU raster): a 5.4s build
// was 3.0s of fixed 100ms sleeps between frames, 1.1s of JPEG and 0.5-0.85s of PNG encoding, and
// only ~0.6s of rendering; the share/gallery load path slept 700ms per frame, ~21s. The sleeps
// existed to let the loader paint, which one frame's yield does just as well, and the encodes run
// off the main thread (2 long tasks in a whole build), so the next frame renders while the
// previous one encodes. At most FRAMES_IN_FLIGHT full-size canvases exist at once, which keeps a
// phone -- where toBlob already returns null under memory pressure -- no worse off than a render
// plus its raster copy. 5.4s -> 2.35s (Chromium), 5.8s -> 2.5s (WebKit).
import GenerateStarField from '../components/Canvas/GenerateStarField';
import StarField from '../components/Canvas/StarField';
import { meanLuminance } from './prng';

const FRAMES_IN_FLIGHT = 2;

export class AnimationBuildCancelled extends Error {}

// Lets a loader paint between frames. A rAF alone would stall in a background tab, where it does
// not fire, so the timeout is the fallback that keeps a hidden build moving.
export function yieldToPaint() {
  return new Promise(resolve => {
    let done = false;
    const go = () => {
      if (!done) {
        done = true;
        resolve();
      }
    };
    requestAnimationFrame(() => setTimeout(go, 0));
    setTimeout(go, 100);
  });
}

// Releases a canvas's backing store now rather than whenever GC gets to it
export function releaseCanvas(canvas) {
  canvas.width = 0;
  canvas.height = 0;
}

// Encodes a finished canvas to a blob URL, releasing the canvases once it lands. `rasterize`
// may return a smaller copy to store instead (phones -- see DisplayCanvas's MOBILE_ANIM_RASTER).
function encodeFrame(canvas, type, quality, rasterize) {
  const out = rasterize ? rasterize(canvas) : canvas;
  return new Promise((resolve, reject) => {
    out.toBlob(blob => {
      if (out !== canvas) releaseCanvas(out);
      releaseCanvas(canvas);
      // WebKit's toBlob can give up (null) at these sizes under memory pressure. Passing null
      // to URL.createObjectURL would throw out of this callback, unhandled, and strand the build.
      if (blob) resolve(URL.createObjectURL(blob));
      else reject(new Error('Animation frame encode failed (canvas.toBlob returned null).'));
    }, type, quality);
  });
}

// `count` frames, each drawn by `draw(i)` (returning a finished canvas), rendered in order with
// each encode overlapping the next render. Resolves to blob URLs in index order; `onFrame(n)`
// reports progress as encodes land. `isCancelled()` stops the build between frames, rejecting
// with AnimationBuildCancelled. On any failure every URL made so far is revoked.
/**
 * @param {number} count
 * @param {(i: number) => HTMLCanvasElement} draw
 * @param {{ type?: string, quality?: number, onFrame?: (n: number) => void,
 *   rasterize?: (c: HTMLCanvasElement) => HTMLCanvasElement, isCancelled?: () => boolean }} [options]
 */
export async function renderFrames(count, draw, { type = 'image/jpeg', quality = 0.98, onFrame, rasterize, isCancelled } = {}) {
  const urls = new Array(count);
  const inFlight = [];
  let done = 0;
  try {
    for (let i = 0; i < count; i++) {
      await yieldToPaint();
      if (isCancelled?.()) throw new AnimationBuildCancelled();
      const job = encodeFrame(draw(i), type, quality, rasterize).then(url => {
        urls[i] = url;
        onFrame?.(++done);
      });
      inFlight.push(job);
      if (inFlight.length >= FRAMES_IN_FLIGHT) await inFlight.shift();
    }
    await Promise.all(inFlight);
    if (isCancelled?.()) throw new AnimationBuildCancelled();
  } catch (e) {
    await Promise.allSettled(inFlight);
    urls.forEach(url => url && URL.revokeObjectURL(url));
    throw e;
  }
  return urls;
}

// Star-only overlay frames as transparent PNGs -- stars composite naturally over whatever
// gradient frame is showing without any blend mode tricks. Each gets a freshly randomised layout
// for variety, in the animation's palette.
export function renderStarFrames(count, width, height, colorValues, options = {}) {
  return renderFrames(
    count,
    () => {
      // backgroundHue/sizeFrame stay at their defaults here (these overlay frames aren't tied to
      // a placement, and the hue bias only applies to an empty palette anyway), but the
      // background lightness is passed for real -- it's what decides whether the stars are
      // driven light or dark to contrast, so leaving it at the 0.5 default would give these
      // frames a different star treatment than the main frames they overlay.
      const starConfig = new GenerateStarField(width, height, colorValues.slice(), Math.random, null, null, meanLuminance(colorValues));
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      canvas.getContext('2d').drawImage(StarField(starConfig), 0, 0);
      return canvas;
    },
    { ...options, type: 'image/png', quality: undefined }
  );
}

// The playback timing AnimationPreview needs, from a frame count and duration -- the one
// derivation, shared so the studio and the gallery modal play an animation identically.
export function animTiming(frameCount, cycleDuration, starCount = Math.max(1, Math.ceil(frameCount / 2))) {
  const spacing = cycleDuration / frameCount;
  const starSpacing = cycleDuration / starCount;
  return {
    frameCount,
    starCount,
    spacing,
    fade: spacing * (5.0 / 3.5),
    starSpacing,
    starFade: starSpacing * (8.0 / 7.0),
    cycleDuration
  };
}
