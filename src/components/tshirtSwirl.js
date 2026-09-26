// Swirling spark particles for the hero t-shirt's generate transition (2026-09-25, Aaron:
// "would it be possible to add some random swirling particle effects to the mix?").
//
// A vortex of palette-coloured comet streaks erupts out of the shirt when the glitch pass is
// raised, orbits it for as long as the generate runs -- passing BEHIND the garment as well as in
// front -- and dissipates as the new design lands: the swirl keeps turning, drifts outward, and
// each spark dies out on its own schedule.
//
// THE SPARKS ARE THEIR OWN LAYER, composited by the aberration pass rather than drawn into the
// scene it distorts. Drawn into the scene, the pass's RGB split pulled every spark apart into
// its red, green and blue components, so the palette never survived (Aaron: "you can't see the
// colors you chose for them. they're all just rgb"). As a separate layer the pass still carries
// them through its ripple warp and tearing -- they stay part of the same event -- but not the
// channel split. Occlusion stays exact without sharing a depth buffer: the scene renders into a
// target with a depth texture, and each spark fragment tests itself against it.
//
// Everything about the motion is computed in the vertex shader from a handful of uniforms, so a
// frame costs a few uniform writes regardless of particle count. Each strike rolls a fresh
// vortex -- axis tilt, direction, speed, reach, spread, drift -- so no two generates swirl the
// same way. Each particle carries a short comet TAIL (the same particle evaluated a few
// milliseconds in the past), which is what makes the motion legible as a swirl in a 190px shirt
// rather than as a cloud of jittering dots.
//
// Takes THREE and Pass as parameters instead of importing them, so three.js stays in its own lazy
// chunk (TshirtPreview dynamic-imports it; a static import here would drag it into the main
// bundle).

const PARTICLES = 90;
// Samples per particle, head first. Spaced tightly enough that they overlap into one continuous
// streak at orbit speed -- spaced wider, a tail reads as a dotted line.
const TAIL = 12;
const TAIL_STEP = 0.009; // seconds between tail samples
const MAX_COLORS = 6;
// Overall strength of the layer (Aaron: "maybe they can be a little less opaque"). Scales every
// sample, so the tail's overlapping samples thin out together rather than the heads alone.
const OPACITY = 0.6;
// The exit. Each spark starts dying out somewhere in [OUT_DELAY, OUT_DELAY + OUT_STAGGER] after
// the release and takes OUT_FADE to go, so the swarm thins out rather than vanishing at once.
const OUT_DELAY = 0.06;
const OUT_STAGGER = 0.5;
const OUT_FADE = 0.45;
const OUT_TOTAL = OUT_DELAY + OUT_STAGGER + OUT_FADE;
// A swarm that is never released still stops here, so a missed release can never pin the render
// loop for the life of the page.
const MAX_LIFE = 20;
// Fallback while no design palette has been handed over yet (the scene comes up wearing the
// model's own white sheet).
const DEFAULT_COLORS = [
  [1, 1, 1],
  [0.85, 0.9, 1]
];

