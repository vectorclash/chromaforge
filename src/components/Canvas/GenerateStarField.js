import GenerateLinearGradient from './GenerateLinearGradient';
import { getCountScale, getElementSizeScale } from '../../render/scale';
import { contrastPalette } from '../../render/prng';

export default class GenerateStarField {
  constructor(
    width,
    height,
    colors = [],
    rng = Math.random,
    backgroundHue = null,
    sizeFrame = null,
    backgroundLuminance = 0.5
  ) {
    let config = {};

    config.width = width;
    config.height = height;

    // Orientation-independent (sqrt(width*height), not just the short axis) so star size
    // relative to the canvas doesn't swing with aspect ratio -- see render/scale.js. This
    // alone can't desync rng() consumption (same number of draws either way, just a
    // different value fed into each), so it's safe on its own.
    let sizeScale = getElementSizeScale(width, height, sizeFrame);

    // Counts scale by area so a thumbnail doesn't get literally the same star counts as a
    // print (the original bug) -- but the loops below always run their ORIGINAL fixed trip
    // count (7/90/450/tiered-small) and only KEEP a
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
    // When there's no user palette, this layer's own gradient is deliberately biased away
    // from the main background's hue -- the background is now allowed to roll close to
    // monochrome (see GenerateLinearGradient/GenerateLargeRadialField's randomPalette use),
    // so the star field is the guaranteed contrasting accent that keeps a fully-random
    // design from ever reading as genuinely flat, regardless of how muted the rest of the
    // piece is. +180 (complement) with +/-30 degrees of jitter for natural variety while
    // always staying a clear contrast. Only meaningful when colors is empty (a real user
    // palette takes GenerateLinearGradient's colors.length > 0 branch instead, where
    // hueBias has no effect) -- see generateArtwork.js's call site.
    const starHueBias =
      backgroundHue === null ? null : (backgroundHue + 180 + (rng() - 0.5) * 60 + 360) % 360;
    // SPECTRUM ROLL (Aaron, 2026-08-02: "the stars gradient never seem to get too colorful...
    // the example I gave you had the stars moving through the entire spectrum of colors. not
    // that I want that to be normal but at least rarely possible"). Most designs keep the tight
    // cluster around the background's complement; SPECTRUM_CHANCE of them sweep most of the
    // wheel instead, so one star field can run red through green through blue the way the
    // Hubble plates this generator is modelled on do.
    //
    // The 10-35 degree cap this replaces was NOT arbitrary -- a wide spread genuinely did wrap
    // the last stop back onto the background's own hue. But that was a property of walking
    // stops FORWARD from the anchor, not of wide spreads, and it was mistaken for the latter.
    // randomPalette's `centered` option (passed via hueSpread below) spaces them symmetrically
    // around the complement instead, so even the 260-degree sweep keeps every stop at least 50
    // degrees off the background hue. Capped at 260 rather than a full 360 for exactly that
    // reason -- a full sweep necessarily passes through the hue it is supposed to contrast with.
    //
    // ONE rng() draw, taken unconditionally, so consumption is fixed either way. It only
    // reaches an auto-palette design: with a real user palette GenerateLinearGradient takes its
    // colors.length > 0 branch and neither hueBias nor hueSpread has any effect, which is
    // correct -- their palette is their choice, not something to sweep.
    const SPECTRUM_CHANCE = 0.14;
    const spectrum = rng() < SPECTRUM_CHANCE;
    let gradientConfig = new GenerateLinearGradient(
      width,
      height,
      gradientComplexity,
      colors.reverse(),
      rng,
      {
        hueBias: starHueBias,
        hueSpread: spectrum ? { min: 130, max: 260 } : { min: 10, max: 35 }
      }
    );

    // The stars are TINTED by this gradient (StarField composites it through the sprite
    // alpha with destination-atop), so its colours are the stars' colours -- and with a user
    // palette they were literally the background's own palette reversed, i.e. the same hues
    // at the same lightness as the pixels underneath. That is why stars faded out instead of
    // popping. contrastPalette drives them away from the background's measured lightness and
    // up in saturation, preserving hue so a user's palette still reads as their palette.
    // ONE rng() draw, taken unconditionally (never inside a branch), so consumption stays
    // fixed -- strength is biased high, with a tail of gentler results so not every design
    // gets the identical treatment.
    const contrastStrength = 0.6 + rng() * 0.4;
    gradientConfig.colors = contrastPalette(
      gradientConfig.colors,
      backgroundLuminance,
      contrastStrength
    );
    config.gradientConfig = gradientConfig;

    let stars = [];

    // BIG STARS ARE RARE BY DEFAULT (Aaron, 2026-08-02: raising the counts made the large
    // tiers "just ridiculous" -- "I don't mind occasionally having a ton of large stars but
    // that needs to be a bit more rare. more stars means they need to be smaller in general").
    // Two mechanisms, deliberately separate:
    //
    //   1. Per-STAR size is skewed, not uniform. `Math.pow(rng(), k)` with k > 1 pushes the
    //      mass of the distribution toward the small end while leaving the same maximum
    //      reachable, so a tier reads as many small stars with the occasional big one instead
    //      of an even spread of medium-large blobs. This is what the Hubble plates the
    //      generator is modelled on actually look like. Costs no extra rng() draw -- it
    //      reshapes the draw that was already being taken.
    //   2. Per-DESIGN abundance: one unconditional roll decides whether this whole design is
    //      one of the rare lush ones that gets the genuinely large stars. Most designs render
    //      the restrained ceiling; ABUNDANT_CHANCE of them open it up.
    //
    // The roll is taken unconditionally and exactly once, before any tier, so rng()
    // consumption is fixed regardless of which branch it lands on.
    const ABUNDANT_CHANCE = 0.15;
    const abundant = rng() < ABUNDANT_CHANCE;

    // Ceilings are per-tier fractions of sizeScale (bigger divisor = smaller star). The
    // restrained xl ceiling is a third of what v4's widening left it at -- that widening was
    // fine when only 5 xl stars existed, but it does not survive 7 of them next to 90 large
    // ones.
    let xlStarSizeMax = sizeScale / (abundant ? 3.2 : 7);
    let xlStarSizeMin = sizeScale / 40;
    let xlStars = [];

    // Counts are still FIXED, size-independent trip counts -- the countScale slice below is
    // what varies with canvas size, exactly as before.
    for (let i = 0; i < 7; i++) {
      let ranSize = Math.round(xlStarSizeMin + Math.pow(rng(), 2.4) * xlStarSizeMax);
      let ranX = Math.round(-100 + rng() * width + 100);
      let ranY = Math.round(-100 + rng() * height + 100);

      xlStars.push({ x: ranX, y: ranY, size: ranSize, image: 'star-large' });
    }
    stars.push(...xlStars.slice(0, Math.max(1, Math.round(7 * countScale))));

    let largeStarSizeMax = sizeScale / (abundant ? 7 : 14);
    let largeStarSizeMin = sizeScale / 200;
    let largeStars = [];

    for (let i = 0; i < 90; i++) {
      let ranSize = Math.round(largeStarSizeMin + Math.pow(rng(), 2) * largeStarSizeMax);
      let ranX = Math.round(-100 + rng() * width + 100);
      let ranY = Math.round(-100 + rng() * height + 100);

      largeStars.push({ x: ranX, y: ranY, size: ranSize, image: 'star-large' });
    }
    stars.push(...largeStars.slice(0, Math.max(1, Math.round(90 * countScale))));

    // The fine tier -- 450 of these are what "many more stars" actually looks like, so they
    // stay small and are skewed hardest of the three.
    let mediumStarSizeMax = sizeScale / 130;
    let mediumStarSizeMin = sizeScale / 3000;
    let mediumStars = [];

    for (let i = 0; i < 450; i++) {
      let ranSize = Math.round(mediumStarSizeMin + Math.pow(rng(), 1.7) * mediumStarSizeMax);
      let ranX = Math.round(-100 + rng() * width + 100);
      let ranY = Math.round(-100 + rng() * height + 100);

      mediumStars.push({ x: ranX, y: ranY, size: ranSize, image: 'star-small' });
    }
    stars.push(...mediumStars.slice(0, Math.max(1, Math.round(450 * countScale))));

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
