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
// sheet TWICE -- the left half slid right, the right half slid left, each by half the discarded
// wedge -- so the seam lands on the composition's own centre column and closes by construction.
// It is a pure translation. Nothing is stretched, sheared or resampled, which is what makes it
// survivable where three earlier attempts were not (see CLAUDE.md for the full trail): mirroring
// the sheet threw half the design away, tiling a periodic composition onto the panels' bounding
// boxes broke the side seams, and a row-by-row warp onto the true edge curves sheared the artwork
// and bled the backdrop through the panel edges.
//
// WHY A CONSTANT SHIFT IS ENOUGH, which is the part that was reasoned wrong before. The rise edge
// LOOKS like a curve on the template, but only its last fifth hooks toward the crotch point, and
// that hook tucks under the body where nothing is visible. Over the part anyone sees it is
// straight to within 10px of 2967 on all three products, so it needs no warp at all. The
// cone-geometry wall from the wrap-a-whole-leg attempt is real and unchanged -- it just does not
// apply to closing one seam at the front. Below the crotch the legs genuinely separate and there
// is no seam to close; the composition simply carries on into air that never gets printed, which
// is exactly right.
//
// Geometry arrives as fractions of the printfile's WIDTH, never pixels and never mixed against
// height, for the same reason hatWrap's and renderContext.sizeFrame's do: a mockup renders through
// capMockupRenderSize while the print file renders at true printfile dims, and only a relative
// frame makes the two compose identically.
//
//   shift -- how far each half slides toward the centre. Its ZERO POINT is what the CAD templates
//            say (half the discarded wedge: 0.09623 / 0.07133 / 0.07033), but the shipped values
//            deliberately overshoot it -- see the note on each product's config. Calibrated with
//            real Printful mockups of a numbered colour ruler put through this same map.
//   width -- the composition's width, sized to span both leg panels once they have slid together.
//            Taken from the widest of the front and back sheets so a mirrored back is covered too.

// The composition's size for a given output sheet. Height is the full sheet: the leg pieces occupy
// essentially all of the print area's height on all three products. A pure function of the
// geometry, so the ASPECT is identical at capped mockup size and at true print resolution -- which
// is what stops the mockup and the print file being two different ratio-aware recomposes of one
// seed.
export function legWrapSourceSize(geom, outW, outH) {
  return { width: Math.max(1, Math.round(geom.width * outW)), height: outH };
}

// Composites the finished sheet onto `ctx`.
//   comp   -- the composition, at legWrapSourceSize()
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
  const shift = Math.round(geom.shift * outW);
  const compW = Math.max(1, Math.round(geom.width * outW));
  const x0 = Math.round((outW - compW) / 2);
  const half = outW / 2;

  ctx.save();
  if (mirror) {
    ctx.translate(outW, 0);
    ctx.scale(-1, 1);
  }
  // The split is at the sheet centre because that is where the discarded wedge is: every product
  // here lays its two leg pieces mirror-symmetrically about the print area's own centre (measured:
  // mean |left + right - width| of 1px over ~2000 rows), so any x inside the wedge would do and the
  // centre is the one that needs no per-product number.
  for (const [clipX, dx] of [
    [0, -shift],
    [half, shift]
  ]) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(clipX, 0, half, outH);
    ctx.clip();
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
    // outside every cut piece -- but the flip being exact by construction is what the front/back
    // side seams rest on, and it costs nothing to keep true.
    const left = x0 + dx;
    const right = left + compW;
    if (left > 0 || right < outW) {
      ctx.imageSmoothingEnabled = false;
      if (left > 0) ctx.drawImage(comp, 0, 0, 1, outH, 0, 0, left, outH);
      if (right < outW) ctx.drawImage(comp, compW - 1, 0, 1, outH, right, 0, outW - right, outH);
      ctx.imageSmoothingEnabled = true;
    }
    ctx.drawImage(comp, left, 0, compW, outH);
    ctx.restore();
  }
  ctx.restore();
}
