// LAB (branch nebula-gpu-lab, local only): a WebGL2 ray marcher for the Blender Market "Nebula
// Generator" 3D material, so the studio can show the volumetric nebula live. Not wired into
// render-service and not used unless the lab switch is on (see installNebulaLab).
//
// It is a port of a CPU ray marcher that was checked against Blender's own render of the same
// design (rank correlation 0.91, dust silhouette agreement 92%), itself built on a port of
// Blender's Noise Texture that matched Blender to 5/255. Pieces:
//   noise    -- Blender's Perlin (Jenkins lookup3 hashing), fBm, and the node's built-in
//               Distortion warp; the five random offsets are Blender's own, precomputed
//   material -- Noise Texture.004 with its SCALE driven by Noise.009 (0.11) and DISTORTION by
//               Noise.008 (20); f < 0.394 is dust (45 per world unit, black), 0.351..0.493 is gas
//               (0.015), albedo navy -> orange -> black as luminance; a spherical falloff; the mesh
//               bounds. The noise is sampled in the space of the file's 'Empty' (world / 85.5445),
//               the falloff in the box's (world / 122.73) -- a detail that cost an hour once.
//   camera   -- the file's camera (18mm, inside the nebula), sensor fit to the larger dimension
//   light    -- three 2 MW point lights at random spots in the box's bounds (as the file's
//               "Large Stars" scatters them) plus the sun from above; shadows from a 64^3
//               extinction grid computed on the GPU
//   slices   -- EEVEE's own depth slicing (128 slices, 1..1000, distribution 0.8); see the loop
//   samples  -- several rays per pixel averaged (Blender averages 32 TAA samples); the depth offset
//               is shared by the whole frame per sample, never per pixel (per-pixel = sand)
// Output per pixel: gas light L (linear, unnormalised) and dust coverage.

import { makeRng, randomPalette } from './prng';
import tinycolor from 'tinycolor2';
import { styledNebula } from './nebulaStyles';
import { PERM } from './nebula2dCpu';

const OFFSETS = [[186.0312758447, 114.9559537682, 154.4475034705], [199.8400018783, 162.2925926843, 154.0482343999], [111.6338426507, 157.3693953122, 199.0881114730], [165.4452775757, 162.7682137915, 193.4084041029], [155.5809152908, 177.1546309062, 138.1400345681]];
const CAM = [[0.6498532891, -0.0672261342, -0.7570807934, -74.7545776367], [-0.7600596547, -0.0574806929, -0.6473061442, -72.5984191895], [-0.0000016365, 0.9960806370, -0.0884498954, 28.9624671936]];
const BB_MIN = [-144.52, -156.70, -151.17], BB_MAX = [145.95, 148.82, 148.47]; // Nebula Box world bounds
const GRID = 64, R_MAX = 0.906 * 1.39;
const f3 = (v) => `vec3(${v.map((x) => x.toFixed(8)).join(',')})`;

const NOISE_GLSL = `
uint rotl(uint x, uint k) { return (x << k) | (x >> (32u - k)); }
uint hash3(uint kx, uint ky, uint kz) {
  uint a = 0xdeadbeefu + (3u << 2u) + 13u, b = a, c = a;
  c += kz; b += ky; a += kx;
  c ^= b; c -= rotl(b, 14u); a ^= c; a -= rotl(c, 11u); b ^= a; b -= rotl(a, 25u);
  c ^= b; c -= rotl(b, 16u); a ^= c; a -= rotl(c, 4u); b ^= a; b -= rotl(a, 14u);
  c ^= b; c -= rotl(b, 24u);
  return c;
}
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
  uint X = uint(I.x), Y = uint(I.y), Z = uint(I.z);
  float u = fade(f.x), v = fade(f.y), w = fade(f.z);
  float n000 = grad3(hash3(X, Y, Z), f.x, f.y, f.z);
  float n100 = grad3(hash3(X + 1u, Y, Z), f.x - 1.0, f.y, f.z);
  float n010 = grad3(hash3(X, Y + 1u, Z), f.x, f.y - 1.0, f.z);
  float n110 = grad3(hash3(X + 1u, Y + 1u, Z), f.x - 1.0, f.y - 1.0, f.z);
  float n001 = grad3(hash3(X, Y, Z + 1u), f.x, f.y, f.z - 1.0);
  float n101 = grad3(hash3(X + 1u, Y, Z + 1u), f.x - 1.0, f.y, f.z - 1.0);
  float n011 = grad3(hash3(X, Y + 1u, Z + 1u), f.x, f.y - 1.0, f.z - 1.0);
  float n111 = grad3(hash3(X + 1u, Y + 1u, Z + 1u), f.x - 1.0, f.y - 1.0, f.z - 1.0);
  return mix(mix(mix(n000, n100, u), mix(n010, n110, u), v), mix(mix(n001, n101, u), mix(n011, n111, u), v), w);
}
float snoise(vec3 p) { return 0.982 * perlin(p); }
float fbm(vec3 p, int oct, float rough) {
  float fs = 1.0, amp = 1.0, maxamp = 0.0, sum = 0.0;
  for (int i = 0; i < 16; i++) {
    if (i >= oct) break;
    sum += snoise(fs * p) * amp; maxamp += amp; amp *= rough; fs *= 2.0;
  }
  return 0.5 * sum / maxamp + 0.5;
}
// Noise Texture node: vector * scale, optional distortion, fBm factor
float noiseTex(vec3 v, float scale, int oct, float rough, float distortion) {
  vec3 p = v * scale;
  if (distortion != 0.0) {
    p += vec3(snoise(p + ${f3(OFFSETS[0])}), snoise(p + ${f3(OFFSETS[1])}), snoise(p + ${f3(OFFSETS[2])})) * distortion;
  }
  return fbm(p, oct, rough);
}
`;

