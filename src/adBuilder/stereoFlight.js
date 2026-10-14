import { rampTime, rampRush, RAMP_FLOOR_3D } from '../utils/speedRamp';

// A cross-eye stereo Reel of a design's 3D flight: the frame split down the middle, each half
// the flight as one eye sees it (2026-10-13, Aaron, after an Instagram post doing the same). The
// LEFT half is the RIGHT eye's view: crossing your eyes sends each eye to the opposite half.
//
// Each eye renders into its own target and one pass lays the two side by side on the canvas, so
// the preview never reads the frame back out of WebGL (see adComposer's `layered` on why that
// matters in Safari). The export hands this same canvas to the encoder.
//
// The depth was picked from rendered tests (https://claude.ai/artifact/VFPYm5529N67QvS1gGzVvD):
// "Strong" was 6 world units between the eyes on half-frame panels of 9:16; on full-height
// halves (each about 0.28 as wide as tall) the same world separation puts twice the offset on
// screen, so 3 here gives what was approved. Things at CONVERGE sit at the screen's depth;
// nearer comes out toward the viewer.
export const STEREO_SEPARATION = 3;
export const STEREO_CONVERGE = 80;

// How much more the flight passes than the studio's -- plates, stars, large stars, the cage
// (tunnelScene's `density`). Depth only reads with many things at many depths, and the studio's
// scene looked sparse crossed. Tried at 3 (and 6, one wall of shapes); 3 was "a bit much now in
// most designs", so 2 (Aaron, 2026-10-13).
export const STEREO_DENSITY = 2;

export const STEREO_LENGTHS = [5, 8, 10, 15, 20, 30];
export const DEFAULT_STEREO = { length: 10, ramp: true };

const SIDE_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = position.xy * 0.5 + 0.5;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;
// Raw copies, no colour conversion -- the scene's colours are already the sRGB values it wants
// on screen (tunnelScene's COPY_FRAG does the same).
const SIDE_FRAG = /* glsl */ `
  varying vec2 vUv;
  uniform sampler2D uLeft;
  uniform sampler2D uRight;
  void main() {
    vec2 uv = vec2(fract(vUv.x * 2.0), vUv.y);
    vec3 c = vUv.x < 0.5 ? texture2D(uLeft, uv).rgb : texture2D(uRight, uv).rgb;
    gl_FragColor = vec4(c, 1.0);
  }
`;

/**
 * @param {{ design: { seed: string, colors?: string[], settings?: any }, width: number, height: number, length: number, density?: number, pull?: number }} o
 */
export async function createStereoComposer({
  design,
  width,
  height,
  length,
  density = STEREO_DENSITY,
  pull = 1
}) {
  const [THREE, { createTunnelScene, warmTunnelStars }] = await Promise.all([
    import('three'),
    import('../animation3d/tunnelScene')
  ]);
  await warmTunnelStars(length, 8, density);

  const half = Math.round(width / 2);
  const renderer = new THREE.WebGLRenderer({ antialias: false });
  const eyes = [
    new THREE.WebGLRenderTarget(half, height),
    new THREE.WebGLRenderTarget(width - half, height)
  ];
  const quad = new THREE.PlaneGeometry(2, 2);
  const uniforms = { uLeft: { value: eyes[0].texture }, uRight: { value: eyes[1].texture } };
  const material = new THREE.ShaderMaterial({
    vertexShader: SIDE_VERT,
    fragmentShader: SIDE_FRAG,
    uniforms,
    depthTest: false,
    depthWrite: false
  });
  const mesh = new THREE.Mesh(quad, material);
  mesh.frustumCulled = false;
  const sideScene = new THREE.Scene();
  sideScene.add(mesh);
  const orthoCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  let world = null;
  let released = false;
  // Idempotent: the export releases it before flushing the encoder, and again in its finally.
  const release = () => {
    if (released) return;
    released = true;
    world?.dispose();
    world = null;
    for (const t of eyes) t.dispose();
    quad.dispose();
    material.dispose();
    renderer.dispose();
    // dispose() alone leaves the context alive until GC -- see Animation3DPreview
    renderer.forceContextLoss();
    renderer.domElement.remove();
  };
  try {
    renderer.setPixelRatio(1);
    renderer.setSize(width, height, false);
    // Always `exact`: an off-centre eye cannot use the plates' scaled cache (tunnelScene's setEye)
    world = createTunnelScene({
      seed: design.seed,
      colors: design.colors || [],
      settings: design.settings ?? null,
      duration: length,
      width: half,
      height,
      exact: true,
      density,
      pull
    });
    await world.ready;
  } catch (e) {
    release();
    throw e;
  }

  // One loop is the whole Reel, so the video loops seamlessly, as the studio's exports do.
  function render(t, ramp) {
    if (!world) return;
    const tl = ((t % length) + length) % length;
    const time = ramp ? rampTime(tl, length, RAMP_FLOOR_3D) : tl;
    const rush = ramp ? rampRush(tl, length) : 0;
    // Cross-eye: the right eye's view goes in the left half
    [+1, -1].forEach((side, i) => {
      world.setEye((side * STEREO_SEPARATION) / 2, STEREO_CONVERGE);
      world.setTime(time, rush, false);
      renderer.setRenderTarget(eyes[i]);
      world.render(renderer);
    });
    renderer.setRenderTarget(null);
    renderer.render(sideScene, orthoCam);
  }

  return { canvas: renderer.domElement, render, dispose: release };
}
