// Instant mockups: a product photo wearing the current design, made in the browser in a fraction
// of a second, with no Printful round trip. The shop cards, the homepage carousel and a product
// page's opening photo all use it; "Generate mockup" still asks Printful for the real set.
//
// HOW. scripts/calibrate-instant-mockup.mjs asked Printful's own mockup generator, once per
// product, how it builds each photo: solid white/black/grey artwork gives every pixel's shading,
// and coded sine patterns give the exact spot of the exact print file each pixel shows. So this is
// Printful's photo with OUR artwork looked up through PRINTFUL'S mapping -- folds, seams, both
// sleeves -- not a guess at where the shirt is. Measured against real Printful mockups of three
// saved designs: mean error 2-4.5 levels out of 255, about the JPEG noise in the photos themselves.
//
// Per view (public/instant-mockups/<productId>/):
//   base      the photo with BLACK artwork, over its background (WebP)
//   gain      how much the photo brightens for white artwork (grey WebP, cropped to `crop`)
//   place     which print file each pixel shows: 0 none, else index into manifest.placements + 1
//   gamma     the mid-tone curve, code -> GAMMA_MIN + code / 255 * GAMMA_SPAN (half resolution)
//   uv        where in that print file, 12 bits a side: R u>>4, G v>>4, B (u&15)<<4 | (v&15)
//             (half resolution, with `uvplace`: which print file each half-resolution cell is)
//   underuv   (optional) the same, for what lies UNDER a transparent label, with `underplace`
// and per pixel:  out = base + gain * art(place, u, v) ^ gamma
//
// The two half-resolution maps are smooth fields and were most of a view's weight; the full-size
// `place` still decides exactly which pixels carry print. The coordinates are interpolated only
// between cells of the SAME print file, and not across a jump inside one (a collar is cut from the
// front's file but somewhere else in it) -- there the nearest cell wins, so a seam stays a seam.
//
// Pure functions over plain { width, height, data } arrays, so the same code runs in the browser
// and in Node (the calibration script's check against real mockups).

// Shared with scripts/calibrate-instant-mockup.mjs -- change both together.
const GAMMA_MIN = 0.5;
const GAMMA_SPAN = 4.5;
const UV_LEVELS = 4096;

// pow(art, gamma) for every gamma code and 8-bit art value, built once: three Math.pow calls per
// pixel were most of the composite's cost.
let POW_LUT = null;
function powLut() {
  if (POW_LUT) return POW_LUT;
  POW_LUT = new Float32Array(256 * 256);
  for (let g = 0; g < 256; g++) {
    const gamma = GAMMA_MIN + (g / 255) * GAMMA_SPAN;
    for (let a = 0; a < 256; a++) POW_LUT[g * 256 + a] = Math.pow(a / 255, gamma);
  }
  return POW_LUT;
}

// `view` is { width, height, crop: [x, y, w, h], base, gain, gamma, place, uv } where each image is
// { width, height, data } (RGBA), base full size and the rest crop-sized. `sources` is an array
// indexed like manifest.placements, each the artwork for that print file as { width, height, data }
// (or null if the caller has none -- those pixels keep the black-artwork base). Returns a new
// Uint8ClampedArray, RGBA, view-sized.
// A coordinate jump larger than this between neighbouring cells is a cut, not a slope.
const UV_JUMP = 0.02;

