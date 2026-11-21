// Stock-video renders of the 3D flight (the ad builder's Flight mode; 2026-11-21, Aaron: flights
// "of much higher quality than what the site can output" to sell as stock footage). The same scene,
// the same loop and the same seam, rendered offline with every budget the live flight has to keep:
//
//   - Compositing in half-float targets (tunnelScene's `quality.float`): the site composites in
//     8-bit, which bands a slow sky gradient and the tail of every fade. A file headed for an
//     editor's grade has to survive being pushed, so nothing here is rounded to 8 bits until the
//     encoder's 10.
//   - A finer nebula: the volume baked on a denser grid with more octaves, in half float (8-bit
//     density terraced under the contrast remap), marched at full resolution with more steps, and a
//     finer detail tile. NEBULA_PROFILES.
//   - Supersampling: the frame is drawn `ss` times larger and box-filtered down.
//   - Motion blur that keeps the picture sharp. Each frame is the mean of `samples` moments across
//     the shutter, averaged in LINEAR light (averaging sRGB values is what makes blur read muddy:
//     a bright edge smeared over a dark one comes out darker than either). Two things stop it
//     smearing the artwork at the ramp's peak, where the earlier lab (2026-10-30) read as a zoom
//     blur: the exposure is CAPPED in scene time (`maxBlur`), so the near-stop at the seam gets
//     the whole shutter and the peak gets no more travel than the cap; and the shutter can be
//     SHAPED (`trail`): the moment the frame is stamped at is weighted most and earlier moments
//     fall off exponentially, so every edge is drawn sharp where it is with a tail behind it,
//     instead of a symmetric smear with no sharp edge at all. trail 0 is a plain box shutter.
//     The subframes also move the nebula's march offsets, so its sampling noise averages out.
//
// The loop still closes exactly: frame f and frame f + fps * seconds are the same moments.
import * as THREE from 'three';
import { rampTime, rampRush, RAMP_FLOOR_3D } from '../utils/speedRamp';

import { NEBULA_PROFILES, STAR_PROFILES } from './stockProfiles';
export { NEBULA_PROFILES, STAR_PROFILES };

// The nebula overrides for a render: a profile by name (or an object), with `dustMode` -- how the
// Blender recipe's dust darkens: 3 the backdrop's hue, 1 the nebula's gradient, 0 black -- on top.
function nebulaProfile(opts) {
  const base = typeof opts.nebula === 'object' ? opts.nebula : NEBULA_PROFILES[opts.nebula] ?? null;
  return base && opts.dustMode != null ? { ...base, dustMode: opts.dustMode } : base;
}

export const STOCK_DEFAULTS = {
  ss: 1, // supersampling factor per axis
  samples: 16, // moments per frame
  shutter: 180, // degrees
  maxBlur: 1 / 90, // the longest exposure, in scene seconds (the flight moves at a constant speed in scene time)
  trail: 3, // shutter shape: 0 box, higher = sharper head, shorter tail
  // The site's own nebula and colouring, at finer detail (Aaron, 2026-11-21: after several rounds
  // on the Blender recipe's colour, "just color it more like the site version"). 'blender' stays
  // available in the panel.
  nebula: 'ultra',
  stars: 'deep'
};

const SRGB_GLSL = /* glsl */ `
  vec3 toLinear(vec3 c) { c = clamp(c, 0.0, 1.0); return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c)); }
  vec3 toSrgb(vec3 c) { c = max(c, 0.0); return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
`;
const VERT = 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }';
// Adds one moment into the accumulator, in linear light, weighted.
const ACC_FRAG = /* glsl */ `
  varying vec2 vUv;
  uniform sampler2D uSrc;
  uniform float uW;
  ${SRGB_GLSL}
  void main() { gl_FragColor = vec4(toLinear(texture2D(uSrc, vUv).rgb) * uW, uW); }
`;
// The finished frame: the box-filtered mean of the accumulator, back to sRGB.
const RESOLVE_FRAG = /* glsl */ `
  precision highp float;
  uniform sampler2D uAcc;
  uniform int uSS;
  ${SRGB_GLSL}
  void main() {
    ivec2 o = ivec2(gl_FragCoord.xy) * uSS;
    vec4 s = vec4(0.0);
    for (int y = 0; y < 4; y++) for (int x = 0; x < 4; x++) {
      if (x < uSS && y < uSS) s += texelFetch(uAcc, o + ivec2(x, y), 0);
    }
    gl_FragColor = vec4(toSrgb(s.rgb / max(s.a, 1e-6)), 1.0);
  }
`;

