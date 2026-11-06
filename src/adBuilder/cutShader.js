import tinycolor from 'tinycolor2';

// A cut between products as one sheet of glass panes, in a WebGL2 canvas of its own. The panes are
// the facet lattice, but they never leave the frame: a wave crosses them, each pane bends and splits
// what it shows, and the old photo turns into the new one inside it. The same language as the hero
// shirt's shockwave and colour split.
//
// What makes it one photo becoming another, rather than one wiped away to reveal the next:
//   - They share a silhouette. Both travel one path from the old figure's place and size to the new
//     one's (the composer's `match`), so at the hand-over they stand in the same spot.
//   - Each is refracted through the other's shape: the next figure forms in the glass over the old
//     photo before it arrives, and the old one's shape lingers in the new as it leaves.
//   - There is no front to follow: the wave is wide, so the whole figure is glass at once, and the
//     panes turn over in a scattered order inside it rather than in a ring from the centre.
//
// Everything is a function of time (`progress`) and each photo's pose, so a frame can be drawn at
// any moment and motion blur is just more moments: they are averaged here on the GPU rather than
// through shutter.js, so nothing is copied out of WebGL more than once a frame.
//
// Sizes are fractions of `unit`, the frame width they were tuned against.

// How much of the wave's timing comes from the pane rather than the pixel.
const PANE_TIMING = 0.45;
// The wave crosses the frame over SPREAD of the run, and each point takes EACH to turn over.
const SPREAD = 0.4;
const EACH = 0.6;
// How far apart in the wave the panes turn over, so the hand-over is scattered rather than a ring.
const TURN_SCATTER = 0.34;
// How strongly each photo bends through the other's shape, and how blurred that shape is: as a
// fraction of `unit`, the size of the features it follows.
const SHAPE_BEND = 0.11;
const SHAPE_SIZE = 0.07;
// Inside a pane, at the wave's crest: how far it tilts what it shows, turns it and magnifies it.
const PANE_TILT = 0.028;
const PANE_TURN = 0.2;
const PANE_ZOOM = 0.16;
// Both photos travel outward with the wave: the old one pushed away, the new one settling in.
const CARRY = 0.03;
// How far the colour channels part at the crest.
const SPLIT = 0.011;

const VERTEX = `#version 300 es
in vec2 aPos;
in vec2 aCentre;
in vec3 aBary;
in vec3 aRand;
in float aPaneD;
uniform vec2 uRes;
out vec2 vPx;
out vec2 vCentre;
out vec3 vBary;
out vec3 vRand;
out float vPaneD;
void main() {
  vPx = aPos;
  vCentre = aCentre;
  vBary = aBary;
  vRand = aRand;
  vPaneD = aPaneD;
  gl_Position = vec4(aPos.x / uRes.x * 2.0 - 1.0, 1.0 - aPos.y / uRes.y * 2.0, 0.0, 1.0);
}`;