const MATERIAL_GLSL = `
uniform vec3 uMapLoc;
uniform int uOct;
const float BOX = 122.73, EMPTY = 85.5445, R_MAX = ${R_MAX.toFixed(6)};
float falloff(float r) {
  float t = min(1.0, r / 1.39);
  if (t <= 0.484) return 1.0;
  if (t >= 0.906) return 0.0;
  return 1.0 - (t - 0.484) / (0.906 - 0.484);
}
float albedo(float g) {
  float a;
  if (g <= 0.593) a = 0.038;
  else if (g <= 0.692) a = 0.038 + (0.56 - 0.038) * (g - 0.593) / 0.099;
  else if (g <= 0.748) a = 0.56 * (1.0 - (g - 0.692) / 0.056);
  else a = 0.0;
  return a * 1.1;
}
// x in BOX object space. Returns the density field f (or 1.0 outside), and the falloff.
vec2 field(vec3 x, int oct) {
  if (x.x < -1.18 || x.x > 1.19 || x.y < -1.28 || x.y > 1.21 || x.z < -1.23 || x.z > 1.21) return vec2(1.0, 0.0);
  float fo = falloff(length(x));
  if (fo <= 0.0) return vec2(1.0, 0.0);
  vec3 p = x * (BOX / EMPTY) + uMapLoc;
  float f9 = noiseTex(p, 0.11, min(oct, 8), 0.5379, 0.0);
  float f8 = noiseTex(p, 20.0, max(1, oct - 6), 0.573, 0.0);
  float f = noiseTex(p, f9, oct, 0.5743, f8 * 0.5);
  return vec2(f, fo);
}
// extinction per world unit and albedo from a field sample
vec2 material(vec2 ff) {
  float f = ff.x, fo = ff.y;
  if (fo <= 0.0) return vec2(0.0);
  float dust = f < 0.394 ? 45.0 : 0.0;
  float g = f <= 0.351 ? 1.0 : (f >= 0.493 ? 0.0 : 1.0 - (f - 0.351) / 0.142);
  return vec2((dust + 0.015 * g) * fo, dust > 0.0 ? 0.0 : albedo(g));
}
`;

const VS = `#version 300 es
in vec2 aPos; out vec2 vUv;
void main() { vUv = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }`;

const GRID_FS = `#version 300 es
precision highp float; precision highp int;
${NOISE_GLSL}
${MATERIAL_GLSL}
uniform float uZ; in vec2 vUv; out vec4 o;
void main() {
  vec3 x = -R_MAX + 2.0 * R_MAX * vec3(vUv, uZ);
  o = vec4(material(field(x, uOct)).x, 0.0, 0.0, 1.0);
}`;

const MAIN_FS = `#version 300 es
precision highp float; precision highp int; precision highp sampler3D;
${NOISE_GLSL}
${MATERIAL_GLSL}
uniform sampler3D uGrid;
uniform vec2 uRes; uniform vec2 uHalf;
uniform mat3 uCamR; uniform vec3 uCamP;
uniform vec4 uLights[4];   // xyz = world position (point) or direction (sun), w = intensity
uniform int uLightType[4]; // 0 point, 1 sun, -1 off
uniform int uSteps, uShadowSteps, uSamples;
uniform float uSeed;
out vec4 o;
float h12(vec2 p) { vec3 q = fract(vec3(p.xyx) * 0.1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
float gridAt(vec3 x) { vec3 t = (x + R_MAX) / (2.0 * R_MAX); if (any(lessThan(t, vec3(0.0))) || any(greaterThan(t, vec3(1.0)))) return 0.0; return texture(uGrid, t).r; }
float shadowTo(vec3 x, int i) {
  vec3 d; float len;
  if (uLightType[i] == 1) { d = -uLights[i].xyz; len = 2.0 * R_MAX; }
  else { vec3 v = uLights[i].xyz / BOX - x; len = length(v); d = v / len; }
  float ds = len / float(uShadowSteps), tau = 0.0;
  for (int s = 0; s < 64; s++) { if (s >= uShadowSteps) break; tau += gridAt(x + d * ds * (float(s) + 0.5)); }
  return exp(-tau * ds * BOX);
}
void main() {
  vec2 px = gl_FragCoord.xy;
  vec3 acc = vec3(0.0);
  for (int k = 0; k < 16; k++) {
    if (k >= uSamples) break;
    // Depth jitter is ONE value per sample for the whole frame (as Blender's volume renderer shifts
    // all its froxel slices together each frame). Per-pixel depth jitter made neighbouring pixels
    // disagree about thin dust and the image came out as sand.
    float j1 = h12(px + float(k) * 17.13 + uSeed), j2 = h12(px.yx + float(k) * 7.71 + uSeed * 3.1), jz = (float(k) + 0.5) / float(uSamples);
    vec2 sub = (px + vec2(j1, j2)) / uRes;
    vec2 s = (sub * 2.0 - 1.0) * uHalf;
    vec3 d = normalize(uCamR * vec3(s, -1.0));
    vec3 o3 = uCamP / BOX;
    float b = dot(o3, d), c = dot(o3, o3) - R_MAX * R_MAX;
    float tExit = (-b + sqrt(max(0.0, b * b - c))) * BOX;
    float T = 1.0, L = 0.0, Td = 1.0, tPrev = 0.0;
    for (int st = 0; st < 2048; st++) {
      if (st >= uSteps || T < 0.003) break;
      // Blender EEVEE's volume slicing: uSteps slices from 1 to the clip end (1000), spaced 80%
      // exponential / 20% linear (volumetric_sample_distribution 0.8), shifted together by jz.
      // About 83 of 128 fall inside the nebula. The look depends on this coarseness: sampled
      // finely, nearly every ray finds a sheet of dust and the gas disappears.
      float zz = (float(st) + jz) / float(uSteps);
      float t = 0.2 * (1.0 + 999.0 * zz) + 0.8 * pow(1000.0, zz);
      if (t > tExit) break;
      vec3 w = uCamP + d * t; vec3 x = w / BOX;
      vec2 ff = field(x, uOct);
      if (ff.x < 0.394 && ff.y > 0.0) {
        Td = 0.0; T = 0.0; break; // opaque black dust: nothing behind it is seen
      }
      vec2 m = material(ff);
      float dt = t - tPrev; tPrev = t;
      if (m.x <= 0.0) continue;
      float a = 1.0 - exp(-m.x * dt);
      float E = 0.0;
      for (int i = 0; i < 4; i++) {
        if (uLightType[i] < 0) continue;
        float tr = shadowTo(x, i);
        if (uLightType[i] == 1) E += uLights[i].w * tr;
        else { vec3 dl = uLights[i].xyz - w; E += uLights[i].w / dot(dl, dl) * tr; }
      }
      L += T * a * m.y * E / 12.566371;
      T *= 1.0 - a;
    }
    acc += vec3(L, 1.0 - Td, 0.0);
  }
  o = vec4(acc / float(uSamples), 1.0);
}`;

