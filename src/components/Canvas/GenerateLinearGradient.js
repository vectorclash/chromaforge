import { randomPalette } from '../../render/prng';

export default class GenerateLinearGradient {
  constructor(
    width,
    height,
    complexity = 0,
    colors = [],
    rng = Math.random,
    { hueBias = null, hueSpread = null } = {}
  ) {
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
      // `hueSpread` (from GenerateStarField -- the only caller that passes it) widens or
      // narrows how far the stops range around the anchor. Anchored palettes are CENTRED on
      // the anchor rather than walking forward from it, which is what lets a wide spread stay
      // a genuine complement instead of wrapping back onto the hue it is complementing -- see
      // randomPalette's own comment for the bug that came from getting this wrong.
      config.colors = randomPalette(
        rng,
        colorAmount,
        hueBias !== null
          ? {
              baseHue: hueBias,
              centered: true,
              minSpread: hueSpread ? hueSpread.min : 10,
              maxSpread: hueSpread ? hueSpread.max : 35
            }
          : {}
      );
    }

    return config;
  }
}
