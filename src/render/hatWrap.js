// Wraps a composition onto a hat's actual cut pieces, instead of laying it flat across the
// printfile and letting each piece sample whatever happens to land on it.
//
// WHY THIS EXISTS. The reversible bucket hat's printfile (410) carries THREE separately cut
// pieces -- a crown top disc, half the crown side wall, and half the brim -- and the lower two
// are annular sectors at wildly different curvature: the crown is a 28.7-degree slice of a huge
// radius, the brim a 112-degree slice of a small one, both representing the same 180 degrees of
// the wearer's head. A flat composition knows about none of that, so the artwork restarted at
// the crown/brim seam and each piece picked up a different amount of polar distortion (the brim
// fanned into radial arcs the crown did not have). Measured over five real saved designs, mean
// per-channel mismatch across that seam was 61-107 of 255; through this map it is 5-10, and the
// residual is the few millimetres of fabric the seam allowance genuinely consumes.
//
// THE MAP. The composition is generated in the hat's own coordinates -- u is angle around the
// head across ONE half (the other half is this sheet mirrored), v is height running from the
// crown's top edge out to the brim's outer edge -- and this module inverse-maps that into each
// sector on the sheet. Because both panels take u from the same normalised angle, a feature at
// u = 0.3 lands at u = 0.3 on both, so the joins close by construction.
//
// THE CROWN TOP IS DELIBERATELY *NOT* PART OF THAT MAP, and this was settled by putting all
// three candidates through real Printful mockups rather than by reasoning (2026-08-21). Mapping
// the composition's horizontal axis around the disc wraps it a full 360 degrees, so it converges
// at the centre -- unavoidable for any continuous map, since a disc cannot carry a strip without
// a singularity somewhere. On the grid test pattern that read as a tidy sunburst; on real artwork
// it read as a pinwheel smear at exactly the spot the eye lands first. A hybrid (polar at the rim
// crossfading to planar in the middle) looked like the obvious compromise and was worse: blending
// two unrelated compositions dissolves the hard-edged translucent facets that are this
// generator's whole character, and buys no continuity anyone can see. So the disc takes a plain
// circular window of a SQUARE render of the same design -- crisp, in character, at the cost of a
// boundary at the disc's rim that reads as what it actually is, a seam between two panels.
//
// Geometry arrives as fractions of the printfile's WIDTH (never pixels, and never mixed against
// height) for the same reason renderContext.sizeFrame is fractional: a mockup renders through
// capMockupRenderSize while the print file renders at true printfile dims, and only a relative,
// isotropic frame makes the two compose identically. Normalising everything by width alone keeps
// radii circular under that uniform scale -- cy values past 1 are normal and correct (the crown's
// arc centre sits far above the sheet).
//
// The centres are snapped to exactly 0.5 rather than carrying their measured values (0.49955 and
// 0.50019, both within 0.05% of the axis). That is a correctness requirement, not tidiness: a
// mirrored face is this sheet reflected about width/2, so a centre even a pixel off-axis would
// put the two faces' geometry out of register at the side seams -- the very join mirroring exists
// to close.

// Sources are generated at this multiple of their mapped size on the sheet, so every sample is a
// downsample rather than an upsample. The map's worst stretch is 1.50x, at the brim's outer edge
// (it compresses to 0.83x at the crown top), so 2x covers the whole range with margin.
export const HAT_WRAP_SUPERSAMPLE = 2;

// Resolves the fractional geometry against a real output width, in pixels.
function resolve(geom, outW) {
  const s = (piece) => ({
    cx: piece.cx * outW,
    cy: piece.cy * outW,
    rIn: (piece.rIn ?? 0) * outW,
    rOut: (piece.rOut ?? piece.r) * outW,
    half: piece.half ?? 0
  });
  const disc = { cx: geom.disc.cx * outW, cy: geom.disc.cy * outW, r: geom.disc.r * outW };
  const crown = s(geom.crown);
  const brim = s(geom.brim);
  return { disc, crown, brim };
}

// The unrolled source's dimensions for a given output width. Width is the SEAM arc -- the one
// circumference the crown and brim physically share -- and height is the crown band plus the brim
// band. Both are pure functions of the geometry, so the source's ASPECT is fixed no matter what
// resolution it is asked for, which is what keeps a capped mockup and a true-resolution print file
// showing the same composition rather than two ratio-aware recomposes of the same seed.
export function hatWrapSourceSize(geom, outW) {
  const { crown, brim } = resolve(geom, outW);
  const seamArc = crown.rOut * 2 * crown.half;
  const total = (crown.rOut - crown.rIn) + (brim.rOut - brim.rIn);
  return {
    width: Math.round(seamArc * HAT_WRAP_SUPERSAMPLE),
    height: Math.round(total * HAT_WRAP_SUPERSAMPLE)
  };
}

// The square source the crown top is cropped from. Sized to the disc's own diameter so the
// circular window is a 1:1 crop at supersample, never an enlargement.
export function hatWrapDiscSourceSize(geom, outW) {
  const { disc } = resolve(geom, outW);
  const side = Math.round(2 * disc.r * HAT_WRAP_SUPERSAMPLE);
  return { width: side, height: side };
}