// ---- the ORIGINAL 2D recipe: nebula_2d.v3.0.4.blend's World node tree (stars left out) ----
// Ported node for node from a JS port that matched Blender's own render to 5/255. Three clouds,
// each a double-warped fBm through a narrow ramp, screened together; a slow glow dodged in where
// the clouds are dim (the rim light); fine orange grain dodged in; an S-curve. Sampled on a flat
// plane per design (UNITS_PER_SHORT_EDGE), as the approved mockups were. Output: sRGB luminance.
// The 2D recipe hashes lattice corners with a permutation table (shared with nebula2dCpu.js, so
// GPU and CPU agree) instead of NOISE_GLSL's Jenkins hash; everything else is NOISE_GLSL's.
const NOISE2D_GLSL = NOISE_GLSL.replace(/float perlin\(vec3 p\) \{[\s\S]*?\n\}\n/, `
const int PERM[256] = int[256](${PERM.join(',')});
int pm(int i) { return PERM[i & 255]; }
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
`);
const NEB2D_FS = `#version 300 es
precision highp float; precision highp int;
${NOISE2D_GLSL}
uniform vec3 uLoc; uniform vec2 uRes; uniform float uK; uniform int uOct;
#define WOCT min(uOct, 6)
out vec4 o;
vec3 noiseColor(vec3 v, float scale, int oct, float distortion) {
  vec3 p = v * scale;
  if (distortion != 0.0) p += vec3(snoise(p + ${f3(OFFSETS[0])}), snoise(p + ${f3(OFFSETS[1])}), snoise(p + ${f3(OFFSETS[2])})) * distortion;
  return vec3(fbm(p, oct, 0.5), fbm(p + ${f3(OFFSETS[3])}, oct, 0.5), fbm(p + ${f3(OFFSETS[4])}, oct, 0.5));
}
float cloud(vec3 v, float scale, float distortion, float ovScale, float ovDist) {
  float a = noiseTex(v, ovScale, WOCT, 0.5, ovDist * 0.5);
  float m = distortion + a;
  vec3 c = noiseColor(v, scale, WOCT, m * 0.5);
  return noiseTex(v + (c - 0.5), scale, uOct, 0.5, m * 0.5);
}
vec3 ramp2(float t, float p0, float p1, vec3 c1) { return c1 * clamp((t - p0) / (p1 - p0), 0.0, 1.0); } // black -> c1
float band(float t, float p0, float p1, float p2) { // black -> white -> black
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
float curveS(float x) { // RGB Curves' combined channel, AUTO handles as a cubic Hermite
  const float X[4] = float[4](0.0, 0.352, 0.573, 1.0), Y[4] = float[4](0.0, 0.157, 0.814, 1.0);
  const float M[4] = float[4](0.4460227273, 1.4205933682, 1.3009259259, 0.4355971897);
  if (x <= 0.0) return 0.0; if (x >= 1.0) return 1.0;
  int i = x < X[1] ? 0 : (x < X[2] ? 1 : 2);
  float h = X[i + 1] - X[i], t = (x - X[i]) / h, t2 = t * t, t3 = t2 * t;
  return (2.0 * t3 - 3.0 * t2 + 1.0) * Y[i] + (t3 - 2.0 * t2 + t) * h * M[i] + (-2.0 * t3 + 3.0 * t2) * Y[i + 1] + (t3 - t2) * h * M[i + 1];
}
float srgb(float c) { c = clamp(c, 0.0, 1.0); return c <= 0.0031308 ? 12.92 * c : 1.055 * pow(c, 1.0 / 2.4) - 0.055; }
void main() {
  vec2 px = gl_FragCoord.xy;
  vec3 dir = vec3((px.x - uRes.x * 0.5) * uK, 1.0, (px.y - uRes.y * 0.5) * uK);
  vec3 base = uLoc + dir;
  float t1 = clamp((cloud(base, 1.64, 0.18, 0.76, -2.88) - 0.535) / (0.704 - 0.535), 0.0, 1.0);
  float t2 = clamp((cloud(base, 0.82, 0.33, 3.18, 0.36) - 0.49) / (0.533 - 0.49), 0.0, 1.0);
  float t3 = clamp((cloud(base + vec3(0.0, 0.0, -0.08), 1.09, 0.0, 1.9, 11.0) - 0.474) / (0.689 - 0.474), 0.0, 1.0);
  vec3 c1 = vec3(0.019, 0.047, 0.107) * t1, c2 = vec3(0.103, 0.19, 0.265) * t2, c3 = vec3(0.161, 0.011, 0.0) * t3;
  vec3 neb = screen(screen(screen(vec3(0.0), c1), c2), c3);
  float ambT = clamp((noiseTex(dir + vec3(0.0, 0.0, -0.3), 1.96, 1, 0.5, 0.0) - 0.125) / (0.792 - 0.125), 0.0, 1.0);
  vec3 m7 = dodge(neb, vec3(ambT), band(gray(neb), 0.005, 0.167, 0.257));
  vec3 nc = noiseColor(dir, 5.0, WOCT, 0.0);
  vec3 fine = vec3(0.692, 0.173, 0.007) * clamp((gray(nc) - 0.148) / (0.816 - 0.148), 0.0, 1.0);
  vec3 m5 = dodge(m7, fine, band(gray(m7), 0.002, 0.264, 0.68));
  vec3 outc = vec3(curveS(m5.r), curveS(m5.g), curveS(m5.b));
  o = vec4(srgb(gray(outc)), t1, t2, t3); // luminance, then each cloud's position in its ramp
}`;

