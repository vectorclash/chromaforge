// The 2D nebula, given depth in the 3D flight. It takes the radial field's slot, as the nebula does
// in 2D. On in every build since 2026-10-19; a dev build can switch it off with ?nebula3d=off to
// compare against the old radial blobs (see nebula3dMode).
//
// The premise both share: the 2D nebula is already a flat SLICE through a 3D noise field (the
// recipe samples loc + (x, 1, y) -- noise x = screen right, noise y = depth, noise z = screen up).
// So "the nebula in 3D" is the same field sampled with depth, not a new nebula. World units map
// to noise units at the 2D framing: the 2D frame's short edge (FRAME_H world units at FRAME_D) is
// UNITS_PER_SHORT_EDGE noise units.
//
// The volume: the field baked into a 3D texture filling a corridor around the flight path, periodic
// along the loop, plus a small tiling detail noise, ray-marched per pixel. A cheaper 'sheets' form
// (stacked slices flown through) was built alongside it and dropped when Aaron picked this one.
//
// Both draw alpha only. Colour is the 2D rule, applied in screen space: the nebula's own gradient
// (plus colour pools, a blur of the layer) or the star field's gradient, from art.nebulaConfig.
import * as THREE from 'three';
import { nebulaFieldGpu, NEBULA_LIB_GLSL, NEBULA_UNIFORMS_GLSL } from '../render/nebulaGpu';
import { UNITS_PER_SHORT_EDGE } from '../render/nebula2dCpu';
import { placement, placementAsync, askNebulaWorker, hisCurveKnots, ALPHAQ, nebulaColour } from '../render/nebula';
import { detailNoiseData, DETAIL_SIZE } from '../render/nebulaDetail';
import { makeRng } from '../render/prng';

export function nebula3dMode() {
  // The volume IS the flight's colour volumes, in every build (2026-10-19; Aaron approved it in the
  // studio, and shipping the 2D nebula without it left the flight on the old radial blobs). A dev
  // build can still switch it off -- ?nebula3d=off, remembered -- to compare against those blobs.
  if (typeof window !== 'undefined' && import.meta.env?.DEV) {
    try {
      const q = new URLSearchParams(window.location.search).get('nebula3d');
      if (q) localStorage.setItem('cf-lab:nebula3d', q);
      if (localStorage.getItem('cf-lab:nebula3d') === 'off') return null;
    } catch {
      /* storage blocked: the default */
    }
  }
  return 'volume';
}
// Lab tuning without a rebuild: localStorage 'cf-lab:nebula3d-opts' = JSON over these.
export const NEB3D = {
  volRadius: 150, // corridor radius, world units
  volLateral: 128, // voxels across
  volStep: 7, // world units per voxel along the flight
  volSteps: 96, // ray-march samples per pixel
  volSigma: 1.5, // extinction per world unit at full density
  volEnvSwing: 0.5, // how far the amount envelope moves the gas threshold (0 = uniform)
  volDrift: 55, // how far the corridor's centre wanders, world units
  volFarFade: [110, 400], // gas fades in from afar over this range (the volume takes no warp)
  volLightStep: 6,
  volShadow: 0.8,
  volAmbient: 0.25,
  volFar: 420,
  volJitter: true, // per-pixel sample offsets
  volStretch: 1,
  volNear: [12, 55], // close gas dissolves before it reaches the camera, where its cells would magnify into smears // how many times slower the field changes along the flight than across it
  volOct: 5, // octaves baked into the grid -- no more than its slice spacing can hold
  volDetail: 0.35, // how far the detail noise moves the field
  volDetailSize: 40, // world units per detail tile
  volRes: 0.5, // march resolution against the frame
  volContrast: [0.5, 0.85], // density remap: smoothstep(lo, hi, d) -- sharper edges as the range narrows
  debugView: false, // lab: show the nebula layer alone, white on black
  pools: 0.6, // colour pools (own-gradient designs), as in 2D
  poolGain: 1.6
};
function readOpts() {
  try {
    Object.assign(NEB3D, JSON.parse(localStorage.getItem('cf-lab:nebula3d-opts') || '{}'));
  } catch {
    /* ignore */
  }
}

const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

// ─── Compiled shaders ─────────────────────────────────────────────────────────────────
// A nebula's compiled programs outlive its flight (2026-10-20, Aaron: Firefox on Windows paused
// every few 3D Generates). three frees a program once no material uses it, so a design with no
// nebula freed the previous flight's, and the next design with one compiled them all again -- the
// bake alone is ~0.7s on Windows, and Firefox compiles on the page. So a nebula's materials are
// kept, undisposed, until its renderer has compiled the next nebula's. Keyed weakly by renderer,
// so they go with it.
const RETIRED = new WeakMap();
function retire(renderer, materials) {
  if (!renderer) {
    for (const m of materials) m.dispose();
    return;
  }
  RETIRED.set(renderer, [...(RETIRED.get(renderer) || []), ...materials]);
}
function releaseRetired(renderer) {
  const held = RETIRED.get(renderer);
  RETIRED.delete(renderer);
  if (held) for (const m of held) m.dispose();
}
// Compiles `scenes` as they are drawn, into a render target: three keys a program on whether it
// draws to the screen or a target, so compiled with none bound it built a second variant that was
// never used -- each nebula shader was compiled twice.
export function compileInto(renderer, target, scenes, camera) {
  const prev = renderer.getRenderTarget();
  renderer.setRenderTarget(target);
  const done = Promise.all(scenes.map(s => renderer.compileAsync(s, camera)));
  renderer.setRenderTarget(prev);
  return done;
}


// ─── Volume ───────────────────────────────────────────────────────────────────────────
// Fine detail: a tiling 3D Perlin fBm texture (gradient noise, integer lattice periods, so it
// wraps exactly), sampled continuously by the march. The baked grid can only hold detail its
// slice spacing can represent -- baked with all octaves, the fine ones aliased between slices into
// rows of 'scales' -- so it carries the large shapes and this carries the small ones.
// The texture is made at once (zeros) and filled from the worker when it arrives (fillDetail);
// an unprepared caller fills it inline.
let DETAIL = null;
let detailFilled = false;
function detailTexture() {
  if (DETAIL) return DETAIL;
  const N = DETAIL_SIZE;
  const tex = new THREE.Data3DTexture(new Uint8Array(N * N * N), N, N, N);
  tex.format = THREE.RedFormat;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = tex.wrapR = THREE.RepeatWrapping;
  tex.needsUpdate = true;
  DETAIL = tex;
  return tex;
}
// The stock render's finer tile (detailNoiseData at 128^3, five octaves): built on demand, once.
let DETAIL_HI = null;
function detailTextureHi() {
  if (DETAIL_HI) return DETAIL_HI;
  const N = 128;
  const tex = new THREE.Data3DTexture(detailNoiseData(N, 5), N, N, N);
  tex.format = THREE.RedFormat;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = tex.wrapR = THREE.RepeatWrapping;
  tex.needsUpdate = true;
  DETAIL_HI = tex;
  return tex;
}
let detailPending = null;
function fillDetail(data) {
  if (detailFilled) return;
  detailTexture().image.data = data;
  DETAIL.needsUpdate = true;
  detailFilled = true;
}
function fillDetailAsync() {
  if (detailFilled) return Promise.resolve();
  if (!detailPending) detailPending = askNebulaWorker({ detail: true }).then(msg => fillDetail(msg && msg.data ? msg.data : detailNoiseData()));
  return detailPending;
}

