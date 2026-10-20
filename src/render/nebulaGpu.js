// The 2D nebula field on the GPU (WebGL2): the same recipe as nebula2dCpu.js, statement for
// statement, so the studio's GPU render and a print rendered without a GPU agree (checked to
// within ~1.3/255). The recipe is a port of the Blender Market "Nebula Generator" 2D World shader:
// three double-warped fBm clouds, each through a narrow ramp, screened together; a slow glow
// dodged in where the clouds are dim (the rim light); fine orange grain dodged in; an S-curve.
// Output is sRGB luminance per pixel, row 0 at the top, exactly like nebula2dRows.
//
// One persistent context for the whole visit (it is never more than one, so check-leaks' context
// count does not grow). If WebGL2 or float render targets are missing, or the context is lost,
// nebulaFieldGpu returns null and the caller falls back to the CPU.

import { PERM, NOISE_OFFSETS, UNITS_PER_SHORT_EDGE } from './nebula2dCpu';

const f3 = (v) => `vec3(${v.map((x) => x.toFixed(10)).join(',')})`;

const VS = `#version 300 es
in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`;

// The recipe as a GLSL library, so the 3D flight's volume bake (animation3d/nebula3d.js) runs the
// SAME code in its own (three.js) context rather than a copy. It expects uniforms uLoc, uOct and
// uViewOff (see NEBULA_UNIFORMS_GLSL) and defines nebulaLum(dir), the sRGB luminance at view
// direction `dir` -- exactly what the 2D shader's main() writes out.
//
// Every noise call goes through a LOOP, never a repeated call (2026-10-20, Aaron: on Windows,
// Firefox froze for seconds on first load and for half a minute before a 3D flight). A shader
// compiler pastes a whole copy of a function at each place it is called, and Windows' Direct3D
// compiler slows down faster than the code grows: written as plain calls the recipe held 37 copies
// of the noise, and Direct3D took 7s to compile the 2D field and 28s for the 3D bake (twice the
// recipe), measured in Firefox on an RTX 4070 -- compiling is CPU work, so a fast GPU does not help.
// Firefox cannot compile in the background, so the page waited. Looped, it holds four copies. The loops count up to `N + uZero`, a uniform nothing sets
// (WebGL starts every uniform at 0), so the compiler cannot know the count and paste the copies
// back out. The arithmetic is the same, statement for statement.
const NOISE_GLSL = `const int PERM[256] = int[256](${PERM.join(',')});
int pm(int i) { return PERM[i & 255]; }
float fade(float t) { return t * t * t * (t * (t * 6.0 - 15.0) + 10.0); }
float grad3(uint h, float x, float y, float z) {
  h &= 15u;
  float u = h < 8u ? x : y;
  float vt = (h == 12u || h == 14u) ? x : z;
  float v = h < 4u ? y : vt;
  return ((h & 1u) != 0u ? -u : u) + ((h & 2u) != 0u ? -v : v);
}
float perlin(vec3 p) {
  vec3 fl = floor(p); ivec3 I = ivec3(fl); vec3 f = p - fl;
  float u = fade(f.x), v = fade(f.y), w = fade(f.z);
  int xi = I.x & 255, yi = I.y & 255, zi = I.z & 255;
  int A = pm(xi) + yi, AA = pm(A) + zi, AB = pm(A + 1) + zi, B = pm(xi + 1) + yi, BA = pm(B) + zi, BB = pm(B + 1) + zi;
  float n000 = grad3(uint(pm(AA)), f.x, f.y, f.z), n100 = grad3(uint(pm(BA)), f.x - 1.0, f.y, f.z);
  float n010 = grad3(uint(pm(AB)), f.x, f.y - 1.0, f.z), n110 = grad3(uint(pm(BB)), f.x - 1.0, f.y - 1.0, f.z);
  float n001 = grad3(uint(pm(AA + 1)), f.x, f.y, f.z - 1.0), n101 = grad3(uint(pm(BA + 1)), f.x - 1.0, f.y, f.z - 1.0);
  float n011 = grad3(uint(pm(AB + 1)), f.x, f.y - 1.0, f.z - 1.0), n111 = grad3(uint(pm(BB + 1)), f.x - 1.0, f.y - 1.0, f.z - 1.0);
  return mix(mix(mix(n000, n100, u), mix(n010, n110, u), v), mix(mix(n001, n101, u), mix(n011, n111, u), v), w);
}
float snoise(vec3 p) { return 0.982 * perlin(p); }
float fbm(vec3 p, int oct) {
  float fs = 1.0, amp = 1.0, maxamp = 0.0, sum = 0.0;
  for (int i = 0; i < 16; i++) {
    if (i >= oct) break;
    sum += snoise(fs * p) * amp; maxamp += amp; amp *= 0.5; fs *= 2.0;
  }
  return 0.5 * sum / maxamp + 0.5;
}
const vec3 WARP_OFF[3] = vec3[3](${NOISE_OFFSETS.slice(0, 3).map(f3).join(', ')});
// The colour channels' offsets; channel 0 has none (adding zero changes nothing)
const vec3 CHAN_OFF[3] = vec3[3](vec3(0.0), ${f3(NOISE_OFFSETS[3])}, ${f3(NOISE_OFFSETS[4])});
vec3 lane(int i) { return vec3(i == 0, i == 1, i == 2); }
vec3 warped(vec3 v, float scale, float distortion) {
  vec3 p = v * scale;
  if (distortion != 0.0) {
    vec3 n = vec3(0.0);
    for (int i = 0; i < 3 + uZero; i++) n += snoise(p + WARP_OFF[i]) * lane(i);
    p += n * distortion;
  }
  return p;
}
`;
const RECIPE_GLSL = `#define WOCT min(uOct, 6)
// Five fbm steps through one fbm call and one warp: 0 the overlay that sets the warp amount m,
// 1-3 the three channels of the vector offset c (step 1 also warps p), 4 the cloud itself.
float cloud(vec3 v, float scale, float distortion, float ovScale, float ovDist) {
  float m = 0.0, r = 0.0;
  vec3 p = vec3(0.0), c = vec3(0.0), w = vec3(0.0);
  for (int s = 0; s < 5 + uZero; s++) {
    if (s < 2 || s == 4) w = warped(s == 4 ? v + (c - 0.5) : v, s == 0 ? ovScale : scale, s == 0 ? ovDist * 0.5 : m * 0.5);
    if (s == 1) p = w;
    float f = fbm(s == 0 || s == 4 ? w : p + CHAN_OFF[clamp(s - 1, 0, 2)], s == 4 ? uOct : WOCT);
    if (s == 0) m = distortion + f;
    else if (s == 4) r = f;
    else c += f * lane(s - 1);
  }
  return r;
}
// The three clouds, in the order they are screened together
const vec3 CLOUD_SHIFT[3] = vec3[3](vec3(0.0), vec3(0.0), vec3(0.0, 0.0, -0.08));
const float CLOUD_SCALE[3] = float[3](1.64, 0.82, 1.09), CLOUD_DIST[3] = float[3](0.18, 0.33, 0.0);
const float CLOUD_OV_SCALE[3] = float[3](0.76, 3.18, 1.9), CLOUD_OV_DIST[3] = float[3](-2.88, 0.36, 11.0);
const float CLOUD_LO[3] = float[3](0.535, 0.49, 0.474), CLOUD_SPAN[3] = float[3](0.704 - 0.535, 0.533 - 0.49, 0.689 - 0.474);
const vec3 CLOUD_TINT[3] = vec3[3](vec3(0.019, 0.047, 0.107), vec3(0.103, 0.19, 0.265), vec3(0.161, 0.011, 0.0));
float band(float t, float p0, float p1, float p2) {
  if (t <= p0 || t >= p2) return 0.0;
  return t < p1 ? (t - p0) / (p1 - p0) : 1.0 - (t - p1) / (p2 - p1);
}
float gray(vec3 c) { return dot(c, vec3(0.2126729, 0.7151522, 0.072175)); }
vec3 screen(vec3 a, vec3 b) { return 1.0 - (1.0 - b) * (1.0 - a); }
vec3 dodge(vec3 a, vec3 b, float t) {
  vec3 r;
  for (int i = 0; i < 3; i++) {
    float x = a[i];
    if (x == 0.0) { r[i] = 0.0; continue; }
    float d = 1.0 - t * b[i];
    r[i] = d <= 0.0 ? 1.0 : min(1.0, x / d);
  }
  return r;
}
float curveS(float x) {
  const float X[4] = float[4](0.0, 0.352, 0.573, 1.0), Y[4] = float[4](0.0, 0.157, 0.814, 1.0);
  const float M[4] = float[4](0.4460227273, 1.4205933682, 1.3009259259, 0.4355971897);
  if (x <= 0.0) return 0.0; if (x >= 1.0) return 1.0;
  int i = x < X[1] ? 0 : (x < X[2] ? 1 : 2);
  float h = X[i + 1] - X[i], t = (x - X[i]) / h, t2 = t * t, t3 = t2 * t;
  return (2.0 * t3 - 3.0 * t2 + 1.0) * Y[i] + (t3 - 2.0 * t2 + t) * h * M[i] + (-2.0 * t3 + 3.0 * t2) * Y[i + 1] + (t3 - t2) * h * M[i + 1];
}
float srgb(float c) { c = clamp(c, 0.0, 1.0); return c <= 0.0031308 ? 12.92 * c : 1.055 * pow(c, 1.0 / 2.4) - 0.055; }
float nebulaLum(vec3 dir) {
  vec3 base = uLoc + dir;
  vec3 neb = vec3(0.0);
  for (int k = 0; k < 3 + uZero; k++) {
    float t = clamp((cloud(base + CLOUD_SHIFT[k], CLOUD_SCALE[k], CLOUD_DIST[k], CLOUD_OV_SCALE[k], CLOUD_OV_DIST[k]) - CLOUD_LO[k]) / CLOUD_SPAN[k], 0.0, 1.0);
    neb = screen(neb, CLOUD_TINT[k] * t);
  }
  float ambT = clamp((fbm(warped(dir + uViewOff + vec3(0.0, 0.0, -0.3), 1.96, 0.0), 1) - 0.125) / (0.792 - 0.125), 0.0, 1.0);
  vec3 m7 = dodge(neb, vec3(ambT), band(gray(neb), 0.005, 0.167, 0.257));
  vec3 g = (dir + uViewOff) * 5.0;
  vec3 nc = vec3(0.0);
  for (int i = 0; i < 3 + uZero; i++) nc += fbm(g + CHAN_OFF[i], WOCT) * lane(i);
  vec3 fine = vec3(0.692, 0.173, 0.007) * clamp((gray(nc) - 0.148) / (0.816 - 0.148), 0.0, 1.0);
  vec3 m5 = dodge(m7, fine, band(gray(m7), 0.002, 0.264, 0.68));
  return srgb(gray(vec3(curveS(m5.r), curveS(m5.g), curveS(m5.b))));
}
`;
export const NEBULA_UNIFORMS_GLSL = `uniform vec3 uLoc; uniform int uOct;
// Offsets the two terms the recipe anchors to the VIEW (the slow rim glow and the fine grain). Zero
// for the 2D layer, where the nebula is one picture and adding zero changes nothing. The 3D flight's
// volume passes each slice's depth, or those terms are identical in every slice and stack into a
// solid tube along the whole flight.
uniform vec3 uViewOff;
// Never set, so always 0: the recipe's loops count to N + uZero (see the note above NOISE_GLSL).
uniform int uZero;
`;
export const NEBULA_LIB_GLSL = NOISE_GLSL + RECIPE_GLSL;

