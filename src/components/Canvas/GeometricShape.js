function buildShape(shapeConfig) {
  let fill = new window.createjs.Shape();

  fill.graphics.beginLinearGradientFill(
    [shapeConfig.colors[0], shapeConfig.colors[1], shapeConfig.colors[2]],
    [0, 0.5, 1],
    shapeConfig.points[0][0],
    shapeConfig.points[0][1],
    shapeConfig.points[2][0],
    shapeConfig.points[2][1]
  );

  fill.graphics.moveTo(shapeConfig.points[0][0], shapeConfig.points[0][1]);
  fill.graphics.lineTo(shapeConfig.points[1][0], shapeConfig.points[1][1]);
  fill.graphics.lineTo(shapeConfig.points[2][0], shapeConfig.points[2][1]);
  fill.graphics.lineTo(shapeConfig.points[0][0], shapeConfig.points[0][1]);

  fill.graphics.endFill();

  fill.compositeOperation = 'hard-light';

  return fill;
}

// `config.legLayout` ('single' | 'mirror', optional): products whose front/back printfile
// is one flat canvas physically cut into two garment legs (mesh shorts, wide-leg joggers --
// see PRODUCT_MOCKUP_CONFIG's twoLegCanvas flag) center the shape at width/2 by default,
// which lands it exactly on that cut line -- the one place on the whole garment that's
// hidden in the inseam or barely peeks out. 'single' anchors the whole shape to one leg's
// own center (width/4) instead; 'mirror' draws it twice, the second copy horizontally
// flipped and anchored to the other leg (3*width/4), so a matching pair straddles the seam
// on purpose. Every other product (and every design generated before this existed) omits
// legLayout entirely, which falls through to the original centered-on-the-whole-canvas
// behavior below -- byte-identical to pre-this-feature output.
function addContainer(stage, shapes, { x, y, flip = false }) {
  let container = new window.createjs.Container();
  container.x = x;
  container.y = y;
  container.rotation = 90;
  if (flip) container.scaleX = -1;

  for (let i = 0; i < shapes.length; i++) {
    container.addChild(buildShape(shapes[i]));
  }

  stage.addChild(container);
}

function buildStage(config) {
  let canvas = document.createElement('canvas');
  canvas.width = config.width;
  canvas.height = config.height;

  let stage = new window.createjs.Stage(canvas);
  // Stage's constructor registers mouseup/mousemove on WINDOW for pointer interactivity this
  // one-shot draw never uses, and those closures hold the stage -- so without this, every
  // render with a geometry layer stayed alive for the rest of the session (its canvas, its
  // whole display list), and every mousemove on the page ran through all of them, each one
  // measuring a detached canvas with getBoundingClientRect + getComputedStyle. Measured on the
  // homepage: 7 more window mousemove listeners per Generate, and the cost of one mousemove
  // dispatch rose 0.06ms -> 0.28ms over ten Generates, without bound. A no-op under
  // render-service's shim, where those adds were already no-ops.
  stage.enableDOMEvents(false);

  if (config.legLayout === 'single') {
    addContainer(stage, config.shapes, { x: config.width / 4, y: config.height / 2 });
  } else if (config.legLayout === 'mirror') {
    addContainer(stage, config.shapes, { x: config.width / 4, y: config.height / 2 });
    addContainer(stage, config.shapes, { x: (config.width * 3) / 4, y: config.height / 2, flip: true });
  } else {
    addContainer(stage, config.shapes, { x: config.width / 2, y: config.height / 2 });
  }
  return { canvas, stage };
}

// Canvases drawn ahead of time by drawGeometryInBatches, keyed by the geometryConfig they show.
// GeometricShape hands one over (once) instead of drawing it again.
const PREPARED = new WeakMap();

export default function GeometricShape(config) {
  const prepared = PREPARED.get(config);
  if (prepared) {
    PREPARED.delete(config);
    return prepared;
  }
  const { canvas, stage } = buildStage(config);
  stage.update();
  return canvas;
}

// Roughly the canvas area a shape blends: half its bounding box in canvas space (a triangle fills
// at most half of its box), clipped to the canvas.
// A container is rotated 90deg about its anchor (and mirrored for the second leg), so a local
// (x, y) lands at (cx - y, cy + sx * x).
function shapeArea(shape, container, width, height) {
  const sx = container.scaleX;
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const [x, y] of shape.points) {
    const px = container.x - y;
    const py = container.y + sx * x;
    if (px < x0) x0 = px;
    if (px > x1) x1 = px;
    if (py < y0) y0 = py;
    if (py > y1) y1 = py;
  }
  const w = Math.min(x1, width) - Math.max(x0, 0);
  const h = Math.min(y1, height) - Math.max(y0, 0);
  return w > 0 && h > 0 ? (w * h) / 2 : 0;
}

// Draws the geometry layer in several pieces, waiting between them, and keeps the result for
// GeometricShape (2026-10-25, Aaron: Generate on the homepage stutters on his iPhone with every
// Geometry slider at the top, never at the defaults). For the render worker only.
//
// The layer is all big translucent triangles blended hard-light, so its cost is the area it
// blends. At the studio defaults that is ~1.5 canvases' worth; at full coherence with Size at
// max (a lattice of 200-600 cells, most of them reaching past the canvas edge) it is ~60, up to
// ~200 -- measured over 30 seeds. Safari keeps the worker's canvases on the GPU, which records the
// draws and runs them all at once when the pixels are read, on the same GPU the page needs for
// its own frames, and that is one job it cannot interrupt. So: draw a budget's worth of shapes,
// read one pixel (which makes the GPU finish them), yield, and carry on. The budget adapts to
// how long a piece took, like the nebula's bands (nebulaFieldGpuBanded).
//
// The pixels are identical to one stage.update(): EaselJS draws visible children in order, and
// hiding the rest while leaving the canvas uncleared just splits that one pass into several. A
// design at the defaults fits in the first piece, so it is drawn exactly as before.
const TARGET_MS = 8;
export async function drawGeometryInBatches(config) {
  if (!config || PREPARED.has(config)) return;
  const { canvas, stage } = buildStage(config);
  const all = [];
  for (const container of stage.children) {
    for (let i = 0; i < container.children.length; i++) {
      all.push({ child: container.children[i], area: shapeArea(config.shapes[i], container, config.width, config.height) });
    }
  }
  const ctx = canvas.getContext('2d');
  // Never below one canvas's worth: each piece also costs a read-back and a yield, and on a slow
  // device a smaller piece would pay that hundreds of times for the same total drawing.
  const floor = config.width * config.height;
  let budget = 3 * floor;
  let start = 0;
  while (start < all.length) {
    let end = start;
    let area = 0;
    while (end < all.length && (end === start || area + all[end].area <= budget)) area += all[end++].area;
    for (let i = 0; i < all.length; i++) all[i].child.visible = i >= start && i < end;
    stage.update();
    stage.autoClear = false;
    start = end;
    if (start >= all.length) break;
    const t0 = performance.now();
    ctx.getImageData(0, 0, 1, 1);
    const ms = performance.now() - t0;
    if (ms > TARGET_MS * 1.5) budget = Math.max(floor, budget / 2);
    else if (ms < TARGET_MS / 2) budget *= 2;
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  for (const item of all) item.child.visible = true;
  PREPARED.set(config, canvas);
}