// The volume is a CORRIDOR: gas fills a tube of radius volRadius around the flight path, on an even
// grid, fading out at the tube's wall; the sky shows beyond it, the way the plates and the cage
// frame the flight. Two wider-reaching grids were tried first and both failed in the same way: a
// fixed number of cells stretched over a huge (or infinite) extent made far cells enormous, and the
// far gas smeared into streaks pointing at the vanishing point.
// Lighting: each sample looks up the density a little way toward a light ahead
// and above; lit gas shows as the palette colour, gas in its own shadow lets the sky through --
// the approved Blender look (lit luminance -> alpha -> gradient), so no colour leaves the palette.
const MARCH_FRAG = /* glsl */ `
  precision highp sampler3D;
  varying vec2 vUv;
  uniform sampler3D uVol;
  uniform vec2 uTan;      // tan(fov/2) * aspect, tan(fov/2)
  uniform float uCamZ;
  uniform float uL;
  uniform float uR;       // corridor radius, world units
  uniform int uSteps;
  uniform float uSigma;
  uniform float uStrength;
  uniform float uJitter;
  uniform vec2 uContrast;
  uniform vec3 uLight;    // toward the light: x right, y up, z ahead
  uniform float uLightStep;
  uniform float uShadow;  // extinction toward the light
  uniform float uAmbient; // how much shadowed gas still shows
  uniform float uFar;
  uniform vec2 uNear;     // gas fades in over this range of distance from the camera
  uniform vec2 uFarFade;  // and fades out (in from afar) over this range
  // Along the loop: how much gas (three harmonics, whole cycles per loop) and where the corridor's
  // centre sits (two drifts). All periodic in L, so the loop still closes.
  uniform vec3 uEnvK; uniform vec3 uEnvP; uniform vec3 uEnvA; uniform float uEnvSwing;
  uniform vec2 uDriftK; uniform vec2 uDriftP; uniform float uDriftA;
  const float TAU = 6.2831853;
  float envelope(float zw) {
    float x = zw / uL * TAU;
    float e = uEnvA.x * sin(uEnvK.x * x + uEnvP.x) + uEnvA.y * sin(uEnvK.y * x + uEnvP.y) + uEnvA.z * sin(uEnvK.z * x + uEnvP.z);
    return clamp(0.5 + 0.5 * e, 0.0, 1.0);
  }
  uniform sampler3D uDetail;
  uniform float uDetailAmt;
  uniform vec3 uDetailFreq; // tiles per world unit: lateral, lateral, along the loop (whole tiles per L)
  SPACE_GLSL_HERE
  float dens(vec2 lat, float zw) {
    float x = zw / uL * TAU;
    lat -= uDriftA * vec2(sin(uDriftK.x * x + uDriftP.x), sin(uDriftK.y * x + uDriftP.y));
    float wall = 1.0 - smoothstep(0.7, 1.0, length(lat) / uR);
    if (wall <= 0.0) return 0.0;
    vec3 g = vec3(0.5 + 0.5 * lat.x / uR, 0.5 + 0.5 * lat.y / uR, mod(zw, uL) / uL);
    float b = texture(uVol, g).r * wall;
    float det = texture(uDetail, vec3(lat, mod(zw, uL)) * uDetailFreq).r;
    // erode: detail pushes the field up and down around its own value, most at the edges
    b += uDetailAmt * (det - 0.5) * (1.0 - 0.6 * b);
    // thin stretches raise the threshold (sparse, open), dense ones lower it
    float shift = (0.5 - envelope(zw)) * uEnvSwing;
    return smoothstep(uContrast.x + shift, uContrast.y + shift, b);
  }
  void main() {
    vec2 ray = (vUv * 2.0 - 1.0) * uTan;
    float T = 1.0, A = 0.0, tPrev = 2.0;
    // Per-pixel offset of the sample depths (interleaved gradient noise). With every pixel sampling
    // the same depths, sharp cloud edges showed the steps as evenly spaced ridges along each ray.
    float jit = uJitter < 0.0 ? fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715)))) : uJitter;
    JITTER_HERE
    for (int i = 0; i < MAX_STEPS_HERE; i++) {
      if (i >= uSteps || T < 0.01) break;
      float t = 2.0 * pow(uFar / 2.0, (float(i) + jit) / float(uSteps));
      float dt = t - tPrev; tPrev = t;
      vec2 lat = ray * t;
      float zw = uCamZ + t;
      float d = dens(lat, zw);
      if (d <= 0.003) continue;
      float far = 1.0 - smoothstep(uFarFade.x, uFarFade.y, t);
      d *= smoothstep(uNear.x, uNear.y, t) * far * far;
      float a = 1.0 - exp(-d * uSigma * dt);
      // two looks toward the light
      vec3 l1 = vec3(lat, zw) + uLight * uLightStep;
      vec3 l2 = vec3(lat, zw) + uLight * uLightStep * 3.0;
      float occ = dens(l1.xy, l1.z) + 2.0 * dens(l2.xy, l2.z);
      float lit = exp(-uShadow * occ);
      A += T * a * mix(uAmbient, 1.0, lit);
      T *= 1.0 - a;
    }
    A *= uStrength;
    gl_FragColor = vec4(A, A, A, A);
  }
`;

