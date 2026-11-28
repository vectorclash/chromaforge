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
// A SWARM IS STIRRED, NOT REPLACED (2026-11-27, Aaron: spinning the shirt again while the sparks
// were swirling made them "just disappear and are replaced with a new set"). Three driven terms
// sit on top of the analytic motion, integrated in JS and handed over as uniforms, each with its
// rate so a tail sample can extrapolate where the term stood a few milliseconds earlier:
//   phase -- extra orbit angle. The shirt's own spin drags the swarm with it (setDrive), and
//            the swarm's HEADING follows the shirt: spin the other way and the whole swarm turns
//            round and keeps going that way (same day, Aaron: on a reversal the sparks "slow down
//            and then keep going the wrong way"). The vortex's rolled direction is only where a
//            swarm starts; phase cancels it and replaces it with the heading's.
//   flare -- radius scale. A charge squeezes the swarm in; a release blasts it out.
//   exit  -- seconds since the release, normally t - releaseAt. stir() REWINDS it, so sparks that
//            were drifting out and fading pull back into orbit and brighten instead of vanishing.
// All three rest at zero, so a swarm nobody stirs (a generate, the explainer's pose) moves exactly
// as it did before.
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
// Each spark's size as a multiple of the base (Aaron, 2026-09-26: "no larger, but maybe a tiny
// bit smaller possible"). Skewed toward the top so the typical spark is unchanged -- median 1.0
// and max 1.4 as before -- while about one in eight now lands below the old 0.6 floor.
const SIZE_MIN = 0.35;
const SIZE_MAX = 1.4;
const SIZE_SKEW = 0.7;
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
// How far a strike may tip the vortex's axis (radians). Tipping it toward the camera (X) opens
// each orbit into an on-screen ellipse sin(tilt) as tall as it is wide, so at the old ~72deg
// ceiling the swarm read as a near-circle, the sparks running straight up and down the shirt's
// sides; rolling it (Z) turns the pass across the front diagonal. Both are capped so the swarm
// stays a band flowing horizontally across the chest (Aaron, 2026-09-26: the more vertical
// rolls "just don't look as good"). Each spark's own orbital plane still wobbles on top of this
// (see swirl()), so the swarm keeps its volume even at zero tilt.
const MAX_TILT_X = 0.5; // ~29deg: the ellipse stays under half as tall as it is wide
const MAX_TILT_Z = 0.25; // ~14deg
// How fast stir() pulls a dying swarm back (seconds of exit undone per second).
const REWIND = 2.5;
// Vertical drift stops growing here, so a swarm kept alive by stirring cannot wander off upward.
const DRIFT_FOR = 6;
// The driven phase chases its target at this rate (1/s): the swarm has some inertia of its own.
const PHASE_FOLLOW = 6;
const PHASE_MAX = 9; // rad/s
// A shirt push faster than this (rad/s of extra orbit) sets which way the swarm heads.
const HEADING_SWITCH = 1.2;
// The flare's spring (radius scale) and the damping of a free blast (explode()).
const FLARE_K = 40;
const FLARE_C = 11;
const BLAST_C = 2.4;
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
  attribute float aScale;
  uniform float uAge;
  uniform float uExit;
  uniform float uExitRate;
  uniform float uPhase;
  uniform float uPhaseRate;
  uniform float uFlare;
  uniform float uFlareRate;
  uniform float uGather;
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

  // Seconds since the release, as it stood LAG seconds ago; 0 before it / if there hasn't been
  // one. Normally exactly t - releaseAt (uExitRate 1); while stir() rewinds it, earlier samples
  // stood further out, which is where the tail then lies.
  float sinceRelease(float lag) { return uExit < 0.0 ? 0.0 : max(uExit - lag * uExitRate, 0.0); }

  // Where this particle is t seconds after the strike, LAG seconds behind the head. Every term
  // is a function of time, so a tail sample lies on the head's real path -- through the exit too.
  vec3 swirl(float t, float lag) {
    t = max(t, 0.0);
    // Erupts from inside the garment and is flung out to its orbit over ~half a second -- or,
    // gathered by a charge, streams in from well outside it.
    float erupt = 1.0 - exp(-t * 5.0);
    float inward = 1.0 + 1.8 * exp(-t * 3.0);
    float r0 = mix(0.40, 1.0, sqrt(aSeed.x)) * uR * uSwirl2.x;
    float r = r0 * mix(0.12 + 0.88 * erupt, inward, uGather)
            * (1.0 + 0.12 * sin(t * (1.3 + aSeed2.x * 1.5) + aSeed.y * 6.2831));
    // The exit drifts each spark outward from a standstill -- quadratic, so its outward speed
    // starts at zero and the swirl never jerks at the release.
    float s = sinceRelease(lag);
    r *= 1.0 + (0.45 + 0.6 * aSeed2.y) * s * s;
    r *= max(0.15, 1.0 + uFlare - lag * uFlareRate);
    // A vortex: the inner orbits turn fastest.
    float spinK = (1.3 + 1.3 * aSeed.w) * pow(0.6 * uR / r0, 0.8);
    float omega = uSwirl.z * spinK;
    float theta = aSeed.y * 6.2831 + omega * t + 0.5 * spinK * (uPhase - lag * uPhaseRate);
    float h = (aSeed.z - 0.5) * uSwirl2.z * uR
            + uSwirl2.y * uR * min(t, ${DRIFT_FOR.toFixed(1)}) * (aSeed2.z - 0.35);
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
    float lag = aTail * ${TAIL_STEP.toFixed(4)};
    float t = uAge - lag;
    vec4 mv = modelViewMatrix * vec4(swirl(t, lag), 1.0);
    gl_Position = projectionMatrix * mv;

    // This spark's own exit, taken from the HEAD's clock so a streak fades as one piece.
    float fadeOut = smoothstep(0.0, 1.0, clamp(
      (sinceRelease(0.0) - ${OUT_DELAY.toFixed(3)} - aSeed2.y * ${OUT_STAGGER.toFixed(3)})
        / ${OUT_FADE.toFixed(3)}, 0.0, 1.0));

    float tailFade = pow(1.0 - aTail / ${TAIL.toFixed(1)}, 1.3);
    float born = smoothstep(0.0, mix(0.15, 0.6, uGather), t);
    float twinkle = 0.75 + 0.25 * sin(uAge * (5.0 + 9.0 * aSeed2.y) + aSeed.x * 40.0);
    // Fade before the canvas edge, so nothing is ever cut off by the square.
    vec2 ndc = gl_Position.xy / gl_Position.w;
    float edge = 1.0 - smoothstep(0.72, 0.96, max(abs(ndc.x), abs(ndc.y)));
    vAlpha = ${OPACITY.toFixed(3)} * tailFade * born * twinkle * edge * (1.0 - fadeOut);

    float size = uSize * aScale * (1.0 - 0.7 * aTail / ${TAIL.toFixed(1)})
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
  const scale = new Float32Array(count);
  const position = new Float32Array(count * 3); // unused by the shader; three requires it
  for (let p = 0; p < PARTICLES; p++) {
    const a = [Math.random(), Math.random(), Math.random(), Math.random()];
    const b = [Math.random(), Math.random(), Math.random(), Math.random()];
    // Its own draw: size used to come from aSeed2.z, which also sets vertical drift, so the
    // biggest sparks were always the ones rising.
    const size = SIZE_MIN + (SIZE_MAX - SIZE_MIN) * Math.random() ** SIZE_SKEW;
    for (let k = 0; k < TAIL; k++) {
      const i = p * TAIL + k;
      seed.set(a, i * 4);
      seed2.set(b, i * 4);
      tail[i] = k;
      scale[i] = size;
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
  geometry.setAttribute('aSeed', new THREE.BufferAttribute(seed, 4));
  geometry.setAttribute('aSeed2', new THREE.BufferAttribute(seed2, 4));
  geometry.setAttribute('aTail', new THREE.BufferAttribute(tail, 1));
  geometry.setAttribute('aScale', new THREE.BufferAttribute(scale, 1));

  const colors = Array.from({ length: MAX_COLORS }, () => new THREE.Vector3(1, 1, 1));
  const uniforms = {
    uAge: { value: 0 },
    uExit: { value: -1 },
    uExitRate: { value: 1 },
    uPhase: { value: 0 },
    uPhaseRate: { value: 0 },
    uFlare: { value: 0 },
    uFlareRate: { value: 0 },
    uGather: { value: 0 },
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
  // Both are QUEUED and applied in order on the next drawn frame, never on the call. The entrance
  // asks for a strike and a release in one breath; an earlier version applied the strike a frame
  // later and let it wipe the release, so the sparks never left -- and, since they count as
  // busy, kept the render loop running at 60fps indefinitely.
  let strikeQueued = false;
  let releaseQueued = false;
  // A strike may ask for its orbit's direction and speed (the shirt's spin does, so the swarm
  // turns with it); otherwise both are rolled.
  let strikeDir = 0;
  let strikeSpeed = 1;
  let strikeGather = 0;
  let posed = false;
  // The driven terms (see the header). `exit` is seconds since the release, -1 for none.
  let exit = -1;
  let exitRate = 1;
  let rewinding = false;
  let phase = 0;
  let phaseVel = 0;
  let phaseTarget = 0;
  let heading = 1; // +1/-1, in the vortex's own sign convention (uSwirl.z)
  let shirtPush = 0;
  let chargeBoost = 0;
  let flare = 0;
  let flareVel = 0;
  let flareTarget = 0;
  let blasting = false; // explode(): the flare coasts outward with no spring pulling it back
  let pendingFlareKick = 0;
  let lastNow = null;
  // Stirring keeps a swarm alive; MAX_LIFE counts from the last time anything did.
  let activeAt = null;
  const alive = now =>
    strikeAt !== null && now - activeAt < MAX_LIFE && exit < OUT_TOTAL;
  const resetDrive = () => {
    exit = -1;
    exitRate = 1;
    rewinding = false;
    phase = phaseVel = 0;
    flare = flareVel = 0;
    blasting = false;
  };

  const writeDrive = () => {
    uniforms.uExit.value = exit;
    uniforms.uExitRate.value = exitRate;
    uniforms.uPhase.value = phase;
    uniforms.uPhaseRate.value = phaseVel;
    uniforms.uFlare.value = flare;
    uniforms.uFlareRate.value = flareVel;
  };

  const rollVortex = (wantDir = 0, speed = 1) => {
    const tiltX = (Math.random() * 2 - 1) * MAX_TILT_X;
    const tiltZ = (Math.random() * 2 - 1) * MAX_TILT_Z;
    const dir = wantDir || (Math.random() < 0.5 ? -1 : 1);
    uniforms.uSwirl.value.set(
      tiltX,
      tiltZ,
      dir * (0.8 + Math.random() * 0.9) * speed,
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
    // `dir` (+1/-1) and `speed` (a multiplier) are optional; see strikeDir. `gather` makes the
    // sparks stream in from outside instead of erupting from the garment (a charge does).
    strike(dir = 0, speed = 1, { gather = false } = {}) {
      strikeQueued = true;
      releaseQueued = false;
      strikeDir = dir;
      strikeSpeed = speed;
      strikeGather = gather ? 1 : 0;
    },
    // Keep a live swarm going instead of replacing it: a pending release is dropped, and one
    // already under way is rewound, so the dying sparks pull back into orbit. With nothing alive
    // (or a strike already queued) this is just a strike. `kick` throws the swarm outward a
    // little, on the flare's spring.
    stir(now, dir = 0, speed = 1, { gather = false, kick = 0 } = {}) {
      if (strikeQueued || !alive(now)) {
        // A fresh eruption is exactly a strike: the kick is for a swarm that was already out.
        this.strike(dir, speed, { gather });
        return;
      }
      releaseQueued = false;
      if (exit >= 0) rewinding = true;
      blasting = false;
      activeAt = now;
      pendingFlareKick += kick;
    },
    // Dissipate, on the next drawn frame.
    release() {
      releaseQueued = true;
    },
    // Dissipate by blasting outward: the flare is kicked and left to coast (no spring back).
    explode(power = 1) {
      releaseQueued = true;
      blasting = true;
      flareVel = Math.max(flareVel, 0) + 4 * power;
    },
    // What the driven terms chase, per frame. `push`: the shirt's drag on the swarm (rad/s of
    // extra orbit, signed in the vortex's convention); a strong enough push also turns the
    // swarm's heading its way. `boost`: extra speed along whatever the heading is (a charge).
    // `radius`: a scale on the orbit (0 = rest; -0.5 squeezes it to half).
    setDrive(push, boost = 0, radius = 0) {
      shirtPush = Math.max(-PHASE_MAX, Math.min(PHASE_MAX, push));
      chargeBoost = boost;
      flareTarget = radius;
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
        resetDrive();
      }
      const rawDt = lastNow === null ? 0 : Math.max(0, now - lastNow);
      const dt = Math.min(rawDt, 0.05);
      lastNow = now;
      if (strikeQueued) {
        strikeAt = activeAt = now;
        resetDrive();
        uniforms.uGather.value = strikeGather;
        rollVortex(strikeDir, strikeSpeed);
        heading = Math.sign(uniforms.uSwirl.value.z) || 1;
        strikeQueued = false;
      }
      if (pendingFlareKick) {
        flareVel += pendingFlareKick;
        pendingFlareKick = 0;
      }
      if (releaseQueued && strikeAt !== null) {
        // Already dying, or being pulled back: carry on dying from where it stands.
        if (exit < 0) exit = 0;
        rewinding = false;
        releaseQueued = false;
      }
      if (strikeAt !== null) {
        // Exit: real time while it dies (a sleep off screen still counts), undone while stirred.
        if (rewinding) {
          exit -= REWIND * dt;
          exitRate = -REWIND;
          if (exit <= 0) {
            exit = -1;
            exitRate = 1;
            rewinding = false;
          }
        } else if (exit >= 0) {
          exit += rawDt;
          exitRate = 1;
        }
        // Being driven (a spin or a charge under way) counts as being kept alive.
        if (exit < 0 && (Math.abs(shirtPush) > 0.5 || chargeBoost > 0.5 || flareTarget < -0.05)) {
          activeAt = now;
        }
        if (Math.abs(shirtPush) > HEADING_SWITCH) heading = Math.sign(shirtPush);
        // Cancels the vortex's own orbit and runs it the heading's way instead (phase enters the
        // shader at half weight, hence the 2).
        const z = uniforms.uSwirl.value.z;
        phaseTarget = 2 * (heading * Math.abs(z) - z) + shirtPush + heading * chargeBoost;
        phaseVel += (phaseTarget - phaseVel) * (1 - Math.exp(-PHASE_FOLLOW * dt));
        phase += phaseVel * dt;
        if (blasting) flareVel *= Math.exp(-BLAST_C * dt);
        else flareVel += (FLARE_K * (flareTarget - flare) - FLARE_C * flareVel) * dt;
        flare += flareVel * dt;
      }
      if (paletteStart === null) paletteStart = now;
      if (paletteStart >= 0) {
        const mix = Math.min(1, (now - paletteStart) / Math.max(paletteDuration, 0.001));
        writeColors(easeInOut(mix));
        if (mix >= 1) paletteStart = -1;
      }
      points.visible = enabled && alive(now);
      uniforms.uAge.value = strikeAt === null ? 0 : now - strikeAt;
      writeDrive();
    },
    // For a caller that draws frames from a timeline, in any order (the ad builder's explainer):
    // the event's times are given outright instead of being queued against the frame clock. The
    // vortex is rolled once, on the first call, so scrubbing back and forth shows one swirl.
    pose(now, at, releasedAt) {
      if (!posed) {
        rollVortex();
        posed = true;
      }
      const released = releasedAt !== null && now >= releasedAt;
      strikeAt = now >= at ? at : null;
      activeAt = strikeAt;
      resetDrive();
      if (released) exit = now - releasedAt;
      uniforms.uGather.value = 0;
      points.visible = enabled && alive(now);
      uniforms.uAge.value = strikeAt === null ? 0 : now - strikeAt;
      writeDrive();
    },
    dispose() {
      geometry.dispose();
      material.dispose();
      target.dispose();
    }
  };
}