const VERTEX = /* glsl */ `
  attribute vec4 aSeed;
  attribute vec4 aSeed2;
  attribute float aTail;
  uniform float uAge;
  uniform float uRelStart;
  uniform float uR;
  uniform float uSize;
  uniform float uCamDist;
  uniform vec4 uSwirl;
  uniform vec4 uSwirl2;
  uniform vec3 uColors[${MAX_COLORS}];
  uniform float uColorCount;
  varying vec3 vColor;
  varying float vAlpha;

  mat3 rotX(float a) { float c = cos(a), s = sin(a); return mat3(1.0, 0.0, 0.0, 0.0, c, s, 0.0, -s, c); }
  mat3 rotZ(float a) { float c = cos(a), s = sin(a); return mat3(c, s, 0.0, -s, c, 0.0, 0.0, 0.0, 1.0); }

  // Seconds since the release at time t, or 0 before it / if there hasn't been one.
  float sinceRelease(float t) { return uRelStart < 0.0 ? 0.0 : max(t - uRelStart, 0.0); }

  // Where this particle is t seconds after the strike. Every term is a function of t alone, so a
  // tail sample (an earlier t) lies on the head's real path -- including through the exit.
  vec3 swirl(float t) {
    t = max(t, 0.0);
    // Erupts from inside the garment and is flung out to its orbit over ~half a second.
    float erupt = 1.0 - exp(-t * 5.0);
    float r0 = mix(0.40, 1.0, sqrt(aSeed.x)) * uR * uSwirl2.x;
    float r = r0 * (0.12 + 0.88 * erupt)
            * (1.0 + 0.12 * sin(t * (1.3 + aSeed2.x * 1.5) + aSeed.y * 6.2831));
    // The exit drifts each spark outward from a standstill -- quadratic, so its outward speed
    // starts at zero and the swirl never jerks at the release.
    float s = sinceRelease(t);
    r *= 1.0 + (0.45 + 0.6 * aSeed2.y) * s * s;
    // A vortex: the inner orbits turn fastest.
    float omega = uSwirl.z * (1.3 + 1.3 * aSeed.w) * pow(0.6 * uR / r0, 0.8);
    float theta = aSeed.y * 6.2831 + omega * t;
    float h = (aSeed.z - 0.5) * uSwirl2.z * uR
            + uSwirl2.y * uR * t * (aSeed2.z - 0.35);
    vec3 p = vec3(r * cos(theta), h, r * sin(theta));
    // Each particle's own orbital plane wobbles a little, so the swarm is a volume rather than
    // one flat disk...
    p = rotZ((aSeed2.x - 0.5) * 0.6) * rotX((aSeed2.w - 0.5) * 0.8) * p;
    // ...and the whole vortex is tilted per strike.
    p = rotZ(uSwirl.y) * rotX(uSwirl.x) * p;
    p.z += uSwirl.w * uR;
    // Dying sparks rise a little as they go, like embers.
    p.y += uR * (0.1 + 0.25 * aSeed2.z) * s * s;
    return p;
  }

  void main() {
    float t = uAge - aTail * ${TAIL_STEP.toFixed(4)};
    vec4 mv = modelViewMatrix * vec4(swirl(t), 1.0);
    gl_Position = projectionMatrix * mv;

    // This spark's own exit, taken from the HEAD's clock so a streak fades as one piece.
    float fadeOut = smoothstep(0.0, 1.0, clamp(
      (sinceRelease(uAge) - ${OUT_DELAY.toFixed(3)} - aSeed2.y * ${OUT_STAGGER.toFixed(3)})
        / ${OUT_FADE.toFixed(3)}, 0.0, 1.0));

    float tailFade = pow(1.0 - aTail / ${TAIL.toFixed(1)}, 1.3);
    float born = smoothstep(0.0, 0.15, t);
    float twinkle = 0.75 + 0.25 * sin(uAge * (5.0 + 9.0 * aSeed2.y) + aSeed.x * 40.0);
    // Fade before the canvas edge, so nothing is ever cut off by the square.
    vec2 ndc = gl_Position.xy / gl_Position.w;
    float edge = 1.0 - smoothstep(0.72, 0.96, max(abs(ndc.x), abs(ndc.y)));
    vAlpha = ${OPACITY.toFixed(3)} * tailFade * born * twinkle * edge * (1.0 - fadeOut);

    float size = uSize * (0.6 + 0.8 * aSeed2.z) * (1.0 - 0.7 * aTail / ${TAIL.toFixed(1)})
               * mix(1.0, 0.35, fadeOut);
    // uSize is device pixels at the shirt's own distance; nearer sparks draw bigger.
    gl_PointSize = max(size * uCamDist / -mv.z, 1.0);

    int idx = int(min(floor(aSeed.w * uColorCount), uColorCount - 1.0));
    vColor = uColors[0];
    for (int i = 1; i < ${MAX_COLORS}; i++) if (i == idx) vColor = uColors[i];
  }
`;

const FRAGMENT = /* glsl */ `
  uniform sampler2D uSceneDepth;
  uniform vec2 uViewport;
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    // Behind the garment: the scene's depth at this pixel is nearer than the spark.
    if (gl_FragCoord.z > texture2D(uSceneDepth, gl_FragCoord.xy / uViewport).r) discard;
    float d = length(gl_PointCoord - 0.5) * 2.0;
    if (d > 1.0) discard;
    float glow = pow(1.0 - d, 1.4);
    // Hot core, palette-coloured falloff. The core is held well short of white, or the colour
    // only survives in a thin rim and every spark reads the same.
    vec3 col = mix(vColor, vec3(1.0), smoothstep(0.35, 0.0, d) * 0.35);
    gl_FragColor = vec4(col, glow * vAlpha);
  }
`;