// The bake runs on the GPU, in the scene's own (three.js) context, straight into a 3D render target:
// one draw per depth slice, the 2D recipe's own GLSL (NEBULA_LIB_GLSL), the tone curve applied in
// the shader. Nothing is read back. Built first as 480 draws in a separate context, each read back
// as floats, then curved and re-uploaded from JavaScript: ~1s of one task, measured as a ~0.5s
// freeze after every Generate. The GPU work itself is a small part of that.
// It is done in chunks (bake(renderer, budget)) so a build never holds the main thread for long;
// see createNebula3d's `ready`.
const ALPHAQ_GLSL = `const float ALPHAQ[33] = float[33](${ALPHAQ.map(v => v.toFixed(4)).join(',')});`;
const BAKE_FRAG = /* glsl */ `
  precision highp float; precision highp int;
  ${NEBULA_UNIFORMS_GLSL}
  ${NEBULA_LIB_GLSL}
  ${ALPHAQ_GLSL}
  uniform float uRes;      // voxels across
  uniform float uSpan;     // noise units across
  uniform float uDepthA;   // this slice's depth, noise units
  uniform float uDepthB;   // the same slice one loop earlier (the seam crossfade)
  uniform float uSeamW;
  uniform float uKnots[33];
  float curve(float v) {
    int lo = 0, hi = 32;
    for (int it = 0; it < 6; it++) { int m = (lo + hi) / 2; if (uKnots[m] <= v) lo = m; else hi = m; }
    float span = uKnots[hi] - uKnots[lo];
    float f = span > 0.0 ? clamp((v - uKnots[lo]) / span, 0.0, 1.0) : 0.0;
    return ALPHAQ[lo] + (ALPHAQ[hi] - ALPHAQ[lo]) * f;
  }
  void main() {
    vec2 q = (gl_FragCoord.xy - uRes * 0.5) * (uSpan / uRes);
    // This slice, then (near the seam) the same slice one loop earlier, through ONE nebulaLum call:
    // two calls put two copies of the recipe in the shader (see nebulaGpu.js's note on loops).
    float v = 0.0, earlier = 0.0;
    for (int k = 0; k < (uSeamW > 0.0 ? 2 : 1); k++) {
      float l = nebulaLum(vec3(q.x, 1.0 + (k == 0 ? uDepthA : uDepthB), q.y));
      if (k == 0) v = l; else earlier = l;
    }
    if (uSeamW > 0.0) v = mix(v, earlier, uSeamW);
    gl_FragColor = vec4(curve(v), 0.0, 0.0, 1.0);
  }
`;

