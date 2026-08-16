// Canvas2D compositor for generateLogoMark() configs, with a stroke build/unbuild fraction.
//
// Unlike renderLabelMark (which owns a whole canvas and its panels) this draws INTO a caller's
// context at a caller-chosen center and size, because it composites over live animation
// frames -- 2D over the frame stack, 3D into the texture of a plane in the tunnel.
//
// The build is the Canvas2D equivalent of Logo.jsx's DrawSVGPlugin tween: each chord grows
// from its start point, staggered across the mark the same way animateLogo's `delay: i * 0.02`
// staggers its lines. Chords are straight segments, so a draw fraction is an endpoint lerp --
// no path-length measurement needed.

import { markFitTransform } from './renderLabelMark';

// Matches renderLabelMark's line:ring weight ratio (5.5 : 8), which was tuned on real
// output; expressed against the same design-space scale so the mark reads identically.
const LINE_WEIGHT = 5.5;
const RING_WEIGHT = 8;

// Fraction of the build timeline spent staggering chords in, leaving 1 - STAGGER_SPAN for
// any single chord's own growth. The ring finishes early (RING_LEAD) so the chords appear to
// fill in inside an already-established ring rather than racing it.
const STAGGER_SPAN = 0.45;
const RING_LEAD = 0.6;

const clamp01 = v => (v < 0 ? 0 : v > 1 ? 1 : v);

// `size` is the side of the square box the mark is fitted into (centered on cx, cy).
// `draw` 0..1 is the build fraction; `alpha` 0..1 multiplies into globalAlpha.
export function drawLogoMark(ctx, config, { cx, cy, size, draw = 1, alpha = 1, margin = 1 }) {
  if (alpha <= 0 || draw <= 0 || size <= 0) return;

  const box = { x: cx - size / 2, y: cy - size / 2, w: size, h: size };
  // `bounds` is the PATH's extent, and a stroke is centered on its path -- so fitting bounds
  // flush to the box leaves half a stroke width hanging outside it. Invisible on a large
  // overlay canvas, but the 3D mode draws this into a 512px texture whose edge IS the plane's
  // edge, where it clipped the ring (reported 2026-08-12). Padding by the heaviest stroke
  // (the ring's) on every side is exact rather than a guessed margin, and self-adjusting:
  // both the weights and this padding are in design units, so they scale together.
  // RING_WEIGHT/2 is the exact half-stroke; the second half is slack, because fitting the
  // visual extent flush to the box still feathers antialiasing onto the outermost pixel row.
  // Costs 2.6% of the mark's size and cannot clip at any texture resolution.
  const pad = RING_WEIGHT;
  const fitBounds = {
    minX: config.bounds.minX - pad,
    maxX: config.bounds.maxX + pad,
    minY: config.bounds.minY - pad,
    maxY: config.bounds.maxY + pad,
    width: config.bounds.width + pad * 2,
    height: config.bounds.height + pad * 2
  };
  const { scale, toCanvas } = markFitTransform(fitBounds, box, margin);

  ctx.save();
  ctx.globalAlpha = ctx.globalAlpha * clamp01(alpha);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  ctx.lineWidth = Math.max(1, LINE_WEIGHT * scale);
  const n = config.lines.length;
  const span = n > 1 ? STAGGER_SPAN : 0;
  for (let i = 0; i < n; i++) {
    const { x1, y1, x2, y2, color } = config.lines[i];
    const start = n > 1 ? (i / (n - 1)) * span : 0;
    const local = clamp01((draw - start) / (1 - span));
    if (local <= 0) continue;

    const [ax, ay] = toCanvas(x1, y1);
    const [bx, by] = toCanvas(x2, y2);
    ctx.strokeStyle = color;
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(ax + (bx - ax) * local, ay + (by - ay) * local);
    ctx.stroke();
  }

  // Ring LAST, so it sits over every chord. That is the mark's real stacking order -- the
  // ring <path> is the final element in Logo.jsx's SVG, and renderLabelMark has always
  // stroked it after its lines. This drew it first until 2026-08-15, which put the chords
  // over the ring in both animation modes (the printed tag was never affected).
  // Order is independent of the build timing below: the ring still COMPLETES early
  // (RING_LEAD) so the chords appear to fill in inside an already-established ring.
  const ringDraw = clamp01(draw / RING_LEAD);
  if (ringDraw > 0) {
    ctx.lineWidth = Math.max(1, RING_WEIGHT * scale);
    ctx.strokeStyle = config.ringColor;
    const [rcx, rcy] = toCanvas(config.ring.center[0], config.ring.center[1]);
    ctx.beginPath();
    if (ringDraw >= 1) {
      // A completed ring takes the same (0, 2*PI) call renderLabelMark has always used,
      // rather than a sweep whose start and end differ by exactly 2*PI. The spec says the
      // latter draws a full circle, and browsers do -- but @napi-rs/canvas draws NOTHING for
      // it (measured), and this project has been caught twice already by shipping something
      // that only works because browsers are lenient (GenerateLargeRadialField's alpha as a
      // string, the tinycolor objects in single-colour palettes). Nothing renders this
      // headlessly today; this is so that staying correct isn't a coincidence.
      ctx.arc(rcx, rcy, config.ring.radius * scale, 0, Math.PI * 2);
    } else {
      ctx.arc(rcx, rcy, config.ring.radius * scale, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * ringDraw);
    }
    ctx.stroke();
  }

  ctx.restore();
}

export default drawLogoMark;