// The print-file coordinate at a pixel, from a half-resolution grid (`uv` packed, `gp` the grid's
// placement + 1), interpolated only between the four surrounding cells that show placement `pl`,
// and not across a jump inside one -- there the nearest such cell wins. `pl` -1 means "whichever
// placement the nearest marked cell shows" (the underlay, which only has cells under labels).
// Writes [u, v] into `res` and returns the placement, or -1 if no surrounding cell qualifies.
const SCRATCH_U = new Float64Array(4);
const SCRATCH_V = new Float64Array(4);
const SCRATCH_W = new Float64Array(4);
const SCRATCH_L = new Float64Array(4);
// `lod` (optional) is the grid's level-of-detail map (lodGrid); the pixel's, weighted the same way
// as its coordinate, goes in res[2].
function gridUV(uv, gp, hw, hx0, hx1, hy0, hy1, hax, hay, pl, res, lod, jumps) {
  if (pl < 0) {
    // The nearest marked cell decides which print file this is.
    let bestW = -1;
    for (let k = 0; k < 4; k++) {
      const right = k & 1;
      const lower = k & 2;
      const q = ((lower ? hy1 : hy0) * hw + (right ? hx1 : hx0)) * 4;
      if (!gp[q]) continue;
      const wk = (right ? hax : 1 - hax) * (lower ? hay : 1 - hay);
      if (wk > bestW) {
        bestW = wk;
        pl = gp[q] - 1;
      }
    }
    if (pl < 0) return -1;
  }
  let n = 0;
  let wsum = 0;
  let umin = 2;
  let umax = -1;
  let vmin = 2;
  let vmax = -1;
  let best = -1;
  let bestW = -1;
  for (let k = 0; k < 4; k++) {
    const right = k & 1;
    const lower = k & 2;
    const q = ((lower ? hy1 : hy0) * hw + (right ? hx1 : hx0)) * 4;
    if (gp[q] - 1 !== pl) continue;
    const cu0 = ((uv[q] << 4) | (uv[q + 2] >> 4)) / (UV_LEVELS - 1);
    const cv0 = ((uv[q + 1] << 4) | (uv[q + 2] & 15)) / (UV_LEVELS - 1);
    const wk = (right ? hax : 1 - hax) * (lower ? hay : 1 - hay) + 1e-6;
    SCRATCH_U[n] = cu0;
    SCRATCH_V[n] = cv0;
    SCRATCH_W[n] = wk;
    SCRATCH_L[n] = lod ? lod[q >> 2] : 0;
    if (wk > bestW) {
      bestW = wk;
      best = n;
    }
    if (cu0 < umin) umin = cu0;
    if (cu0 > umax) umax = cu0;
    if (cv0 < vmin) vmin = cv0;
    if (cv0 > vmax) vmax = cv0;
    wsum += wk;
    n++;
  }
  if (n === 0) {
    // No neighbouring cell shows this print file (a sliver narrower than a cell): the nearest cell.
    const q = ((hay < 0.5 ? hy0 : hy1) * hw + (hax < 0.5 ? hx0 : hx1)) * 4;
    res[0] = ((uv[q] << 4) | (uv[q + 2] >> 4)) / (UV_LEVELS - 1);
    res[1] = ((uv[q + 1] << 4) | (uv[q + 2] & 15)) / (UV_LEVELS - 1);
    res[2] = lod ? lod[q >> 2] : 0;
  } else if (umax - umin > (jumps ? jumps[pl] : UV_JUMP) || vmax - vmin > (jumps ? jumps[pl] : UV_JUMP)) {
    res[0] = SCRATCH_U[best];
    res[1] = SCRATCH_V[best];
    res[2] = SCRATCH_L[best];
  } else {
    let u = 0;
    let v = 0;
    let l = 0;
    for (let k = 0; k < n; k++) {
      u += SCRATCH_U[k] * SCRATCH_W[k];
      v += SCRATCH_V[k] * SCRATCH_W[k];
      l += SCRATCH_L[k] * SCRATCH_W[k];
    }
    res[0] = u / wsum;
    res[1] = v / wsum;
    res[2] = l / wsum;
  }
  return pl;
}

// The coordinate at a pixel from only the cells in `mask` (bit k = cell k: 0 top-left, 1 top-right,
// 2 bottom-left, 3 bottom-right), weighted by distance -- the edge map's statement of which cells
// are on this pixel's side of a seam. Writes [u, v, lod] into `res`.
function maskedUV(uv, hw, hx0, hx1, hy0, hy1, hax, hay, mask, res, lod) {
  let u = 0;
  let v = 0;
  let l = 0;
  let wsum = 0;
  for (let k = 0; k < 4; k++) {
    if (!(mask & (1 << k))) continue;
    const right = k & 1;
    const lower = k & 2;
    const q = ((lower ? hy1 : hy0) * hw + (right ? hx1 : hx0)) * 4;
    const wk = (right ? hax : 1 - hax) * (lower ? hay : 1 - hay) + 1e-6;
    u += (((uv[q] << 4) | (uv[q + 2] >> 4)) / (UV_LEVELS - 1)) * wk;
    v += (((uv[q + 1] << 4) | (uv[q + 2] & 15)) / (UV_LEVELS - 1)) * wk;
    l += (lod ? lod[q >> 2] : 0) * wk;
    wsum += wk;
  }
  res[0] = u / wsum;
  res[1] = v / wsum;
  res[2] = l / wsum;
}

