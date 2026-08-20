// Procedural star sprite -- the xl/large tiers' star, drawn as vector paths at each star's
// real pixel size instead of scaling one 648px raster down to it.
//
// WHY THIS REPLACED star-sprite-large.png (2026-08-20, Aaron: the large stars "lose their
// diffraction spikes quite a lot... sometimes smaller ones will have them and larger ones
// will lose them"). The raster's cross was 4px wide in a 648px sheet -- 0.62% of its width --
// so at the median drawn size of 58px an arm covered a THIRD of a pixel. Two consequences,
// both measured:
//
//   1. It went sub-pixel and got averaged into the halo. Worse, the two engines disagreed
//      about how much survived: Chromium mipmaps and kept a weak line, while
//      @napi-rs/canvas (imageSmoothingQuality defaults to 'low') erased it outright below
//      ~140px. Since 70% of these stars are under 100px, most of them carried a cross in the
//      studio preview and none in the print file -- a real mockup-vs-print divergence that
//      check-render-regression.mjs could never see, because it runs napi-rs at both ends.
//   2. Even at full size the arm peaked at alpha 125/255 ABOVE its own halo, against an
//      opaque 255 core. So the cross could never carry more than about half the star's
//      tint-vs-backdrop contrast, and it was always the first thing to vanish when a star
//      landed on a backdrop close to its own luminance.
//
// Drawing the shape instead fixes both: SPIKE.minPx floors an arm at just over a device
// pixel so it can never be resampled away at any size, in either engine, and every element's
// alpha is authored here rather than baked into a PNG. An SVG asset was considered and
// rejected -- it rasterizes at its intrinsic size and scales like any other bitmap, so it
// solves neither problem (verified: a 4/648 hairline in an SVG measured alpha 31 at a 40px
// draw in Chromium, no better than the PNG).
//
// Only ALPHA matters downstream: StarField composites this through `destination-atop`
// against the star gradient, so everything here paints white and varies opacity. (That is
// also why swapping in the `-3d` sprite variants does nothing -- their alpha channels are
// byte-identical to the originals, verified 0 differing pixels of 419,904; only their RGB
// is inverted, which is what the three.js tunnel needs and this path discards.)
//
// Geometry is expressed as fractions of the star's HALF-width, measured off the original
// raster so the new star reads as the same object: core edge 0.17, halo disc 0.34 with a
// bright hairline stroke at its rim, glow fading out by 0.86, arms reaching 0.89.

export const STAR_SHAPE = {
  // Opaque centre.
  coreR: 0.17,
  // Inner halo: a flat semi-transparent disc with the "very small stroke" at its rim that
  // gives the original its lens-element look.
  haloR: 0.34,
  haloAlpha: 0.62,
  haloStrokeAlpha: 0.82,
  haloStrokeW: 0.012,
  // Outer glow, reaching the arm tips.
  glowR: 0.88,
  glowAlpha: 0.42,
  // Diffraction spikes. `alpha` is the arm's own opacity where it leaves the core -- it
  // tapers to nothing at the tip. Raised well above the raster's effective 0.49 ceiling:
  // this is the value that decides whether a star reads as a cross or a ball.
  spikeR: 0.89,
  spikeW: 0.026,
  spikeAlpha: 0.9,
  // An arm narrower than this many device pixels is widened to it (and dimmed in
  // proportion, so it keeps the same total light rather than getting heavier as it
  // shrinks). Just over one pixel: enough that antialiasing always has something to
  // resolve, small enough that a big star's arm is still a hairline.
  spikeMinPx: 1.25
};

