import { FACET_INTRO_MS } from '../components/ui/facetMosaic';

// Where everything in an ad happens, in seconds. Pure, so the preview and the export cannot
// disagree about it.
//
// An ad is the flight, then each product photo in turn, every boundary on a bar line of the
// music: the flight slows toward its loop seam, the first photo assembles out of facets over it
// while it is still slowing, and each later photo assembles over the one before.

// Instagram Reels: 9:16 at 1080x1920, 30fps.
export const AD_WIDTH = 1080;
export const AD_HEIGHT = 1920;
export const AD_FPS = 30;

// The flight's loop length -- the studio's default Duration.
export const SCENE_DURATION = 10;

// How far before the loop seam (in the flight's own time) the first product arrives. The speed
// ramp nearly stops the camera at the seam -- its last 1.5s run under a third of full speed -- and
// ending the flight right on it left a long, dead stretch before the first product (Aaron,
// 2026-10-06). Arriving this far ahead, the product lands while the flight is still visibly
// slowing (~0.35x), and the flight carries on slowing behind it. Raise it to cut in sooner.
export const SEAM_LEAD = 1.5;

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
