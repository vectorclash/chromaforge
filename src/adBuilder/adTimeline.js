// Where everything in an ad happens, in seconds. Pure, so the preview and the export cannot
// disagree about it.
//
// An ad is the flight, then each product photo in turn, every boundary on a bar line of the
// music: the flight slows toward its loop seam, the first photo assembles out of facets over it
// while it is still slowing, and each later photo assembles over the one before.

// Instagram Reels: 9:16 at 1080x1920, 30fps.
export const AD_WIDTH = 1080;
export const AD_HEIGHT = 1920;
// The sizes an ad can be exported at (2026-11-03, Aaron: the Reels' 9:16 plus feed, square and
// landscape, for other platforms and the demo reel). 9:16 stays the default and lays out exactly
// as it always has; see adLayout for the rest.
export const AD_SIZES = [
  { id: '9:16', label: '9:16', width: 1080, height: 1920 },
  { id: '4:5', label: '4:5', width: 1080, height: 1350 },
  { id: '1:1', label: '1:1', width: 1080, height: 1080 },
  { id: '16:9', label: '16:9', width: 1920, height: 1080 }
];
export const adSize = id => AD_SIZES.find(s => s.id === id) ?? AD_SIZES[0];
export const AD_FPS = 30;

// The flight's loop length -- the studio's default Duration.
export const SCENE_DURATION = 10;

// How far before the loop seam (in the flight's own time) the first product arrives. The speed
// ramp nearly stops the camera at the seam -- its last 1.5s run under a third of full speed -- and
// ending the flight right on it left a long, dead stretch before the first product (Aaron,
// 2026-10-06). Arriving this far ahead, the product lands while the flight is still visibly
// slowing (~0.35x), and the flight carries on slowing behind it. Raise it to cut in sooner. It
// also sets where a flight may START (the same distance after the seam -- see adComposer's
// drawFlight), so raising it shortens the stretch a long flight can play at full speed.
export const SEAM_LEAD = 1.5;

// Used when an ad has no music to take a tempo from.
export const DEFAULT_TEMPO = 110;
const BEATS_PER_BAR = 4;

// A cut between products (cutShader.js): long enough to follow as one motion, but never more than
// most of a short product's time on screen.
const CUT_SECONDS = 0.72;
const CUT_MAX_SHARE = 0.85;

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
    const transition = Math.min(CUT_SECONDS, CUT_MAX_SHARE * (end - t));
    products.push({ start: t, end, transition });
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

// Where the lockup and the products go in a frame, in pixels.
//   unit     -- the lockup's scale (1 = as authored for a 1080-wide 9:16 frame)
//   lockup   -- its centre across the frame and the top of its band
//   product  -- the rectangle products are placed in, clear of the lockup
//   facets   -- where a cut's facets assemble from
//   landscape -- a frame wider than tall: lockup in a left column, products in the right
// A 9:16 frame keeps Instagram Reels' safe zones (the app's own UI covers the top 14% and the
// bottom 35%) and is exactly the layout every ad had before sizes. The others are feed and video
// frames with no UI over them, so they keep only a margin.
export const SAFE_TOP = 0.14;
export const SAFE_BOTTOM = 0.35;
// The lockup's height as a fraction of a 9:16 frame -- the band reserved for it.
export const LOCKUP_BAND = 0.088;
const MARGIN = 0.05;
export function adLayout(width, height, position = 'bottom', showText = true) {
  const tall = height / width > 1.5;
  if (tall) {
    // 9:16, as before sizes.
    const top = SAFE_TOP;
    const bottom = 1 - SAFE_BOTTOM;
    const bands = !showText
      ? { lockupTop: 0, product: [top + 0.01, bottom] }
      : position === 'bottom'
        ? { lockupTop: bottom - LOCKUP_BAND, product: [top + 0.01, bottom - LOCKUP_BAND - 0.012] }
        : { lockupTop: top + 0.004, product: [top + 0.004 + LOCKUP_BAND + 0.012, bottom] };
    return {
      unit: width / 1080,
      landscape: false,
      lockup: { cx: width / 2, top: bands.lockupTop * height },
      product: { x0: 0, x1: width, y0: bands.product[0] * height, y1: bands.product[1] * height },
      facets: [width / 2, height / 2]
    };
  }
  if (width > height) {
    // Landscape: the lockup centred in the left column, the products in the right, full height.
    const unit = (0.95 * height) / 1080;
    const band = LOCKUP_BAND * 1920 * unit;
    const split = 0.46 * width;
    const product = { x0: split, x1: width * (1 - MARGIN / 2), y0: height * MARGIN, y1: height * (1 - MARGIN) };
    return {
      unit,
      landscape: true,
      lockup: { cx: split / 2 + (width * MARGIN) / 2, top: (height - band) / 2 },
      product: showText ? product : { x0: width * MARGIN, x1: width * (1 - MARGIN), y0: product.y0, y1: product.y1 },
      facets: showText ? [(product.x0 + product.x1) / 2, height / 2] : [width / 2, height / 2]
    };
  }
  // 4:5 and 1:1: the 9:16 stack -- the lockup's band at the top or bottom, products in the rest --
  // with a margin in place of the safe zones and a lockup sized to the shorter frame.
  const unit = Math.min(width / 1080, height / 1350) * (height / width < 1.1 ? 0.85 : 0.95);
  const band = LOCKUP_BAND * 1920 * unit;
  const gap = 0.012 * height;
  const top = MARGIN * height;
  const bottom = (1 - MARGIN) * height;
  const product = !showText
    ? { y0: top, y1: bottom }
    : position === 'bottom'
      ? { y0: top, y1: bottom - band - gap }
      : { y0: top + band + gap, y1: bottom };
  return {
    unit,
    landscape: false,
    lockup: { cx: width / 2, top: position === 'bottom' ? bottom - band : top },
    product: { x0: 0, x1: width, ...product },
    facets: [width / 2, height / 2]
  };
}