let GLS = null; // one persistent context for the whole visit
function gl() {
  if (GLS) return GLS;
  const canvas = document.createElement('canvas');
  const g = canvas.getContext('webgl2', { antialias: false, preserveDrawingBuffer: false });
  if (!g || !g.getExtension('EXT_color_buffer_float')) throw new Error('nebula lab needs WebGL2 + float render targets');
  const compile = (type, src) => { const s = g.createShader(type); g.shaderSource(s, src); g.compileShader(s); if (!g.getShaderParameter(s, g.COMPILE_STATUS)) throw new Error(g.getShaderInfoLog(s)); return s; };
  const program = (fs) => { const p = g.createProgram(); g.attachShader(p, compile(g.VERTEX_SHADER, VS)); g.attachShader(p, compile(g.FRAGMENT_SHADER, fs)); g.bindAttribLocation(p, 0, 'aPos'); g.linkProgram(p); if (!g.getProgramParameter(p, g.LINK_STATUS)) throw new Error(g.getProgramInfoLog(p)); return p; };
  const buf = g.createBuffer(); g.bindBuffer(g.ARRAY_BUFFER, buf);
  g.bufferData(g.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), g.STATIC_DRAW);
  g.enableVertexAttribArray(0); g.vertexAttribPointer(0, 2, g.FLOAT, false, 0, 0);
  const gridTex = g.createTexture(); g.bindTexture(g.TEXTURE_3D, gridTex);
  g.texImage3D(g.TEXTURE_3D, 0, g.R16F, GRID, GRID, GRID, 0, g.RED, g.HALF_FLOAT, null);
  for (const [k, v] of [[g.TEXTURE_MIN_FILTER, g.LINEAR], [g.TEXTURE_MAG_FILTER, g.LINEAR], [g.TEXTURE_WRAP_S, g.CLAMP_TO_EDGE], [g.TEXTURE_WRAP_T, g.CLAMP_TO_EDGE], [g.TEXTURE_WRAP_R, g.CLAMP_TO_EDGE]]) g.texParameteri(g.TEXTURE_3D, k, v);
  GLS = { canvas, g, grid: program(GRID_FS), main: program(MAIN_FS), neb2d: program(NEB2D_FS), gridTex, fb: g.createFramebuffer() };
  return GLS;
}

function setCommon(g, p, P) {
  g.uniform3fv(g.getUniformLocation(p, 'uMapLoc'), P.mapLoc);
}

// Placement for a design: noise offset and light positions, from its own side stream.
export function nebulaPlacement(seed, attempt = 0) {
  const rng = makeRng(`${seed}-nebula3d-${attempt}`);
  const mapLoc = [rng() * 100 - 50, rng() * 100 - 50, rng() * 100 - 50];
  const lights = [0, 1, 2].map(() => BB_MIN.map((lo, i) => lo + rng() * (BB_MAX[i] - lo)));
  return { mapLoc, lights };
}

