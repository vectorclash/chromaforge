// LAB (branch nebula-gpu-lab): stylised nebulae built from the 2D nebula's own fields.
//   'topo-lines' -- contour lines over the nebula treated as elevation, every 4th an index contour.
//                   White with alpha, tinted by the star gradient like the plain nebula.
//   'topo-nebula'-- the plain nebula (at 70%) with the same contour lines drawn into it.
//   'topo-map'   -- flat elevation bands coloured by HEIGHT from the star colours (a hypsometric
//                   tint), the lowest band left clear, contour lines in dark ink on top.
//   'cutpaper'   -- the three cloud fields as flat paper shapes stacked back to front, one star
//                   colour each, with soft drop shadows.
// Sizes (blur, line width, shadow) are given at a 1920px long edge and scale with the render, so
// a mockup and a print rendered at the same nebula size come out the same.
import tinycolor from 'tinycolor2';

function boxBlur(a, w, h, r) {
  if (r < 1) return a;
  const tmp = new Float32Array(a.length), out = Float32Array.from(a);
  for (let it = 0; it < 3; it++) {
    for (let y = 0; y < h; y++) {
      let acc = 0, n = 0;
      for (let x = -r; x < w; x++) {
        if (x + r < w) { acc += out[y * w + x + r]; n++; }
        if (x - r - 1 >= 0) { acc -= out[y * w + x - r - 1]; n--; }
        if (x >= 0) tmp[y * w + x] = acc / n;
      }
    }
    for (let x = 0; x < w; x++) {
      let acc = 0, n = 0;
      for (let y = -r; y < h; y++) {
        if (y + r < h) { acc += tmp[(y + r) * w + x]; n++; }
        if (y - r - 1 >= 0) { acc -= tmp[(y - r - 1) * w + x]; n--; }
        if (y >= 0) out[y * w + x] = acc / n;
      }
    }
  }
  return out;
}
const smooth = (e0, e1, x) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
const gradMag = (a, w, h, x, y) => {
  const gx = a[y * w + Math.min(w - 1, x + 1)] - a[y * w + Math.max(0, x - 1)];
  const gy = a[Math.min(h - 1, y + 1) * w + x] - a[Math.max(0, y - 1) * w + x];
  return 0.5 * Math.hypot(gx, gy);
};
function rgbRamp(colors) {
  const cs = colors.map((c) => tinycolor(c).toRgb());
  return (t) => {
    const f = Math.min(1, Math.max(0, t)) * (cs.length - 1), i = Math.min(cs.length - 2, Math.floor(f)), u = f - i;
    const a = cs[i], b = cs[i + 1] || a;
    return [a.r + (b.r - a.r) * u, a.g + (b.g - a.g) * u, a.b + (b.b - a.b) * u];
  };
}
function toCanvas(w, h, fill) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const x = c.getContext('2d'), id = x.createImageData(w, h);
  fill(id.data);
  x.putImageData(id, 0, 0);
  return c;
}

// Contour coverage (0..1) at each pixel of field E with `levels` steps; index lines every `every`.
function contours(E, w, h, levels, every, px, out) {
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const k = y * w + x, f = E[k] * levels, r = Math.round(f);
    if (r <= 0 || r >= levels) { out[k] = 0; continue; }
    const g = Math.max(1e-5, gradMag(E, w, h, x, y) * levels);
    const d = Math.abs(f - r) / g; // pixels to the nearest contour
    const hw = (r % every === 0 ? 1.0 : 0.55) * px;
    out[k] = 1 - smooth(hw - 0.6, hw + 0.6, d);
  }
  return out;
}

/** Returns { canvas, tint } at w x h. `mask` is the nebula after his curve (0..1, with .clouds). */
export function styledNebula(style, mask, w, h, starColors) {
  const s = Math.max(w, h) / 1920; // size scale
  if (style === 'topo-lines' || style === 'topo-nebula') {
    const E = boxBlur(mask, w, h, Math.round(5 * s));
    const L = contours(E, w, h, 16, 4, 1.4 * Math.max(1, s), new Float32Array(w * h));
    const gas = style === 'topo-nebula' ? 0.7 : 0; // the hybrid keeps the soft nebula under the lines
    return { tint: true, canvas: toCanvas(w, h, (d) => { for (let k = 0; k < L.length; k++) { d[k * 4] = d[k * 4 + 1] = d[k * 4 + 2] = 255; d[k * 4 + 3] = Math.round(Math.max(L[k], mask[k] * gas) * 255); } }) };
  }
  if (style === 'topo-map') {
    const N = 9, E = boxBlur(mask, w, h, Math.round(4 * s));
    const L = contours(E, w, h, N, 3, Math.max(1, s), new Float32Array(w * h));
    const ramp = rgbRamp(starColors);
    return { tint: false, canvas: toCanvas(w, h, (d) => {
      for (let k = 0; k < E.length; k++) {
        const band = Math.min(N - 1, Math.floor(E[k] * N));
        const c = ramp(band / (N - 1)), shade = 0.75 + 0.25 * (band / (N - 1)); // higher land lighter
        const a = band === 0 ? 0 : 0.85;
        const ink = L[k] * 0.55; // contour ink over the band colour
        d[k * 4] = c[0] * shade * (1 - ink); d[k * 4 + 1] = c[1] * shade * (1 - ink); d[k * 4 + 2] = c[2] * shade * (1 - ink);
        d[k * 4 + 3] = Math.round(Math.max(a, L[k] * 0.6) * 255);
      }
    }) };
  }
  if (style === 'cutpaper') {
    const ramp = rgbRamp(starColors), cols = [ramp(0.1), ramp(0.5), ramp(0.9)];
    const out = document.createElement('canvas'); out.width = w; out.height = h;
    const ox = out.getContext('2d');
    // back to front: the broad cloud, the mid one, the fine one
    for (const [i, t] of [mask.clouds[1], mask.clouds[0], mask.clouds[2]].entries()) {
      const T = boxBlur(t, w, h, Math.round(2 * s));
      const A = new Float32Array(w * h);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const k = y * w + x, g = Math.max(1e-4, gradMag(T, w, h, x, y));
        A[k] = smooth(-0.7, 0.7, (T[k] - 0.5) / g); // a crisp, antialiased paper edge
      }
      const shape = toCanvas(w, h, (d) => { for (let k = 0; k < A.length; k++) { d[k * 4] = cols[i][0]; d[k * 4 + 1] = cols[i][1]; d[k * 4 + 2] = cols[i][2]; d[k * 4 + 3] = Math.round(A[k] * 255); } });
      ox.save();
      ox.shadowColor = 'rgba(0,0,0,0.4)'; ox.shadowBlur = 14 * s; ox.shadowOffsetX = 4 * s; ox.shadowOffsetY = 7 * s;
      ox.drawImage(shape, 0, 0);
      ox.restore();
    }
    return { tint: false, canvas: out };
  }
  return null;
}