function readPixels(source, w, h) {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(source, 0, 0, w, h);
  return ctx.getImageData(0, 0, w, h).data;
}

// Bilinear, with the sample point clamped into the source. Clamping rather than wrapping is
// deliberate: u and v only leave [0,1] in the sliver of sheet outside every cut piece, which is
// cut away, and an edge-clamped colour there is a better neighbour for the piece it borders than
// a wrapped one from the opposite edge would be.
function sample(data, w, h, u, v, out, p) {
  const sx = Math.min(w - 1, Math.max(0, u * w - 0.5));
  const sy = Math.min(h - 1, Math.max(0, v * h - 0.5));
  const x0 = Math.floor(sx);
  const y0 = Math.floor(sy);
  const x1 = Math.min(w - 1, x0 + 1);
  const y1 = Math.min(h - 1, y0 + 1);
  const fx = sx - x0;
  const fy = sy - y0;
  const i00 = (y0 * w + x0) << 2;
  const i10 = (y0 * w + x1) << 2;
  const i01 = (y1 * w + x0) << 2;
  const i11 = (y1 * w + x1) << 2;
  for (let k = 0; k < 3; k++) {
    const a = data[i00 + k] * (1 - fx) + data[i10 + k] * fx;
    const b = data[i01 + k] * (1 - fx) + data[i11 + k] * fx;
    out[p + k] = a * (1 - fy) + b * fy;
  }
}

// Composites the finished sheet onto `ctx`.
//   unrolled  -- the composition in hat coordinates, at hatWrapSourceSize()
//   discSource-- a square render of the same design, at hatWrapDiscSourceSize()
//   geom      -- the product's hatWrap geometry (fractions of width)
//   mirror    -- reflect the finished sheet, for a face whose pattern must meet its partner's
//                across the side seams (PRODUCT_MOCKUP_CONFIG's mirrorPlacements)
//
// `mirror` reflects the OUTPUT rather than flipping u during sampling. The two are equivalent
// only because the geometry is exactly symmetric about width/2 (see the header note on snapping
// the centres), and reflecting the output is the form that stays pixel-exact by construction
// instead of depending on that symmetry holding to the last decimal.
export function drawHatWrap(ctx, unrolled, discSource, geom, outW, outH, { mirror = false } = {}) {
  const { disc, crown, brim } = resolve(geom, outW);
  const src = hatWrapSourceSize(geom, outW);
  const dsc = hatWrapDiscSourceSize(geom, outW);
  const uData = readPixels(unrolled, src.width, src.height);
  const dData = readPixels(discSource, dsc.width, dsc.height);

  const crownBand = crown.rOut - crown.rIn;
  const total = crownBand + (brim.rOut - brim.rIn);

  const out = ctx.createImageData(outW, outH);
  const data = out.data;

  for (let y = 0; y < outH; y++) {
    const gy = y + 0.5;
    for (let x = 0; x < outW; x++) {
      const gx = x + 0.5;
      const p = (y * outW + x) << 2;
      data[p + 3] = 255;

      // Crown top: a circular window of the square render, centred on the disc.
      const ddx = gx - disc.cx;
      const ddy = gy - disc.cy;
      if (ddx * ddx + ddy * ddy <= disc.r * disc.r) {
        sample(dData, dsc.width, dsc.height, 0.5 + ddx / (2 * disc.r), 0.5 + ddy / (2 * disc.r), data, p);
        continue;
      }

      // Crown wall, then brim. Angles are measured from straight down the sheet (atan2(dx, dy)),
      // which is the direction both arcs bulge toward, so v grows down the hat in both pieces.
      let dx = gx - crown.cx;
      let dy = gy - crown.cy;
      const rc = Math.sqrt(dx * dx + dy * dy);
      const tc = Math.atan2(dx, dy);
      let u;
      let v;
      // The tolerances widen the crown's claim slightly past its own cut edge so the sliver of
      // bleed just outside it continues the crown rather than jumping to the brim's mapping.
      if (Math.abs(tc) <= crown.half * 1.02 && rc >= crown.rIn * 0.97 && rc <= crown.rOut * 1.03) {
        u = (tc + crown.half) / (2 * crown.half);
        v = (rc - crown.rIn) / total;
      } else {
        dx = gx - brim.cx;
        dy = gy - brim.cy;
        const rb = Math.sqrt(dx * dx + dy * dy);
        const tb = Math.atan2(dx, dy);
        u = (tb + brim.half) / (2 * brim.half);
        v = (crownBand + (rb - brim.rIn)) / total;
      }
      sample(uData, src.width, src.height, u, v, data, p);
    }
  }

  if (!mirror) {
    ctx.putImageData(out, 0, 0);
    return;
  }
  const scratch = document.createElement('canvas');
  scratch.width = outW;
  scratch.height = outH;
  scratch.getContext('2d').putImageData(out, 0, 0);
  ctx.save();
  ctx.translate(outW, 0);
  ctx.scale(-1, 1);
  ctx.drawImage(scratch, 0, 0);
  ctx.restore();
}
