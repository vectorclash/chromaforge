import tinycolor from 'tinycolor2';

// A wave of glass rolling out from a point: whatever it passes bends and splits its light, and an
// old picture turns into a new one under its crest, each refracted through the other's soft shape.
// The Glass cut's language (cutShader.js) without its panes, for the explainer's taps and hits.
//
// One picture out, the size of the frame, which the caller draws through its own camera. Everything
// is a function of the arguments, so it can be drawn at any moment, and motion blur is the caller
// drawing more moments.
//
// Sizes are fractions of `unit`, the frame width they were tuned against.

// The width of the wave, how far it bends what it passes, and how far the colours part.
const WAVE_WIDTH = 0.15;
const WAVE_BEND = 0.09;
const WAVE_SPLIT = 0.02;
// A fainter wave following it, the way a real one has an echo.
const ECHO_AT = 0.72;
const ECHO_BEND = 0.32;
// How strongly each picture bends through the other's shape, and the size of the shape it follows.
const SHAPE_BEND = 0.12;
const SHAPE_SIZE = 0.07;

const VERTEX = `#version 300 es
out vec2 vPx;
uniform vec2 uRes;
void main() {
  vec2 corner = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  vPx = corner * uRes;
  gl_Position = vec4(corner.x * 2.0 - 1.0, 1.0 - corner.y * 2.0, 0.0, 1.0);
}`;

const FRAGMENT = `#version 300 es
precision highp float;
in vec2 vPx;
uniform vec2 uRes;
uniform float uUnit;
uniform sampler2D uFrom;
uniform sampler2D uTo;
uniform vec2 uCentre;
uniform float uRadius;
uniform float uStrength;
uniform float uFromScale;
uniform float uToZoom;
uniform float uFromLight;
uniform float uShape;
uniform float uShapeLod;
uniform vec3 uTintA;
uniform vec3 uTintB;
out vec4 fragColor;

vec4 tap(sampler2D tex, vec2 p, float zoom) {
  return textureLod(tex, (uRes * 0.5 + (p - uRes * 0.5) / zoom) / uRes, 0.0);
}
vec3 taps(sampler2D tex, vec2 p, vec2 split, float zoom) {
  return vec3(tap(tex, p + split, zoom).r, tap(tex, p, zoom).g, tap(tex, p - split, zoom).b);
}
float shapeAt(sampler2D tex, vec2 p, float zoom) {
  vec2 q = (uRes * 0.5 + (p - uRes * 0.5) / zoom) / uRes;
  return dot(textureLod(tex, q, uShapeLod).rgb, vec3(0.3, 0.59, 0.11));
}
vec2 slope(sampler2D tex, vec2 p, float zoom) {
  vec2 e = vec2(${SHAPE_SIZE.toFixed(3)} * uUnit, 0.0);
  return vec2(shapeAt(tex, p + e.xy, zoom) - shapeAt(tex, p - e.xy, zoom), shapeAt(tex, p + e.yx, zoom) - shapeAt(tex, p - e.yx, zoom));
}
// The bend across a wave: pushing out ahead of its crest and in behind it.
float bendOf(float x) {
  return -x * exp(-x * x) * 2.33;
}

void main() {
  vec2 away = vPx - uCentre;
  float r = length(away);
  vec2 dir = r > 0.001 ? away / r : vec2(0.0);
  float width = ${WAVE_WIDTH.toFixed(3)} * uUnit;
  float x = (r - uRadius) / width;
  float crest = exp(-x * x * 2.2);
  float echoX = (r - uRadius * ${ECHO_AT.toFixed(3)}) / (width * 0.7);
  float bent = bendOf(x) + bendOf(echoX) * ${ECHO_BEND.toFixed(3)};
  vec2 q = vPx + dir * bent * ${WAVE_BEND.toFixed(3)} * uUnit * uStrength;
  float parted = crest + exp(-echoX * echoX * 2.2) * ${ECHO_BEND.toFixed(3)};
  vec2 split = dir * parted * ${WAVE_SPLIT.toFixed(3)} * uUnit * uStrength;

  vec2 bendA = vec2(0.0);
  vec2 bendB = vec2(0.0);
  if (uShape > 0.0) {
    float shape = ${SHAPE_BEND.toFixed(3)} * uUnit * crest * uStrength * uShape;
    bendA = slope(uTo, q, uToZoom) * shape;
    bendB = slope(uFrom, q, uFromScale) * shape;
  }
  vec3 a = taps(uFrom, q + bendA, split, uFromScale) * uFromLight;
  vec3 b = taps(uTo, q + bendB, split, uToZoom);
  // A narrow hand-over under the crest, where the glass bends most.
  vec3 col = mix(b, a, smoothstep(-0.2, 0.2, x));

  // Light on the crest, in the incoming picture's own colours.
  float angle = atan(dir.y, dir.x) / 6.28318 + 0.5;
  vec3 tint = mix(uTintA, uTintB, 0.5 + 0.5 * sin(angle * 12.566 + r / uUnit * 6.0));
  col += tint * pow(crest, 5.0) * 0.55 * uStrength;
  fragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}`;

