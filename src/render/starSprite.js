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
  // The rim highlight's own thickness, and its own (small) feather. Kept SEPARATE from
  // featherR below: coupling them made the bright band as wide as the soft falloff and the
  // rim read as a fat ring rather than the fine line the original had.
  haloStrokeW: 0.006,
  rimFeatherR: 0.006,
  rimFeatherMinPx: 1,
  // How far the halo drops immediately past the rim, as a fraction of the disc's own alpha.
  // The original raster does the same thing -- disc 167, rim peak 203, then straight down to
  // 74 -- and it is what makes the rim read as a lit edge instead of a gradient shoulder.
  haloOuterFalloff: 0.55,
  // EDGE FEATHER (2026-08-20, Aaron: the new stars "feel a bit more pixelated than the old
  // ones"). They are not lower resolution -- they are drawn as paths at the exact output
  // size, so there is no raster to enlarge and "higher res" is not available as a fix. What
  // changed is edge HARDNESS: the raster was a 648px sheet being upscaled, i.e. blurred,
  // which hid its own antialiasing, while a filled arc lands a full-contrast edge inside a
  // single pixel. At 3x zoom both have identical 1px AA on the halo rim; only the new one
  // has the contrast to make the steps visible. It also matters that the studio renders at
  // 3840x2160 and displays far smaller -- a hard edge is high-frequency content that aliases
  // on the downscale, where a soft one resamples cleanly.
  // So the core rim and the halo rim are ramps rather than cuts. Expressed in fractions of
  // the star with a device-pixel floor, since a feather thinner than a pixel is not a
  // feather.
  featherR: 0.022,
  featherMinPx: 1.4,
  // Outer glow, reaching the arm tips. Pulled well back from the first version (Aaron: it
  // "feels a bit too much") -- it now reads as a halo around the star rather than a fog the
  // star sits inside, which also stops it washing out a light backdrop.
  glowR: 0.62,
  glowAlpha: 0.2,
  // Diffraction spikes. `spikeAlpha` is the arm's opacity along its held stretch, raised
  // well above the raster's effective 0.49 ceiling -- it is the value that decides whether a
  // star reads as a cross or a ball.
  // Arms are 50% longer than the sprite box they came from and do not taper in WIDTH
  // (Aaron) -- a diffraction spike is a constant-width streak that fades out, not a wedge.
  // Only the opacity tapers, and only over the last stretch. Note spikeR > 1 is fine and
  // deliberate: nothing here is bounded by a sprite frame any more, so `size` is the star's
  // core-and-halo diameter while the arms reach beyond it.
  spikeR: 1.335,
  spikeW: 0.03,
  spikeAlpha: 0.9,
  // Fraction of the arm that holds full opacity before the fade begins.
  spikeHold: 0.5,
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
    // Extra intermediate stops: an 8-bit alpha ramp stretched over hundreds of pixels bands
    // visibly with only three, and concentric banding reads as exactly the same defect the
    // feather above exists to remove.
    g.addColorStop(0, `rgba(255,255,255,${shape.glowAlpha})`);
    g.addColorStop(0.2, `rgba(255,255,255,${shape.glowAlpha * 0.74})`);
    g.addColorStop(0.4, `rgba(255,255,255,${shape.glowAlpha * 0.5})`);
    g.addColorStop(0.6, `rgba(255,255,255,${shape.glowAlpha * 0.29})`);
    g.addColorStop(0.8, `rgba(255,255,255,${shape.glowAlpha * 0.12})`);
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
  const feather = Math.max(shape.featherMinPx, R * shape.featherR);
  if (haloR > 0.5) {
    // Disc, rim highlight and fade-out in ONE gradient rather than a fill plus a stroke, so
    // the rim is a ramp a couple of pixels wide instead of a hard-edged ring. The stroke's
    // brightness survives as the peak stop; only its edges soften.
    const outer = haloR + feather;
    const sw = Math.max(shape.rimFeatherMinPx, R * shape.haloStrokeW);
    const rf = Math.max(shape.rimFeatherMinPx, R * shape.rimFeatherR);
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, outer);
    // Stops are built as radii and normalised, then forced monotonic -- on a small star the
    // pixel floors above can otherwise push one past the next and addColorStop would take
    // them out of order.
    let last = 0;
    const stop = (radius, alpha) => {
      const t = Math.min(1, Math.max(last, radius / outer));
      g.addColorStop(t, `rgba(255,255,255,${alpha})`);
      last = t;
    };
    stop(0, shape.haloAlpha);
    stop(haloR - sw / 2 - rf, shape.haloAlpha);
    stop(haloR - sw / 2, shape.haloStrokeAlpha);
    stop(haloR + sw / 2, shape.haloAlpha * shape.haloOuterFalloff);
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.globalAlpha = 1;
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx, cy, outer, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#fff';
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
      // Constant width; opacity holds flat and then fades over the tail only.
      const g = ctx.createLinearGradient(inner, 0, spikeR, 0);
      g.addColorStop(0, `rgba(255,255,255,${spikeAlpha})`);
      g.addColorStop(shape.spikeHold, `rgba(255,255,255,${spikeAlpha})`);
      g.addColorStop(
        shape.spikeHold + (1 - shape.spikeHold) * 0.45,
        `rgba(255,255,255,${spikeAlpha * 0.62})`
      );
      g.addColorStop(
        shape.spikeHold + (1 - shape.spikeHold) * 0.78,
        `rgba(255,255,255,${spikeAlpha * 0.24})`
      );
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.globalAlpha = 1;
      ctx.fillStyle = g;
      ctx.fillRect(inner, -halfW, spikeR - inner, halfW * 2);
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
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, coreR);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(Math.max(0, (coreR - feather) / coreR), 'rgba(255,255,255,1)');
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