// ─── The Blender recipe (stock renders only) ─────────────────────────────────────────
// The 3D Nebula Generator file's volume (Blender Market, Mark Kingsnorth, v3.0.4: the "Nebula
// Material" node tree, read out of nebula_3d.current.v3.0.4.blend on 2026-11-21), the look Aaron
// approved on 2026-10-18 and set aside then as too slow for the site. One fBm whose SCALE is driven
// by a slow noise and whose DISTORTION by a fine one:
//   q = world / 85.5445 (the file's Empty) + offset
//   s = fbm(q * 0.11, rough 0.5379)              -- the scale field
//   d = fbm(q * 20,   rough 0.573)               -- the distortion field
//   n = fbm(distort(q * s, 0.5 * d), rough 0.5743)
//   dust: n < 0.3944, density 45 (a hard step: black, opaque)
//   gas:  1 at n = 0.3513 falling to 0 at 0.4932, density 0.015, coloured by a ramp over that
//         value -- navy (0.593), orange (0.692), black (0.748) -- so the gas is a faint navy
//         haze with an orange rim right at the edge of the dust.
// The file's octaves (16) are more than any grid holds; the bake keeps what its voxels can (uOctN)
// and the march's detail tile supplies the rest, which is where the dust edges get their wisps.
// Colour stays the flight's: gas luminance becomes the layer's alpha, painted with the design's
// gradient as every nebula is; the dust darkens what is behind it.
const BLENDER_BAKE_FRAG = /* glsl */ `
  precision highp float; precision highp int;
  ${NEBULA_UNIFORMS_GLSL}
  ${NEBULA_LIB_GLSL}
  uniform float uRes;      // voxels across
  uniform float uSpan;     // world units across
  uniform float uDepthA;   // this slice's depth, world units
  uniform float uDepthB;   // the same slice one loop earlier (the seam crossfade)
  uniform float uSeamW;
  uniform float uQ;        // recipe units per world unit
  uniform vec3 uQOff;
  uniform int uOctN, uOctS, uOctD;
  float fbmR(vec3 p, int oct, float rough) {
    float fs = 1.0, amp = 1.0, maxamp = 0.0, sum = 0.0;
    for (int i = 0; i < 16; i++) {
      if (i >= oct) break;
      sum += snoise(fs * p) * amp; maxamp += amp; amp *= rough; fs *= 2.0;
    }
    return 0.5 * sum / maxamp + 0.5;
  }
  float recipe(vec3 q) {
    float sc = fbmR(q * 0.11, uOctS, 0.5379);
    float d = fbmR(q * 20.0, uOctD, 0.573);
    return fbmR(warped(q, sc, 0.5 * d), uOctN, 0.5743);
  }
  void main() {
    vec2 lat = (gl_FragCoord.xy - uRes * 0.5) * (uSpan / uRes);
    float v = 0.0, earlier = 0.0;
    for (int k = 0; k < (uSeamW > 0.0 ? 2 : 1); k++) {
      float z = k == 0 ? uDepthA : uDepthB;
      float l = recipe(vec3(lat.x, z, lat.y) * uQ + uQOff);
      if (k == 0) v = l; else earlier = l;
    }
    if (uSeamW > 0.0) v = mix(v, earlier, uSeamW);
    gl_FragColor = vec4(v, 0.0, 0.0, 1.0);
  }
`;
// Marches the recipe's field: gas brightness (lit, shadowed by dust toward the light) into alpha,
// dust coverage into red. The flight path itself is kept clear of dust (uAxisClear), or the camera
// spends whole stretches inside a black wall -- most of the file's own camera placements did.
const BLENDER_MARCH_FRAG = /* glsl */ `
  precision highp sampler3D;
  varying vec2 vUv;
  uniform sampler3D uVol;
  uniform vec2 uTan;
  uniform float uCamZ;
  uniform float uL;
  uniform float uR;
  uniform int uSteps;
  uniform float uJitter;
  uniform float uFrameJit;
  uniform vec3 uLight;
  uniform float uLightStep;
  uniform float uFar;
  uniform vec2 uNear;
  uniform vec2 uFarFade;
  uniform vec3 uEnvK; uniform vec3 uEnvP; uniform vec3 uEnvA; uniform float uEnvSwing;
  uniform vec2 uDriftK; uniform vec2 uDriftP; uniform float uDriftA;
  uniform sampler3D uDetail;
  uniform float uDetailAmt;
  uniform vec3 uDetailFreq;
  uniform float uDustSigma, uGasSigma, uGasGain, uShadow, uAmbient, uDustEdge, uThreshold;
  // How brightly the gas BODY glows, against the file's ramp, where only the orange rim at the dust
  // edge is bright and the body is a navy at luminance 0.04 -- so the nebula read as outlines.
  uniform float uGasBody;
  // The site's colouring (2026-11-21, Aaron: "color it the way the site nebula are colored"): the
  // gas brightness is rank-mapped onto the alpha distribution of Aaron's original nebula artwork
  // (ALPHAQ, the site's "his curve"), with knots measured from this flight's own gas (sampleCurve).
  // uCurveOn is 0 while those samples are taken.
  uniform float uKnots[33];
  uniform float uCurveOn;
  ${ALPHAQ_GLSL}
  float hisCurve(float v) {
    int lo = 0, hi = 32;
    for (int it = 0; it < 6; it++) { int m = (lo + hi) / 2; if (uKnots[m] <= v) lo = m; else hi = m; }
    float span = uKnots[hi] - uKnots[lo];
    float f = span > 0.0 ? clamp((v - uKnots[lo]) / span, 0.0, 1.0) : 0.0;
    return ALPHAQ[lo] + (ALPHAQ[hi] - ALPHAQ[lo]) * f;
  }
  uniform vec2 uAxisClear;
  // Where in the palette a bit of gas sits (the composite's paletteAt): offset, then how fast it
  // moves with the gas value, with depth along the loop (whole cycles, so the loop closes) and with
  // the angle around the flight path. Read back as an emission-weighted mean, through a triangle
  // wave so the mean never averages across a wrap.
  uniform vec4 uHue;
  const float TAU = 6.2831853;
  float envelope(float zw) {
    float x = zw / uL * TAU;
    float e = uEnvA.x * sin(uEnvK.x * x + uEnvP.x) + uEnvA.y * sin(uEnvK.y * x + uEnvP.y) + uEnvA.z * sin(uEnvK.z * x + uEnvP.z);
    return clamp(0.5 + 0.5 * e, 0.0, 1.0);
  }
  // the recipe value at a point, and how far it is from the corridor's wall (1 inside, 0 beyond)
  float field(vec2 lat, float zw, out float wall, out float axis) {
    float x = zw / uL * TAU;
    vec2 c = lat - uDriftA * vec2(sin(uDriftK.x * x + uDriftP.x), sin(uDriftK.y * x + uDriftP.y));
    wall = 1.0 - smoothstep(0.7, 1.0, length(c) / uR);
    axis = smoothstep(uAxisClear.x, uAxisClear.y, length(lat));
    if (wall <= 0.0) return 1.0;
    // the volume is baked around the corridor's own (drifting) centre, so it is read there too --
    // read at the raw position, a drifted corridor ran off the grid's edge and smeared its edge
    // texels into streaks
    vec3 g = vec3(0.5 + 0.5 * c.x / uR, 0.5 + 0.5 * c.y / uR, mod(zw, uL) / uL);
    float n = texture(uVol, g).r;
    float det = texture(uDetail, vec3(c, mod(zw, uL)) * uDetailFreq).r;
    n += uDetailAmt * (det - 0.5);
    // the envelope moves the thresholds: denser stretches of the loop have more dust and gas
    n += (envelope(zw) - 0.5) * uEnvSwing + uThreshold;
    return n;
  }
  float dustOf(float n, float wall, float axis) { return smoothstep(0.3944 + uDustEdge, 0.3944 - uDustEdge, n) * wall * axis; }
  float gasOf(float n, float wall) { return clamp((0.4932 - n) / 0.1419, 0.0, 1.0) * wall; }
  // the file's gas ramp, as luminance: navy below 0.5934, orange at 0.692, black from 0.748
  float gasLum(float v) {
    vec3 navy = vec3(0.0067, 0.0309, 0.1998), orange = vec3(1.0, 0.486, 0.0036);
    vec3 c = v < 0.5934 ? navy : v < 0.692 ? mix(navy, orange, (v - 0.5934) / 0.0986) : v < 0.748 ? mix(orange, vec3(0.0), (v - 0.692) / 0.056) : vec3(0.0);
    return dot(c * 1.1, vec3(0.2126, 0.7152, 0.0722));
  }
  void main() {
    vec2 ray = (vUv * 2.0 - 1.0) * uTan;
    float T = 1.0, Td = 1.0, A = 0.0, tPrev = 2.0, C = 0.0, Cw = 0.0;
    float jit = uJitter < 0.0 ? fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715)))) : uJitter;
    jit = fract(jit + uFrameJit);
    for (int i = 0; i < MAX_STEPS_HERE; i++) {
      if (i >= uSteps || T < 0.003) break;
      float t = 2.0 * pow(uFar / 2.0, (float(i) + jit) / float(uSteps));
      float dt = t - tPrev; tPrev = t;
      vec2 lat = ray * t;
      float zw = uCamZ + t;
      float wall, axis;
      float n = field(lat, zw, wall, axis);
      if (wall <= 0.0) continue;
      float fade = smoothstep(uNear.x, uNear.y, t) * (1.0 - smoothstep(uFarFade.x, uFarFade.y, t));
      float dust = dustOf(n, wall, axis) * fade;
      float gv = gasOf(n, wall);
      float gas = gv * fade;
      if (dust < 0.001 && gas < 0.001) continue;
      float sd = dust * uDustSigma, sg = gas * uGasSigma;
      // two looks toward the light: dust between here and it shadows the gas
      float w1, a1, w2, a2;
      vec3 l1 = vec3(lat, zw) + uLight * uLightStep, l2 = vec3(lat, zw) + uLight * uLightStep * 3.0;
      float occ = dustOf(field(l1.xy, l1.z, w1, a1), w1, a1) + 2.0 * dustOf(field(l2.xy, l2.z, w2, a2), w2, a2);
      float lit = mix(uAmbient, 1.0, exp(-uShadow * occ));
      float ag = 1.0 - exp(-sg * dt);
      float e = T * ag * max(gasLum(gv), uGasBody * smoothstep(0.0, 0.6, gv)) * lit * uGasGain;
      A += e;
      float hx = uHue.x + gv * uHue.y + floor(uHue.z) * mod(zw, uL) / uL + uHue.w * atan(lat.y, lat.x) / TAU;
      C += e * (1.0 - abs(fract(hx) * 2.0 - 1.0));
      Cw += e;
      float ad = 1.0 - exp(-sd * dt);
      T *= (1.0 - ag) * (1.0 - ad);
      Td *= 1.0 - ad;
    }
    // where there is no gas there is no nebula: empty space, as in the artwork
    float a = uCurveOn > 0.5 ? (A > 1e-4 ? hisCurve(A) : 0.0) : A;
    gl_FragColor = vec4(1.0 - Td, Cw > 0.0 ? C / Cw : 0.5, 0.0, a);
  }
`;

