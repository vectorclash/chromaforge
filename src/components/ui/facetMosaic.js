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

const tracePath = (ctx, p) => {
  ctx.moveTo(p[0][0], p[0][1]);
  ctx.lineTo(p[1][0], p[1][1]);
  ctx.lineTo(p[2][0], p[2][1]);
  ctx.closePath();
};
// A triangle scaled about its centroid.
const scaled = (tr, s) => tr.p.map(([x, y]) => [tr.cx + (x - tr.cx) * s, tr.cy + (y - tr.cy) * s]);

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

// One wave from `from` to `to`, both canvases the size of the frame and either of them allowed to
// be mostly transparent: a single edge travels out from the origin, with the new photo inside it and
// the old one outside. Each triangle SWAPS as the edge reaches it: the old facet shrinks into its
// centre and the new one pops out of the same point, over it.
//
// drawFacets run forwards over itself run backwards cannot do this. One opens from the origin while
// the other closes toward it, so the origin is where the new photo arrives first and the old leaves
// last, and two people stand on top of each other. Two things make the edge read as one:
//   - Each triangle is quick against the wave (SWAP_EACH): with drawFacets' timing most of the frame
//     is mid-swap at once, and it reads as two photos again whichever order they are drawn in.
//   - The old facet goes first. New under old showed the new photo through the old one's empty
//     areas well before it had left. Cutting the old facet away by the shape of the new left thin
//     rims of the old photo standing in the frame, a wireframe of its legs and sleeves.
//
// Triangles the edge has not reached, and those it has passed, are drawn in one go, unscaled
// (drawFacets' 1.012 magnifies each facet's image about its own centre, a step between neighbours
// that shows as a jump when the mosaic gives way to the plain photo). So t = 0 is exactly `from`
// and t = 1 exactly `to`. `glintWidth` and `visible` are as for drawFacets, the flags only
// deciding the glints: a slightly moved photo can reach into a triangle flagged empty, and
// skipping that triangle would cut a piece off it.
// When each triangle starts, 0..1: in order of distance from the origin, but evenly spaced. By the
// distance itself, the lattice's triangles clump into rings that turn over together, so a cut ran in
// bursts frame to frame.
const SWAP_ORDERS = new WeakMap();
function swapOrder(layout) {
  let order = SWAP_ORDERS.get(layout);
  if (!order) {
    const { tris } = layout;
    const byDistance = tris.map((_, k) => k).sort((a, b) => tris[a].d - tris[b].d);
    order = new Array(tris.length);
    byDistance.forEach((k, rank) => (order[k] = rank / Math.max(1, tris.length - 1)));
    SWAP_ORDERS.set(layout, order);
  }
  return order;
}
const SWAP_SPREAD = 0.82;
const SWAP_EACH = 0.18;
const SWAP_OLD_GONE = 0.5; // of a triangle's time, when its old facet has gone
const SWAP_NEW_FROM = 0.25; // and when its new one starts, so little background shows between them
export function drawFacetSwap(ctx, layout, from, to, t, glintWidth = 0, visible = null) {
  const { tris } = layout;
  const order = swapOrder(layout);
  const waiting = [];
  const landed = [];
  const moving = [];
  for (let k = 0; k < tris.length; k++) {
    const p = clamp01((t - order[k] * SWAP_SPREAD) / SWAP_EACH);
    (p <= 0 ? waiting : p >= 1 ? landed : moving).push({ tr: tris[k], k, p });
  }
  const whole = (list, image) => {
    if (!list.length) return;
    ctx.save();
    ctx.beginPath();
    for (const { tr } of list) tracePath(ctx, tr.p);
    ctx.clip();
    ctx.drawImage(image, 0, 0);
    ctx.restore();
  };
  // A facet of `image` at scale s about its centre. Clipped a little past its own edges, so no
  // hairline of what is underneath shows between it and a neighbour at the same scale.
  const facet = (tr, image, s) => {
    ctx.translate(tr.cx, tr.cy);
    ctx.scale(s, s);
    ctx.translate(-tr.cx, -tr.cy);
    ctx.save();
    ctx.beginPath();
    tracePath(ctx, scaled(tr, 1.012));
    ctx.clip();
    ctx.drawImage(image, tr.bx, tr.by, tr.bw, tr.bh, tr.bx, tr.by, tr.bw, tr.bh);
    ctx.restore();
  };

  whole(waiting, from);
  whole(landed, to);
  for (const { tr, p } of moving) {
    if (p >= SWAP_OLD_GONE) continue;
    ctx.save();
    facet(tr, from, 1 - (p / SWAP_OLD_GONE) ** 2);
    ctx.restore();
  }
  for (const { tr, k, p } of moving) {
    const q = (p - SWAP_NEW_FROM) / (1 - SWAP_NEW_FROM);
    if (q <= 0) continue;
    const s = easeOutBack(q);
    ctx.save();
    facet(tr, to, s);
    if (glintWidth > 0 && (!visible || visible[k])) {
      ctx.beginPath();
      tracePath(ctx, tr.p);
      ctx.globalAlpha = (1 - q) * 0.9;
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = glintWidth / Math.max(0.2, s);
      ctx.lineJoin = 'round';
      ctx.stroke();
    }
    ctx.restore();
  }
}
