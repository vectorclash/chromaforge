import LinearGradient from './LinearGradient';
import { drawStarSprite } from '../../render/starSprite';

export default function StarField(config, images) {
  let canvas = document.createElement('canvas');
  let context = canvas.getContext('2d');

  canvas.width = config.width;
  canvas.height = config.height;

  context.globalCompositeOperation = 'destination-atop';

  let gradient = LinearGradient(config.gradientConfig);
  context.drawImage(gradient, 0, 0);

  let starCanvas = document.createElement('canvas');
  let starContext = starCanvas.getContext('2d');

  starCanvas.width = config.width;
  starCanvas.height = config.height;

  for (let i = 0; i < config.stars.length; i++) {
    const star = config.stars[i];
    if (star.image === 'star-large') {
      // Drawn as vector paths at this star's real pixel size rather than scaled down from a
      // 648px raster -- see render/starSprite.js for why (the raster's cross went sub-pixel
      // on most of these stars, and the two canvas engines disagreed about how much of it
      // survived, so print files lost spikes the studio preview showed).
      drawStarSprite(starContext, star.x + star.size / 2, star.y + star.size / 2, star.size);
      continue;
    }
    // The fine tier keeps star-sprite-small.png: it is a SOLID four-point star, so its
    // points are the silhouette rather than a hairline over a halo and they survive any
    // amount of downscaling. Nothing to fix there.
    let starImage = images.getResult(star.image);
    if (starImage) {
      starContext.drawImage(starImage, star.x, star.y, star.size, star.size);
    }
  }

  // Fine star layer is now pre-resolved (and seeded) in GenerateStarField, so the same
  // config always draws the identical field. Fall back to smallStarAmount for any legacy
  // config that predates config.smallStars.
  let smallStars = config.smallStars;
  if (!smallStars && config.smallStarAmount) {
    smallStars = [];
    let smallStarSizeMax = config.width / 500;
    let smallStarSizeMin = config.width / 5000;
    for (let i = 0; i < config.smallStarAmount; i++) {
      smallStars.push({
        x: -100 + Math.random() * config.width + 100,
        y: -100 + Math.random() * config.height + 100,
        size: smallStarSizeMin + Math.random() * smallStarSizeMax
      });
    }
  }

  if (smallStars) {
    let smallStarImage = images.getResult('star-small');
    if (smallStarImage) {
      for (let i = 0; i < smallStars.length; i++) {
        starContext.drawImage(
          smallStarImage,
          smallStars[i].x,
          smallStars[i].y,
          smallStars[i].size,
          smallStars[i].size
        );
      }
    }
  }

  context.drawImage(starCanvas, 0, 0);

  return canvas;
}