/** Render the nebula at w x h. Returns { L, dust } Float32Arrays (row 0 = top). */
export function renderNebula(P, w, h, { samples = 4, steps = 128, shadowSteps = 24, oct = 0 } = {}) {
  const { g, grid, main, gridTex, fb } = gl();
  const octaves = oct || Math.max(6, Math.min(12, Math.round(Math.log2(Math.max(w, h)) + 0.5)));
  // 1. shadow grid
  g.useProgram(grid); setCommon(g, grid, P);
  g.uniform1i(g.getUniformLocation(grid, 'uOct'), 5);
  g.bindFramebuffer(g.FRAMEBUFFER, fb); g.viewport(0, 0, GRID, GRID);
  for (let z = 0; z < GRID; z++) {
    g.framebufferTextureLayer(g.FRAMEBUFFER, g.COLOR_ATTACHMENT0, gridTex, 0, z);
    g.uniform1f(g.getUniformLocation(grid, 'uZ'), (z + 0.5) / GRID);
    g.drawArrays(g.TRIANGLE_STRIP, 0, 4);
  }
  // 2. ray march into a float target
  const tex = g.createTexture(); g.bindTexture(g.TEXTURE_2D, tex);
  g.texImage2D(g.TEXTURE_2D, 0, g.RGBA32F, w, h, 0, g.RGBA, g.FLOAT, null);
  g.framebufferTexture2D(g.FRAMEBUFFER, g.COLOR_ATTACHMENT0, g.TEXTURE_2D, tex, 0);
  g.viewport(0, 0, w, h);
  g.useProgram(main); setCommon(g, main, P);
  const U = (n) => g.getUniformLocation(main, n);
  g.uniform1i(U('uOct'), octaves);
  g.activeTexture(g.TEXTURE0); g.bindTexture(g.TEXTURE_3D, gridTex); g.uniform1i(U('uGrid'), 0);
  g.uniform2f(U('uRes'), w, h);
  const half = w >= h ? [1, h / w] : [w / h, 1]; // 36mm sensor on 18mm, fit to the larger side
  g.uniform2f(U('uHalf'), half[0], half[1]);
  g.uniformMatrix3fv(U('uCamR'), false, [CAM[0][0], CAM[1][0], CAM[2][0], CAM[0][1], CAM[1][1], CAM[2][1], CAM[0][2], CAM[1][2], CAM[2][2]]);
  g.uniform3f(U('uCamP'), CAM[0][3], CAM[1][3], CAM[2][3]);
  // three point lights (2 MW, luminance-weighted, /4pi^2) and the sun from above (40, luminance-weighted)
  const pointI = (2e6 * 0.5826) / (4 * Math.PI * Math.PI), sunI = 40 * 0.4130;
  const L4 = [...P.lights.map((p) => [...p, pointI]), [0, 0, -1, sunI]].flat();
  g.uniform4fv(U('uLights[0]'), L4);
  g.uniform1iv(U('uLightType[0]'), [0, 0, 0, 1]);
  g.uniform1i(U('uSteps'), steps); g.uniform1i(U('uShadowSteps'), shadowSteps); g.uniform1i(U('uSamples'), samples);
  g.uniform1f(U('uSeed'), 0.0);
  g.drawArrays(g.TRIANGLE_STRIP, 0, 4);
  const px = new Float32Array(w * h * 4);
  g.readPixels(0, 0, w, h, g.RGBA, g.FLOAT, px);
  g.deleteTexture(tex); g.bindFramebuffer(g.FRAMEBUFFER, null);
  const L = new Float32Array(w * h), dust = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { // GL rows are bottom-up
    const s = ((h - 1 - y) * w + x) * 4, d = y * w + x;
    L[d] = px[s]; dust[d] = px[s + 1];
  }
  return { L, dust };
}

// 2D: the file's camera sees ~1.44 units across 16:9, i.e. ~0.81 across the short edge.
const UNITS_PER_SHORT_EDGE = 0.81;
export function render2d(loc, w, h, oct, withClouds = false) {
  const { g, neb2d, fb } = gl();
  const tex = g.createTexture(); g.bindTexture(g.TEXTURE_2D, tex);
  g.texImage2D(g.TEXTURE_2D, 0, g.RGBA32F, w, h, 0, g.RGBA, g.FLOAT, null);
  g.bindFramebuffer(g.FRAMEBUFFER, fb);
  g.framebufferTexture2D(g.FRAMEBUFFER, g.COLOR_ATTACHMENT0, g.TEXTURE_2D, tex, 0);
  g.viewport(0, 0, w, h); g.useProgram(neb2d);
  const U = (n) => g.getUniformLocation(neb2d, n);
  g.uniform3fv(U('uLoc'), loc); g.uniform2f(U('uRes'), w, h);
  g.uniform1f(U('uK'), UNITS_PER_SHORT_EDGE / Math.min(w, h)); g.uniform1i(U('uOct'), oct);
  g.drawArrays(g.TRIANGLE_STRIP, 0, 4);
  const px = new Float32Array(w * h * 4); g.readPixels(0, 0, w, h, g.RGBA, g.FLOAT, px);
  g.deleteTexture(tex); g.bindFramebuffer(g.FRAMEBUFFER, null);
  const m = new Float32Array(w * h);
  const clouds = withClouds ? [new Float32Array(w * h), new Float32Array(w * h), new Float32Array(w * h)] : null;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const sI = ((h - 1 - y) * w + x) * 4, d = y * w + x;
    m[d] = px[sI];
    if (clouds) { clouds[0][d] = px[sI + 1]; clouds[1][d] = px[sI + 2]; clouds[2][d] = px[sI + 3]; }
  }
  if (withClouds) m.clouds = clouds;
  return m;
}
// Placement re-rolled until the gas covers a sensible share of the frame, as in the mockups.
function placement2d(seed, target = 0.42, tries = 16) {
  let best = null;
  for (let i = 0; i < tries; i++) {
    const rng = makeRng(`${seed}-nebula-${i}`);
    const loc = [rng() * 400 - 200, rng() * 400 - 200, rng() * 400 - 200];
    const m = render2d(loc, 64, 36, 6);
    let lit = 0; for (const v of m) if (v > 0.3) lit++;
    const cover = lit / m.length, score = Math.abs(cover - target);
    if (!best || score < best.score) best = { loc, score, cover };
    if (score < 0.06) break;
  }
  return best;
}

