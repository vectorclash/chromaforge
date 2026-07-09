import GenerateLinearGradient from './GenerateLinearGradient';
import { getCountScale, getElementSizeScale } from '../../render/scale';

export default class GenerateStarField {
  constructor(width, height, colors = [], rng = Math.random) {
    let config = {};

    config.width = width;
    config.height = height;

    // Orientation-independent (sqrt(width*height), not just the short axis) so star size
    // relative to the canvas doesn't swing with aspect ratio -- see render/scale.js. This
    // alone can't desync rng() consumption (same number of draws either way, just a
    // different value fed into each), so it's safe on its own.
    let sizeScale = getElementSizeScale(width, height);

    // Counts scale by area so a thumbnail doesn't get literally the same star counts as a
    // print (the original bug) -- but the loops below always run their ORIGINAL fixed trip
    // count (5/50/200/tiered-small, exactly as before this fix) and only KEEP a
    // size-scaled subset of what gets generated. This is deliberate: if the loop trip count
    // itself varied by size, rng() consumption would too, which shifts every downstream
    // draw (geometryChance, overlayChance, etc.) -- meaning the same seed could gain or
    // lose an entire geometry-shape layer purely depending on what size it's rendered at,
    // breaking the recompose-per-ratio guarantee that a mockup and its print are the same
    // underlying piece. Confirmed live: this was exactly what happened before this fix.
    // Sizes at/above the reference resolution keep everything generated (unchanged density
    // from before); only smaller canvases keep a reduced subset.
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

    // Widened (Aaron's request, 2026-07-09): the big star-large tier should be able to
    // fill out with noticeably larger stars, not just occasionally graze the old cap.
    // Both ends raised (not just the max) so the whole tier trends bigger on average,
    // not just a rarer huge outlier. Same rng() draw either way -- see GENERATOR_VERSION
    // v4 note above.
    let xlStarSizeMax = sizeScale / 2.5;
    let xlStarSizeMin = sizeScale / 20;
    let xlStars = [];

    for (let i = 0; i < 5; i++) {
      let ranSize = Math.round(xlStarSizeMin + rng() * xlStarSizeMax);
      let ranX = Math.round(-100 + rng() * width + 100);
      let ranY = Math.round(-100 + rng() * height + 100);

      xlStars.push({ x: ranX, y: ranY, size: ranSize, image: 'star-large' });
    }
    stars.push(...xlStars.slice(0, Math.max(1, Math.round(5 * countScale))));

    // Widened alongside xlStars above, same reasoning.
    let largeStarSizeMax = sizeScale / 4.5;
    let largeStarSizeMin = sizeScale / 120;
    let largeStars = [];

    for (let i = 0; i < 50; i++) {
      let ranSize = Math.round(largeStarSizeMin + rng() * largeStarSizeMax);
      let ranX = Math.round(-100 + rng() * width + 100);
      let ranY = Math.round(-100 + rng() * height + 100);

      largeStars.push({ x: ranX, y: ranY, size: ranSize, image: 'star-large' });
    }
    stars.push(...largeStars.slice(0, Math.max(1, Math.round(50 * countScale))));

    let mediumStarSizeMax = sizeScale / 100;
    let mediumStarSizeMin = sizeScale / 3000;
    let mediumStars = [];

    for (let i = 0; i < 200; i++) {
      let ranSize = Math.round(mediumStarSizeMin + rng() * mediumStarSizeMax);
      let ranX = Math.round(-100 + rng() * width + 100);
      let ranY = Math.round(-100 + rng() * height + 100);

      mediumStars.push({ x: ranX, y: ranY, size: ranSize, image: 'star-small' });
    }
    stars.push(...mediumStars.slice(0, Math.max(1, Math.round(200 * countScale))));

    let smallStarChance = rng();
    let smallStarAmount;

    if (smallStarChance < 0.7) {
      smallStarAmount = 5000;
    } else if (smallStarChance > 0.7 && smallStarChance < 0.9) {
      smallStarAmount = Math.round(50 + rng() * 200);
    } else {
      smallStarAmount = Math.round(5000 + rng() * 100000);
    }

    config.smallStarAmount = Math.max(1, Math.round(smallStarAmount * countScale));

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

    config.smallStars = smallStars.slice(0, config.smallStarAmount);

    config.stars = stars;

    return config;
  }
}
