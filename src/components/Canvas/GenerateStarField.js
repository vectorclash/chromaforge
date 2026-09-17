import GenerateLinearGradient from './GenerateLinearGradient';
import { getElementSizeScale } from '../../render/scale';
import { contrastPalette, makeRng } from '../../render/prng';
import { valueNoise } from '../../render/valueNoise';

// _BASE = how many stars v9 generated from the shared rng; _TOTAL = how many v10 draws in all.
// The BASE values must never change -- they are the shape of v9's main-stream consumption, and
// moving one re-rolls every saved design's composition. Add stars by raising _TOTAL only.
const XL_BASE = 5, XL_TOTAL = 7;
const LARGE_BASE = 50, LARGE_TOTAL = 90;
const MEDIUM_BASE = 200, MEDIUM_TOTAL = 450;

// FINE STAR FIELD (the 5k-105k speck layer). Two changes, 2026-08-20, Aaron's ask.
//
// (1) A wider size range. The ceiling was sizeScale/500 -- 4.3px at the studio's own
//     3840x2160 -- which put the whole layer within a hair of uniform, so it read as even
//     grain rather than a depth of field. sizeScale/300 lifts the largest specks to ~7px
//     while the floor is untouched, so the layer gains a top end without getting coarse.
//
// (2) Scale comes from a NOISE FIELD, not a flat random draw -- the same clustering idea the
//     3D tunnel uses for star placement (see animation3d/tunnelScene's clusterDensity), and
//     the same shared render/valueNoise module. Three octaves sampled at the star's own
//     normalised position give the layer regions of systematically brighter, larger specks
//     with quieter dust between them, which is what a real plate looks like; FIELD_JITTER
//     keeps a per-star component so neighbours aren't identical.
//
// The noise is sampled in NORMALISED canvas coordinates (0..1), never pixels. That is a hard
// requirement, not a tidiness point: x/width is exactly the raw rng draw, so the field is
// identical at every render size and a print cannot disagree with its mockup about which
// specks are large. Sampling in pixels would make the whole layer resolution-dependent.
//
// valueNoise consumes no rng() at all -- it is a pure function of its coordinates -- so this
// costs the shared sequence nothing. Only the per-design offset needs randomness, and it
// comes from starRng, drawn immediately before the loop so it shifts nothing above it.
const FINE_SIZE_DIVISOR = 300;
// Frequencies are cycles across the whole canvas, so they set how big a cluster is relative
// to the picture rather than in pixels -- which is what keeps the field size-independent.
// 4.5 was picked by measuring, not by eye: at 2.1 the largest octave fits barely twice across
// the canvas, so a whole DESIGN could sit in one lobe and the layer's overall brightness
// became a per-design lottery (median speck 1.89px to 4.42px across 24 offsets). At 4.5 the
// canvas averages over enough cells to hold that to 2.47..3.49 while the within-image spread
// is at its widest -- field p10..p90 of 0.09..0.86, i.e. genuinely dense knots and genuinely
// empty voids inside one picture, which is the structure this exists for.
const FINE_FIELD = { freqLarge: 4.5, freqMid: 11.3, freqFine: 29.2, ampLarge: 0.6, ampMid: 0.28, ampFine: 0.12 };
// STRETCH THE FIELD BEFORE USING IT. Summed value noise is nothing like uniform -- measured
// over 40,000 samples of this exact octave mix, it spans only 0.25..0.79 with the middle 80%
// inside 0.37..0.65. Fed in raw it barely varies, and any skew applied on top of that
// collapses the whole layer toward its floor (the first version of this did exactly that and
// made the field visibly SPARSER than the flat random one it replaced). These are the
// measured 1st and 99th percentiles, so the remap clips ~1% at each end -- which is wanted:
// those clipped tails are the dense cores and the empty voids.
const FIELD_LO = 0.286;
const FIELD_SPAN = 0.48;
// How much of a speck's size comes from its own draw rather than the field. Low enough that
// the clustering is legible, high enough that a cluster isn't a patch of identical dots.
const FIELD_JITTER = 0.42;
// The same rng()-reshaping trick the tiers above use -- skews toward small without changing
// the maximum reachable or costing a draw. Solved, not guessed: at this jitter and remap the
// combined value has a median of 0.424, so 1.4 puts the median speck back on the size the
// flat-random field produced. The layer therefore gains a top end and spatial structure
// without getting brighter or coarser overall.
const FINE_SKEW = 1.4;

