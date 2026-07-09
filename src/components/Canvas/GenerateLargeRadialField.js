import tinycolor from 'tinycolor2';
import { randomPalette } from '../../render/prng';
import { getCountScale, getSizeScale } from '../../render/scale';

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

    // `amount` (the loop trip count) is computed unscaled -- exactly one rng() draw,
    // matching pre-fix behavior -- and the loop always runs the full unscaled amount, so
    // total rng() consumption here never depends on canvas size (each iteration below
    // consumes a variable number of draws depending on color branches, so varying the trip
    // count itself would desync every rng() draw downstream of this class -- same reasoning
    // as GenerateStarField's fixed-generate-then-truncate pattern). Only the KEPT subset
    // (pushed into config.radGradients below) is size-scaled.
    let amount = 2 + Math.round(rng() * 8);
    let keepAmount = Math.max(1, Math.round(amount * getCountScale(width, height)));
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
        if (colors.length === 1) {
          let colorChance = rng();
          if (colorChance > 0.5) {
            let ranGrayScale = Math.round(rng() * 255);
            let newColor = tinycolor({ r: ranGrayScale, g: ranGrayScale, b: ranGrayScale });
            let colorOrderChance = rng();
            if (colorOrderChance > 0.5) {
              radGrad.colors.push(colors[0]);
              radGrad.colors.push(newColor);
            } else {
              radGrad.colors.push(newColor);
              radGrad.colors.push(colors[0]);
            }
          }
        } else {
          radGrad.colors = colors.slice();
        }
      } else {
        radGrad.colors = randomPalette(rng, colorAmount);
      }

      radGradients.push(radGrad);
    }

    config.radGradients = radGradients.slice(0, keepAmount);

    return config;
  }
}