const FRAGMENT = `#version 300 es
precision highp float;
in vec2 vPx;
in vec2 vCentre;
in vec3 vBary;
in vec3 vRand;
in float vPaneD;
uniform vec2 uRes;
uniform vec2 uOrigin;
uniform float uMaxR;
uniform float uUnit;
uniform float uProgress;
uniform sampler2D uFrom;
uniform sampler2D uTo;
uniform bool uHasFrom;
uniform vec4 uFromPose; // origin x, origin y + dy, scale, turn
uniform vec4 uToPose;
uniform vec3 uFromMatch; // the figure's own centre, and its scale on the shared path
uniform vec3 uToMatch;
uniform vec2 uMatchAt; // where the shared path is now
uniform float uShapeLod;
uniform vec3 uPalette[5];
uniform int uPaletteN;
out vec4 fragColor;

const float PI = 3.14159265;

vec2 unpose(vec2 p, vec4 pose, float originY) {
  float c = cos(-pose.w);
  float s = sin(-pose.w);
  vec2 d = p - pose.xy;
  return vec2(pose.x, originY) + mat2(c, s, -s, c) * d / pose.z;
}

vec2 place(vec2 p, vec3 match, vec4 pose, float originY) {
  return unpose(match.xy + (p - uMatchAt) / match.z, pose, originY) / uRes;
}

// A premultiplied photo with its colour channels parted along split. Always the full-size level:
// the derivatives jump at every pane's edge, which would otherwise pick a blurred one there.
vec4 taps(sampler2D tex, vec2 p, vec2 split, vec3 match, vec4 pose, float originY) {
  vec4 r = textureLod(tex, place(p + split, match, pose, originY), 0.0);
  vec4 g = textureLod(tex, place(p, match, pose, originY), 0.0);
  vec4 b = textureLod(tex, place(p - split, match, pose, originY), 0.0);
  return vec4(r.r, g.g, b.b, max(max(r.a, g.a), b.a));
}

// How a photo's soft shape slopes here: its brightness and silhouette, blurred, as a height.
float shapeAt(sampler2D tex, vec2 p, vec3 match, vec4 pose, float originY) {
  vec4 c = textureLod(tex, place(p, match, pose, originY), uShapeLod);
  return dot(c.rgb, vec3(0.3, 0.59, 0.11)) + c.a * 0.8;
}
vec2 slope(sampler2D tex, vec2 p, vec3 match, vec4 pose, float originY) {
  // A full texel of that level each way: any closer and the slope jumps at every texel's edge, which
  // bends the photo into streaks like brushed metal.
  vec2 e = vec2(${SHAPE_SIZE.toFixed(3)} * uUnit, 0.0);
  return vec2(
    shapeAt(tex, p + e.xy, match, pose, originY) - shapeAt(tex, p - e.xy, match, pose, originY),
    shapeAt(tex, p + e.yx, match, pose, originY) - shapeAt(tex, p - e.yx, match, pose, originY)
  );
}

vec3 paletteAt(float x) {
  float f = fract(x) * float(uPaletteN);
  int i = int(floor(f));
  return mix(uPalette[i % uPaletteN], uPalette[(i + 1) % uPaletteN], fract(f));
}

uniform vec2 uOriginY; // the photos' own origin heights, before their bob: from, to

void main() {
  vec2 away = vPx - uOrigin;
  float r = length(away);
  vec2 dir = r > 0.001 ? away / r : vec2(0.0);
  float d = mix(r / uMaxR, vPaneD, ${PANE_TIMING.toFixed(3)});
  float phi = clamp((uProgress * (${SPREAD.toFixed(3)} + ${EACH.toFixed(3)}) - d * ${SPREAD.toFixed(3)}) / ${EACH.toFixed(3)}, 0.0, 1.0);
  float crest = sin(PI * phi);
  crest *= crest;

  // What this pane shows at the crest: tilted, turned and magnified about its own centre.
  vec2 fromCentre = vPx - vCentre;
  float turn = (vRand.z - 0.5) * ${PANE_TURN.toFixed(3)} * crest;
  float ct = cos(turn);
  float st = sin(turn);
  vec2 inPane = mat2(ct, st, -st, ct) * fromCentre * (1.0 - ${PANE_ZOOM.toFixed(3)} * crest);
  vec2 tilt = (vRand.xy * 2.0 - 1.0) * ${PANE_TILT.toFixed(3)} * uUnit * crest;
  vec2 q = vCentre + inPane + tilt;

  vec2 split = dir * ${SPLIT.toFixed(4)} * uUnit * crest;
  float carry = ${CARRY.toFixed(3)} * uUnit;
  float bend = ${SHAPE_BEND.toFixed(3)} * uUnit * crest;
  vec4 a = vec4(0.0);
  vec2 bendTo = vec2(0.0);
  if (uHasFrom) {
    bendTo = slope(uTo, q, uToMatch, uToPose, uOriginY.y) * bend;
    vec2 bendFrom = slope(uFrom, q, uFromMatch, uFromPose, uOriginY.x) * bend;
    a = taps(uFrom, q - dir * carry * phi + bendTo, split, uFromMatch, uFromPose, uOriginY.x);
    q += bendFrom;
  }
  vec4 b = taps(uTo, q + dir * carry * (1.0 - phi), split, uToMatch, uToPose, uOriginY.y);
  // A narrow hand-over in each pane, at the crest where the glass bends most (any softer and the
  // two people ghost through each other), each pane at its own moment.
  float at = 0.5 + (fract(vRand.x * 7.0 + vRand.y) - 0.5) * ${TURN_SCATTER.toFixed(3)};
  vec4 col = mix(a, b, smoothstep(at - 0.05, at + 0.05, phi));

  // Light on the glass, only where there is a photo to catch it: it was the outlines of empty panes
  // floating in the air that the old glints were taken off cutouts for.
  float edge = min(vBary.x, min(vBary.y, vBary.z));
  float line = 1.0 - smoothstep(0.0, fwidth(edge) * 1.2, edge);
  float sheen = pow(max(0.0, dot(normalize(fromCentre + 1.0), normalize(vRand.xy - 0.5))), 3.0);
  vec3 tint = paletteAt(vRand.x + phi * 0.5);
  col.rgb += (line * 0.4 + sheen * 0.14) * crest * col.a * mix(vec3(1.0), tint, 0.8);
  fragColor = clamp(col, 0.0, 1.0);
}`;