// How much nebula a design gets: its own side stream, so it moves nothing else. Four tiers, smooth
// within each: none ~15%, faint ~20%, medium ~40%, full ~25% (the radial field it replaces is absent
// on 40% of designs and varies wildly in strength when present, so the nebula needs this range too).
export const AMOUNT_TIERS = [
  { name: 'none', share: 0.15 },
  { name: 'faint', share: 0.20, cover: [0.10, 0.20], strength: [0.20, 0.40] },
  { name: 'medium', share: 0.40, cover: [0.20, 0.35], strength: [0.45, 0.75] },
  { name: 'full', share: 0.25, cover: [0.35, 0.55], strength: [0.80, 1.00] },
];
// The nebula's colours. Usually the star field's gradient (gas and stars read as one), but on some
// designs the nebula gets a gradient of its own -- the radial field it replaces gave every blob its
// own random palette on auto-palette designs, and that was much of their colour. Own gradient: the
// user's palette if there is one, else a random palette, laid across the frame at a random angle.
// Its own side stream; draws a fixed number of values whatever it picks.
export const OWN_GRADIENT_SHARE = 0.5;
export function nebulaColour(config) {
  const rng = makeRng(`${config.seed}-nebula-colour`);
  const u = rng(), angle = rng() * Math.PI * 2, count = 2 + Math.floor(rng() * 4);
  const palRng = makeRng(`${config.seed}-nebula-palette`);
  const user = (config.colors || []).filter(Boolean);
  let colors;
  if (user.length >= 2) {
    const off = Math.floor(palRng() * user.length); // start the user's palette somewhere new
    colors = user.map((_, i) => user[(i + off) % user.length]);
  } else {
    // aim AWAY from the sky: centred opposite the background's mean hue (+-50deg), sweeping 120-220deg,
    // so the nebula adds colours the design does not already have (as the radial blobs often did)
    const bg = config.gradientBackgroundConfig.colors.map((c) => tinycolor(c).toHsl());
    let sx = 0, sy = 0; for (const c of bg) { sx += Math.cos((c.h * Math.PI) / 180) * c.s; sy += Math.sin((c.h * Math.PI) / 180) * c.s; }
    const bgHue = (Math.atan2(sy, sx) * 180) / Math.PI;
    const base = (bgHue + 180 + (palRng() - 0.5) * 100 + 360) % 360;
    colors = randomPalette(palRng, count, { minSpread: 120, maxSpread: 220, baseHue: base, centered: true });
  }
  const W = config.width, H = config.height, r = Math.hypot(W, H) / 2, dx = Math.cos(angle) * r, dy = Math.sin(angle) * r;
  const own = { width: W, height: H, colors: [...colors, colors[colors.length - 1]], gradientDirection: { x1: W / 2 - dx, y1: H / 2 - dy, x2: W / 2 + dx, y2: H / 2 + dy } };
  const mode = NEBULA_LAB.colour === 'stars' || NEBULA_LAB.colour === 'own' ? NEBULA_LAB.colour : (u < OWN_GRADIENT_SHARE ? 'own' : 'stars');
  return mode === 'own' ? { mode, gradient: own } : { mode, gradient: null };
}

export function nebulaAmount(seed) {
  const rng = makeRng(`${seed}-nebula-amount`);
  const u = rng(), v = rng(), w = rng(); // always three draws, whatever the tier
  let acc = 0;
  for (const t of AMOUNT_TIERS) {
    acc += t.share;
    if (u < acc || t === AMOUNT_TIERS[AMOUNT_TIERS.length - 1]) {
      if (!t.cover) return { tier: t.name, cover: 0, strength: 0 };
      return { tier: t.name, cover: t.cover[0] + v * (t.cover[1] - t.cover[0]), strength: t.strength[0] + w * (t.strength[1] - t.strength[0]) };
    }
  }
}

// ---- stylised variants of the 2D nebula: the SAME structure, restyled after the fact ----
//   'poster'      -- 4 flat tonal steps (screenprint), edges antialiased over ~1.5px
//   'poster-soft' -- 3 steps, edges feathered over ~6px
//   'contour'     -- only the edges between 6 steps, as lines ~2px wide (line art)
// Widths are in pixels of the nebula's own render, so they scale with it like the rest of the layer.
function smoothstep(e0, e1, x) { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); }
export function stylize(a, w, h, style) {
  if (!style) return a;
  const out = new Float32Array(a.length);
  if (style === 'poster' || style === 'poster-soft') {
    const L = style === 'poster' ? 3 : 2, soft = style === 'poster' ? 1.5 : 6; // L+1 flat steps
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const k = y * w + x, f = a[k] * L, i = Math.floor(f), fr = f - i;
      const gx = a[y * w + Math.min(w - 1, x + 1)] - a[y * w + Math.max(0, x - 1)], gy = a[Math.min(h - 1, y + 1) * w + x] - a[Math.max(0, y - 1) * w + x];
      const wv = Math.max(1e-4, 0.5 * Math.hypot(gx, gy) * L * soft); // edge width in step units
      out[k] = Math.min(1, (i + smoothstep(1 - wv, 1, fr)) / L);
    }
    return out;
  }
  if (style === 'contour') {
    const n = 6;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const k = y * w + x, f = a[k] * n;
      const gx = (a[y * w + Math.min(w - 1, x + 1)] - a[y * w + Math.max(0, x - 1)]) * 0.5 * n, gy = (a[Math.min(h - 1, y + 1) * w + x] - a[Math.max(0, y - 1) * w + x]) * 0.5 * n;
      const g = Math.max(1e-4, Math.hypot(gx, gy));
      const d = Math.abs(f - Math.round(f)) / g; // distance to the nearest step edge, in pixels
      out[k] = Math.round(f) > 0 ? 1 - smoothstep(0.6, 1.6, d) : 0;
    }
    return out;
  }
  return a;
}

