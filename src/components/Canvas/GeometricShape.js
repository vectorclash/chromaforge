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

export default function GeometricShape(config) {
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

  stage.update();

  return canvas;
}
