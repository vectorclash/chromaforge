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
import { placement, placementAsync, askNebulaWorker, hisCurveKnots, ALPHAQ } from '../render/nebula';
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
    for (int i = 0; i < 160; i++) {
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

function buildVolume({ seed, plan, L, frameH, space }) {
  const s = UNITS_PER_SHORT_EDGE / frameH;
  const NX = NEB3D.volLateral, R = NEB3D.volRadius;
  const NZ = Math.max(32, Math.round(L / NEB3D.volStep));
  const seam = 0.2; // the last 20% of the loop crossfades into the slices before its start
  // depth can run slower through the field than across it (volStretch, 1 = isotropic)
  const sz = s / NEB3D.volStretch;
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
      const f = nebulaFieldGpu([loc[0], loc[1] + z * sz, loc[2]], 48, 48, NEB3D.volOct, span, [0, z * sz, 0]);
      if (!f) throw new Error('nebula3d volume needs WebGL2');
      for (const v of f) sample.push(v);
    }
    // (The bake below puts depth into dir.y rather than loc.y + uViewOff: the same sums, since the
    // recipe sees base = loc + dir and the view terms see dir + uViewOff.)
    bakeU.uLoc.value.set(loc[0], loc[1], loc[2]);
    bakeU.uKnots.value = hisCurveKnots(sample);
    located = true;
  }

  const rt = new THREE.WebGL3DRenderTarget(NX, NX, NZ, { format: THREE.RedFormat, type: THREE.UnsignedByteType, depthBuffer: false });
  rt.texture.minFilter = THREE.LinearFilter;
  rt.texture.magFilter = THREE.LinearFilter;
  rt.texture.wrapR = THREE.RepeatWrapping;
  const bakeU = {
    uLoc: { value: new THREE.Vector3() },
    uOct: { value: NEB3D.volOct },
    uViewOff: { value: new THREE.Vector3(0, 0, 0) },
    uRes: { value: NX },
    uSpan: { value: span },
    uDepthA: { value: 0 },
    uDepthB: { value: 0 },
    uSeamW: { value: 0 },
    uKnots: { value: new Array(33).fill(0) }
  };
  const bakeMat = new THREE.ShaderMaterial({
    vertexShader: 'void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: BAKE_FRAG,
    uniforms: bakeU,
    depthTest: false,
    depthWrite: false
  });
  const bakeScene = new THREE.Scene();
  const bakeQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), bakeMat);
  bakeQuad.frustumCulled = false;
  bakeScene.add(bakeQuad);
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
        bakeU.uDepthA.value = z * sz;
        bakeU.uDepthB.value = (z - L) * sz;
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
    uEnvSwing: { value: NEB3D.volEnvSwing },
    uDriftK: { value: new THREE.Vector2(cyc(900), cyc(700)) },
    uDriftP: { value: new THREE.Vector2(vr() * 6.283, vr() * 6.283) },
    uDriftA: { value: NEB3D.volDrift }
  };
  const uniforms = {
    uVol: { value: tex },
    uTan: { value: new THREE.Vector2(1, 1) },
    uCamZ: { value: 0 },
    uL: { value: L },
    uR: { value: R },
    uSteps: { value: NEB3D.volSteps },
    uSigma: { value: NEB3D.volSigma },
    uStrength: { value: plan.strength },
    uJitter: { value: NEB3D.volJitter ? -1 : 0.5 },
    uContrast: { value: new THREE.Vector2(...NEB3D.volContrast) },
    uLight: { value: variation.light },
    uLightStep: { value: NEB3D.volLightStep },
    uShadow: { value: NEB3D.volShadow },
    uAmbient: { value: NEB3D.volAmbient },
    uFar: { value: NEB3D.volFar },
    uNear: { value: new THREE.Vector2(...NEB3D.volNear) },
    uFarFade: { value: new THREE.Vector2(...NEB3D.volFarFade) },
    uEnvK: variation.uEnvK, uEnvP: variation.uEnvP, uEnvA: variation.uEnvA, uEnvSwing: variation.uEnvSwing,
    uDriftK: variation.uDriftK, uDriftP: variation.uDriftP, uDriftA: variation.uDriftA,
    uDetail: { value: detailTexture() },
    uDetailAmt: { value: NEB3D.volDetail },
    uDetailFreq: { value: new THREE.Vector3(1 / NEB3D.volDetailSize, 1 / NEB3D.volDetailSize, Math.max(1, Math.round(L / NEB3D.volDetailSize)) / L) }
  };
  const mat = space.passMaterial(MARCH_FRAG.replace('SPACE_GLSL_HERE', space.SPACE_GLSL), uniforms);
  const scene = new THREE.Scene();
  scene.add(space.screenQuad(mat));
  let low = null;
  const upU = { uSrc: { value: null }, uTexel: { value: new THREE.Vector2() } };
  const upScene = new THREE.Scene();
  upScene.add(space.screenQuad(space.passMaterial('varying vec2 vUv; uniform sampler2D uSrc; uniform vec2 uTexel; void main() { vec4 c = texture2D(uSrc, vUv) * 0.4; c += (texture2D(uSrc, vUv + vec2(uTexel.x, 0.0)) + texture2D(uSrc, vUv - vec2(uTexel.x, 0.0)) + texture2D(uSrc, vUv + vec2(0.0, uTexel.y)) + texture2D(uSrc, vUv - vec2(0.0, uTexel.y))) * 0.15; gl_FragColor = c; }', upU)));
  return {
    bake,
    async locate() {
      await fillDetailAsync();
      if (!located) {
        const loc = await placementAsync(seed, plan.cover);
        if (!located) locate(loc);
      }
    },
    // Compiles both shaders without blocking (KHR_parallel_shader_compile, via three's
    // compileAsync). The bake shader is the whole 2D recipe: compiled on first use it was a ~400ms
    // stall, once per visit.
    compile(renderer) {
      return Promise.all([renderer.compileAsync(bakeScene, space.orthoCam), renderer.compileAsync(scene, space.orthoCam)]);
    },
    update(camZ) {
      uniforms.uCamZ.value = camZ;
    },
    draw(renderer, camera, target) {
      bake(renderer); // a caller that never prepared gets the whole bake here, once
      const tan = Math.tan((camera.fov * Math.PI) / 360);
      uniforms.uTan.value.set(tan * camera.aspect, tan);
      // march at reduced resolution, then upscale into the layer target
      const w = Math.max(1, Math.round(target.width * NEB3D.volRes)), h = Math.max(1, Math.round(target.height * NEB3D.volRes));
      if (!low) low = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType });
      if (low.width !== w || low.height !== h) low.setSize(w, h);
      renderer.setRenderTarget(low);
      renderer.render(scene, space.orthoCam);
      upU.uSrc.value = low.texture;
      upU.uTexel.value.set(1 / w, 1 / h);
      renderer.setRenderTarget(target);
      renderer.render(upScene, space.orthoCam);
    },
    dispose() {
      mat.dispose();
      rt.dispose();
      bakeMat.dispose();
      bakeQuad.geometry.dispose();
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
  GRADIENT_FN_HERE
  void main() {
    vec3 cb = texture2D(uBack, vUv).rgb;
    float a = texture2D(uLayer, vUv).a;
    if (uPools > 0.0) a = max(a, min(1.0, texture2D(uPool, vUv).a * uPoolGain) * uPools);
    if (uDebug > 0.5) { gl_FragColor = vec4(vec3(clamp(a, 0.0, 1.0)), 1.0); return; }
    gl_FragColor = vec4(mix(cb, gradientAt(vUv), clamp(a, 0.0, 1.0)), 1.0);
  }
`;

export function createNebula3d({ mode, seed, art, L, frameH, space, gradientUniforms, gradientFn }) {
  readOpts();
  const plan = art.nebulaConfig;
  if (!plan || !plan.strength) return null;
  const neb = buildVolume({ seed, plan, L, frameH, space });
  const own = plan.colour?.mode === 'own';
  const gu = gradientUniforms(plan.colour?.gradient || art.starFieldConfig.gradientConfig);
  gu.uView.value = space.view;
  const layer = new THREE.WebGLRenderTarget(1, 1);
  const poolA = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType });
  const poolB = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType });
  const poolU = { uSrc: { value: null }, uDir: { value: new THREE.Vector2() } };
  const poolScene = new THREE.Scene();
  poolScene.add(space.screenQuad(space.passMaterial(POOL_FRAG, poolU)));
  const compU = {
    ...gu,
    uBack: { value: null },
    uLayer: { value: layer.texture },
    uPool: { value: poolB.texture },
    uPools: { value: own ? NEB3D.pools : 0 },
    uPoolGain: { value: NEB3D.poolGain },
    uDebug: { value: NEB3D.debugView ? 1 : 0 }
  };
  let disposed = false;
  const compScene = new THREE.Scene();
  compScene.add(space.screenQuad(space.passMaterial(NEB_COMP_FRAG.replace('GRADIENT_FN_HERE', gradientFn), compU)));
  return {
    mode,
    debugOnly: NEB3D.debugView,
    update: neb.update,
    // Bakes the volume a few ms at a time, yielding between chunks, so building a flight never
    // holds the main thread for long. Resolves when done (or when disposed first).
    async prepare(renderer) {
      await neb.locate();
      if (disposed) return;
      await neb.compile(renderer);
      while (!disposed && !neb.bake(renderer, Infinity, true)) await new Promise(r => setTimeout(r, 0));
    },
    // Draws the nebula onto `back` (the frame so far), writing the result into `out`.
    render(renderer, camera, back, out) {
      if (layer.width !== back.width || layer.height !== back.height) layer.setSize(back.width, back.height);
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
      compU.uBack.value = back.texture;
      renderer.setRenderTarget(out);
      renderer.render(compScene, space.orthoCam);
    },
    dispose() {
      disposed = true;
      neb.dispose();
      layer.dispose();
      poolA.dispose();
      poolB.dispose();
    }
  };
}