// 0..1 after the remap above.
function fineFieldAt(u, v, offset) {
  const n =
    valueNoise(u * FINE_FIELD.freqLarge + offset, v * FINE_FIELD.freqLarge + offset, offset) *
      FINE_FIELD.ampLarge +
    valueNoise(u * FINE_FIELD.freqMid + offset, v * FINE_FIELD.freqMid + offset, offset * 2) *
      FINE_FIELD.ampMid +
    valueNoise(u * FINE_FIELD.freqFine + offset, v * FINE_FIELD.freqFine + offset, offset * 3) *
      FINE_FIELD.ampFine;
  const unit = n / (FINE_FIELD.ampLarge + FINE_FIELD.ampMid + FINE_FIELD.ampFine);
  return Math.min(1, Math.max(0, (unit - FIELD_LO) / FIELD_SPAN));
}

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

    // COUNTS ARE SIZE-INDEPENDENT (v14, 2026-09-17). Every star this class generates is kept,
    // at every canvas size. The loops already ran their ORIGINAL fixed trip count and only the
    // KEPT subset was scaled -- so removing the slice consumes exactly the same rng() draws and
    // shifts nothing downstream (geometryChance, overlayChance, every blend roll are untouched).
    //
    // The slice it replaces dated from v3, where counts scaled by canvas area so a 320px
    // thumbnail wouldn't get a print's star count. That reasoning was about a render being
    // viewed at its own size -- but a MOCKUP is not viewed at its own size, it stands in for a
    // print. Mockups render through capMockupRenderSize while print files render at true
    // printfile dimensions, so the slice made the preview a customer approves systematically
    // sparser than the garment they receive. Measured across the live table: star counts
    // differed between the two on 101 of 101 stored designs, and radial-field blobs on 61.
    // v7 had already removed exactly this from the geometry layer and stated the rule while
    // doing it -- "density must never vary by resolution or a mockup lies about the print" --
    // and this finishes the job for the two layers it left behind.
    //
    // The density floor (DISPLAY_RENDER_CAP / renderDesignBlob's highDensity) is NOT redundant
    // now and should stay: it no longer buys density, but drawing thousands of sub-pixel specks
    // at 640px aliases where the same field rendered at 2000px and downscaled resolves cleanly.
    // Its justification is antialiasing, not element count -- worth knowing before anyone trims it.

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

    // Trip counts are FIXED and size-independent, and as of v14 so is what survives -- every
    // star generated here is kept at every canvas size.
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
    stars.push(...xlStars);

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
    stars.push(...largeStars);

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
    stars.push(...mediumStars);

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
    let smallStarSizeMax = sizeScale / FINE_SIZE_DIVISOR;
    let smallStarSizeMin = sizeScale / 5000;
    // Per-design offset into the noise field, so every design clusters differently rather
    // than every one of them clumping in the same places. From starRng -- see the
    // side-stream note at the top -- and drawn here, after every other starRng consumer, so
    // it cannot shift the tiers above.
    const fieldOffset = starRng() * 1000;

    for (let i = 0; i < smallStarAmount; i++) {
      // EXACTLY three rng() draws per speck, in the original order, with the original value
      // going to the original role. That is the whole constraint here: this loop runs up to
      // 105,000 times off the SHARED sequence, so adding, removing or reordering a draw
      // would shift every downstream layer for every saved design. The size draw is taken
      // first as before and simply held until x and y are known, since the field is sampled
      // at the speck's own position -- deferring arithmetic costs the sequence nothing.
      let sizeRoll = rng();
      let ranX = -100 + rng() * width + 100;
      let ranY = -100 + rng() * height + 100;
      const field = fineFieldAt(ranX / width, ranY / height, fieldOffset);
      const t = field * (1 - FIELD_JITTER) + sizeRoll * FIELD_JITTER;
      let ranSize = smallStarSizeMin + Math.pow(t, FINE_SKEW) * smallStarSizeMax;
      smallStars.push({ x: ranX, y: ranY, size: ranSize });
    }

    config.smallStars = smallStars.slice(0, config.smallStarAmount);

    config.stars = stars;

    return config;
  }
}
