import { makeRng } from '../../render/prng';

// The drawing behind FacetSwap -- a photo assembling out of triangles that pop in -- as pure
// functions of time, so a frame can be drawn at any moment rather than only as a live animation.
// FacetSwap plays it on the product page; the local ad builder (src/adBuilder) draws it into
// video frames. See FacetSwap.jsx for where the look came from.

// How long a run takes: a SWAP between two photos, and the INTRO of a photo arriving over
// nothing in particular. The intro is the bigger moment (on the product page it ends a wait of
// ~15s), so it takes a little longer.
export const FACET_SWAP_MS = 440;
export const FACET_INTRO_MS = 560;

// Triangle start times are spread over the first SPREAD of the run by distance from the origin,
// and each takes EACH of it to land. SPREAD + EACH = 1, so the last one lands exactly at the end.
const SPREAD = 0.55;
const EACH = 0.45;
const GRID = 6;

// One fixed lattice: a 6x6 grid with jittered interior points and alternating diagonals, like the
// artwork's own facets. Edge points stay on the edge so the mosaic always covers the frame.
const LATTICE = (() => {
  const rng = makeRng('facet-swap');
  const jitter = 0.32 / GRID;
  const pts = [];
  for (let r = 0; r <= GRID; r++) {
    pts.push([]);
    for (let c = 0; c <= GRID; c++) {
      const edge = r === 0 || c === 0 || r === GRID || c === GRID;
      const j = edge ? 0 : jitter;
      pts[r].push([c / GRID + (rng() - 0.5) * j, r / GRID + (rng() - 0.5) * j]);
    }
  }
  const tris = [];
  for (let r = 0; r < GRID; r++) {
    for (let c = 0; c < GRID; c++) {
      const a = pts[r][c], b = pts[r][c + 1], d = pts[r + 1][c], e = pts[r + 1][c + 1];
      if ((r + c) % 2) tris.push([a, b, e], [a, e, d]);
      else tris.push([a, b, d], [b, e, d]);
    }
  }
  return tris;
})();

const clamp01 = x => (x < 0 ? 0 : x > 1 ? 1 : x);
// Overshoots past 1 and settles, which is the "pop".
const easeOutBack = p => {
  const c1 = 1.9;
  const c3 = c1 + 1;
  return 1 + c3 * (p - 1) ** 3 + c1 * (p - 1) ** 2;
};

// Draws `img` cover-fitted into a new width x height canvas -- the same crop as CSS
// object-cover, so the mosaic registers with a photo shown that way.
/** @param {HTMLImageElement | HTMLCanvasElement | ImageBitmap} img */
export function coverCanvas(img, width, height) {
  const iw = /** @type {any} */ (img).naturalWidth || img.width;
  const ih = /** @type {any} */ (img).naturalHeight || img.height;
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  const scale = Math.max(width / iw, height / ih);
  const sw = width / scale;
  const sh = height / scale;
  ctx.drawImage(img, (iw - sw) / 2, (ih - sh) / 2, sw, sh, 0, 0, width, height);
  return c;
}

// The lattice placed on a W x H frame, with each triangle's distance from the origin (ox, oy)
// that decides when it lands. Computed once per run.
export function layoutFacets(W, H, ox, oy) {
  const tris = LATTICE.map(pts => {
    const p = pts.map(([x, y]) => [x * W, y * H]);
    const cx = (p[0][0] + p[1][0] + p[2][0]) / 3;
    const cy = (p[0][1] + p[1][1] + p[2][1]) / 3;
    const xs = p.map(q => q[0]);
    const ys = p.map(q => q[1]);
    const bx = Math.max(0, Math.floor(Math.min(...xs)) - 2);
    const by = Math.max(0, Math.floor(Math.min(...ys)) - 2);
    return {
      p,
      cx,
      cy,
      bx,
      by,
      bw: Math.min(W, Math.ceil(Math.max(...xs)) + 2) - bx,
      bh: Math.min(H, Math.ceil(Math.max(...ys)) + 2) - by,
      d: Math.hypot(cx - ox, cy - oy)
    };
  });
  return { tris, maxD: Math.max(...tris.map(t => t.d)) || 1 };
}

// Draws the triangles of `to` (a canvas the size of the frame, from coverCanvas) that have
// started landing by run progress `t` (0..1), over whatever is already on `ctx`. `glintWidth` is
// the edge highlight's line width in canvas pixels (0 for none). `visible`, if given, is one flag per
// triangle of the layout: a triangle flagged false is skipped, glint and all -- for a `to` that
// is mostly transparent, so empty triangles do not draw a lattice of glints over everything.
// Run `t` backwards (1 -> 0) and the mosaic breaks apart toward the origin instead.
export function drawFacets(ctx, layout, to, t, glintWidth, visible = null) {
  const { tris, maxD } = layout;
  for (let k = 0; k < tris.length; k++) {
    if (visible && !visible[k]) continue;
    const tr = tris[k];
    const p = clamp01((t - (tr.d / maxD) * SPREAD) / EACH);
    if (p <= 0) continue;
    // 1.012 at rest so neighbours overlap and no hairline of what is underneath shows
    // between them.
    const s = easeOutBack(p) * 1.012;
    ctx.save();
    ctx.globalAlpha = Math.min(1, p * 2.5);
    ctx.translate(tr.cx, tr.cy);
    ctx.scale(s, s);
    ctx.translate(-tr.cx, -tr.cy);
    ctx.beginPath();
    ctx.moveTo(tr.p[0][0], tr.p[0][1]);
    ctx.lineTo(tr.p[1][0], tr.p[1][1]);
    ctx.lineTo(tr.p[2][0], tr.p[2][1]);
    ctx.closePath();
    ctx.save();
    ctx.clip();
    ctx.drawImage(to, tr.bx, tr.by, tr.bw, tr.bh, tr.bx, tr.by, tr.bw, tr.bh);
    ctx.restore();
    // A glint along the facet's edges while it lands.
    if (p < 1 && glintWidth > 0) {
      ctx.globalAlpha = (1 - p) * 0.9;
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = glintWidth / Math.max(0.2, s);
      ctx.lineJoin = 'round';
      ctx.stroke();
    }
    ctx.restore();
  }
}