/**
 * @param {{ seed: string, colors?: string[], settings?: any }} design the scene design (objects already applied)
 * @param {{ width: number, height: number, seconds: number, ramp: boolean, fps: number,
 *   ss?: number, samples?: number, shutter?: number, maxBlur?: number, trail?: number, nebula?: any, stars?: any, dustMode?: number }} o
 */
export async function createStockRenderer(design, o) {
  const opts = { ...STOCK_DEFAULTS, ...o };
  const ss = Math.max(1, Math.min(4, Math.round(opts.ss)));
  const W = opts.width * ss, H = opts.height * ss;
  const { createTunnelScene, warmTunnelStars } = await import('./tunnelScene');
  await warmTunnelStars(opts.seconds);
  const renderer = new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: false });
  renderer.setPixelRatio(1);
  renderer.setSize(W, H, false);
  const gl = renderer.getContext();
  if (!gl.getExtension('EXT_color_buffer_float')) {
    renderer.dispose();
    renderer.forceContextLoss();
    throw new Error('Stock renders need float render targets (EXT_color_buffer_float), which this browser lacks.');
  }
  const max = gl.getParameter(gl.MAX_RENDERBUFFER_SIZE);
  if (W > max || H > max) throw new Error(`${W}x${H} is past this GPU's ${max}px limit: lower the supersampling.`);

  let world = null;
  const disposables = [];
  const dispose = () => {
    world?.dispose();
    world = null;
    for (const d of disposables) d.dispose();
    renderer.dispose();
    renderer.forceContextLoss();
  };
  try {
    world = createTunnelScene({
      seed: design.seed,
      colors: design.colors || [],
      settings: design.settings ?? null,
      duration: opts.seconds,
      width: W,
      height: H,
      exact: true,
      renderer,
      quality: {
        float: true,
        nebula: nebulaProfile(opts),
        stars: typeof opts.stars === 'object' ? opts.stars : STAR_PROFILES[opts.stars] ?? null
      }
    });
    await world.ready;
  } catch (e) {
    dispose();
    throw e;
  }

  const { seconds, fps, ramp } = opts;
  const sceneTime = x => (ramp ? rampTime(x, seconds, RAMP_FLOOR_3D) : x);
  const open = Math.max(0, Math.min(360, opts.shutter)) / 360 / fps;
  const n = open > 0 ? Math.max(1, Math.round(opts.samples)) : 1;
  const shutter = createShutter(renderer, { width: W, height: H, ss, samples: n, trail: opts.trail });
  const out = new THREE.WebGLRenderTarget(opts.width, opts.height, { type: THREE.FloatType });
  out.texture.minFilter = out.texture.magFilter = THREE.NearestFilter;
  disposables.push(shutter, out);

  const pixels = new Float32Array(opts.width * opts.height * 4);
  const frames = Math.round(seconds * fps);

  // Draws frame f (or any linear time t) into the float target; returns the scene-time exposure used.
  function draw(t) {
    const head = sceneTime(t);
    const span = Math.min(head - sceneTime(t - open), opts.maxBlur);
    const rush = ramp ? rampRush(((t % seconds) + seconds) % seconds, seconds) : 0;
    shutter.expose(world, head, span, rush, out);
    return span;
  }
  function read() {
    renderer.readRenderTargetPixels(out, 0, 0, opts.width, opts.height, pixels);
    return pixels;
  }
  return {
    frames,
    width: opts.width,
    height: opts.height,
    samplesPerFrame: n,
    // Frame f as 16-bit RGB, top row first (rgb48le, ffmpeg's rawvideo order).
    frameRgb48(f) {
      draw(f / fps);
      const px = read();
      const w = opts.width, h = opts.height;
      const outBuf = new Uint16Array(w * h * 3);
      for (let y = 0; y < h; y++) {
        const src = (h - 1 - y) * w * 4;
        const dst = y * w * 3;
        for (let x = 0; x < w; x++) {
          const s = src + x * 4, d = dst + x * 3;
          outBuf[d] = Math.max(0, Math.min(65535, Math.round(px[s] * 65535)));
          outBuf[d + 1] = Math.max(0, Math.min(65535, Math.round(px[s + 1] * 65535)));
          outBuf[d + 2] = Math.max(0, Math.min(65535, Math.round(px[s + 2] * 65535)));
        }
      }
      return outBuf;
    },
    // The moment at linear time t, as an 8-bit canvas (the panel's preview, a PNG still).
    // `into` (optional) is a canvas of the output size to draw into instead of a new one.
    frameCanvas(t, into = null) {
      draw(t);
      const px = read();
      const w = opts.width, h = opts.height;
      const c = into || document.createElement('canvas');
      if (c.width !== w) c.width = w;
      if (c.height !== h) c.height = h;
      const ctx = c.getContext('2d');
      const img = ctx.createImageData(w, h);
      for (let y = 0; y < h; y++) {
        const src = (h - 1 - y) * w * 4;
        for (let x = 0; x < w * 4; x += 4) {
          const d = y * w * 4 + x;
          // ordered dither to 8 bits, so the preview shows what the file holds rather than new bands
          const dith = (((x >> 2) * 7 + y * 13) % 16) / 16 - 0.5;
          img.data[d] = Math.max(0, Math.min(255, Math.round(px[src + x] * 255 + dith)));
          img.data[d + 1] = Math.max(0, Math.min(255, Math.round(px[src + x + 1] * 255 + dith)));
          img.data[d + 2] = Math.max(0, Math.min(255, Math.round(px[src + x + 2] * 255 + dith)));
          img.data[d + 3] = 255;
        }
      }
      ctx.putImageData(img, 0, 0);
      return c;
    },
    dispose
  };
}

