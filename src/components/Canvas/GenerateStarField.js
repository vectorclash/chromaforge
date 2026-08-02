import GenerateLinearGradient from './GenerateLinearGradient';
import { getCountScale, getElementSizeScale } from '../../render/scale';
import { contrastPalette, makeRng } from '../../render/prng';

// _BASE = how many stars v9 generated from the shared rng; _TOTAL = how many v10 draws in all.
// The BASE values must never change -- they are the shape of v9's main-stream consumption, and
// moving one re-rolls every saved design's composition. Add stars by raising _TOTAL only.
const XL_BASE = 5, XL_TOTAL = 7;
const LARGE_BASE = 50, LARGE_TOTAL = 90;
const MEDIUM_BASE = 200, MEDIUM_TOTAL = 450;

export default class GenerateStarField {
  constructor(
    width,
    height,
    colors = [],
    rng = Math.random,
    backgroundHue = null,
    sizeFrame = null,
    backgroundLuminance = 0.5,
    seed = ''
  ) {
    let config = {};

    // SIDE RNG STREAM -- everything v10 ADDED draws from here, never from the shared `rng`.
    //
    // This is not a style choice, it is the whole reason existing designs survive. The main
    // stream is shared by every layer in sequence, so any draw added here shifts the value
    // that lands on generateArtwork's geometryChance/overlayChance further down. v10's first
    // version took its new draws from `rng` -- and because raising the star counts costs
    // THREE draws per star (size, x, y), that was +876 draws -- which silently rerolled the
    // geometry coin for every saved design. 13 of 45 real gallery designs lost their geometry
    // layer outright (Aaron, live: "the recent render change has completely destroyed the
    // existing artwork... nothing we did should have touched the geometry layers at all").
    //
    // Drawing from `${seed}-stars` instead means this layer's main-stream consumption is
    // byte-identical to v9, so composition -- which layers exist, the geometry shapes, the
    // overlay, the blend modes -- is untouched and only the stars themselves change. Same
    // separate-stream discipline as expandMonochromePalette's `${seed}-palette` and
    // generateLabelMark's `${seed}-label`.
    //
    // RULE for anything added here later: if it needs randomness, it draws from starRng. A new
    // draw on `rng` is a composition change to every design in the gallery.
    const starRng = makeRng(`${seed}-stars`);

    config.width = width;
    config.height = height;

    // Orientation-independent (sqrt(width*height), not just the short axis) so star size
    // relative to the canvas doesn't swing with aspect ratio -- see render/scale.js. This
    // alone can't desync rng() consumption (same number of draws either way, just a
    // different value fed into each), so it's safe on its own.
    let sizeScale = getElementSizeScale(width, height, sizeFrame);

    // Counts scale by area so a thumbnail doesn't get literally the same star counts as a
    // print (the original bug) -- but the loops below always run their ORIGINAL fixed trip
    // count (see the _BASE/_TOTAL constants above, plus tiered-small) and only KEEP a
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
    // Drawn from starRng (see the side-stream note at the top), so it cannot move the main
    // sequence. Note it does NOT change randomPalette's own draw count -- the spread is one
    // draw whatever its range -- so the gradient's main-stream consumption is unchanged. It
    // only reaches an auto-palette design: with a real user palette GenerateLinearGradient takes its
    // colors.length > 0 branch and neither hueBias nor hueSpread has any effect, which is
    // correct -- their palette is their choice, not something to sweep.
    const SPECTRUM_CHANCE = 0.14;
    const spectrum = starRng() < SPECTRUM_CHANCE;
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
    // Drawn from starRng, not rng -- see the side-stream note at the top. Strength is biased
    // high, with a tail of gentler results so not every design gets the identical treatment.
    const contrastStrength = 0.6 + starRng() * 0.4;
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
    // The roll comes from starRng (see the side-stream note at the top) so it cannot move the
    // main sequence.
    const ABUNDANT_CHANCE = 0.15;
    const abundant = starRng() < ABUNDANT_CHANCE;

    // Ceilings are per-tier fractions of sizeScale (bigger divisor = smaller star). The
    // restrained xl ceiling is a third of what v4's widening left it at -- that widening was
    // fine when only 5 xl stars existed, but it does not survive 7 of them next to 90 large
    // ones.
    let xlStarSizeMax = sizeScale / (abundant ? 3.2 : 7);
    let xlStarSizeMin = sizeScale / 40;
    let xlStars = [];

    // Counts are still FIXED, size-independent trip counts -- the countScale slice below is
    // what varies with canvas size, exactly as before.
    //
    // The first XL_BASE stars draw from the shared `rng`, in the same order and count as v9,
    // and every star beyond that draws from starRng. That is what keeps the main sequence
    // byte-identical while still adding stars -- see the side-stream note at the top. Do not
    // "simplify" this to one stream: all-`rng` re-rolls the geometry layer for every saved
    // design, and all-`starRng` would shift the sequence just as badly by removing draws.
    for (let i = 0; i < XL_TOTAL; i++) {
      const r = i < XL_BASE ? rng : starRng;
      let ranSize = Math.round(xlStarSizeMin + Math.pow(r(), 2.4) * xlStarSizeMax);
      let ranX = Math.round(-100 + r() * width + 100);
      let ranY = Math.round(-100 + r() * height + 100);

      xlStars.push({ x: ranX, y: ranY, size: ranSize, image: 'star-large' });
    }
    stars.push(...xlStars.slice(0, Math.max(1, Math.round(XL_TOTAL * countScale))));

    let largeStarSizeMax = sizeScale / (abundant ? 7 : 14);
    let largeStarSizeMin = sizeScale / 200;
    let largeStars = [];

    for (let i = 0; i < LARGE_TOTAL; i++) {
      const r = i < LARGE_BASE ? rng : starRng;
      let ranSize = Math.round(largeStarSizeMin + Math.pow(r(), 2) * largeStarSizeMax);
      let ranX = Math.round(-100 + r() * width + 100);
      let ranY = Math.round(-100 + r() * height + 100);

      largeStars.push({ x: ranX, y: ranY, size: ranSize, image: 'star-large' });
    }
    stars.push(...largeStars.slice(0, Math.max(1, Math.round(LARGE_TOTAL * countScale))));

    // The fine tier -- 450 of these are what "many more stars" actually looks like, so they
    // stay small and are skewed hardest of the three.
    let mediumStarSizeMax = sizeScale / 130;
    let mediumStarSizeMin = sizeScale / 3000;
    let mediumStars = [];

    for (let i = 0; i < MEDIUM_TOTAL; i++) {
      const r = i < MEDIUM_BASE ? rng : starRng;
      let ranSize = Math.round(mediumStarSizeMin + Math.pow(r(), 1.7) * mediumStarSizeMax);
      let ranX = Math.round(-100 + r() * width + 100);
      let ranY = Math.round(-100 + r() * height + 100);

      mediumStars.push({ x: ranX, y: ranY, size: ranSize, image: 'star-small' });
    }
    stars.push(...mediumStars.slice(0, Math.max(1, Math.round(MEDIUM_TOTAL * countScale))));

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