// Bilinear RGBA from a print file at (u, v), texel centres at +0.5, clamped to the file's edge.
function sample(src, u, v, rgba) {
  const sw = src.width;
  const sh = src.height;
  let fx = u * sw - 0.5;
  let fy = v * sh - 0.5;
  if (fx < 0) fx = 0;
  else if (fx > sw - 1) fx = sw - 1;
  if (fy < 0) fy = 0;
  else if (fy > sh - 1) fy = sh - 1;
  const x0 = fx | 0;
  const y0 = fy | 0;
  const x1 = x0 + 1 < sw ? x0 + 1 : x0;
  const y1 = y0 + 1 < sh ? y0 + 1 : y0;
  const ax = fx - x0;
  const ay = fy - y0;
  const sd = src.data;
  const p00 = (y0 * sw + x0) * 4;
  const p10 = (y0 * sw + x1) * 4;
  const p01 = (y1 * sw + x0) * 4;
  const p11 = (y1 * sw + x1) * 4;
  for (let c = 0; c < 4; c++) {
    const top = sd[p00 + c] + (sd[p10 + c] - sd[p00 + c]) * ax;
    const bottom = sd[p01 + c] + (sd[p11 + c] - sd[p01 + c]) * ax;
    rgba[c] = top + (bottom - top) * ay;
  }
}

// A print file's mip chain, built on first use and kept on the source object (the worker keeps a
// render's decoded pixels for every view that shows it): level 0 the file itself, each further
// level half the size, box-filtered. A view that shows a print file SMALLER than the file -- a
// 450px label mark drawn 60px wide, the stars of a whole sheet in an on-model shot -- samples the
// level that matches, so thin lines and specks average out instead of breaking up into dots.
// A file with any transparency (a label_outside mark) is kept PREMULTIPLIED: its clear pixels
// are transparent black, and blending straight colours drags every edge of the mark towards
// black, which read as a dark, pixelated outline.
function levelsOf(src) {
  if (src.levels) return src.levels;
  const d = src.data;
  let clear = false;
  for (let i = 3; i < d.length; i += 4) {
    if (d[i] < 255) {
      clear = true;
      break;
    }
  }
  let level = src;
  if (clear) {
    const p = new Uint8ClampedArray(d.length);
    for (let i = 0; i < d.length; i += 4) {
      const a = d[i + 3] / 255;
      p[i] = d[i] * a + 0.5;
      p[i + 1] = d[i + 1] * a + 0.5;
      p[i + 2] = d[i + 2] * a + 0.5;
      p[i + 3] = d[i + 3];
    }
    level = { width: src.width, height: src.height, data: p };
  }
  const levels = [level];
  while (level.width > 1 || level.height > 1) {
    const w = level.width;
    const h = level.height;
    const nw = (w + 1) >> 1;
    const nh = (h + 1) >> 1;
    const ld = level.data;
    const nd = new Uint8ClampedArray(nw * nh * 4);
    for (let y = 0; y < nh; y++) {
      const y0 = 2 * y;
      const y1 = y0 + 1 < h ? y0 + 1 : y0;
      for (let x = 0; x < nw; x++) {
        const x0 = 2 * x;
        const x1 = x0 + 1 < w ? x0 + 1 : x0;
        const a = (y0 * w + x0) * 4;
        const b = (y0 * w + x1) * 4;
        const c = (y1 * w + x0) * 4;
        const e = (y1 * w + x1) * 4;
        const o = (y * nw + x) * 4;
        for (let k = 0; k < 4; k++) nd[o + k] = (ld[a + k] + ld[b + k] + ld[c + k] + ld[e + k] + 2) >> 2;
      }
    }
    level = { width: nw, height: nh, data: nd };
    levels.push(level);
  }
  src.levels = levels;
  return levels;
}