// The shutter, on its own (2026-11-21): averages `samples` moments of a flight scene across an
// exposure, in linear light, weighted toward the stamped moment (trail), box-filtered down by `ss`,
// and resolves into `target` (a render target, or null for the renderer's own canvas). The stock
// renderer uses it, and so does the ad builder's Reel for its flight (adComposer), so both blur
// identically. `span` is the exposure in scene seconds, ending at `head`; the caller caps it.
/**
 * @param {any} renderer a three WebGLRenderer, drawing at width x height
 * @param {{ width: number, height: number, ss?: number, samples: number, trail?: number }} o
 */
export function createShutter(renderer, { width, height, ss = 1, samples, trail = 3 }) {
  const gl = renderer.getContext();
  gl.getExtension('EXT_color_buffer_float');
  const floatBlend = !!gl.getExtension('EXT_float_blend');
  const n = Math.max(1, Math.round(samples));
  const sub = new THREE.WebGLRenderTarget(width, height, { type: THREE.HalfFloatType });
  const acc = new THREE.WebGLRenderTarget(width, height, { type: floatBlend ? THREE.FloatType : THREE.HalfFloatType });
  for (const t of [sub, acc]) t.texture.minFilter = t.texture.magFilter = THREE.NearestFilter;
  const ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const quadGeo = new THREE.PlaneGeometry(2, 2);
  const mats = [];
  const pass = (frag, uniforms, extra = {}) => {
    const mat = new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: frag, uniforms, depthTest: false, depthWrite: false, ...extra });
    mats.push(mat);
    const scene = new THREE.Scene();
    const mesh = new THREE.Mesh(quadGeo, mat);
    mesh.frustumCulled = false;
    scene.add(mesh);
    return scene;
  };
  const accU = { uSrc: { value: sub.texture }, uW: { value: 1 } };
  const accScene = pass(ACC_FRAG, accU, {
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneFactor,
    blendSrcAlpha: THREE.OneFactor,
    blendDstAlpha: THREE.OneFactor
  });
  const resU = { uAcc: { value: acc.texture }, uSS: { value: Math.max(1, Math.round(ss)) } };
  const resScene = pass(RESOLVE_FRAG, resU, { blending: THREE.NoBlending });
  // the shutter's shape: weight per moment, u = 0 at the opening, 1 at the stamp
  const weights = [];
  for (let i = 0; i < n; i++) weights.push(Math.exp(-trail * (1 - (n === 1 ? 1 : (i + 0.5) / n))));
  const wSum = weights.reduce((a, b) => a + b, 0);
  let exposures = 0;
  return {
    samples: n,
    expose(world, head, span, rush, target = null) {
      const prevClear = renderer.getClearAlpha();
      const autoClear = renderer.autoClear;
      renderer.setRenderTarget(acc);
      renderer.setClearColor(0x000000, 0);
      renderer.clear();
      for (let i = 0; i < n; i++) {
        const u = n === 1 ? 1 : (i + 0.5) / n;
        world.setTime(head - Math.max(0, span) * (1 - u), rush, false);
        world.setNebulaJitter?.(((i + 0.5) / n + exposures * 0.61803398875) % 1);
        renderer.setRenderTarget(sub);
        world.render(renderer);
        accU.uW.value = weights[i] / wSum;
        renderer.setRenderTarget(acc);
        // three clears a target before every render by default, which would leave only the last moment
        renderer.autoClear = false;
        renderer.render(accScene, ortho);
        renderer.autoClear = autoClear;
      }
      renderer.setRenderTarget(target);
      renderer.render(resScene, ortho);
      renderer.setRenderTarget(null);
      renderer.setClearAlpha(prevClear);
      exposures++;
    },
    dispose() {
      sub.dispose();
      acc.dispose();
      quadGeo.dispose();
      for (const m of mats) m.dispose();
    }
  };
}

