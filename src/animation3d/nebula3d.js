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
  volRadius: 280, // world units either side of the flight axis the volume covers
  volLateral: 192, // voxels across
  volStep: 5, // world units per voxel along the flight
  volSteps: 48, // ray-march samples per pixel
  volSigma: 0.05, // extinction per world unit at full density
  volDetail: 0.8, // how much the detail noise erodes edges
  volDetailFreq: 0.08, // detail cycles per world unit
  volRes: 0.5, // march resolution against the frame
  volContrast: [0.25, 0.6], // density remap: smoothstep(lo, hi, d) -- sharper edges as the range narrows
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
// A tiling 3D value-noise fBm, for the detail that a coarse baked grid cannot hold.
let DETAIL = null;
function detailTexture() {
  if (DETAIL) return DETAIL;
  const N = 32, P = 8; // N voxels, lattice period P cells (tiles exactly)
  let h = 2166136261 >>> 0;
  const rnd = new Float32Array(P * P * P * 8);
  for (let i = 0; i < rnd.length; i++) {
    h = Math.imul(h ^ (i + 0x9e3779b9), 16777619) >>> 0;
    h ^= h >>> 13;
    rnd[i] = (h & 0xffff) / 0xffff;
  }
  const lat = (x, y, z, per, o) => rnd[o + ((x % per) * per * per + (y % per) * per + (z % per))];
  const vnoise = (x, y, z, per, o) => {
    const X = Math.floor(x), Y = Math.floor(y), Z = Math.floor(z);
    const fx = x - X, fy = y - Y, fz = z - Z;
    const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy), w = fz * fz * (3 - 2 * fz);
    const g = (a, b, c) => lat(X + a, Y + b, Z + c, per, o);
    const x00 = g(0, 0, 0) + (g(1, 0, 0) - g(0, 0, 0)) * u, x10 = g(0, 1, 0) + (g(1, 1, 0) - g(0, 1, 0)) * u;
    const x01 = g(0, 0, 1) + (g(1, 0, 1) - g(0, 0, 1)) * u, x11 = g(0, 1, 1) + (g(1, 1, 1) - g(0, 1, 1)) * u;
    const y0 = x00 + (x10 - x00) * v, y1 = x01 + (x11 - x01) * v;
    return y0 + (y1 - y0) * w;
  };
  const data = new Uint8Array(N * N * N);
  for (let z = 0; z < N; z++)
    for (let y = 0; y < N; y++)
      for (let x = 0; x < N; x++) {
        let sum = 0, amp = 0.5, norm = 0;
        for (let o = 0; o < 3; o++) {
          const per = P << o, f = per / N;
          sum += amp * vnoise(x * f, y * f, z * f, per, o * P * P * P);
          norm += amp;
          amp *= 0.5;
        }
        data[(z * N + y) * N + x] = Math.round((sum / norm) * 255);
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

const MARCH_FRAG = /* glsl */ `
  precision highp sampler3D;
  varying vec2 vUv;
  uniform sampler3D uVol;
  uniform sampler3D uDetail;
  uniform vec2 uTan;      // tan(fov/2) * aspect, tan(fov/2)
  uniform float uCamZ;
  uniform float uL;
  uniform float uR;
  uniform int uSteps;
  uniform float uSigma;
  uniform float uDetailAmt;
  uniform float uDetailFreq;
  uniform float uStrength;
  uniform float uJitter;
  uniform vec2 uContrast;
  SPACE_GLSL_HERE
  void main() {
    vec2 ndc = vUv * 2.0 - 1.0;
    vec2 ray = ndc * uTan;
    float T = 1.0;
    float tPrev = 1.5;
    // exponential steps from 1.5 to 400: fine near the camera, coarse where the warp has shrunk it
    for (int i = 0; i < 128; i++) {
      if (i >= uSteps || T < 0.01) break;
      float f = (float(i) + uJitter) / float(uSteps);
      float t = 1.5 * pow(400.0 / 1.5, f);
      float dt = t - tPrev; tPrev = t;
      vec2 lat = ray * t / warpW(t); // the real lateral position this pixel shows at depth t
      vec2 g = lat / (2.0 * uR) + 0.5;
      float edgeFade = smoothstep(0.0, 0.08, g.x) * smoothstep(1.0, 0.92, g.x) * smoothstep(0.0, 0.08, g.y) * smoothstep(1.0, 0.92, g.y);
      if (edgeFade <= 0.0) continue;
      float z = mod(uCamZ + t, uL);
      float d = texture(uVol, vec3(g, z / uL)).r;
      if (d <= 0.004) continue;
      float det = texture(uDetail, vec3(lat.x, lat.y, uCamZ + t) * uDetailFreq).r;
      d = clamp(d - uDetailAmt * det * (1.0 - d), 0.0, 1.0);
      d = smoothstep(uContrast.x, uContrast.y, d);
      d *= edgeFade * smoothstep(2.0, 25.0, t) * haze(t);
      float a = 1.0 - exp(-d * uSigma * dt);
      T *= 1.0 - a;
    }
    float A = (1.0 - T) * uStrength;
    gl_FragColor = vec4(A, A, A, A);
  }
`;

function buildVolume({ seed, plan, L, frameH, space }) {
  const loc = placement(seed, plan.cover);
  const s = UNITS_PER_SHORT_EDGE / frameH;
  const R = NEB3D.volRadius, NX = NEB3D.volLateral;
  const NZ = Math.max(32, Math.round(L / NEB3D.volStep));
  const units = 2 * R * s;
  const seam = 0.2; // the last 20% of the loop crossfades into the slices before its start
  const t0 = performance.now();
  const vol = new Float32Array(NX * NX * NZ);
  for (let k = 0; k < NZ; k++) {
    const z = (k / NZ) * L;
    let f = field([loc[0], loc[1] + z * s, loc[2]], NX, NX, 6, units);
    const w = smooth(L * (1 - seam), L, z);
    if (w > 0) {
      const g = field([loc[0], loc[1] + (z - L) * s, loc[2]], NX, NX, 6, units);
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
    uDetail: { value: detailTexture() },
    uTan: { value: new THREE.Vector2(1, 1) },
    uCamZ: { value: 0 },
    uL: { value: L },
    uR: { value: R },
    uSteps: { value: NEB3D.volSteps },
    uSigma: { value: NEB3D.volSigma },
    uDetailAmt: { value: NEB3D.volDetail },
    // a whole number of detail tiles per loop, so the detail is periodic in L like everything else
    uDetailFreq: { value: Math.max(1, Math.round(L * NEB3D.volDetailFreq)) / L },
    uStrength: { value: plan.strength },
    uJitter: { value: 0.5 },
    uContrast: { value: new THREE.Vector2(...NEB3D.volContrast) }
  };
  const mat = space.passMaterial(MARCH_FRAG.replace('SPACE_GLSL_HERE', space.SPACE_GLSL), uniforms);
  const scene = new THREE.Scene();
  scene.add(space.screenQuad(mat));
  let low = null;
  const upU = { uSrc: { value: null } };
  const upScene = new THREE.Scene();
  upScene.add(space.screenQuad(space.passMaterial('varying vec2 vUv; uniform sampler2D uSrc; void main() { gl_FragColor = texture2D(uSrc, vUv); }', upU)));
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
  GRADIENT_FN_HERE
  void main() {
    vec3 cb = texture2D(uBack, vUv).rgb;
    float a = texture2D(uLayer, vUv).a;
    if (uPools > 0.0) a = max(a, min(1.0, texture2D(uPool, vUv).a * uPoolGain) * uPools);
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
    uPoolGain: { value: NEB3D.poolGain }
  };
  const compScene = new THREE.Scene();
  compScene.add(space.screenQuad(space.passMaterial(NEB_COMP_FRAG.replace('GRADIENT_FN_HERE', gradientFn), compU)));
  return {
    mode,
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