// Bilinear from the level of detail `lod`, blending the two levels either side of it.
const SAMPLE_B = new Float64Array(4);
function sampleLod(levels, u, v, lod, rgba) {
  if (!(lod > 0.01) || levels.length === 1) {
    sample(levels[0], u, v, rgba);
    return;
  }
  const top = levels.length - 1;
  const l = lod < top ? lod : top;
  const l0 = l | 0;
  const f = l - l0;
  sample(levels[l0], u, v, rgba);
  if (f < 0.01 || l0 === top) return;
  sample(levels[l0 + 1], u, v, SAMPLE_B);
  for (let c = 0; c < 4; c++) rgba[c] += (SAMPLE_B[c] - rgba[c]) * f;
}

// The coordinate step that counts as a cut, per print file: UV_JUMP, or eight times the file's
// typical step between neighbouring cells where that is larger -- a label drawn 15px wide moves a
// tenth of itself per cell, and judged by the fixed threshold every cell of it looked like a cut,
// so it was drawn as blocks of nearest cells at full detail (speckle) instead of a soft mark.
function jumpsOf(uv, gp, hw, hh, count) {
  const steps = Array.from({ length: count }, () => []);
  for (let j = 0; j < hh; j += 2) {
    for (let i = 0; i + 1 < hw; i += 2) {
      const q = (j * hw + i) * 4;
      const pl = gp[q];
      if (!pl || gp[q + 4] !== pl || pl > count) continue;
      const du = Math.abs((((uv[q + 4] << 4) | (uv[q + 6] >> 4)) - ((uv[q] << 4) | (uv[q + 2] >> 4))) / (UV_LEVELS - 1));
      const dv = Math.abs((((uv[q + 5] << 4) | (uv[q + 6] & 15)) - ((uv[q + 1] << 4) | (uv[q + 2] & 15))) / (UV_LEVELS - 1));
      steps[pl - 1].push(du > dv ? du : dv);
    }
  }
  return Float64Array.from(steps, list => {
    if (!list.length) return UV_JUMP;
    list.sort((a, b) => a - b);
    const typical = list[list.length >> 1];
    return typical * 8 > UV_JUMP ? typical * 8 : UV_JUMP;
  });
}

// The level of detail at every half-resolution cell: log2 of how many print-file pixels one photo
// pixel spans there (0 where it spans one or fewer), from the coordinate's change to neighbouring
// cells of the same print file, then averaged over the 3x3 cells around it (the coordinates are
// measured, so their differences are noisy).
function lodGrid(uv, gp, hw, hh, sources, jumps) {
  const n = hw * hh;
  const raw = new Float32Array(n).fill(-1);
  const U = new Float32Array(n);
  const V = new Float32Array(n);
  for (let q = 0; q < n; q++) {
    const o = q * 4;
    U[q] = ((uv[o] << 4) | (uv[o + 2] >> 4)) / (UV_LEVELS - 1);
    V[q] = ((uv[o + 1] << 4) | (uv[o + 2] & 15)) / (UV_LEVELS - 1);
  }
  // Change per PHOTO pixel along one axis (cells are two photo pixels apart), from whichever
  // neighbours are the same print file without a cut between.
  const along = (q, a, b, pl, out) => {
    const j = jumps[pl - 1];
    const okA = a >= 0 && gp[a * 4] === pl && Math.abs(U[a] - U[q]) < j && Math.abs(V[a] - V[q]) < j;
    const okB = b >= 0 && gp[b * 4] === pl && Math.abs(U[b] - U[q]) < j && Math.abs(V[b] - V[q]) < j;
    if (okA && okB) {
      out[0] = (U[b] - U[a]) / 4;
      out[1] = (V[b] - V[a]) / 4;
    } else if (okA || okB) {
      const r = okB ? b : a;
      const sgn = okB ? 1 : -1;
      out[0] = (sgn * (U[r] - U[q])) / 2;
      out[1] = (sgn * (V[r] - V[q])) / 2;
    } else return false;
    return true;
  };
  const dx = [0, 0];
  const dy = [0, 0];
  for (let j = 0; j < hh; j++) {
    for (let i = 0; i < hw; i++) {
      const q = j * hw + i;
      const pl = gp[q * 4];
      const src = pl ? sources[pl - 1] : null;
      if (!src) continue;
      const hx = along(q, i > 0 ? q - 1 : -1, i + 1 < hw ? q + 1 : -1, pl, dx);
      const hy = along(q, j > 0 ? q - hw : -1, j + 1 < hh ? q + hw : -1, pl, dy);
      if (!hx && !hy) continue;
      const fx = hx ? Math.hypot(dx[0] * src.width, dx[1] * src.height) : 0;
      const fy = hy ? Math.hypot(dy[0] * src.width, dy[1] * src.height) : 0;
      const rho = fx > fy ? fx : fy;
      raw[q] = rho > 1 ? Math.log2(rho) : 0;
    }
  }
  const lod = new Float32Array(n);
  for (let j = 0; j < hh; j++) {
    for (let i = 0; i < hw; i++) {
      const q = j * hw + i;
      const pl = gp[q * 4];
      if (!pl) continue;
      let s = 0;
      let c = 0;
      for (let y = j - 1; y <= j + 1; y++) {
        if (y < 0 || y >= hh) continue;
        for (let x = i - 1; x <= i + 1; x++) {
          if (x < 0 || x >= hw) continue;
          const r = y * hw + x;
          if (gp[r * 4] !== pl || raw[r] < 0) continue;
          s += raw[r];
          c++;
        }
      }
      lod[q] = c ? s / c : 0;
    }
  }
  return lod;
}