// Draws one star centred at (cx, cy) spanning `size` pixels, in white with per-element
// alpha. `ctx` is any Canvas2D context; no state is left behind beyond globalAlpha, which
// is restored.
export function drawStarSprite(ctx, cx, cy, size, shape = STAR_SHAPE) {
  const R = size / 2;
  if (!(R > 0)) return;

  const prevAlpha = ctx.globalAlpha;
  ctx.fillStyle = '#fff';
  ctx.strokeStyle = '#fff';

  // --- Outer glow -------------------------------------------------------------------
  // From the halo's rim outward, so it doesn't pile a second gradient onto the flat disc.
  const glowR = R * shape.glowR;
  if (glowR > 0.5) {
    const g = ctx.createRadialGradient(cx, cy, R * shape.haloR * 0.6, cx, cy, glowR);
    g.addColorStop(0, `rgba(255,255,255,${shape.glowAlpha})`);
    g.addColorStop(0.35, `rgba(255,255,255,${shape.glowAlpha * 0.62})`);
    g.addColorStop(0.7, `rgba(255,255,255,${shape.glowAlpha * 0.22})`);
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.globalAlpha = 1;
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx, cy, glowR, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#fff';
  }

  // --- Inner halo disc + rim stroke -------------------------------------------------
  const haloR = R * shape.haloR;
  if (haloR > 0.5) {
    ctx.globalAlpha = shape.haloAlpha;
    ctx.beginPath();
    ctx.arc(cx, cy, haloR, 0, Math.PI * 2);
    ctx.fill();

    const sw = R * shape.haloStrokeW;
    if (sw > 0.35) {
      ctx.globalAlpha = shape.haloStrokeAlpha;
      ctx.lineWidth = sw;
      ctx.beginPath();
      ctx.arc(cx, cy, haloR - sw / 2, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  // --- Diffraction spikes -----------------------------------------------------------
  // Four arms from the core out to spikeR, each a triangle pair tapering to a point, with
  // a soft alpha falloff along its length. Drawn before the core so they emerge from
  // behind it.
  const spikeR = R * shape.spikeR;
  let halfW = (R * shape.spikeW) / 2;
  let spikeAlpha = shape.spikeAlpha;
  const minHalf = shape.spikeMinPx / 2;
  if (halfW < minHalf) {
    // Widen to the floor and dim to compensate, so an arm carries the same total light at
    // every size instead of getting proportionally heavier as the star shrinks.
    spikeAlpha *= halfW / minHalf;
    halfW = minHalf;
  }
  if (spikeR > 1 && spikeAlpha > 0.004) {
    const inner = R * shape.coreR * 0.5;
    for (let i = 0; i < 4; i++) {
      // Each arm is drawn as a horizontal one and rotated, so the four are identical.
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate((i * Math.PI) / 2);
      // Falloff along the arm: bright at the core, gone at the tip.
      const g = ctx.createLinearGradient(inner, 0, spikeR, 0);
      g.addColorStop(0, `rgba(255,255,255,${spikeAlpha})`);
      g.addColorStop(0.5, `rgba(255,255,255,${spikeAlpha * 0.86})`);
      g.addColorStop(0.82, `rgba(255,255,255,${spikeAlpha * 0.42})`);
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.globalAlpha = 1;
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(inner, -halfW);
      ctx.lineTo(spikeR, -halfW * 0.32);
      ctx.lineTo(spikeR, halfW * 0.32);
      ctx.lineTo(inner, halfW);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
    ctx.fillStyle = '#fff';
  }

  // --- Core -------------------------------------------------------------------------
  const coreR = R * shape.coreR;
  if (coreR > 0.35) {
    ctx.globalAlpha = 1;
    // A touch of falloff at the very rim, so the core reads as a glowing point rather than
    // a cut disc -- the raster's core does the same over its last few percent.
    const g = ctx.createRadialGradient(cx, cy, coreR * 0.72, cx, cy, coreR);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.75, 'rgba(255,255,255,1)');
    g.addColorStop(1, `rgba(255,255,255,${shape.haloAlpha})`);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx, cy, coreR, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#fff';
  } else {
    // Below about a pixel the core would antialias to nothing; keep a floor so a tiny star
    // still has a definite centre.
    ctx.globalAlpha = Math.min(1, Math.max(0.5, coreR / 0.35));
    ctx.beginPath();
    ctx.arc(cx, cy, 0.35, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.globalAlpha = prevAlpha;
}