function buildVolume({ seed, plan, L, frameH, space, quad, O, float }) {
  const blender = O.recipe === 'blender';
  const s = UNITS_PER_SHORT_EDGE / frameH;
  const NX = O.volLateral, R = O.volRadius;
  const NZ = Math.max(32, Math.round(L / O.volStep));
  const seam = 0.2; // the last 20% of the loop crossfades into the slices before its start
  // depth can run slower through the field than across it (volStretch, 1 = isotropic)
  const sz = s / O.volStretch;
  const span = 2 * R * s;

  // Placement (where in the field this design sits) and the tone curve's knots, set once before
  // the first slice. The placement is the 2D nebula's own (render/nebula.js), and computing it is
  // ~100ms of CPU -- on a phone several times that -- so a prepared bake fetches it from the
  // nebula's worker (placementAsync) rather than doing it here, inline in the scene build.
  let located = false;
  function locate(loc) {
    // The knots, from a coarse sample of the same field: 12 slices at 48x48 through the 2D layer's
    // renderer (a few ms). The curve is a rank map, so a sample this size pins it well.
    const sample = [];
    for (let k = 0; k < 12; k++) {
      const z = ((k + 0.5) / 12) * L;
      const f = nebulaFieldGpu([loc[0], loc[1] + z * sz, loc[2]], 48, 48, O.volOct, span, [0, z * sz, 0]);
      if (!f) throw new Error('nebula3d volume needs WebGL2');
      for (const v of f) sample.push(v);
    }
    // (The bake below puts depth into dir.y rather than loc.y + uViewOff: the same sums, since the
    // recipe sees base = loc + dir and the view terms see dir + uViewOff.)
    bakeU.uLoc.value.set(loc[0], loc[1], loc[2]);
    bakeU.uKnots.value = hisCurveKnots(sample);
    located = true;
  }

  // 8-bit density for the flight (memory, and phones); half float for a stock render, where the
  // contrast remap below would otherwise stretch 256 levels into visible terraces.
  const rt = new THREE.WebGL3DRenderTarget(NX, NX, NZ, { format: THREE.RedFormat, type: float ? THREE.HalfFloatType : THREE.UnsignedByteType, depthBuffer: false });
  rt.texture.minFilter = THREE.LinearFilter;
  rt.texture.magFilter = THREE.LinearFilter;
  rt.texture.wrapR = THREE.RepeatWrapping;
  const bakeU = {
    uLoc: { value: new THREE.Vector3() },
    uOct: { value: O.volOct },
    uViewOff: { value: new THREE.Vector3(0, 0, 0) },
    uRes: { value: NX },
    uSpan: { value: span },
    uDepthA: { value: 0 },
    uDepthB: { value: 0 },
    uSeamW: { value: 0 },
    uKnots: { value: new Array(33).fill(0) }
  };
  if (blender) {
    // world -> recipe units, and where in the recipe's field this design sits (its own stream)
    const pr = makeRng(`${seed}-nebula3d-blender`);
    Object.assign(bakeU, {
      uSpan: { value: 2 * R },
      uQ: { value: (O.blenderScale ?? 1) / 85.5445 },
      uQOff: { value: new THREE.Vector3(pr() * 40 - 20, 11.11 + pr() * 40 - 20, 12.51 + pr() * 40 - 20) },
      uOctN: { value: O.blenderOctN ?? 8 },
      uOctS: { value: 4 },
      uOctD: { value: 2 }
    });
    located = true; // the recipe needs no placement search and no tone curve
  }
  const bakeMat = new THREE.ShaderMaterial({
    vertexShader: 'void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: blender ? BLENDER_BAKE_FRAG : BAKE_FRAG,
    uniforms: bakeU,
    depthTest: false,
    depthWrite: false
  });
  const bakeScene = new THREE.Scene();
  bakeScene.add(quad(bakeMat));
  let next = 0;
  let fence = null;
  // Bakes slices until `budget` ms have passed (Infinity = all), returning true when complete.
  // `async` mode never waits on the GPU: it queues one chunk, leaves a fence, and on the next call
  // queues another only once that fence has signalled -- so the main thread is never blocked
  // waiting for slices to finish. The synchronous form (a caller that never prepared) waits.
  function bake(renderer, budget = Infinity, async = false) {
    if (next >= NZ && !fence) return true;
    if (!located) locate(placement(seed, plan.cover)); // an unprepared caller: inline
    if (!detailFilled) fillDetail(detailNoiseData());
    const gl = renderer.getContext();
    if (fence) {
      if (async && gl.getSyncParameter(fence, gl.SYNC_STATUS) !== gl.SIGNALED) return false;
      gl.deleteSync(fence);
      fence = null;
      if (next >= NZ) return true;
    }
    const t0 = performance.now();
    const prev = renderer.getRenderTarget();
    const px = new Uint8Array(4);
    while (next < NZ) {
      for (let c = 0; c < 16 && next < NZ; c++, next++) {
        const z = (next / NZ) * L;
        bakeU.uDepthA.value = blender ? z : z * sz;
        bakeU.uDepthB.value = blender ? z - L : (z - L) * sz;
        bakeU.uSeamW.value = smooth(L * (1 - seam), L, z);
        renderer.setRenderTarget(rt, next);
        renderer.render(bakeScene, space.orthoCam);
      }
      if (async) {
        fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
        gl.flush();
        break;
      }
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); // wait, so the budget is real time
      if (performance.now() - t0 > budget) break;
    }
    renderer.setRenderTarget(prev);
    return next >= NZ && !fence;
  }
  const tex = rt.texture;

  // Per design, on its own stream: the light's direction around the flight axis (always mostly ahead,
  // so gas is backlit; a fixed one lit the same side of every flight), the amount envelope and the
  // corridor's drift. Whole cycles per loop throughout.
  const vr = makeRng(`${seed}-nebula3d-vary`);
  const cyc = per => Math.max(1, Math.round(L / per));
  const az = vr() * Math.PI * 2;
  const variation = {
    light: new THREE.Vector3(Math.cos(az) * 0.6, Math.sin(az) * 0.6, 0.8).normalize(),
    uEnvK: { value: new THREE.Vector3(cyc(1100), cyc(520), cyc(260)) },
    uEnvP: { value: new THREE.Vector3(vr() * 6.283, vr() * 6.283, vr() * 6.283) },
    uEnvA: { value: new THREE.Vector3(0.7, 0.45, 0.25) },
    uEnvSwing: { value: O.volEnvSwing },
    uDriftK: { value: new THREE.Vector2(cyc(900), cyc(700)) },
    uDriftP: { value: new THREE.Vector2(vr() * 6.283, vr() * 6.283) },
    uDriftA: { value: O.volDrift }
  };
  const uniforms = {
    uVol: { value: tex },
    uTan: { value: new THREE.Vector2(1, 1) },
    uCamZ: { value: 0 },
    uL: { value: L },
    uR: { value: R },
    uSteps: { value: O.volSteps },
    uSigma: { value: O.volSigma },
    uStrength: { value: plan.strength },
    uJitter: { value: O.volJitter ? -1 : 0.5 },
    uContrast: { value: new THREE.Vector2(...O.volContrast) },
    uLight: { value: variation.light },
    uLightStep: { value: O.volLightStep },
    uShadow: { value: O.volShadow },
    uAmbient: { value: O.volAmbient },
    uFar: { value: O.volFar },
    uNear: { value: new THREE.Vector2(...O.volNear) },
    uFarFade: { value: new THREE.Vector2(...O.volFarFade) },
    uEnvK: variation.uEnvK, uEnvP: variation.uEnvP, uEnvA: variation.uEnvA, uEnvSwing: variation.uEnvSwing,
    uDriftK: variation.uDriftK, uDriftP: variation.uDriftP, uDriftA: variation.uDriftA,
    uDetail: { value: O.volDetailHi ? detailTextureHi() : detailTexture() },
    uFrameJit: { value: 0 },
    uDetailAmt: { value: O.volDetail },
    uDetailFreq: { value: new THREE.Vector3(1 / O.volDetailSize, 1 / O.volDetailSize, Math.max(1, Math.round(L / O.volDetailSize)) / L) }
  };
  // The site's shader text is exactly what it was; only a stock render's differs.
  const stock = float || O.volSteps > 160;
  const marchFrag = MARCH_FRAG.replace('SPACE_GLSL_HERE', space.SPACE_GLSL)
    .replace('MAX_STEPS_HERE', String(Math.max(160, Math.ceil(O.volSteps))))
    .replace('JITTER_HERE', stock ? 'jit = fract(jit + uFrameJit);' : '')
    .replace('uniform float uJitter;', stock ? 'uniform float uJitter;\n  uniform float uFrameJit;' : 'uniform float uJitter;');
  if (blender) {
    Object.assign(uniforms, {
      uDustSigma: { value: O.dustSigma ?? 45 },
      uGasSigma: { value: O.gasSigma ?? 0.015 },
      uGasGain: { value: (O.gasGain ?? 6) * plan.strength },
      uDustEdge: { value: O.dustEdge ?? 0.004 },
      uThreshold: { value: O.threshold ?? 0 },
      uAxisClear: { value: new THREE.Vector2(...(O.axisClear ?? [10, 35])) },
      uGasBody: { value: O.gasBody ?? 0 },
      uKnots: { value: new Array(33).fill(0) },
      uCurveOn: { value: 0 },
      uHue: { value: new THREE.Vector4(makeRng(`${seed}-nebula3d-hue`)(), O.hueDensity ?? 2.5, O.hueDepth ?? 3, O.hueAngle ?? 1) }
    });
  }
  const mat = space.passMaterial(
    blender
      ? BLENDER_MARCH_FRAG.replace('MAX_STEPS_HERE', String(Math.max(160, Math.ceil(O.volSteps))))
      : marchFrag,
    uniforms
  );
  const scene = new THREE.Scene();
  scene.add(quad(mat));
  // The site's tone curve for the recipe (see hisCurve in BLENDER_MARCH_FRAG): the raw gas
  // brightness, marched small at eight points around the loop, gives the knots -- once per flight, so
  // the mapping is the same in every frame. Only gas counts: empty space stays empty.
  // Everything the measurement reads is pinned -- depth, jitter, and the lens at its resting field of
  // view (2026-11-22): it used to take whatever field of view the FIRST drawn frame had, and the ramp
  // widens it by up to 14 degrees mid-cycle, so a render started mid-loop (a preview frame, a cover,
  // a stock render rebuilt after a GPU reset) got a different curve from one started at the seam --
  // measured 1.2/255 mean, 15 max across the whole frame. A render from frame 0 starts at the seam,
  // where the boost is zero, so those are unchanged.
  let curveReady = false;
  function sampleCurve(renderer, aspect) {
    curveReady = true;
    const W = 192, H = 108;
    const rtS = new THREE.WebGLRenderTarget(W, H, { type: THREE.FloatType });
    const px = new Float32Array(W * H * 4);
    const camZ = uniforms.uCamZ.value, jit = uniforms.uFrameJit.value;
    const tanPrev = uniforms.uTan.value.clone();
    if (space.lensFov) {
      const t = Math.tan((space.lensFov * Math.PI) / 360);
      uniforms.uTan.value.set(t * aspect, t);
    }
    const prev = renderer.getRenderTarget();
    const vals = [];
    for (let k = 0; k < 8; k++) {
      uniforms.uCamZ.value = ((k + 0.37) / 8) * L;
      uniforms.uFrameJit.value = k / 8;
      renderer.setRenderTarget(rtS);
      renderer.render(scene, space.orthoCam);
      renderer.readRenderTargetPixels(rtS, 0, 0, W, H, px);
      for (let i = 3; i < px.length; i += 4) if (px[i] > 1e-4) vals.push(px[i]);
    }
    renderer.setRenderTarget(prev);
    rtS.dispose();
    uniforms.uCamZ.value = camZ;
    uniforms.uFrameJit.value = jit;
    uniforms.uTan.value.copy(tanPrev);
    if (vals.length < 100) return; // next to no gas: leave the raw brightness
    uniforms.uKnots.value = hisCurveKnots(vals);
    uniforms.uCurveOn.value = 1;
  }
  let low = null;
  const upU = { uSrc: { value: null }, uTexel: { value: new THREE.Vector2() } };
  const upScene = new THREE.Scene();
  upScene.add(quad(space.passMaterial('varying vec2 vUv; uniform sampler2D uSrc; uniform vec2 uTexel; void main() { vec4 c = texture2D(uSrc, vUv) * 0.4; c += (texture2D(uSrc, vUv + vec2(uTexel.x, 0.0)) + texture2D(uSrc, vUv - vec2(uTexel.x, 0.0)) + texture2D(uSrc, vUv + vec2(0.0, uTexel.y)) + texture2D(uSrc, vUv - vec2(0.0, uTexel.y))) * 0.15; gl_FragColor = c; }', upU)));
  return {
    bake,
    async locate() {
      await fillDetailAsync();
      if (!located) {
        const loc = await placementAsync(seed, plan.cover);
        if (!located) locate(loc);
      }
    },
    // Compiles the volume's shaders without blocking where the browser can (KHR_parallel_shader_compile,
    // via three's compileAsync; Firefox cannot). The bake shader is the whole 2D recipe: compiled on
    // first use it was a ~400ms stall, once per visit.
    compile(renderer) {
      return compileInto(renderer, rt, [bakeScene, scene, upScene], space.orthoCam);
    },
    update(camZ) {
      uniforms.uCamZ.value = camZ;
    },
    setFrameJitter(j) {
      uniforms.uFrameJit.value = j;
    },
    draw(renderer, camera, target) {
      bake(renderer); // a caller that never prepared gets the whole bake here, once
      const tan = Math.tan((camera.fov * Math.PI) / 360);
      uniforms.uTan.value.set(tan * camera.aspect, tan);
      if (blender && O.siteCurve && !curveReady) sampleCurve(renderer, camera.aspect);
      // At full resolution (a stock render) the march draws straight into the layer: the upscale's
      // small blur exists only to hide a half-resolution march.
      if (O.volRes >= 1) {
        renderer.setRenderTarget(target);
        renderer.render(scene, space.orthoCam);
        return;
      }
      // march at reduced resolution, then upscale into the layer target
      const w = Math.max(1, Math.round(target.width * O.volRes)), h = Math.max(1, Math.round(target.height * O.volRes));
      if (!low) low = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType });
      if (low.width !== w || low.height !== h) low.setSize(w, h);
      renderer.setRenderTarget(low);
      renderer.render(scene, space.orthoCam);
      upU.uSrc.value = low.texture;
      upU.uTexel.value.set(1 / w, 1 / h);
      renderer.setRenderTarget(target);
      renderer.render(upScene, space.orthoCam);
    },
    // (its materials are createNebula3d's to retire)
    dispose() {
      rt.dispose();
      low?.dispose();
    }
  };
}

