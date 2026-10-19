// LAB (branch nebula-gpu-lab, dev only): the 2D nebula, given depth in the 3D flight. It takes the
// radial field's slot, as the nebula does in 2D. Two techniques, switched with
// localStorage 'cf-lab:nebula3d' = 'sheets' | 'volume' (anything else: the old radial blobs).
//
// The premise both share: the 2D nebula is already a flat SLICE through a 3D noise field (the
// recipe samples loc + (x, 1, y) -- noise x = screen right, noise y = depth, noise z = screen up).
// So "the nebula in 3D" is the same field sampled with depth, not a new nebula. World units map
// to noise units at the 2D framing: the 2D frame's short edge (FRAME_H world units at FRAME_D) is
// UNITS_PER_SHORT_EDGE noise units.
//
//   sheets -- translucent slices of that field at their own depths, flown through with parallax
//             and the scene's warp and haze. A few textures, a few quads: phone-safe.
//   volume -- the field's coarse structure baked once into a 3D texture around the flight axis,
//             periodic along the loop, plus a small tiling detail noise for fine edges, ray-marched
//             per pixel. Real depth; the cost is the bake and the march.
//
// Both draw alpha only. Colour is the 2D rule, applied in screen space: the nebula's own gradient
// (plus colour pools, a blur of the layer) or the star field's gradient, from art.nebulaConfig.
import * as THREE from 'three';
import { nebulaFieldGpu } from '../render/nebulaGpu';
import { nebula2dRows, UNITS_PER_SHORT_EDGE } from '../render/nebula2dCpu';
import { placement, hisCurveKnots, applyHisCurve } from '../render/nebula';