const FS = `#version 300 es
precision highp float; precision highp int;
uniform vec2 uRes; uniform float uK;
${NEBULA_UNIFORMS_GLSL}out vec4 o;
${NEBULA_LIB_GLSL}void main() {
  // gl_FragCoord's y runs up; the CPU's dz = (h/2 - py - 0.5) * k for row py from the top is the
  // same value here, since this pixel's row from the top is h - 1 - floor(gl_FragCoord.y).
  vec2 px = gl_FragCoord.xy;
  vec3 dir = vec3((px.x - uRes.x * 0.5) * uK, 1.0, (px.y - uRes.y * 0.5) * uK);
  // Packed into two 8-bit channels (16 bits), so this needs no float render target: those are an
  // extension (EXT_color_buffer_float) a phone may lack, which silently sent it to the CPU path.
  float q = floor(clamp(nebulaLum(dir), 0.0, 1.0) * 65535.0 + 0.5);
  o = vec4(floor(q / 256.0) / 255.0, mod(q, 256.0) / 255.0, 0.0, 1.0);
}`;

let STATE = null; // { g, prog, fb } | false once known unavailable
function context() {
  if (STATE === false) return null;
  if (STATE && !STATE.g.isContextLost()) return STATE;
  STATE = false;
  const inWorker = typeof document === 'undefined';
  if (inWorker ? typeof OffscreenCanvas === 'undefined' : typeof WebGL2RenderingContext === 'undefined') return null;
  try {
    // In the page, a canvas element (counted by scripts/check-leaks.mjs via data-nebula); in the
    // nebula's worker (render/nebulaWorker.js), an OffscreenCanvas.
    let canvas;
    if (inWorker) canvas = new OffscreenCanvas(1, 1);
    else {
      canvas = document.createElement('canvas');
      canvas.dataset.nebula = '1';
    }
    const g = /** @type {WebGL2RenderingContext} */ (canvas.getContext('webgl2', { antialias: false, preserveDrawingBuffer: false }));
    if (!g) return null;
    const compile = (type, src) => {
      const s = g.createShader(type);
      g.shaderSource(s, src);
      g.compileShader(s);
      if (!g.getShaderParameter(s, g.COMPILE_STATUS)) throw new Error(g.getShaderInfoLog(s));
      return s;
    };
    const prog = g.createProgram();
    g.attachShader(prog, compile(g.VERTEX_SHADER, VS));
    g.attachShader(prog, compile(g.FRAGMENT_SHADER, FS));
    g.bindAttribLocation(prog, 0, 'aPos');
    g.linkProgram(prog);
    if (!g.getProgramParameter(prog, g.LINK_STATUS)) throw new Error(g.getProgramInfoLog(prog));
    const buf = g.createBuffer();
    g.bindBuffer(g.ARRAY_BUFFER, buf);
    g.bufferData(g.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), g.STATIC_DRAW);
    g.enableVertexAttribArray(0);
    g.vertexAttribPointer(0, 2, g.FLOAT, false, 0, 0);
    STATE = { g, prog, fb: g.createFramebuffer() };
    return STATE;
  } catch (err) {
    console.warn('[nebula] GPU unavailable, using the CPU:', err);
    return null;
  }
}