function blurField(a, w, h, r) {
  const tmp = new Float32Array(a.length), out = Float32Array.from(a);
  for (let it = 0; it < 3; it++) {
    for (let y = 0; y < h; y++) { let acc = 0, n = 0; for (let x = -r; x < w; x++) { if (x + r < w) { acc += out[y * w + x + r]; n++; } if (x - r - 1 >= 0) { acc -= out[y * w + x - r - 1]; n--; } if (x >= 0) tmp[y * w + x] = acc / n; } }
    for (let x = 0; x < w; x++) { let acc = 0, n = 0; for (let y = -r; y < h; y++) { if (y + r < h) { acc += tmp[(y + r) * w + x]; n++; } if (y - r - 1 >= 0) { acc -= tmp[(y - r - 1) * w + x]; n--; } if (y >= 0) out[y * w + x] = acc / n; } }
  }
  return out;
}

// ---- the approved treatment ----
// His alpha's tonal curve (33 quantiles), applied to the gas light by rank.
const ALPHAQ = [0, 0.031, 0.043, 0.055, 0.063, 0.075, 0.082, 0.094, 0.11, 0.125, 0.149, 0.173, 0.2, 0.227, 0.255,
  0.282, 0.306, 0.333, 0.357, 0.384, 0.412, 0.439, 0.467, 0.498, 0.522, 0.549, 0.584, 0.62, 0.655, 0.698, 0.737, 0.792, 1];
export function toHisCurve(L) {
  const step = Math.max(1, Math.floor(L.length / 20000)), sample = [];
  for (let k = 0; k < L.length; k += step) sample.push(L[k]);
  sample.sort((a, b) => a - b);
  const q = (r) => sample[Math.min(sample.length - 1, Math.floor(r * (sample.length - 1)))];
  const knots = Array.from({ length: 33 }, (_, i) => q(i / 32));
  const out = new Float32Array(L.length);
  for (let k = 0; k < L.length; k++) {
    const v = L[k]; let lo = 0, hi = 32;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (knots[m] <= v) lo = m; else hi = m; }
    const span = knots[hi] - knots[lo], f = span > 0 ? Math.min(1, Math.max(0, (v - knots[lo]) / span)) : 0;
    out[k] = ALPHAQ[lo] + (ALPHAQ[hi] - ALPHAQ[lo]) * f;
  }
  return out;
}
function alphaCanvas(a, w, h, rgb) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const x = c.getContext('2d'), id = x.createImageData(w, h);
  for (let k = 0; k < a.length; k++) { id.data[k * 4] = rgb[0]; id.data[k * 4 + 1] = rgb[1]; id.data[k * 4 + 2] = rgb[2]; id.data[k * 4 + 3] = Math.round(a[k] * 255); }
  x.putImageData(id, 0, 0); return c;
}

const CACHE = new Map(); // seed + size -> { gas, dust } canvases (the studio re-renders the same design often)
// mode '2d' = the original 2D recipe as approved in its own round (star gradient, normal, behind the
// geometry); mode '3d' = the volumetric one as approved (hard light 50% on top, dust 35%). `place`,
// `blend` and `gasAlpha` override the mode's own treatment if set.
export const NEBULA_LAB = { mode: '3d', style: null, maxRender: 1920, samples: 8, steps: 128, oct: 0, dust: 0.35, ms: 0, view: null };
export function nebulaTreatment() {
  const base = NEBULA_LAB.mode === '2d'
    ? { place: 'behind', blend: 'source-over', gasAlpha: 1 }
    : { place: 'top', blend: 'hard-light', gasAlpha: 0.5 };
  for (const k of ['place', 'blend', 'gasAlpha']) if (NEBULA_LAB[k] != null) base[k] = NEBULA_LAB[k];
  return base;
}
// Lab tuning without a rebuild: localStorage 'cf-lab:nebula-opts' = JSON overriding the fields above.
try {
  if (typeof localStorage !== 'undefined') Object.assign(NEBULA_LAB, JSON.parse(localStorage.getItem('cf-lab:nebula-opts') || '{}'));
} catch { /* ignore */ }

