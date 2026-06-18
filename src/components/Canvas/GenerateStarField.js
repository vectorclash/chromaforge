import GenerateLinearGradient from './GenerateLinearGradient';

export default class GenerateStarField {
  constructor(width, height, colors = [], rng = Math.random) {
    let config = {};

    config.width = width;
    config.height = height;

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

    let xlStarSizeMax = width / 4;
    let xlStarSizeMin = width / 30;

    for (let i = 0; i < 5; i++) {
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

    let largeStarSizeMax = width / 7;
    let largeStarSizeMin = width / 200;

    for (let i = 0; i < 50; i++) {
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

    let mediumStarSizeMax = width / 100;
    let mediumStarSizeMin = width / 3000;

    for (let i = 0; i < 200; i++) {
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
      smallStarAmount = 5000;
    } else if (smallStarChance > 0.7 && smallStarChance < 0.9) {
      smallStarAmount = Math.round(50 + rng() * 200);
    } else {
      smallStarAmount = Math.round(5000 + rng() * 100000);
    }

    config.smallStarAmount = smallStarAmount;

    // Fine star layer — previously generated with Math.random() at render time, which made
    // the same design render differently every time. Now seeded and resolved here so the
    // whole composition is fully deterministic from the seed (and matches at print time).
    let smallStars = [];
    let smallStarSizeMax = width / 500;
    let smallStarSizeMin = width / 5000;

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