/** The nebula field at w x h for placement `loc`, or null if the GPU cannot do it. */
// `units` (optional) is how many noise units the short edge spans; the 2D layer always uses
// UNITS_PER_SHORT_EDGE. The 3D flight's lab bakes wider and coarser slices through it.
export function nebulaFieldGpu(loc, w, h, oct, units = UNITS_PER_SHORT_EDGE, viewOff = [0, 0, 0]) {
  const s = begin(loc, w, h, oct, units, viewOff);
  if (!s) return null;
  s.g.drawArrays(s.g.TRIANGLE_STRIP, 0, 4);
  return finish(s, w, h);
}

// The same field, drawn in horizontal BANDS with the GPU handed back between them (2026-10-19,
// Aaron: Generate on the homepage stuttered badly on his phone). The whole field is one draw of a
// very heavy shader (~100 Perlin evaluations per pixel), and a phone GPU cannot preempt a draw:
// for as long as it runs the page cannot composite a frame, however idle the main thread is --
// and the homepage asks for six of them per Generate (one per surface aspect). Banded, each draw
// is a few ms of GPU time, and a fence between bands lets the compositor's frames in. Every pixel
// runs the identical shader with the identical gl_FragCoord, so the result is byte-identical to
// the one-draw version (verified). Used by the nebula's worker, where waiting is free.
// Band size is in PIXELS and adapts: a band that came back by the first poll grows, one that held
// the GPU clearly longer than the budget shrinks in proportion. The wait itself cannot be timed
// finer than the worker's timer (~1-5ms), so only a long wait is read as GPU time.
const BAND_START_PX = 16384, BAND_MIN_PX = 8192, BAND_MAX_PX = 131072, BAND_SLOW_MS = 10, BAND_TARGET_MS = 6;
export async function nebulaFieldGpuBanded(loc, w, h, oct, units = UNITS_PER_SHORT_EDGE, viewOff = [0, 0, 0], stats = null) {
  const s = begin(loc, w, h, oct, units, viewOff);
  if (!s) return null;
  const { g } = s;
  g.enable(g.SCISSOR_TEST);
  let y = 0, px = BAND_START_PX, band = 0;
  try {
    while (y < h) {
      const n = Math.min(h - y, Math.max(1, Math.round(px / w)));
      g.scissor(0, y, w, n);
      g.drawArrays(g.TRIANGLE_STRIP, 0, 4);
      const fence = g.fenceSync(g.SYNC_GPU_COMMANDS_COMPLETE, 0);
      g.flush();
      const t0 = performance.now();
      let polls = 0;
      // Poll rather than block: a blocking clientWaitSync would hold the worker for the band.
      while (g.clientWaitSync(fence, 0, 0) === g.TIMEOUT_EXPIRED) {
        if (g.isContextLost()) { g.deleteSync(fence); return null; }
        polls++;
        await new Promise(r => setTimeout(r, 1));
      }
      g.deleteSync(fence);
      const ms = performance.now() - t0;
      if (stats) { stats.bands = (stats.bands || 0) + 1; stats.maxBandMs = Math.max(stats.maxBandMs || 0, ms); }
      y += n;
      // The first band of a job can carry the shader's compile (seconds, on a software GL), which
      // says nothing about how long a band of pixels takes, so it never shrinks the next one.
      if (band++ === 0 && ms > BAND_SLOW_MS) continue;
      if (ms > BAND_SLOW_MS) px = Math.max(BAND_MIN_PX, px * Math.max(0.5, BAND_TARGET_MS / ms));
      else if (polls <= 1) px = Math.min(BAND_MAX_PX, px * 1.5);
    }
  } finally {
    g.disable(g.SCISSOR_TEST);
  }
  return finish(s, w, h);
}