// ─── Colour + pools: the 2D rule, in screen space ─────────────────────────────────────
const POOL_FRAG = /* glsl */ `
  varying vec2 vUv;
  uniform sampler2D uSrc;
  uniform vec2 uDir;
  void main() {
    // 9-tap gaussian along uDir (in UV units per tap)
    float w[5]; w[0] = 0.2270; w[1] = 0.1946; w[2] = 0.1216; w[3] = 0.0541; w[4] = 0.0162;
    float a = texture2D(uSrc, vUv).a * w[0];
    for (int i = 1; i < 5; i++) {
      a += texture2D(uSrc, vUv + uDir * float(i)).a * w[i];
      a += texture2D(uSrc, vUv - uDir * float(i)).a * w[i];
    }
    gl_FragColor = vec4(a);
  }
`;
const NEB_COMP_FRAG = /* glsl */ `
  varying vec2 vUv;
  uniform sampler2D uBack;
  uniform sampler2D uLayer;
  uniform sampler2D uPool;
  uniform float uPools;
  uniform float uPoolGain;
  uniform float uDebug;
  // The Blender recipe's dust (the layer's red; uDust = 1 for that recipe): how far it darkens what is behind it
  uniform float uDust;
  uniform float uDustDark;
  // How the dust darkens (2026-11-21, Aaron: black dust "takes it out of the composition"):
  // 0 toward black; 1 toward a deep shade of the nebula's own gradient; 2 through the gradient's
  // colour (a coloured filter); 3 a rich shadow -- lower perceptual lightness, saturation kept and
  // raised, so the dust is the backdrop's own hue, deeper.
  uniform int uDustMode;
  uniform float uDustTone;
  uniform float uDustLight;  // mode 3: how much lightness the dust takes away
  uniform float uDustChroma; // mode 3: its saturation, relative (1 = unchanged)
  // The gas's colour (Blender recipe): 0 the screen-space gradient, as every nebula is painted; 1 the
  // palette position the march carried (layer green) -- each filament its own colour. uGasChroma
  // scales its saturation (OKLab chroma).
  uniform float uPaletteMix;
  uniform float uGasChroma;
  vec3 srgbToLin(vec3 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c)); }
  vec3 linToSrgb(vec3 c) { c = max(c, 0.0); return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
  vec3 toOklab(vec3 c) {
    vec3 l = srgbToLin(c);
    vec3 lms = vec3(0.4122214708 * l.r + 0.5363325363 * l.g + 0.0514459929 * l.b,
                    0.2119034982 * l.r + 0.6806995451 * l.g + 0.1073969566 * l.b,
                    0.0883024619 * l.r + 0.2817188376 * l.g + 0.6299787005 * l.b);
    lms = pow(max(lms, 0.0), vec3(1.0 / 3.0));
    return vec3(0.2104542553 * lms.x + 0.7936177850 * lms.y - 0.0040720468 * lms.z,
                1.9779984951 * lms.x - 2.4285922050 * lms.y + 0.4505937099 * lms.z,
                0.0259040371 * lms.x + 0.7827717662 * lms.y - 0.8086757660 * lms.z);
  }
  vec3 fromOklab(vec3 o) {
    vec3 lms = vec3(o.x + 0.3963377774 * o.y + 0.2158037573 * o.z,
                    o.x - 0.1055613458 * o.y - 0.0638541728 * o.z,
                    o.x - 0.0894841775 * o.y - 1.2914855480 * o.z);
    lms = lms * lms * lms;
    return linToSrgb(vec3(4.0767416621 * lms.x - 3.3077115913 * lms.y + 0.2309699292 * lms.z,
                         -1.2684380046 * lms.x + 2.6097574011 * lms.y - 0.3413193965 * lms.z,
                         -0.0041960771 * lms.x - 0.7034186147 * lms.y + 1.7076147010 * lms.z));
  }
  vec3 dustOver(vec3 cb, float d, vec3 grad) {
    if (uDustMode == 1) return mix(cb, grad * uDustTone, d);
    if (uDustMode == 2) return mix(cb, cb * mix(vec3(1.0), grad, 0.85) * (1.0 - 0.35 * d), d);
    if (uDustMode == 3) {
      vec3 o = toOklab(cb);
      o.x *= 1.0 - uDustLight * d;
      o.yz *= mix(1.0, uDustChroma, d);
      return clamp(fromOklab(o), 0.0, 1.0);
    }
    return cb * (1.0 - d);
  }
  GRADIENT_FN_HERE
  // the gradient's stops along x in 0..1, ignoring where it lies on screen
  vec3 paletteAt(float x) {
    float y = clamp(x, 0.0, 1.0) * max(uCount - 1.0, 0.0);
    vec3 col = uStops[0];
    for (int i = 1; i < 6; i++) {
      if (float(i) >= uCount) break;
      col = mix(col, uStops[i], clamp(y - float(i - 1), 0.0, 1.0));
    }
    return col;
  }
  void main() {
    vec3 cb = texture2D(uBack, vUv).rgb;
    float a = texture2D(uLayer, vUv).a;
    if (uPools > 0.0) a = max(a, min(1.0, texture2D(uPool, vUv).a * uPoolGain) * uPools);
    if (uDust > 0.5) cb = dustOver(cb, uDustDark * clamp(texture2D(uLayer, vUv).r, 0.0, 1.0), gradientAt(vUv));
    if (uDebug > 0.5) { gl_FragColor = vec4(vec3(clamp(a, 0.0, 1.0)), 1.0); return; }
    vec3 gas = gradientAt(vUv);
    if (uPaletteMix > 0.0) gas = mix(gas, paletteAt(texture2D(uLayer, vUv).g), uPaletteMix);
    if (uGasChroma != 1.0) { vec3 o = toOklab(gas); o.yz *= uGasChroma; gas = clamp(fromOklab(o), 0.0, 1.0); }
    gl_FragColor = vec4(mix(cb, gas, clamp(a, 0.0, 1.0)), 1.0);
  }
`;

