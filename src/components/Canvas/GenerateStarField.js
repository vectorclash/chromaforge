import GenerateLinearGradient from './GenerateLinearGradient';
import { getCountScale, getSizeScale } from '../../render/scale';

export default class GenerateStarField {
  constructor(width, height, colors = [], rng = Math.random) {
    let config = {};

    config.width = width;
    config.height = height;

    // Sizes off the smaller dimension (not width alone) so a tall/narrow canvas doesn't
    // size stars off its narrow axis only; counts scaled by area so density (stars per unit
    // area) stays roughly constant instead of a fixed count looking cluttered at thumbnail
    // size and sparse at print size -- see render/scale.js.
    let sizeScale = getSizeScale(width, height);
    let countScale = getCountScale(width, height);

    let gradientComplexity = Math.round(rng() * 4);
    let gradientConfig = new GenerateLinearGradient(
      width,
      height,
      gradientComplexity,
      colors.reverse(),
      rng
    );
    config.gradientConfig = gradientConfig;

    let stars = [];

    let xlStarSizeMax = sizeScale / 4;
    let xlStarSizeMin = sizeScale / 30;
    let xlStarCount = Math.max(1, Math.round(5 * countScale));

    for (let i = 0; i < xlStarCount; i++) {
      let ranSize = Math.round(xlStarSizeMin + rng() * xlStarSizeMax);
      let ranX = Math.round(-100 + rng() * width + 100);
      let ranY = Math.round(-100 + rng() * height + 100);

      let star = {
        x: ranX,
        y: ranY,
        size: ranSize,
        image: 'star-large'
      };

      stars.push(star);
    }

    let largeStarSizeMax = sizeScale / 7;
    let largeStarSizeMin = sizeScale / 200;
    let largeStarCount = Math.max(1, Math.round(50 * countScale));

    for (let i = 0; i < largeStarCount; i++) {
      let ranSize = Math.round(largeStarSizeMin + rng() * largeStarSizeMax);
      let ranX = Math.round(-100 + rng() * width + 100);
      let ranY = Math.round(-100 + rng() * height + 100);

      let star = {
        x: ranX,
        y: ranY,
        size: ranSize,
        image: 'star-large'
      };

      stars.push(star);
    }

    let mediumStarSizeMax = sizeScale / 100;
    let mediumStarSizeMin = sizeScale / 3000;
    let mediumStarCount = Math.max(1, Math.round(200 * countScale));

    for (let i = 0; i < mediumStarCount; i++) {
      let ranSize = Math.round(mediumStarSizeMin + rng() * mediumStarSizeMax);
      let ranX = Math.round(-100 + rng() * width + 100);
      let ranY = Math.round(-100 + rng() * height + 100);

      let star = {
        x: ranX,
        y: ranY,
        size: ranSize,
        image: 'star-small'
      };

      stars.push(star);
    }

    let smallStarChance = rng();
    let smallStarAmount;

    if (smallStarChance < 0.7) {
      smallStarAmount = Math.round(5000 * countScale);
    } else if (smallStarChance > 0.7 && smallStarChance < 0.9) {
      smallStarAmount = Math.round((50 + rng() * 200) * countScale);
    } else {
      smallStarAmount = Math.round((5000 + rng() * 100000) * countScale);
    }

    config.smallStarAmount = smallStarAmount;

    // Fine star layer — previously generated with Math.random() at render time, which made
    // the same design render differently every time. Now seeded and resolved here so the
    // whole composition is fully deterministic from the seed (and matches at print time).
    let smallStars = [];
    let smallStarSizeMax = sizeScale / 500;
    let smallStarSizeMin = sizeScale / 5000;

    for (let i = 0; i < smallStarAmount; i++) {
      let ranSize = smallStarSizeMin + rng() * smallStarSizeMax;
      let ranX = -100 + rng() * width + 100;
      let ranY = -100 + rng() * height + 100;
      smallStars.push({ x: ranX, y: ranY, size: ranSize });
    }

    config.smallStars = smallStars;

    config.stars = stars;

    return config;
  }
}