/**
 * @param {{ width: number, height: number, unit: number, layout: { tris: any[], maxD: number }, origin: number[], palette: string[] }} o
 *   `layout` is layoutFacets' and `origin` the point it was laid out from.
 */
export function createCutShader({ width, height, unit, layout, origin, palette }) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const gl = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: false });
  if (!gl) throw new Error('This browser has no WebGL2.');

  const compile = (type, source) => {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(`Cut shader: ${gl.getShaderInfoLog(shader)}`);
    return shader;
  };
  const program = gl.createProgram();
  gl.attachShader(program, compile(gl.VERTEX_SHADER, VERTEX));
  gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAGMENT));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(`Cut shader: ${gl.getProgramInfoLog(program)}`);
  gl.useProgram(program);
  const u = name => gl.getUniformLocation(program, name);

  // One interleaved triangle per pane: position, centre, barycentric, random, distance.
  const FIELDS = 2 + 2 + 3 + 3 + 1;
  const data = new Float32Array(layout.tris.length * 3 * FIELDS);
  // Fixed per pane, so the same pane does the same thing in the preview and the file.
  const noise = (k, salt) => {
    const x = Math.sin(k * 127.1 + salt * 311.7) * 43758.5453;
    return x - Math.floor(x);
  };
  let w = 0;
  layout.tris.forEach((tr, k) => {
    tr.p.forEach((pt, v) => {
      data.set([pt[0], pt[1], tr.cx, tr.cy, v === 0 ? 1 : 0, v === 1 ? 1 : 0, v === 2 ? 1 : 0, noise(k, 1), noise(k, 2), noise(k, 3), tr.d / layout.maxD], w);
      w += FIELDS;
    });
  });
  gl.bindVertexArray(gl.createVertexArray());
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
  let offset = 0;
  /** @type {Array<[string, number]>} */
  const attributes = [['aPos', 2], ['aCentre', 2], ['aBary', 3], ['aRand', 3], ['aPaneD', 1]];
  for (const [name, size] of attributes) {
    const at = gl.getAttribLocation(program, name);
    gl.enableVertexAttribArray(at);
    gl.vertexAttribPointer(at, size, gl.FLOAT, false, FIELDS * 4, offset * 4);
    offset += size;
  }

  gl.viewport(0, 0, width, height);
  gl.uniform2f(u('uRes'), width, height);
  gl.uniform2f(u('uOrigin'), origin[0], origin[1]);
  const corners = [[0, 0], [width, 0], [0, height], [width, height]];
  gl.uniform1f(u('uMaxR'), Math.max(...corners.map(([x, y]) => Math.hypot(x - origin[0], y - origin[1]))));
  gl.uniform1f(u('uUnit'), 1080 * unit);
  // The mip level whose texels are about the size of the features the shape should follow.
  gl.uniform1f(u('uShapeLod'), Math.log2(Math.max(1, SHAPE_SIZE * 1080 * unit)));
  gl.uniform1i(u('uFrom'), 0);
  gl.uniform1i(u('uTo'), 1);
  const stops = (palette.length ? palette : ['#ffffff']).slice(0, 5).map(c => {
    const { r, g, b } = tinycolor(c).toRgb();
    return [r / 255, g / 255, b / 255];
  });
  gl.uniform3fv(u('uPalette'), stops.flat());
  gl.uniform1i(u('uPaletteN'), stops.length);
  const uProgress = u('uProgress');
  const uHasFrom = u('uHasFrom');
  const uFromPose = u('uFromPose');
  const uToPose = u('uToPose');
  const uFromMatch = u('uFromMatch');
  const uToMatch = u('uToMatch');
  const uMatchAt = u('uMatchAt');
  const uOriginY = u('uOriginY');

  // Averaging the moments: each lands at 1/(i+1) over what is there, which on premultiplied colour
  // is the exact running mean, transparency included, in one step.
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.CONSTANT_ALPHA, gl.ONE_MINUS_CONSTANT_ALPHA);
  gl.clearColor(0, 0, 0, 0);

  const textures = new Map();
  /** A photo's canvas, uploaded ahead of its cut so the cut itself never stalls on an upload. */
  function setImages(images) {
    for (const [image, tex] of textures) {
      if (images.includes(image)) continue;
      gl.deleteTexture(tex);
      textures.delete(image);
    }
    gl.activeTexture(gl.TEXTURE0);
    for (const image of images) {
      if (textures.has(image)) continue;
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      textures.set(image, tex);
    }
  }

  /**
   * Draws a frame: `moments` of them averaged across `open` seconds, centred on `t`.
   * `at(moment)` gives each one's { progress, from, to, matchAt }, where from and to are
   * { x, y, dy, s, rot, match: [figure x, figure y, scale] } and matchAt the [x, y] of the path they
   * share; `fromImage` may be null, for a photo arriving over nothing.
   */
  function draw(t, open, moments, fromImage, toImage, at) {
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, fromImage ? textures.get(fromImage) : null);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, textures.get(toImage));
    gl.uniform1i(uHasFrom, fromImage ? 1 : 0);
    const n = layout.tris.length * 3;
    for (let i = 0; i < moments; i++) {
      const { progress, from, to, matchAt } = at(t + ((i + 0.5) / moments - 0.5) * open);
      gl.uniform1f(uProgress, progress);
      gl.uniform2f(uMatchAt, matchAt[0], matchAt[1]);
      if (from) {
        gl.uniform4f(uFromPose, from.x, from.y + from.dy, from.s, from.rot);
        gl.uniform3f(uFromMatch, from.match[0], from.match[1], from.match[2]);
      }
      gl.uniform4f(uToPose, to.x, to.y + to.dy, to.s, to.rot);
      gl.uniform3f(uToMatch, to.match[0], to.match[1], to.match[2]);
      gl.uniform2f(uOriginY, from ? from.y : 0, to.y);
      gl.blendColor(0, 0, 0, 1 / (i + 1));
      gl.drawArrays(gl.TRIANGLES, 0, n);
    }
  }

  function dispose() {
    for (const tex of textures.values()) gl.deleteTexture(tex);
    textures.clear();
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    canvas.remove();
  }

  return { canvas, setImages, draw, dispose };
}