function begin(loc, w, h, oct, units, viewOff) {
  const s = context();
  if (!s) return null;
  const { g, prog, fb } = s;
  const tex = g.createTexture();
  g.bindTexture(g.TEXTURE_2D, tex);
  g.texImage2D(g.TEXTURE_2D, 0, g.RGBA8, w, h, 0, g.RGBA, g.UNSIGNED_BYTE, null);
  g.bindFramebuffer(g.FRAMEBUFFER, fb);
  g.framebufferTexture2D(g.FRAMEBUFFER, g.COLOR_ATTACHMENT0, g.TEXTURE_2D, tex, 0);
  g.viewport(0, 0, w, h);
  g.useProgram(prog);
  g.uniform3fv(g.getUniformLocation(prog, 'uLoc'), loc);
  g.uniform2f(g.getUniformLocation(prog, 'uRes'), w, h);
  g.uniform1f(g.getUniformLocation(prog, 'uK'), units / Math.min(w, h));
  g.uniform1i(g.getUniformLocation(prog, 'uOct'), oct);
  g.uniform3fv(g.getUniformLocation(prog, 'uViewOff'), viewOff);
  return { ...s, tex };
}

function finish(s, w, h) {
  const { g, tex } = s;
  const px = new Uint8Array(w * h * 4);
  g.readPixels(0, 0, w, h, g.RGBA, g.UNSIGNED_BYTE, px);
  g.deleteTexture(tex);
  g.bindFramebuffer(g.FRAMEBUFFER, null);
  if (g.isContextLost()) return null;
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const src = (h - 1 - y) * w * 4, dst = y * w; // GL rows are bottom-up
    for (let x = 0; x < w; x++) out[dst + x] = (px[src + x * 4] * 256 + px[src + x * 4 + 1]) / 65535;
  }
  return out;
}