/** Gas (white, alpha = his curve) and dust (black, alpha = coverage x strength) canvases at config size. */
export function nebulaLayers(config) {
  const key = `${NEBULA_LAB.mode}:${NEBULA_LAB.style}:${NEBULA_LAB.amount}:${NEBULA_LAB.colour}:${NEBULA_LAB.pools}:${config.seed}:${config.width}x${config.height}:${NEBULA_LAB.samples}:${NEBULA_LAB.steps}:${NEBULA_LAB.oct}:${NEBULA_LAB.maxRender}`;
  if (CACHE.has(key)) return CACHE.get(key);
  const t0 = performance.now();
  const scale = Math.min(1, NEBULA_LAB.maxRender / Math.max(config.width, config.height));
  const w = Math.max(16, Math.round(config.width * scale)), h = Math.max(16, Math.round(config.height * scale));
  const up = (c) => { if (w === config.width && h === config.height) return c; const u = document.createElement('canvas'); u.width = config.width; u.height = config.height; const x = u.getContext('2d'); x.imageSmoothingQuality = 'high'; x.drawImage(c, 0, 0, config.width, config.height); return u; };
  if (NEBULA_LAB.mode === '2d') {
    const oct = NEBULA_LAB.oct || Math.max(6, Math.min(12, Math.round(Math.log2(Math.max(w, h)) + 0.5)));
    const amount = NEBULA_LAB.amount === false ? { tier: 'full', cover: 0.42, strength: 1 } : nebulaAmount(config.seed);
    if (amount.strength === 0) {
      const none = { none: true, amount };
      CACHE.set(key, none);
      return none;
    }
    const pl = placement2d(config.seed, amount.cover);
    const m = render2d(pl.loc, w, h, oct, true);
    const curve = toHisCurve(m); curve.clouds = m.clouds;
    // colour pools (own-gradient designs): a heavily blurred copy of the gas, laid under it as a broad
    // glow, so the nebula puts down colour the way the radial blobs did, but shaped by the nebula
    const colour = nebulaColour(config);
    if (colour.mode === 'own' && NEBULA_LAB.pools !== 0) {
      const pools = blurField(curve, w, h, Math.round(Math.max(w, h) / 24));
      let mx = 1e-6; for (const v of pools) mx = Math.max(mx, v);
      const k0 = NEBULA_LAB.pools ?? 0.6;
      for (let k = 0; k < curve.length; k++) curve[k] = Math.max(curve[k], (pools[k] / mx) * k0);
    }
    for (let k = 0; k < curve.length; k++) curve[k] *= amount.strength;
    const styled = styledNebula(NEBULA_LAB.style, curve, w, h, config.starFieldConfig.gradientConfig.colors);
    const out = styled
      ? { gas: up(styled.canvas), tint: styled.tint, dust: null, amount, colour }
      : { gas: up(alphaCanvas(stylize(curve, w, h, NEBULA_LAB.style), w, h, [255, 255, 255])), tint: true, dust: null, amount, colour };
    NEBULA_LAB.ms = Math.round(performance.now() - t0);
    console.info(`[nebula lab] 2d ${config.seed} ${w}x${h} ${amount.tier} cover ${amount.cover.toFixed(2)} (got ${pl.cover.toFixed(2)}) strength ${amount.strength.toFixed(2)}: ${NEBULA_LAB.ms}ms`);
    if (CACHE.size > 12) CACHE.delete(CACHE.keys().next().value);
    CACHE.set(key, out);
    return out;
  }
  // re-roll the placement until the dust covers a sensible share of the frame (a tiny preview each)
  let P = null;
  for (let t = 0; t < 6; t++) {
    P = nebulaPlacement(config.seed, t);
    const pv = renderNebula(P, 64, Math.max(8, Math.round(64 * h / w)), { samples: 1, steps: 64 });
    let s = 0; for (const v of pv.dust) s += v; const cover = s / pv.dust.length;
    if (cover > 0.1 && cover < 0.5) break;
  }
  const { L, dust } = renderNebula(P, w, h, { samples: NEBULA_LAB.samples, steps: NEBULA_LAB.steps, oct: NEBULA_LAB.oct });
  const gas = alphaCanvas(toHisCurve(L), w, h, [255, 255, 255]);
  const dd = new Float32Array(dust.length); for (let k = 0; k < dust.length; k++) dd[k] = dust[k] * NEBULA_LAB.dust;
  const dc = alphaCanvas(dd, w, h, [0, 0, 0]);
  const out = { gas: up(gas), dust: up(dc) };
  NEBULA_LAB.ms = Math.round(performance.now() - t0);
  console.info(`[nebula lab] 3d ${config.seed} ${w}x${h} x${NEBULA_LAB.samples} samples: ${NEBULA_LAB.ms}ms`);
  if (CACHE.size > 12) CACHE.delete(CACHE.keys().next().value);
  CACHE.set(key, out);
  return out;
}

// The lab switch, dev only: ?nebula=2d or ?nebula=3d (remembered), ?nebula=0 to turn it off.
export function nebulaLabOn() {
  if (typeof window === 'undefined' || !import.meta.env?.DEV) return false;
  try {
    const q = new URLSearchParams(window.location.search).get('nebula');
    if (q === '1' || q === '2d' || q === '3d') localStorage.setItem('cf-lab:nebula', '1');
    if (q === '2d' || q === '3d') localStorage.setItem('cf-lab:nebula-mode', q);
    if (q === '0') localStorage.removeItem('cf-lab:nebula');
    NEBULA_LAB.mode = localStorage.getItem('cf-lab:nebula-mode') || NEBULA_LAB.mode;
    Object.assign(NEBULA_LAB, { style: null, place: null, blend: null, gasAlpha: null, amount: true, colour: null, pools: null }, JSON.parse(localStorage.getItem('cf-lab:nebula-opts') || '{}'));
    return localStorage.getItem('cf-lab:nebula') === '1';
  } catch { return false; }
}
