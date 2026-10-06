import { FACET_INTRO_MS } from '../components/ui/facetMosaic';

// Where everything in an ad happens, in seconds. Pure, so the preview and the export cannot
// disagree about it.
//
// An ad is the flight, then each product photo in turn, every boundary on a bar line of the
// music: the flight decelerates into its loop seam, the first photo assembles out of facets over
// it, and each later photo assembles over the one before.

// Instagram Reels: 9:16 at 1080x1920, 30fps.
export const AD_WIDTH = 1080;
export const AD_HEIGHT = 1920;
export const AD_FPS = 30;

// The flight's loop length -- the studio's default Duration. The flight segment ENDS on the
// loop seam, where the speed ramp nearly stops the camera, so a longer loop only changes how
// fast it is going when the ad starts.
export const SCENE_DURATION = 10;

// Used when an ad has no music to take a tempo from.
export const DEFAULT_TEMPO = 110;
const BEATS_PER_BAR = 4;

/**
 * @param {{ tempo: number, flightBars: number, productBars: number, productCount: number }} o
 */
export function adTimeline({ tempo, flightBars, productBars, productCount }) {
  const beat = 60 / tempo;
  const bar = BEATS_PER_BAR * beat;
  const flight = flightBars * bar;
  const products = [];
  let t = flight;
  for (let i = 0; i < productCount; i++) {
    const end = t + productBars * bar;
    // Every cut uses the facets' longer INTRO run: a cut both breaks the outgoing product apart
    // and assembles the next, which needs the time.
    products.push({ start: t, end, transition: FACET_INTRO_MS / 1000 });
    t = end;
  }
  return { beat, bar, flight, products, total: t };
}

// Which part of the ad `t` falls in, for the scrubber's labels.
export function segmentAt(timeline, t) {
  for (let i = timeline.products.length - 1; i >= 0; i--) {
    if (t >= timeline.products[i].start) return i;
  }
  return -1;
}
