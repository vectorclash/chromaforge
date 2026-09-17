import { randomPalette } from '../../render/prng';
import { getSizeScale } from '../../render/scale';

export default class GenerateLargeRadialField {
  constructor(width, height, colors = [], rng = Math.random) {
    let config = {};

    config.width = width;
    config.height = height;

    // Deliberately plain getSizeScale (min-based), NOT getElementSizeScale -- these blobs
    // are the composition's main color-carrying layer (the big saturated "glow" regions),
    // and getElementSizeScale's aspect-ratio correction (built for the chaotic-geometry
    // layer's "few huge dominant triangles" problem, see that formula's own comments) was
    // never actually verified for this layer before being applied here too. Confirmed live,
    // after a real complaint of "losing color depth" on a shirt panel: the correction was
    // shrinking these blobs on portrait canvases (down to ~400px from an original ~780px on
    // a 1556x2000 panel) while growing them on landscape ones (up to ~1160px from ~560px) --
    // exactly backwards from what a color-depth-carrying layer wants, and not something the
    // original "zoomed in" complaint was ever about (that was specifically the chaotic
    // triangles overlapping into flat color blocks, not this layer). Plain min(w,h) is what
    // this class used before any of that tuning and is what actually looked right here.
    config.radGradSize = getSizeScale(width, height) / 2;

    // `amount` (the loop trip count) is computed unscaled -- exactly one rng() draw -- and the
    // loop always runs the full amount, so rng() consumption here never depends on canvas size
    // (each iteration consumes a variable number of draws depending on colour branches, so
    // varying the trip count itself would desync every draw downstream of this class).
    //
    // EVERY GENERATED BLOB IS NOW KEPT (v14, 2026-09-17). This used to keep only
    // `amount * getCountScale(width, height)` of them, which made the layer's density a
    // function of the canvas -- so a capped mockup render dropped blobs the true-resolution
    // print file keeps. That is how a customer could approve a flat blue-purple t-shirt and be
    // sent a rainbow one (design SubatomicDiffraction-db0d, seed bffvnasl: the mockup kept 2 of
    // 4 blobs and the one it cut carried the entire colour identity, at alpha 0.97). Because
    // the slice was applied AFTER generation, removing it consumes identical rng() draws and
    // moves nothing else in the composition. See GenerateStarField for the full reasoning.
    let amount = 2 + Math.round(rng() * 8);
    let radGradients = [];

    for (let i = 0; i < amount; i++) {
      let radGrad = {};
      radGrad.alpha = rng().toFixed(2);
      radGrad.size = Math.round(config.radGradSize / 2 + rng() * config.radGradSize * 4);
      radGrad.x = Math.round(-radGrad.size + rng() * width + radGrad.size / 2);
      radGrad.y = Math.round(-radGrad.size + rng() * height + radGrad.size / 2);
      radGrad.colors = [];

      let colorAmount = 2 + Math.round(rng() * 3);

      if (colors.length > 0) {
        // No colors.length === 1 special case any more: generateArtwork expands a
        // one-colour palette before any generator sees it (see expandMonochromePalette).
        // What was here paired the colour with a RANDOM GREYSCALE value -- and only 50% of
        // the time, since the `else` pushed nothing at all, leaving radGrad.colors empty and
        // rendering roughly half of a single-colour design's blobs invisible. It also pushed
        // a raw tinycolor object, which crashed the print renderer outright.
        radGrad.colors = colors.slice();
      } else {
        radGrad.colors = randomPalette(rng, colorAmount);
      }

      radGradients.push(radGrad);
    }

    config.radGradients = radGradients;

    return config;
  }
}
