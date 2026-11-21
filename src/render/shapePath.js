// Curved geometry shapes (2026-11-20). A shape from the Flower or Golden style carries a `path`
// beside its usual three `points`: the points still define the gradient (point 0 to point 2,
// as for every triangle) and the path is its outline, a list of
//   ['M', x, y] | ['L', x, y] | ['A', cx, cy, r, a0, a1, anticlockwise]
// in the geometry container's own coordinates. Arcs follow canvas arc() and are always written
// with a1 - a0 already signed the way they turn (negative when anticlockwise), so a sweep can
// be read off directly.
//
// Alongside the path, a curved shape carries `curve`, the same outline as a region the 3D
// flight's shader can test per pixel without cutting it into triangles (a petal cut into ~80
// thin triangles made Flower and Golden flights drop frames, 2026-11-20):
//   { discs: [[c, r], ...1-2],  inside every disc
//     hole?: [c, r],            outside this disc
//     sector?: [a0, a1] }       within the angle a0..a1 (at most half a turn) about discs[0]'s
//                               centre
// It must describe exactly the region the path outlines.
//
// Every surface that draws geometry reads curves through here: GeometricShape.js (canvas,
// arcs drawn exactly), geometrySvg.js (SVG arcs), and the 3D flight, which tests `curve` per
// pixel (see below) and uses shapeOutline only for bounds.

const TAU = Math.PI * 2;
// Flattening resolution: no flattened segment turns more than this. Used only where a curve
// has to become straight segments (bounds and area estimates); 2D and SVG draw true arcs.
const MAX_STEP = Math.PI / 64;

// The outline as a polygon: every vertex in order, the closing edge implied. Only the first
// subpath is used (Flower and Golden never draw holes).
export function shapeOutline(shape) {
  if (!shape.path) return shape.points.slice(0, 3);
  const out = [];
  const push = (x, y) => {
    const last = out[out.length - 1];
    if (!last || Math.abs(last[0] - x) > 1e-9 || Math.abs(last[1] - y) > 1e-9) out.push([x, y]);
  };
  for (const op of shape.path) {
    if (op[0] === 'M') {
      if (out.length) break;
      push(op[1], op[2]);
    } else if (op[0] === 'L') push(op[1], op[2]);
    else {
      const [, cx, cy, r, a0, a1] = op;
      const steps = Math.max(2, Math.ceil(Math.abs(a1 - a0) / MAX_STEP));
      for (let i = 0; i <= steps; i++) {
        const a = a0 + ((a1 - a0) * i) / steps;
        push(cx + r * Math.cos(a), cy + r * Math.sin(a));
      }
    }
  }
  const first = out[0];
  const last = out[out.length - 1];
  if (out.length > 1 && Math.abs(first[0] - last[0]) < 1e-9 && Math.abs(first[1] - last[1]) < 1e-9) out.pop();
  return out;
}

// The path as SVG path data, true arcs. `num` formats a coordinate.
export function shapePathData(shape, num) {
  let d = '';
  for (const op of shape.path) {
    if (op[0] === 'M') d += `M${num(op[1])} ${num(op[2])}`;
    else if (op[0] === 'L') d += `L${num(op[1])} ${num(op[2])}`;
    else {
      const [, cx, cy, r, a0, a1, ccw] = op;
      const sweep = a1 - a0;
      d += `L${num(cx + r * Math.cos(a0))} ${num(cy + r * Math.sin(a0))}`;
      // SVG cannot draw a whole circle as one arc; split anything close to a full turn.
      const parts = Math.abs(sweep) > Math.PI * 1.9 ? 2 : 1;
      for (let i = 1; i <= parts; i++) {
        const a = a0 + (sweep * i) / parts;
        const large = Math.abs(sweep / parts) > Math.PI ? 1 : 0;
        // SVG's sweep-flag 1 turns toward increasing angle in y-down coordinates, which is canvas
        // arc()'s clockwise (not anticlockwise) direction.
        d += `A${num(r)} ${num(r)} 0 ${large} ${ccw ? 0 : 1} ${num(cx + r * Math.cos(a))} ${num(cy + r * Math.sin(a))}`;
      }
    }
  }
  return d + 'Z';
}

// Draws the outline onto an EaselJS Graphics (between begin*Fill and endFill).
export function drawShapePath(graphics, shape) {
  for (const op of shape.path) {
    if (op[0] === 'M') graphics.moveTo(op[1], op[2]);
    else if (op[0] === 'L') graphics.lineTo(op[1], op[2]);
    else graphics.arc(op[1], op[2], op[3], op[4], op[5], op[6]);
  }
  graphics.closePath();
}

export { TAU };