export function nebula3dMode() {
  if (typeof window === 'undefined' || !import.meta.env?.DEV) return null;
  try {
    const q = new URLSearchParams(window.location.search).get('nebula3d');
    if (q) localStorage.setItem('cf-lab:nebula3d', q);
    const m = localStorage.getItem('cf-lab:nebula3d');
    return m === 'sheets' || m === 'volume' ? m : null;
  } catch {
    return null;
  }
}
// Lab tuning without a rebuild: localStorage 'cf-lab:nebula3d-opts' = JSON over these.
export const NEB3D = {
  sheetSpacing: 30, // world units between sheets
  sheetUnique: 8, // distinct slices, reused along the flight
  sheetAlpha: 0.45, // per sheet, before the amount strength
  sheetScale: 2.2, // sheet size against the 2D frame at FRAME_D
  volRadius: 150, // corridor radius, world units
  volLateral: 192, // voxels across
  volStep: 5, // world units per voxel along the flight
  volSteps: 96, // ray-march samples per pixel
  volSigma: 1.5, // extinction per world unit at full density
  volLight: [-0.3, 0.6, 0.75], // toward the light: right, up, ahead
  volLightStep: 6,
  volShadow: 0.8,
  volAmbient: 0.25,
  volFar: 420,
  volJitter: true, // per-pixel sample offsets
  volStretch: 1,
  volNear: [12, 55], // close gas dissolves before it reaches the camera, where its cells would magnify into smears // how many times slower the field changes along the flight than across it
  volOct: 6, // octaves baked into the grid -- no more than its slice spacing can hold
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

// The GPU field if it can, else the CPU one (same field to within 1/255).
function field(loc, w, h, oct, units) {
  const g = nebulaFieldGpu(loc, w, h, oct, units);
  if (g) return g;
  const out = new Float32Array(w * h);
  // nebula2dRows has no units parameter; a different span is a different loc spacing, which
  // only the GPU path needs in the lab
  return nebula2dRows(loc, w, h, oct, 0, h, out);
}

// ─── Sheets ───────────────────────────────────────────────────────────────────────────
const SHEET_VERT = /* glsl */ `
  attribute vec2 aUv;
  attribute float aLayer;
  attribute float aA;
  varying vec2 vUv;
  varying float vLayer;
  varying float vA;
  void main() {
    vUv = aUv; vLayer = aLayer; vA = aA;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const SHEET_FRAG = /* glsl */ `
  precision highp sampler2DArray;
  uniform sampler2DArray uTex;
  varying vec2 vUv;
  varying float vLayer;
  varying float vA;
  void main() {
    vec2 c = vUv * 2.0 - 1.0;
    // soft elliptical edge, so no sheet ever shows a rectangle
    float edge = 1.0 - smoothstep(0.55, 1.0, length(c));
    float a = texture(uTex, vec3(vUv, vLayer)).r * edge * vA;
    if (a < 0.002) discard;
    gl_FragColor = vec4(a, a, a, a); // premultiplied white
  }
`;

function buildSheets({ seed, plan, L, frameH, space }) {
  const { warpW, haze, VIEW_FAR, BEHIND } = space;
  const loc = placement(seed, plan.cover);
  const W = 768, H = 432;
  const s = UNITS_PER_SHORT_EDGE / frameH; // noise units per world unit
  const worldH = frameH * NEB3D.sheetScale, worldW = (worldH * W) / H;
  const units = worldH * s;
  const U = NEB3D.sheetUnique;
  const data = new Uint8Array(W * H * U);
  const fields = [];
  for (let k = 0; k < U; k++) {
    // slices through the field's own depth axis, spaced as the sheets themselves will be
    fields.push(field([loc[0], loc[1] + k * NEB3D.sheetSpacing * s, loc[2]], W, H, 8, units));
  }
  const knots = hisCurveKnots(fields[Math.floor(U / 2)]);
  fields.forEach((f, k) => {
    const a = applyHisCurve(f, knots);
    for (let i = 0; i < a.length; i++) data[k * W * H + i] = Math.round(a[i] * 255);
  });
  const tex = new THREE.DataArrayTexture(data, W, H, U);
  tex.format = THREE.RedFormat;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.flipY = false;
  tex.needsUpdate = true;

  const n = Math.max(U, Math.round(L / NEB3D.sheetSpacing));
  const sheets = Array.from({ length: n }, (_, i) => ({ z: (i / n) * L, layer: i % U }));
  const positions = new Float32Array(n * 4 * 3);
  const uv = new Float32Array(n * 4 * 2);
  const layer = new Float32Array(n * 4);
  const alpha = new Float32Array(n * 4);
  const index = new Uint32Array(n * 6);
  const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
  sheets.forEach((sh, i) => {
    for (let c = 0; c < 4; c++) {
      uv.set([(corners[c][0] + 1) / 2, (corners[c][1] + 1) / 2], (i * 4 + c) * 2);
      layer[i * 4 + c] = sh.layer;
    }
  });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage));
  geo.setAttribute('aUv', new THREE.BufferAttribute(uv, 2));
  geo.setAttribute('aLayer', new THREE.BufferAttribute(layer, 1));
  geo.setAttribute('aA', new THREE.BufferAttribute(alpha, 1).setUsage(THREE.DynamicDrawUsage));
  geo.setIndex(new THREE.BufferAttribute(index, 1).setUsage(THREE.DynamicDrawUsage));
  const mat = new THREE.ShaderMaterial({
    vertexShader: SHEET_VERT,
    fragmentShader: SHEET_FRAG,
    uniforms: { uTex: { value: tex } },
    transparent: true,
    depthTest: false,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.OneFactor,
    blendDstAlpha: THREE.OneMinusSrcAlphaFactor
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  const scene = new THREE.Scene();
  scene.add(mesh);

  const depth = new Float32Array(n);
  const order = [];
  function update(camZ) {
    order.length = 0;
    for (let i = 0; i < n; i++) {
      let dz = (((sheets[i].z - camZ) % L) + L) % L;
      if (dz > L - BEHIND) dz -= L;
      if (dz > VIEW_FAR || dz < 0.5) continue;
      const a = NEB3D.sheetAlpha * plan.strength * smooth(3, 45, dz) * haze(dz);
      if (a < 0.002) continue;
      depth[i] = dz;
      const w = warpW(dz);
      for (let c = 0; c < 4; c++) {
        const o = (i * 4 + c) * 3;
        positions[o] = corners[c][0] * (worldW / 2) * w;
        positions[o + 1] = corners[c][1] * (worldH / 2) * w;
        positions[o + 2] = camZ + dz;
        alpha[i * 4 + c] = a;
      }
      order.push(i);
    }
    order.sort((i, j) => depth[j] - depth[i]);
    for (let k = 0; k < order.length; k++) {
      const b = order[k] * 4;
      index.set([b, b + 1, b + 2, b, b + 2, b + 3], k * 6);
    }
    geo.setDrawRange(0, order.length * 6);
    geo.index.needsUpdate = true;
    geo.attributes.position.needsUpdate = true;
    geo.attributes.aA.needsUpdate = true;
  }
  return {
    update,
    draw(renderer, camera, target) {
      renderer.setRenderTarget(target);
      renderer.setClearColor(0x000000, 0);
      renderer.clear();
      renderer.render(scene, camera);
    },
    dispose() {
      geo.dispose();
      mat.dispose();
      tex.dispose();
    }
  };
}

// ─── Volume ───────────────────────────────────────────────────────────────────────────
// Fine detail: a tiling 3D Perlin fBm texture (gradient noise, integer lattice periods, so it
// wraps exactly), sampled continuously by the march. The baked grid can only hold detail its
// slice spacing can represent -- baked with all octaves, the fine ones aliased between slices into
// rows of 'scales' -- so it carries the large shapes and this carries the small ones.
let DETAIL = null;
function detailTexture() {
  if (DETAIL) return DETAIL;
  const N = 64;
  let h = 2166136261 >>> 0;
  const rand = () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507) >>> 0;
    h = Math.imul(h ^ (h >>> 13), 3266489909) >>> 0;
    h ^= h >>> 16;
    return h / 4294967296;
  };
  const MAXP = 32;
  const grads = new Float32Array(MAXP * MAXP * MAXP * 3);
  for (let i = 0; i < MAXP * MAXP * MAXP; i++) {
    const z = rand() * 2 - 1, a = rand() * Math.PI * 2, r = Math.sqrt(1 - z * z);
    grads.set([r * Math.cos(a), r * Math.sin(a), z], i * 3);
  }
  const fade = t => t * t * t * (t * (t * 6 - 15) + 10);
  const perlin = (x, y, z, P) => {
    const X = Math.floor(x), Y = Math.floor(y), Z = Math.floor(z);
    const fx = x - X, fy = y - Y, fz = z - Z;
    let out = 0;
    const u = fade(fx), v = fade(fy), w = fade(fz);
    for (let c = 0; c < 8; c++) {
      const dx = c & 1, dy = (c >> 1) & 1, dz = (c >> 2) & 1;
      const gi = ((((X + dx) % P) * MAXP + ((Y + dy) % P)) * MAXP + ((Z + dz) % P)) * 3;
      const dot = grads[gi] * (fx - dx) + grads[gi + 1] * (fy - dy) + grads[gi + 2] * (fz - dz);
      out += dot * (dx ? u : 1 - u) * (dy ? v : 1 - v) * (dz ? w : 1 - w);
    }
    return out;
  };
  const data = new Uint8Array(N * N * N);
  for (let z = 0; z < N; z++)
    for (let y = 0; y < N; y++)
      for (let x = 0; x < N; x++) {
        let sum = 0, amp = 1, norm = 0;
        for (let o = 0; o < 4; o++) {
          const P = 4 << o; // lattice cells across the tile: 4, 8, 16, 32
          sum += amp * perlin((x / N) * P, (y / N) * P, (z / N) * P, P);
          norm += amp;
          amp *= 0.5;
        }
        data[(z * N + y) * N + x] = Math.max(0, Math.min(255, Math.round((0.5 + (0.9 * sum) / norm) * 255)));
      }
  const tex = new THREE.Data3DTexture(data, N, N, N);
  tex.format = THREE.RedFormat;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = tex.wrapR = THREE.RepeatWrapping;
  tex.needsUpdate = true;
  DETAIL = tex;
  return tex;
}

// The volume is a CORRIDOR: gas fills a tube of radius volRadius around the flight path, on an even
// grid, fading out at the tube's wall; the sky shows beyond it, the way the plates and the cage
// frame the flight. Two wider-reaching grids were tried first and both failed in the same way: a
// fixed number of cells stretched over a huge (or infinite) extent made far cells enormous, and the
// far gas smeared into streaks pointing at the vanishing point.
function corridorSlice(loc, n, oct, units) {
  const f = nebulaFieldGpu(loc, n, n, oct, units);
  if (!f) throw new Error('nebula3d volume needs WebGL2');
  return f;
}

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
  uniform sampler3D uDetail;
  uniform float uDetailAmt;
  uniform vec3 uDetailFreq; // tiles per world unit: lateral, lateral, along the loop (whole tiles per L)
  SPACE_GLSL_HERE
  float dens(vec2 lat, float zw) {
    float wall = 1.0 - smoothstep(0.7, 1.0, length(lat) / uR);
    if (wall <= 0.0) return 0.0;
    vec3 g = vec3(0.5 + 0.5 * lat.x / uR, 0.5 - 0.5 * lat.y / uR, mod(zw, uL) / uL);
    float b = texture(uVol, g).r * wall;
    float det = texture(uDetail, vec3(lat, mod(zw, uL)) * uDetailFreq).r;
    // erode: detail pushes the field up and down around its own value, most at the edges
    b += uDetailAmt * (det - 0.5) * (1.0 - 0.6 * b);
    return smoothstep(uContrast.x, uContrast.y, b);
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
      d *= smoothstep(uNear.x, uNear.y, t) * haze(t);
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

function buildVolume({ seed, plan, L, frameH, space }) {
  const loc = placement(seed, plan.cover);
  const s = UNITS_PER_SHORT_EDGE / frameH;
  const NX = NEB3D.volLateral, R = NEB3D.volRadius;
  const NZ = Math.max(32, Math.round(L / NEB3D.volStep));
  const seam = 0.2; // the last 20% of the loop crossfades into the slices before its start
  const t0 = performance.now();
  const vol = new Float32Array(NX * NX * NZ);
  for (let k = 0; k < NZ; k++) {
    const z = (k / NZ) * L;
    // depth runs slower through the field than the lateral axes (volStretch): the recipe's strong
    // domain warp makes it change fast along every axis, and slices this far apart were otherwise
    // nearly unrelated, which their blend showed as rows of 'scales'
    const sz = s / NEB3D.volStretch;
    let f = corridorSlice([loc[0], loc[1] + z * sz, loc[2]], NX, NEB3D.volOct, 2 * R * s);
    const w = smooth(L * (1 - seam), L, z);
    if (w > 0) {
      const g = corridorSlice([loc[0], loc[1] + (z - L) * sz, loc[2]], NX, NEB3D.volOct, 2 * R * s);
      f = f.map((v, i) => v + (g[i] - v) * w);
    }
    vol.set(f, k * NX * NX);
  }
  const knots = hisCurveKnots(vol);
  const a = applyHisCurve(vol, knots);
  const data = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i++) data[i] = Math.round(a[i] * 255);
  const tex = new THREE.Data3DTexture(data, NX, NX, NZ);
  tex.format = THREE.RedFormat;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapR = THREE.RepeatWrapping;
  tex.needsUpdate = true;
  const bakeMs = Math.round(performance.now() - t0);
  console.info(`[nebula3d] volume ${NX}x${NX}x${NZ} baked in ${bakeMs}ms`);

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
    uLight: { value: new THREE.Vector3(...NEB3D.volLight).normalize() },
    uLightStep: { value: NEB3D.volLightStep },
    uShadow: { value: NEB3D.volShadow },
    uAmbient: { value: NEB3D.volAmbient },
    uFar: { value: NEB3D.volFar },
    uNear: { value: new THREE.Vector2(...NEB3D.volNear) },
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
    bakeMs,
    update(camZ) {
      uniforms.uCamZ.value = camZ;
    },
    draw(renderer, camera, target) {
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
      tex.dispose();
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
  const neb = mode === 'volume' ? buildVolume({ seed, plan, L, frameH, space }) : buildSheets({ seed, plan, L, frameH, space });
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
  const compScene = new THREE.Scene();
  compScene.add(space.screenQuad(space.passMaterial(NEB_COMP_FRAG.replace('GRADIENT_FN_HERE', gradientFn), compU)));
  return {
    mode,
    debugOnly: NEB3D.debugView,
    bakeMs: neb.bakeMs ?? 0,
    update: neb.update,
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
      neb.dispose();
      layer.dispose();
      poolA.dispose();
      poolB.dispose();
    }
  };
}