export function composeInstantMockup(view, sources) {
  const out = new Uint8ClampedArray(view.base.data);
  const lut = powLut();
  const [cx, cy, cw, ch] = view.crop;
  const [hw, hh] = view.half;
  const W = view.width;
  const place = view.place.data;
  const uv = view.uv.data;
  const uvPlace = view.uvplace.data;
  const gainD = view.gain.data;
  const gammaD = view.gamma.data;
  // What lies under a transparent label, where it was measured (calibrate --underlay).
  const underUV = view.underuv?.data || null;
  const underPlace = view.underplace?.data || null;
  const res = new Float64Array(3);
  const art = new Float64Array(4);
  const below = new Float64Array(4);
  const across = new Float64Array(4);
  // Seams (see the calibration script's edgeMap): which side of a cut each pixel is on, and how
  // much of the print across a seam it shows.
  const edge = view.edge?.data || null;
  const levels = sources.map(src => (src ? levelsOf(src) : null));
  // The cut thresholds and level-of-detail grids depend on the view and the SIZES of the print
  // files, never on the design, so they are kept on the view (the worker keeps a view for every
  // design shown on it) per set of sizes.
  const sizes = sources.map(src => (src ? `${src.width}x${src.height}` : '-')).join(',');
  if (!view.derived) view.derived = new Map();
  let derived = view.derived.get(sizes);
  if (!derived) {
    const jumps = jumpsOf(uv, uvPlace, hw, hh, sources.length);
    const underJumps = underPlace ? jumpsOf(underUV, underPlace, hw, hh, sources.length) : null;
    derived = {
      jumps,
      underJumps,
      lod: lodGrid(uv, uvPlace, hw, hh, sources, jumps),
      underLod: underPlace ? lodGrid(underUV, underPlace, hw, hh, sources, underJumps) : null
    };
    view.derived.set(sizes, derived);
    if (view.derived.size > 4) view.derived.delete(view.derived.keys().next().value);
  }
  const { jumps, underJumps, lod, underLod } = derived;
  for (let y = 0; y < ch; y++) {
    // This pixel's position on the half-resolution grid, cell centres at +0.5.
    let hfy = (y + 0.5) / 2 - 0.5;
    if (hfy < 0) hfy = 0;
    else if (hfy > hh - 1) hfy = hh - 1;
    const hy0 = hfy | 0;
    const hy1 = hy0 + 1 < hh ? hy0 + 1 : hy0;
    const hay = hfy - hy0;
    for (let x = 0; x < cw; x++) {
      const i = (y * cw + x) * 4;
      const pl = place[i] - 1;
      if (pl < 0) continue;
      if (!levels[pl]) continue;
      let hfx = (x + 0.5) / 2 - 0.5;
      if (hfx < 0) hfx = 0;
      else if (hfx > hw - 1) hfx = hw - 1;
      const hx0 = hfx | 0;
      const hx1 = hx0 + 1 < hw ? hx0 + 1 : hx0;
      const hax = hfx - hx0;
      const sided = edge ? edge[i + 2] : 0;
      if (sided & 16) maskedUV(uv, hw, hx0, hx1, hy0, hy1, hax, hay, sided & 15, res, lod);
      else gridUV(uv, uvPlace, hw, hx0, hx1, hy0, hy1, hax, hay, pl, res, lod, jumps);
      sampleLod(levels[pl], res[0], res[1], res[2], art);
      // A transparent print file (a label_outside mark), premultiplied, over the print beneath it:
      // where that was measured (calibrate --underlay), else -- an edge cell the measurement
      // missed -- the print file of a neighbouring cell, continued under the label.
      if (art[3] < 254.5) {
        let upl = underPlace ? gridUV(underUV, underPlace, hw, hx0, hx1, hy0, hy1, hax, hay, -1, res, underLod, underJumps) : -1;
        if (upl < 0 || !levels[upl]) {
          upl = -1;
          for (let k = 0; k < 4 && upl < 0; k++) {
            const q = (((k & 2) ? hy1 : hy0) * hw + ((k & 1) ? hx1 : hx0)) * 4;
            const other = uvPlace[q] - 1;
            if (other >= 0 && other !== pl && levels[other]) upl = other;
          }
          if (upl >= 0) gridUV(uv, uvPlace, hw, hx0, hx1, hy0, hy1, hax, hay, upl, res, lod, jumps);
        }
        if (upl >= 0) {
          sampleLod(levels[upl], res[0], res[1], res[2], below);
          const t = 1 - art[3] / 255;
          for (let c = 0; c < 3; c++) art[c] += below[c] * t;
        }
      }
      // A seam pixel: part this side's print, part the print across the seam.
      if (sided && edge[i] & 15 && edge[i + 1] < 250) {
        const other = (edge[i] & 15) - 1;
        if (levels[other]) {
          maskedUV(uv, hw, hx0, hx1, hy0, hy1, hax, hay, edge[i] >> 4, res, lod);
          sampleLod(levels[other], res[0], res[1], res[2], across);
          if (across[3] > 254.5) {
            const k = edge[i + 1] / 255;
            for (let c = 0; c < 3; c++) art[c] = art[c] * k + across[c] * (1 - k);
          }
        }
      }
      const g = gainD[i];
      // Gamma: plain bilinear on its half-resolution grid.
      const g00 = gammaD[(hy0 * hw + hx0) * 4];
      const g10 = gammaD[(hy0 * hw + hx1) * 4];
      const g01 = gammaD[(hy1 * hw + hx0) * 4];
      const g11 = gammaD[(hy1 * hw + hx1) * 4];
      const gTop = g00 + (g10 - g00) * hax;
      const gBottom = g01 + (g11 - g01) * hax;
      const row = ((gTop + (gBottom - gTop) * hay + 0.5) | 0) << 8;
      const o = ((cy + y) * W + cx + x) * 4;
      // Clamped: a mark's edge blended over the print can sum a hair past 255, and index 256 is the
      // NEXT row's first entry (0) -- a pink line came out with blue pixels along its edge.
      for (let c = 0; c < 3; c++) {
        const a = art[c] < 0 ? 0 : art[c] > 255 ? 255 : art[c];
        out[o + c] = out[o + c] + g * lut[row + ((a + 0.5) | 0)];
      }
    }
  }
  return out;
}

// Which placements a view actually shows, so a caller renders only those (an on-model front shows
// the front and both sleeves, never the back).
export function placementsInView(view) {
  const seen = new Set();
  const place = view.place.data;
  for (let i = 0; i < place.length; i += 4) if (place[i]) seen.add(place[i] - 1);
  return [...seen].sort((a, b) => a - b);
}
