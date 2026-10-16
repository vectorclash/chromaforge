// The geometry layer as an SVG document: the same triangles GeometricShape.js draws, as
// vectors, so the layer can be taken into a design tool, cut on a plotter or printed at any
// size. Pure and framework-free (a string in, a string out), so it runs in Node as well as the
// browser and needs no createjs.
//
// It mirrors GeometricShape.js element for element, and has to move with it:
//  - each shape is a triangle (points 0, 1, 2) filled with a three-stop linear gradient
//    (colors[0..2] at 0 / 0.5 / 1) running from point 0 to point 2. `userSpaceOnUse` puts that
//    line in the shape's own coordinates, i.e. inside the container's transform, exactly as
//    createjs's beginLinearGradientFill does;
//  - the container is translated to the canvas centre and rotated 90 degrees (legLayout moves
//    it to width/4, and 'mirror' adds a flipped copy at 3*width/4);
//  - the file is framed by the GEOMETRY'S OWN BOUNDS, not the artwork's rectangle (Aaron,
//    2026-10-16: "the size of the artwork will always be the size of the geometry so nothing
//    is cut off"). Large and high-spread shapes run well past the canvas edge, and the canvas
//    clips them; here they come out whole. The coordinates stay the artwork's own -- only the
//    viewBox moves -- so the shapes are exactly where they would be in the piece;
//  - every shape composites 'hard-light' onto the ones before it. `isolation: isolate` keeps
//    that blending inside the layer, which is what drawing it on its own transparent canvas
//    does. The layer's blend with the rest of the artwork (config.thirdBlend) is deliberately
//    NOT applied: this file is the layer alone, on a transparent background.
// Gradients pad past their ends and interpolate in sRGB in both, so no conversion is needed.

function num(n) {
  // Points are whole pixels and the transforms are halves, so two decimals is lossless in
  // practice and keeps a several-thousand-cell lattice to a readable size.
  return String(Math.round(n * 100) / 100);
}

function escapeAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

// The containers GeometricShape.js builds: where each is centred and whether it is flipped.
function containers(config) {
  const { width, height, legLayout } = config;
  const cy = height / 2;
  if (legLayout === 'single') return [{ cx: width / 4, cy, flip: false }];
  if (legLayout === 'mirror') {
    return [
      { cx: width / 4, cy, flip: false },
      { cx: (width * 3) / 4, cy, flip: true }
    ];
  }
  return [{ cx: width / 2, cy, flip: false }];
}

// createjs applies scale before rotation (its matrix is T * R * S), so the flip is the
// innermost transform.
function transformAttr({ cx, cy, flip }) {
  return `translate(${num(cx)} ${num(cy)}) rotate(90)${flip ? ' scale(-1 1)' : ''}`;
}

// A shape point in artwork coordinates: flip, then rotate 90 degrees, then translate.
function place([x, y], { cx, cy, flip }) {
  const fx = flip ? -x : x;
  return [cx - y, cy + fx];
}

// Every vertex of every shape, as placed in the artwork, rounded outward to whole units so the
// frame never shaves an edge. Triangles are convex, so their vertices bound them exactly.
export function geometryBounds(config) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const c of containers(config)) {
    for (const shape of config.shapes) {
      for (const p of shape.points.slice(0, 3)) {
        const [x, y] = place(p, c);
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (!Number.isFinite(minX)) return { x: 0, y: 0, width: config.width, height: config.height };
  const x = Math.floor(minX);
  const y = Math.floor(minY);
  return { x, y, width: Math.ceil(maxX) - x, height: Math.ceil(maxY) - y };
}

/** @param {{ title?: string }} [options] */
export function geometrySvg(config, options = {}) {
  const { title } = options;
  if (!config || !Array.isArray(config.shapes))
    throw new Error('This design has no geometry layer.');
  const { shapes } = config;

  const defs = [];
  const paths = [];
  shapes.forEach((shape, i) => {
    const [p0, p1, p2] = shape.points;
    const [c0, c1, c2] = shape.colors;
    defs.push(
      `<linearGradient id="g${i}" gradientUnits="userSpaceOnUse" x1="${num(p0[0])}" y1="${num(p0[1])}" x2="${num(p2[0])}" y2="${num(p2[1])}">` +
        `<stop offset="0" stop-color="${escapeAttr(c0)}"/>` +
        `<stop offset="0.5" stop-color="${escapeAttr(c1)}"/>` +
        `<stop offset="1" stop-color="${escapeAttr(c2)}"/>` +
        `</linearGradient>`
    );
    paths.push(
      `<path d="M${num(p0[0])} ${num(p0[1])}L${num(p1[0])} ${num(p1[1])}L${num(p2[0])} ${num(p2[1])}Z" fill="url(#g${i})" style="mix-blend-mode:hard-light"/>`
    );
  });

  const body = paths.join('\n');
  const groups = containers(config).map(c => `<g transform="${transformAttr(c)}">\n${body}\n</g>`);
  const box = geometryBounds(config);

  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<svg xmlns="http://www.w3.org/2000/svg" width="${box.width}" height="${box.height}" viewBox="${box.x} ${box.y} ${box.width} ${box.height}">`,
    title ? `<title>${escapeAttr(title)}</title>` : null,
    `<defs>\n${defs.join('\n')}\n</defs>`,
    `<g style="isolation:isolate">`,
    ...groups,
    `</g>`,
    `</svg>`,
    ''
  ]
    .filter(line => line !== null)
    .join('\n');
}

// The blob plus the size it came out, which is the geometry's and not the artwork's -- the
// file name and the panel both report it.
/** @param {{ title?: string }} [options] */
export function geometrySvgBlob(config, options) {
  const { width, height } = geometryBounds(config);
  return {
    blob: new Blob([geometrySvg(config, options)], { type: 'image/svg+xml' }),
    width,
    height
  };
}
