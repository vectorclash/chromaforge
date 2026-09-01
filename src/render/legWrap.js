// Lays a composition across the ASSEMBLED FRONT of a two-leg garment instead of across the flat
// printfile, so the artwork continues over the centre-front seam rather than restarting at it.
//
// WHY THIS EXISTS (2026-08-29, Aaron: "the legs read as separate"). The shorts, joggers and
// wide-leg pants each print from one flat sheet carrying two leg panels with a wedge of fabric
// between them that never becomes garment -- 568px of 2967 on the shorts, 428 on the pants, 422 on
// the joggers. The two edges either side of that wedge are then sewn to each other at the
// centre-front rise. So a composition running straight across the sheet JUMPS exactly where the
// customer looks first: measured on the two columns actually stitched together, over 3 products x
// 5 real saved designs, the mean per-channel difference was 57-85 of 255, about eight times what
// the same artwork changes naturally over that span.
//
// THE MAP. Render the composition once at the assembled front's own size, then draw it onto the
// sheet TWICE -- the left half slid right, the right half slid left -- so the seam lands on the
// composition's own centre column and closes by construction. It is a pure translation. Nothing is
// stretched, sheared or resampled, which is what makes it survivable where three earlier attempts
// were not (see CLAUDE.md for the full trail): mirroring the sheet threw half the design away,
// tiling a periodic composition onto the panels' bounding boxes broke the side seams, and a
// row-by-row warp onto the true edge curves sheared the artwork and bled the backdrop through the
// panel edges.
//
// THE RISE EDGE ITSELF NEEDS NO WARP, and that has been re-measured rather than inherited. Flood
// -measuring the shorts' front template (198100), half the discarded wedge holds at 0.0930 of the
// sheet width for the whole rise -- which is where the 0.09623 zero point came from. The
// cone-geometry wall from the wrap-a-whole-leg attempt is real and unchanged; it just does not
// apply to closing one seam at the front. Below the crotch the legs genuinely separate and there is
// no seam to close; the composition simply carries on into air that never gets printed.
//
// WHAT DOES VARY IS THE FABRIC THAT NEVER SHOWS -- seam allowance, the rise curving under the body,
// and on the shorts a gathered elastic waistband. That is what `shift` overshoots its zero point to
// cancel, and it is largest at the waist, which is the one height the original ruler mockup was
// read at. Held constant down the leg the overshoot outlives the fabric it was cancelling and
// surfaces as a band of design printed on BOTH legs, 2 x (shift - zero) wide: 3.40in per leg on the
// shorts, 2.06 on the pants, 1.15 on the joggers (measured by decoding a column-index ramp back out
// of a real sheet). Hence `shiftBottom`.
//
// Geometry arrives as fractions of the printfile's WIDTH, never pixels and never mixed against
// height, for the same reason hatWrap's and renderContext.sizeFrame's do: a mockup renders through
// capMockupRenderSize while the print file renders at true printfile dims, and only a relative
// frame makes the two compose identically.
//
//   shift       -- how far each half slides toward the centre AT THE WAIST. Its zero point is what
//                  the CAD templates say (half the discarded wedge: 0.09623 / 0.07133 / 0.07033);
//                  the shipped values overshoot it, calibrated on real Printful mockups of a
//                  numbered colour ruler put through this same map. See each product's config.
//   shiftBottom -- optional. The value at the BOTTOM of the sheet, ramped to linearly as an affine
//                  shear. Omit it and the map is exactly the integer blit it always was.
//   width       -- the composition's width, sized to span both leg panels once they have slid
//                  together. Taken from the widest of the front and back sheets so a mirrored back
//                  is covered too.
//
// THE BACK IS A KNOWN LIMIT, NOT A CALIBRATION MISS. The back sheet has to be an exact mirror of
// the front or the SIDE seams reopen, so one shift serves both faces -- and they are different
// pattern pieces. Measured on the shorts, the back's rise is longer than the front's and its wedge
// is wider near the waist (half-wedge 0.1052 against the front's 0.0930, converging by mid-rise),
// so the back sits about 1.8in under-shifted across the seat and tapering widens that by exactly
// what it closes at the front. Closing the back needs the back to shift differently from the front,
// which trades one seam for two. Aaron's call, 2026-09-01, from real mockups of both faces.

// The composition's size for a given output sheet. Height is the full sheet: the leg pieces occupy
// essentially all of the print area's height on all three products. A pure function of the
// geometry, so the ASPECT is identical at capped mockup size and at true print resolution -- which
// is what stops the mockup and the print file being two different ratio-aware recomposes of one
// seed.
export function legWrapSourceSize(geom, outW, outH) {
  return { width: Math.max(1, Math.round(geom.width * outW)), height: outH };
}

