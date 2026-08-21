import LinearGradient from './LinearGradient';
import { buildSmallStarSprite, drawStarSprite } from '../../render/starSprite';

// Resolution of the generated four-point sprite. A FIXED CONSTANT, never derived from the
// canvas -- and that is load-bearing, not tidiness. Measured: a 3px speck blitted from a
// 64px sprite carries 466 ink against 885 from a 512px one, a 47% swing. Deriving the
// resolution from the render size would therefore make a print's fine field brighter than
// its own mockup, which is the exact mockup-vs-print divergence the large star was rebuilt
// to remove. The old PNG was safe from this only by accident, being a fixed 648.
// 256 is also what SMALL_STAR_SHAPE's numbers were fitted against, so the two must move
// together; the largest star this sprite ever draws is 35px (the mesh-shorts sheet), leaving
// 7x of headroom.
const SMALL_SPRITE_PX = 256;

export default function StarField(config) {
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

  // Built once and then blitted, unlike the large star which is drawn per-star. That split is
  // deliberate and measured -- see buildSmallStarSprite's header.
  const smallSprite = buildSmallStarSprite(SMALL_SPRITE_PX, (w, h) => {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
  });

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
    starContext.drawImage(smallSprite, star.x, star.y, star.size, star.size);
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
    for (let i = 0; i < smallStars.length; i++) {
      starContext.drawImage(
        smallSprite,
        smallStars[i].x,
        smallStars[i].y,
        smallStars[i].size,
        smallStars[i].size
      );
    }
  }

  context.drawImage(starCanvas, 0, 0);

  return canvas;
}