// ─── The fine/medium tiers' four-point star ────────────────────────────────────────────
//
// Authored here rather than loaded from star-sprite-small.png, so both star shapes live in
// code and are tunable together. Unlike the large star this is BUILT ONCE PER RENDER and
// then blitted, which is a deliberate split, not an inconsistency:
//
//   - The large star had to become per-star drawing because its hairline arm went sub-pixel
//     and the two canvas engines disagreed about whether it survived at all (alpha 47 in the
//     browser against 3 on Fly). Nothing here has that problem -- this shape is SOLID, and
//     measured across engines its total ink agrees to 0.4-1.6% from 12px up, with the shape
//     never vanishing at any size.
//   - The fine field runs to 103,375 specks on the densest designs. Drawing each as a path
//     with its own glow gradient measured +290ms on that worst case, against ~600ms for a
//     whole shorts-sheet render. Blitting one prepared sprite costs nothing over today.
//
// So the AUTHORING is consistent; the blit is an implementation detail the count justifies.
//
// The soft edge is a real Gaussian blur via ctx.filter, which both @napi-rs/canvas and
// Chromium support and agree on closely (alpha 54/28/11 vs 54/26/10 across a blurred edge).
// That reproduces the character of the sprite it replaces instead of approximating it with
// stacked strokes.
export const SMALL_STAR_SHAPE = {
  // Point tips, on the axes, as a fraction of the sprite's half-width.
  pointR: 0.68,
  // Control-point distance for the concave sides, as a fraction of pointR -- this is what
  // sets the waist. These four numbers were FITTED to the raster's own alpha profile by
  // search, not eyeballed, so the field keeps the character it already had.
  waistK: 0.12,
  // Blur radius as a fraction of the half-width, and the outer glow that sits under it.
  blurR: 0.11,
  glowR: 0.92,
  glowAlpha: 0.4
};

// Returns a square canvas holding the four-point star in white, sized `px` on a side.
// `makeCanvas(w, h)` is injected because the browser and Node create canvases differently --
// the same reason renderArtwork takes one.
export function buildSmallStarSprite(px, makeCanvas, shape = SMALL_STAR_SHAPE) {
  const size = Math.max(8, Math.round(px));
  const c = makeCanvas(size, size);
  const ctx = c.getContext('2d');
  const R = size / 2;
  const cx = R;
  const cy = R;

  const path = () => {
    const r = R * shape.pointR;
    const k = r * shape.waistK;
    ctx.beginPath();
    ctx.moveTo(cx, cy - r);
    ctx.quadraticCurveTo(cx + k, cy - k, cx + r, cy);
    ctx.quadraticCurveTo(cx + k, cy + k, cx, cy + r);
    ctx.quadraticCurveTo(cx - k, cy + k, cx - r, cy);
    ctx.quadraticCurveTo(cx - k, cy - k, cx, cy - r);
    ctx.closePath();
  };

  // Outer glow first, so the star sits on it rather than in it.
  const gr = R * shape.glowR;
  const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, gr);
  g.addColorStop(0, `rgba(255,255,255,${shape.glowAlpha})`);
  g.addColorStop(0.35, `rgba(255,255,255,${shape.glowAlpha * 0.5})`);
  g.addColorStop(0.7, `rgba(255,255,255,${shape.glowAlpha * 0.16})`);
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(cx, cy, gr, 0, Math.PI * 2);
  ctx.fill();

  // The star itself, blurred. Drawn twice: once through the blur for the soft falloff, once
  // clean on top so the body stays solid rather than turning to mush.
  ctx.fillStyle = '#fff';
  const blur = R * shape.blurR;
  if (blur >= 0.5) {
    ctx.filter = `blur(${blur}px)`;
    path();
    ctx.fill();
    ctx.filter = 'none';
  }
  path();
  ctx.fill();

  // FLATTEN. Not cosmetic -- without it this canvas still carries its recorded draw ops (a
  // radial gradient, a blur, two paths) and every single drawImage FROM it re-runs them.
  // Measured on a real 23,693-speck field: 297ms as built against 14ms flattened, a 21x
  // difference that showed up as a ~350ms regression on a whole render. A round-trip through
  // ImageData replaces the backing with a plain pixel buffer, is lossless (verified: 0
  // differing subpixels), and is portable, unlike toBuffer(). Cheap at this size -- one
  // 256x256 readback.
  // Note a bare getImageData does NOT do it: reading without writing back left blits at
  // 298ms, and reading the whole surface without writing was worse still at 639ms.
  ctx.putImageData(ctx.getImageData(0, 0, size, size), 0, 0);

  return c;
}
