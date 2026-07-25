import { randomPalette } from '../../render/prng';

export default class GenerateLinearGradient {
  constructor(width, height, complexity = 0, colors = [], rng = Math.random, { hueBias = null } = {}) {
    let config = {};

    config.width = width;
    config.height = height;

    // set the gradient direction

    let ranDirection = rng();
    if (ranDirection > 0.5) {
      config.gradientDirection = {
        x1: 0,
        y1: Math.round(rng() * height),
        x2: width,
        y2: Math.round(rng() * height)
      };
    } else {
      config.gradientDirection = {
        x1: Math.round(rng() * width),
        y1: 0,
        x2: Math.round(rng() * width),
        y2: height
      };
    }

    // set the colors

    config.colors = [];

    if (colors.length > 0) {
      // See GenerateLargeRadialField for why the one-colour special case is gone: a
      // one-colour palette is expanded centrally now (expandMonochromePalette), so this
      // only ever receives two or more.
      config.colors = colors;
    } else {
      let colorAmount = 2 + complexity;
      // When hue-biased (see GenerateStarField's use of this -- anchoring to the
      // background's complement), spread must stay NARROW, not wide: randomPalette spaces
      // stops linearly forward from the anchor by `spread` degrees, so with several stops
      // a wide spread walks the later stops most of the way back around the wheel,
      // landing them near the ORIGINAL hue being complemented against -- the opposite of
      // the guarantee this is for. Confirmed live: a 140-180 spread here put the star
      // field's last gradient stop back within ~10 degrees of the background's own hue.
      // A narrow spread keeps every stop clustered near the true complement instead.
      config.colors = randomPalette(
        rng,
        colorAmount,
        hueBias !== null ? { baseHue: hueBias, minSpread: 10, maxSpread: 35 } : {}
      );
    }

    return config;
  }
}
