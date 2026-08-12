// Pure Canvas2D compositor for generateLabelMark() configs -- draws the mark directly (no
// GSAP, no SVG, no DOM query), so it runs unmodified in a real browser via
// document.createElement (same convention as renderAvatar.js).

// Scale/center the mark's real bounding box (see generateLabelMark's computeBounds) into an
// arbitrary box, returning { scale, toCanvas }. Exported because the animation's logo
// overlay (renderLogoMark.js) must center the mark exactly the same way -- centering
// against Logo.jsx's declared viewBox instead is what made earlier renders look off-center.
export function markFitTransform(bounds, box, margin) {
  const scale = Math.min(box.w / bounds.width, box.h / bounds.height) * margin;
  const centerX = (bounds.minX + bounds.maxX) / 2;
  const centerY = (bounds.minY + bounds.maxY) / 2;
  const toCanvas = (x, y) => [
    box.x + box.w / 2 + (x - centerX) * scale,
    box.y + box.h / 2 + (y - centerY) * scale
  ];
  return { scale, toCanvas };
}

export default function renderLabelMark(config) {
  const canvas = document.createElement('canvas');
  canvas.width = config.width;
  canvas.height = config.height;
  const ctx = canvas.getContext('2d');

  // Two-panel layout (see generateLabelMark): the mark lives in its own dark panel, and
  // the accent panel (wide placements only) is a flat fill of the design's chosen accent.
  // Older configs without `panels` fall back to the whole canvas as the mark panel.
  const markPanel = config.panels?.mark ?? { x: 0, y: 0, w: config.width, h: config.height };
  // A transparent config (v4, label_outside) has no fills at all -- backgroundColor is
  // null and the canvas stays fully transparent behind the strokes.
  if (config.backgroundColor) {
    ctx.fillStyle = config.backgroundColor;
    ctx.fillRect(markPanel.x, markPanel.y, markPanel.w, markPanel.h);
  }
  if (config.panels?.accent) {
    const a = config.panels.accent;
    ctx.fillStyle = config.accentColor;
    ctx.fillRect(a.x, a.y, a.w, a.h);
  }

  // Scale/center against the mark's real bounding box (see generateLabelMark's
  // computeBounds), not the panel's own dims -- centers the true geometry regardless of
  // how short/wide or square the panel is.
  // 0.82 -> 0.697 (-15%) and heavier strokes below (3->5.5, 4.5->8), v4: tuned on real
  // track-jacket draft mockups (orders 166996698 vs 166999659) -- the thinner full-size
  // mark read spindly printed over a busy composition.
  const { scale, toCanvas } = markFitTransform(config.bounds, markPanel, 0.697);

  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // Heavier than Logo.jsx's own 2px/3px (tuned for an 80px animated UI mark) -- a printed
  // tag reads better with more weight; keeps the same roughly 2:3 line:ring ratio.
  ctx.lineWidth = Math.max(1, 5.5 * scale);
  for (const { x1, y1, x2, y2, color } of config.lines) {
    const [cx1, cy1] = toCanvas(x1, y1);
    const [cx2, cy2] = toCanvas(x2, y2);
    ctx.strokeStyle = color;
    ctx.beginPath();
    ctx.moveTo(cx1, cy1);
    ctx.lineTo(cx2, cy2);
    ctx.stroke();
  }

  ctx.lineWidth = Math.max(1, 8 * scale);
  ctx.strokeStyle = config.ringColor;
  const [rcx, rcy] = toCanvas(config.ring.center[0], config.ring.center[1]);
  ctx.beginPath();
  ctx.arc(rcx, rcy, config.ring.radius * scale, 0, Math.PI * 2);
  ctx.stroke();

  return canvas;
}