/**
 * @param {{ width: number, height: number, unit: number }} o
 */
export function createRippleLens({ width, height, unit }) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const gl = canvas.getContext('webgl2', { alpha: false, antialias: false });
  if (!gl) throw new Error('This browser has no WebGL2.');

  const compile = (type, source) => {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(`Ripple lens: ${gl.getShaderInfoLog(shader)}`);
    return shader;
  };
  const program = gl.createProgram();
  gl.attachShader(program, compile(gl.VERTEX_SHADER, VERTEX));
  gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAGMENT));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(`Ripple lens: ${gl.getProgramInfoLog(program)}`);
  gl.useProgram(program);
  gl.bindVertexArray(gl.createVertexArray());
  gl.viewport(0, 0, width, height);
  const u = name => gl.getUniformLocation(program, name);
  gl.uniform2f(u('uRes'), width, height);
  gl.uniform1f(u('uUnit'), 1080 * unit);
  gl.uniform1i(u('uFrom'), 0);
  gl.uniform1i(u('uTo'), 1);
  gl.uniform1f(u('uShapeLod'), Math.log2(Math.max(1, SHAPE_SIZE * 1080 * unit)));
  const uniforms = Object.fromEntries(
    ['uCentre', 'uRadius', 'uStrength', 'uFromScale', 'uToZoom', 'uFromLight', 'uShape', 'uTintA', 'uTintB'].map(n => [n, u(n)])
  );

  const textures = new Map();
  const upload = (image, tex, mips) => {
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
    if (mips) gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mips ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  };
  /** Pictures that will be used, uploaded ahead so a tap never stalls on one. */
  function setImages(images) {
    for (const image of images) {
      if (textures.has(image)) continue;
      const tex = gl.createTexture();
      upload(image, tex, true);
      textures.set(image, tex);
    }
  }
  const liveTexture = gl.createTexture();
  const rgb = c => {
    const { r, g, b } = tinycolor(c).toRgb();
    return [r / 255, g / 255, b / 255];
  };

  /**
   * Draws one moment and returns the canvas holding it, to be drawn in the same task.
   * `from` and `to` are images given to setImages. A `live` image is a picture that changes every
   * frame, uploaded here unless `reuseLive` says the last upload will do, and passes through the
   * wave whole: no `from`, no `to`, no shape to bend by.
   * @param {{ from?: any, to?: any, live?: any, reuseLive?: boolean, centre: number[], radius: number, strength?: number, fromScale?: number, toZoom?: number, fromLight?: number, tint: string[] }} o
   */
  function draw({ from, to, live, reuseLive = false, centre, radius, strength = 1, fromScale = 1, toZoom = 1, fromLight = 1, tint }) {
    if (live && !reuseLive) upload(live, liveTexture, false);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, live ? liveTexture : textures.get(from));
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, live ? liveTexture : textures.get(to));
    gl.uniform2f(uniforms.uCentre, centre[0], centre[1]);
    gl.uniform1f(uniforms.uRadius, radius);
    gl.uniform1f(uniforms.uStrength, strength);
    gl.uniform1f(uniforms.uFromScale, fromScale);
    gl.uniform1f(uniforms.uToZoom, toZoom);
    gl.uniform1f(uniforms.uFromLight, fromLight);
    gl.uniform1f(uniforms.uShape, live ? 0 : 1);
    gl.uniform3fv(uniforms.uTintA, rgb(tint[0]));
    gl.uniform3fv(uniforms.uTintB, rgb(tint[tint.length - 1]));
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    return canvas;
  }

  function dispose() {
    for (const tex of textures.values()) gl.deleteTexture(tex);
    textures.clear();
    gl.deleteTexture(liveTexture);
    gl.getExtension('WEBGL_lose_context')?.loseContext();
  }

  return { canvas, setImages, draw, dispose };
}