// Composites the finished sheet onto `ctx`.
//   comp   -- the composition, at legWrapSourceSize() (compW x outH -- the source rects below
//             assume that, which every call site guarantees by deriving the size from this module)
//   geom   -- the product's legWrap geometry (fractions of width)
//   mirror -- reflect the finished SHEET, for a face whose pattern must meet its partner's across
//             the side seams (PRODUCT_MOCKUP_CONFIG's mirrorPlacements).
//
// mirror reflects the output rather than the composition. The two are equivalent here (the map is
// exactly symmetric about outW/2), but reflecting the output is the form that stays pixel-exact by
// construction instead of depending on that symmetry surviving two roundings. It is also why
// mirrorX must NOT be handed to the source render as well -- doing both mirrors twice and lands
// back where it started.
export function drawLegWrap(ctx, comp, geom, outW, outH, { mirror = false } = {}) {
  const compW = Math.max(1, Math.round(geom.width * outW));
  const x0 = Math.round((outW - compW) / 2);
  const half = outW / 2;
  const top = geom.shift * outW;
  const bottom = (typeof geom.shiftBottom === 'number' ? geom.shiftBottom : geom.shift) * outW;
  // Whole pixels when the shift is constant, so the un-tapered map stays the exact integer blit it
  // has always been -- see the note under this function.
  const shift = bottom === top ? Math.round(top) : top;
  const slope = (bottom - top) / outH;

  ctx.save();
  if (mirror) {
    ctx.translate(outW, 0);
    ctx.scale(-1, 1);
  }
  // The split is at the sheet centre because that is where the discarded wedge is: every product
  // here lays its two leg pieces mirror-symmetrically about the print area's own centre (measured:
  // mean |left + right - width| of 1px over ~2000 rows), so any x inside the wedge would do and the
  // centre is the one that needs no per-product number.
  for (const [clipX, sign] of [
    [0, -1],
    [half, 1]
  ]) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(clipX, 0, half, outH);
    ctx.clip();
    // The taper is a y->x term in the transform: one draw per half, whatever the ramp. Straight
    // edges stay straight (it is affine), and a shape crossing the seam changes direction there
    // rather than breaking -- about 13 degrees on the shorts, which is the visible cost of this
    // whole approach and what the mockups were approved against.
    if (slope) ctx.transform(1, 0, sign * slope, 1, 0, 0);
    const left = x0 + sign * shift;
    const right = left + compW;
    // Edge-clamp outward from the composition's own outermost columns. With the shipped geometry
    // the composition already covers every cut piece, so this only ever paints the sliver of sheet
    // outside them, which is cut away -- but it guarantees no blank fabric if a printfile's
    // dimensions ever change under us.
    //
    // Smoothing is off for the two clamp draws and back on for the composition itself. A single
    // source column stretched sideways has nothing to interpolate, so nearest is both the right
    // answer and an exact one: with smoothing left on, the stretch resampled slightly differently
    // at the two ends and a mirrored render stopped being a pixel-exact flip of its unmirrored
    // twin (measured on the joggers: 7 subpixels of 2.52M, all inside this sliver). Small, and
    // outside every cut piece -- but on an un-tapered product the flip is exact by construction
    // and it costs nothing to keep it true.
    //
    // The clamps reach a full sheet width beyond each edge rather than just to it, because under a
    // taper the sheared band travels: a clamp sized to the untilted position leaves a wedge of
    // blank sheet at whichever end the ramp runs toward. They also OVERLAP the composition by a
    // pixel instead of abutting it. Under a taper `left` is fractional, so clamp and composition
    // share a subpixel column and two antialiased edges composited in sequence do not add up to
    // full coverage -- measured as a hairline of alpha 144-240 down both outer edges before the
    // overlap (836 subpixels at mockup size). The composition is drawn last and covers the
    // overlap, so on the un-tapered path this repaints one column and changes nothing.
    if (left > 0 || right < outW) {
      ctx.imageSmoothingEnabled = false;
      if (left > 0) ctx.drawImage(comp, 0, 0, 1, comp.height, left - outW, 0, outW + 1, outH);
      if (right < outW) ctx.drawImage(comp, compW - 1, 0, 1, comp.height, right - 1, 0, outW, outH);
      ctx.imageSmoothingEnabled = true;
    }
    ctx.drawImage(comp, left, 0, compW, outH);
    ctx.restore();
  }
  ctx.restore();
}

// WHY THE TAPER IS A SHEAR AND NOT WHOLE-PIXEL BANDS, because the tidier answer was built first and
// measured second (2026-09-01).
//
// An un-tapered sheet is an integer 1:1 blit, and two properties fall out of that for free: it is
// byte-identical under @napi-rs/canvas, Chromium and WebKit, and a mirrored sheet is a pixel-exact
// flip of its unmirrored twin -- which is what the front/back SIDE seams rest on. A shear gives
// both up, because every row now lands on a fractional x and each engine resamples it its own way.
// Measured on the shorts at mockup size: the engines differ on up to 1.3% of subpixels (max 72),
// and the mirror differs on 0.015% (max 135). Both are sub-pixel and neither is visible on a
// garment -- a print pixel is 1/150in -- but they are real losses and worth stating.
//
// The fix for both is to quantise the shift to whole pixels in horizontal bands, so every draw
// stays an integer blit. That was implemented and REJECTED ON MEASUREMENT: it needs one draw per
// pixel of drift, 510 per half on a true shorts printfile, and @napi-rs/canvas materialises a
// source copy per call that V8 frees only lazily. At 11250x4350 that is a peak RSS of **15GB and
// 3.2s** against **360MB and 15ms** for the shear -- on a render-service machine with 4096MB that
// is not a purity trade, it is an OOM kill on every checkout of these products. Coarser bands buy
// the memory back but put a visible jog on straight edges (a fixed 32 bands steps 0.14% of the
// sheet width at once, in the mockup and the print alike), which defeats the point.
//
// So: the tapered products pay sub-pixel inexactness, and every product that omits `shiftBottom`
// keeps the old guarantees untouched -- the constant path still rounds to a whole pixel and never
// sets a transform.
