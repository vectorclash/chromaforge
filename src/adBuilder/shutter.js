// Motion blur for a transparent layer, as a camera shutter makes it: the moments across an exposure,
// averaged, so whatever moves streaks by exactly how fast it moves. The caller composites the result
// over whatever must stay sharp -- in a Reel, the flight.
//
// Each moment needs both steps of the running mean: fading what is there by 1/(i+1) and adding the
// moment at 1/(i+1). Source-over at that alpha (which is enough over an opaque frame, as the
// explainer's is) never fades a pixel the next moment leaves empty, so a streak piles up towards
// where the thing started. Adding at a flat 1/n is also exact on paper, but its rounding builds up n
// times over, shifting colours as they settle.

/**
 * A function that exposes `samples` moments across `open` seconds, centred on `t`, calling
 * `drawMoment(ctx, at)` for each on a cleared canvas, and returns the canvas holding their mean.
 * Its canvases are made on first use and reused, so the result is only good until the next call.
 * @param {number} width
 * @param {number} height
 * @returns {(t: number, open: number, samples: number, drawMoment: (ctx: CanvasRenderingContext2D, at: number) => void) => HTMLCanvasElement}
 */
export function createShutter(width, height) {
  let meanCanvas = null;
  let momentCanvas = null;
  return (t, open, samples, drawMoment) => {
    if (!meanCanvas) {
      [meanCanvas, momentCanvas] = [0, 1].map(() => {
        const c = document.createElement('canvas');
        c.width = width;
        c.height = height;
        return c;
      });
    }
    const mean = meanCanvas.getContext('2d');
    const moment = momentCanvas.getContext('2d');
    mean.clearRect(0, 0, width, height);
    for (let i = 0; i < samples; i++) {
      moment.clearRect(0, 0, width, height);
      moment.save();
      drawMoment(moment, t + ((i + 0.5) / samples - 0.5) * open);
      moment.restore();
      const weight = 1 / (i + 1);
      mean.globalAlpha = weight;
      mean.globalCompositeOperation = 'destination-out';
      mean.fillRect(0, 0, width, height);
      mean.globalCompositeOperation = 'lighter';
      mean.drawImage(momentCanvas, 0, 0);
    }
    mean.globalAlpha = 1;
    mean.globalCompositeOperation = 'source-over';
    return meanCanvas;
  };
}