// Sparks need to read against busy artwork, so every palette colour is pushed saturated and
// bright, keeping its hue. Values stay raw sRGB 0..1: the shirt's composer writes a
// ShaderMaterial's output to the screen untouched (measured: 0.5 renders as 128), so these land
// on screen as the colour chosen here.
function sparkColor(THREE, hex) {
  const c = new THREE.Color();
  try {
    c.setStyle(hex, THREE.LinearSRGBColorSpace); // no sRGB->linear conversion
  } catch {
    return [1, 1, 1];
  }
  const hsl = {};
  c.getHSL(hsl, THREE.LinearSRGBColorSpace);
  c.setHSL(hsl.h, Math.max(hsl.s, 0.85), Math.min(Math.max(hsl.l, 0.55), 0.68), THREE.LinearSRGBColorSpace);
  return [c.r, c.g, c.b];
}

const easeInOut = x => (x < 0.5 ? 2 * x * x : 1 - (-2 * x + 2) ** 2 / 2);

export function createTshirtSwirl(THREE, Pass, { camera, radius, pixelSize, enabled = true }) {
  const count = PARTICLES * TAIL;
  const seed = new Float32Array(count * 4);
  const seed2 = new Float32Array(count * 4);
  const tail = new Float32Array(count);
  const position = new Float32Array(count * 3); // unused by the shader; three requires it
  for (let p = 0; p < PARTICLES; p++) {
    const a = [Math.random(), Math.random(), Math.random(), Math.random()];
    const b = [Math.random(), Math.random(), Math.random(), Math.random()];
    for (let k = 0; k < TAIL; k++) {
      const i = p * TAIL + k;
      seed.set(a, i * 4);
      seed2.set(b, i * 4);
      tail[i] = k;
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
  geometry.setAttribute('aSeed', new THREE.BufferAttribute(seed, 4));
  geometry.setAttribute('aSeed2', new THREE.BufferAttribute(seed2, 4));
  geometry.setAttribute('aTail', new THREE.BufferAttribute(tail, 1));

  const colors = Array.from({ length: MAX_COLORS }, () => new THREE.Vector3(1, 1, 1));
  const uniforms = {
    uAge: { value: 0 },
    uRelStart: { value: -1 },
    uR: { value: radius },
    uSize: { value: pixelSize },
    uCamDist: { value: camera.position.length() },
    uSwirl: { value: new THREE.Vector4() },
    uSwirl2: { value: new THREE.Vector4(1, 0, 1, 0) },
    uColors: { value: colors },
    uColorCount: { value: DEFAULT_COLORS.length },
    uSceneDepth: { value: null },
    uViewport: { value: new THREE.Vector2(1, 1) }
  };
  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    transparent: true,
    depthWrite: false,
    depthTest: false, // tested by hand against the scene's depth texture instead
    blending: THREE.AdditiveBlending
  });
  const points = new THREE.Points(geometry, material);
  // The shader moves every vertex; the CPU-side bounds know nothing about that.
  points.frustumCulled = false;
  points.visible = false;
  const sparkScene = new THREE.Scene();
  sparkScene.add(points);

  const target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false });
  const clearColor = new THREE.Color();
  // Sits between the scene's RenderPass and the aberration pass. The composer hands it the scene
  // target as `readBuffer`, whose depth texture is exactly the frame just drawn; needsSwap stays
  // false, so the aberration pass still reads that same scene target after it.
  class SparkPass extends Pass {
    constructor() {
      super();
      this.needsSwap = false;
    }
    setSize(width, height) {
      target.setSize(width, height);
      uniforms.uViewport.value.set(width, height);
    }
    render(renderer, writeBuffer, readBuffer) {
      uniforms.uSceneDepth.value = readBuffer.depthTexture;
      const prevTarget = renderer.getRenderTarget();
      const prevAutoClear = renderer.autoClear;
      const prevAlpha = renderer.getClearAlpha();
      renderer.getClearColor(clearColor);
      renderer.setRenderTarget(target);
      renderer.setClearColor(0x000000, 0);
      renderer.clear(true, false, false);
      if (points.visible) {
        renderer.autoClear = false;
        renderer.render(sparkScene, camera);
      }
      renderer.autoClear = prevAutoClear;
      renderer.setClearColor(clearColor, prevAlpha);
      renderer.setRenderTarget(prevTarget);
    }
  }
  const pass = new SparkPass();

  // Palette: raw sRGB triples, crossfaded over `duration` when one arrives mid-effect.
  let from = DEFAULT_COLORS;
  let to = DEFAULT_COLORS;
  let paletteStart = -1;
  let paletteDuration = 0;
  const writeColors = mix => {
    const n = Math.max(from.length, to.length);
    for (let i = 0; i < MAX_COLORS; i++) {
      const a = from[i % from.length];
      const b = to[i % to.length];
      colors[i].set(a[0] + (b[0] - a[0]) * mix, a[1] + (b[1] - a[1]) * mix, a[2] + (b[2] - a[2]) * mix);
    }
    uniforms.uColorCount.value = Math.min(n, MAX_COLORS);
  };
  writeColors(1);

  let strikeAt = null;
  let releaseAt = null;
  // Both are QUEUED and applied in order on the next drawn frame, never on the call. The entrance
  // asks for a strike and a release in one breath; an earlier version applied the strike a frame
  // later and let it wipe the release, so the sparks never left -- and, since they count as
  // busy, kept the render loop running at 60fps indefinitely.
  let strikeQueued = false;
  let releaseQueued = false;
  const alive = now =>
    strikeAt !== null &&
    now - strikeAt < MAX_LIFE &&
    (releaseAt === null || now - releaseAt < OUT_TOTAL);

  const rollVortex = () => {
    const tiltX = (Math.random() * 2 - 1) * 1.25; // up to ~72deg: tornado through whirlpool
    const tiltZ = (Math.random() * 2 - 1) * 0.5;
    const dir = Math.random() < 0.5 ? -1 : 1;
    uniforms.uSwirl.value.set(
      tiltX,
      tiltZ,
      dir * (0.8 + Math.random() * 0.9),
      // A whirlpool facing the camera would sit inside the garment; bring it forward in
      // proportion to how far the axis is tipped toward the viewer.
      0.42 * Math.abs(Math.sin(tiltX))
    );
    uniforms.uSwirl2.value.set(
      0.85 + Math.random() * 0.4, // reach
      (Math.random() * 2 - 1) * 0.12, // vertical drift per second
      0.6 + Math.random() * 0.9, // spread along the axis
      0
    );
  };

  return {
    pass,
    // The spark layer, for the aberration pass to composite.
    texture: target.texture,
    // True while any spark could still be on screen, so the render loop keeps drawing through the
    // exit, which outlasts the glitch pass's own ease-down.
    busy: now => enabled && alive(now),
    // A fresh vortex, rolled on the next drawn frame so the eruption is never spent while the
    // main thread is busy (see setAberration). Supersedes a release not yet applied.
    strike() {
      strikeQueued = true;
      releaseQueued = false;
    },
    // Dissipate, on the next drawn frame.
    release() {
      releaseQueued = true;
    },
    setPalette(hexes, duration) {
      const next = (hexes || []).slice(0, MAX_COLORS).map(h => sparkColor(THREE, h));
      if (!next.length) return;
      const cur = [];
      for (let i = 0; i < MAX_COLORS; i++) cur.push([colors[i].x, colors[i].y, colors[i].z]);
      from = cur.slice(0, Math.max(uniforms.uColorCount.value, 1));
      to = next;
      // Nothing on screen to crossfade: swap outright, or the next strike would open on a swarm
      // still drifting between two palettes.
      if (!points.visible || !(duration > 0)) {
        paletteStart = -1;
        writeColors(1);
        return;
      }
      paletteStart = null; // start on the next drawn frame
      paletteDuration = duration;
    },
    // Per drawn frame. `amount` is the aberration pass's uAmount -- the glitch the sparks ride.
    update(now, amount) {
      // The whole event came and went while nothing could draw (Aaron, 2026-09-25: generate
      // from the footer, scroll back up, and the swarm plays for a transition that finished
      // long ago). The render loop sleeps while the shirt is off screen, so a queued strike and
      // release -- or a live swarm plus a queued release -- only reach it when it comes back.
      // If a release is waiting and the glitch has already faded to nothing, the effect is
      // over: drop it rather than replay it. The entrance is unaffected (it raises the glitch
      // to its peak in the same call that queues both), and so is a return mid-generate, when
      // no release is waiting yet.
      if (releaseQueued && amount < 1e-3) {
        strikeQueued = false;
        releaseQueued = false;
        strikeAt = null;
        releaseAt = null;
      }
      if (strikeQueued) {
        strikeAt = now;
        releaseAt = null;
        rollVortex();
        strikeQueued = false;
      }
      if (releaseQueued && strikeAt !== null) {
        releaseAt = now;
        releaseQueued = false;
      }
      if (paletteStart === null) paletteStart = now;
      if (paletteStart >= 0) {
        const mix = Math.min(1, (now - paletteStart) / Math.max(paletteDuration, 0.001));
        writeColors(easeInOut(mix));
        if (mix >= 1) paletteStart = -1;
      }
      points.visible = enabled && alive(now);
      uniforms.uAge.value = strikeAt === null ? 0 : now - strikeAt;
      uniforms.uRelStart.value = releaseAt === null ? -1 : releaseAt - strikeAt;
    },
    dispose() {
      geometry.dispose();
      material.dispose();
      target.dispose();
    }
  };
}
