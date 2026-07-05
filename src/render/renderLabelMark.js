// Pure Canvas2D compositor for generateLabelMark() configs -- draws the mark directly (no
// GSAP, no SVG, no DOM query), so it runs unmodified in a real browser via
// document.createElement (same convention as renderAvatar.js).

export default function renderLabelMark(config) {
  const canvas = document.createElement('canvas');
  canvas.width = config.width;
  canvas.height = config.height;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = config.backgroundColor;
  ctx.fillRect(0, 0, config.width, config.height);

  // Scale/center against the mark's real bounding box (see generateLabelMark's
  // computeBounds), not the target canvas's own dims -- centers the true geometry
  // regardless of how short/wide (label_inside) or square (label_outside) the target is.
  const { bounds } = config;
  const margin = 0.82;
  const scale = Math.min(config.width / bounds.width, config.height / bounds.height) * margin;
  const centerX = (bounds.minX + bounds.maxX) / 2;
  const centerY = (bounds.minY + bounds.maxY) / 2;
  const toCanvas = (x, y) => [
    config.width / 2 + (x - centerX) * scale,
    config.height / 2 + (y - centerY) * scale
  ];

  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // Heavier than Logo.jsx's own 2px/3px (tuned for an 80px animated UI mark) -- a printed
  // tag reads better with more weight; keeps the same roughly 2:3 line:ring ratio.
  ctx.lineWidth = Math.max(1, 3 * scale);
  for (const { x1, y1, x2, y2, color } of config.lines) {
    const [cx1, cy1] = toCanvas(x1, y1);
    const [cx2, cy2] = toCanvas(x2, y2);
    ctx.strokeStyle = color;
    ctx.beginPath();
    ctx.moveTo(cx1, cy1);
    ctx.lineTo(cx2, cy2);
    ctx.stroke();
  }

  ctx.lineWidth = Math.max(1, 4.5 * scale);
  ctx.strokeStyle = config.ringColor;
  const [rcx, rcy] = toCanvas(config.ring.center[0], config.ring.center[1]);
  ctx.beginPath();
  ctx.arc(rcx, rcy, config.ring.radius * scale, 0, Math.PI * 2);
  ctx.stroke();

  return canvas;
}