export function createNebula3d({ mode, seed, art, L, frameH, space, gradientUniforms, gradientFn, overrides = null, float = false }) {
  readOpts();
  const O = { ...NEB3D, ...(overrides || {}) };
  let plan = art.nebulaConfig;
  // A stock render can give a design that rolled no nebula one anyway (O.forceNebula, its strength),
  // coloured the way the design would have been.
  if ((!plan || !plan.strength) && O.forceNebula) plan = { ...(plan || {}), cover: 0.3, strength: O.forceNebula, colour: nebulaColour(art, false) };
  if (!plan || !plan.strength) return null;
  // Every material goes through quad(), so dispose() can retire them all (see RETIRED); the
  // scene's own screenQuad would dispose them with the flight.
  const materials = [];
  const quadGeo = new THREE.PlaneGeometry(2, 2);
  const quad = m => {
    materials.push(m);
    const mesh = new THREE.Mesh(quadGeo, m);
    mesh.frustumCulled = false;
    return mesh;
  };
  let owner = null; // the renderer this nebula compiled with
  let settled = false; // the previous nebula's materials released
  const settle = renderer => {
    owner = renderer;
    if (settled) return;
    settled = true;
    releaseRetired(renderer);
  };
  const neb = buildVolume({ seed, plan, L, frameH, space, quad, O, float });
  const own = plan.colour?.mode === 'own';
  const gu = gradientUniforms(plan.colour?.gradient || art.starFieldConfig.gradientConfig);
  gu.uView.value = space.view;
  const layer = new THREE.WebGLRenderTarget(1, 1, float ? { type: THREE.HalfFloatType } : {});
  const poolA = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType });
  const poolB = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType });
  const poolU = { uSrc: { value: null }, uDir: { value: new THREE.Vector2() } };
  const poolScene = new THREE.Scene();
  poolScene.add(quad(space.passMaterial(POOL_FRAG, poolU)));
  const compU = {
    ...gu,
    uBack: { value: null },
    uLayer: { value: layer.texture },
    uPool: { value: poolB.texture },
    uPools: { value: own ? O.pools : 0 },
    uPoolGain: { value: O.poolGain },
    uDebug: { value: O.debugView ? 1 : 0 },
    uDust: { value: O.recipe === 'blender' ? 1 : 0 },
    uDustDark: { value: O.dustDark ?? 0.6 },
    uDustMode: { value: O.dustMode ?? 0 },
    uDustTone: { value: O.dustTone ?? 0.35 },
    uDustLight: { value: O.dustLight ?? 0.75 },
    uDustChroma: { value: O.dustChroma ?? 1.6 },
    uPaletteMix: { value: O.recipe === 'blender' ? O.paletteMix ?? 0 : 0 },
    uGasChroma: { value: O.gasChroma ?? 1 }
  };
  let disposed = false;
  let marched = false; // whether `layer` holds a march (render's `reuse`)
  const compScene = new THREE.Scene();
  compScene.add(quad(space.passMaterial(NEB_COMP_FRAG.replace('GRADIENT_FN_HERE', gradientFn), compU)));
  return {
    mode,
    debugOnly: O.debugView,
    update: neb.update,
    setFrameJitter: neb.setFrameJitter,
    // Bakes the volume a few ms at a time, yielding between chunks, so building a flight never
    // holds the main thread for long. Resolves when done (or when disposed first).
    // Every shader is compiled here, the pools' too (cheap, and kept for the next design that
    // has them), so none compiles on the flight's first visible frame.
    async prepare(renderer) {
      owner = renderer;
      await neb.locate();
      if (disposed) return;
      await Promise.all([neb.compile(renderer), compileInto(renderer, layer, [poolScene, compScene], space.orthoCam)]);
      if (disposed) return;
      settle(renderer);
      while (!disposed && !neb.bake(renderer, Infinity, true)) await new Promise(r => setTimeout(r, 0));
    },
    // Draws the nebula onto `back` (the frame so far), writing the result into `out`.
    // `reuse` composites the layer the previous call marched instead of marching again (the stock
    // shutter's nebula passes: the march is most of a stock frame's GPU time, and within one
    // shutter the volume barely moves). Ignored until a layer of this size exists.
    render(renderer, camera, back, out, reuse = false) {
      if (!settled) owner = renderer; // a caller that never prepared settles after this draw
      if (layer.width !== back.width || layer.height !== back.height) {
        layer.setSize(back.width, back.height);
        marched = false;
      }
      if (!(reuse && marched)) march(renderer, camera, back);
      compU.uBack.value = back.texture;
      renderer.setRenderTarget(out);
      renderer.render(compScene, space.orthoCam);
      if (!settled) settle(renderer);
    },
    dispose() {
      disposed = true;
      neb.dispose();
      layer.dispose();
      poolA.dispose();
      poolB.dispose();
      quadGeo.dispose();
      retire(owner, materials);
    }
  };
  // The march (into `layer`) and the pools derived from it.
  function march(renderer, camera, back) {
    marched = true;
    neb.draw(renderer, camera, layer);
    if (own) {
      // pools: a blur of the layer at 1/8 resolution, ~1/24 of the long edge, as in 2D
      const pw = Math.max(1, Math.round(back.width / 8)), ph = Math.max(1, Math.round(back.height / 8));
      for (const t of [poolA, poolB]) if (t.width !== pw || t.height !== ph) t.setSize(pw, ph);
      const r = Math.max(pw, ph) / 24 / 4; // taps reach 4 * step
      poolU.uSrc.value = layer.texture;
      poolU.uDir.value.set(r / pw, 0);
      renderer.setRenderTarget(poolA);
      renderer.render(poolScene, space.orthoCam);
      poolU.uSrc.value = poolA.texture;
      poolU.uDir.value.set(0, r / ph);
      renderer.setRenderTarget(poolB);
      renderer.render(poolScene, space.orthoCam);
    }
  }
}
