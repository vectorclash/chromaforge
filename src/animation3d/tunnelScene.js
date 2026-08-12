import * as THREE from 'three';
import tinycolor from 'tinycolor2';
import { nLerp, valueNoise } from '../render/valueNoise';
import { makeRng, randomPalette } from '../render/prng';
import { resolveScenePalette } from './scenePalette';
import { getGeometrySettings } from '../render/designSettings';
import { LOGO_SCREEN_FRACTION } from '../utils/logoIntro';
import { drawLogoMark } from '../render/renderLogoMark';
// The -3d sprites are the sound-generator example's INVERTED variants (bright core on
// transparent, built for additive blending) -- not the 2D pipeline's star sprites, which
// are authored for the createjs canvas compositing and read wrong as additive points.
import largeStarUrl from '../assets/images/star-sprite-large-3d.png';
import smallStarUrl from '../assets/images/star-sprite-small-3d.png';

// 3D animation mode: a deterministic star-tunnel scene the camera flies through, styled
// after the 2D artwork (same palette, same lattice structure as GenerateGeometricShape's
// vector-equilibrium web, gradient-field background). Everything is a pure function of
// (seed, colors, settings, duration): the scene builds identically for the same design,
// and setTime(t) drives ALL motion/color from the GSAP timeline's clock — no internal
// clock anywhere — so preview stepping and frame-exact MP4 export share one code path.
//
// Seamless loop: star placement, lattice stations, and camera travel are all periodic in
// the scene's content length L (camera z wraps modulo it, content repeats modulo it),
// and every time-varying term is built from sin/cos of (2π · t/duration · integer), so
// setTime(0) and setTime(duration) produce identical frames.
//
// Flight speed is CONSTANT regardless of duration (Aaron's original intent — a longer
// duration means MORE tunnel to fly through at the same pace, not the same tunnel
// slower): the factory builds L = FLIGHT_SPEED · duration world units of unique content,
// capped at MAX_CONTENT_LENGTH; past the cap the camera does an exact integer number of
// laps of the content per cycle (still seamless — content is periodic in L and colors
// evolve over the FULL cycle, so repeat laps read color-shifted, not identical).

const FLIGHT_SPEED = 240; // world units/sec — constant across durations (ramp peak ≈ ×3.23)
const MAX_CONTENT_LENGTH = 2400; // unique-content cap; longer cycles lap it (integer times)
const REFERENCE_LENGTH = 400; // density reference: all per-length counts were tuned at this
const TUNNEL_RADIUS = 46; // outer radius of the star tube
const TUNNEL_CORE = 5; // stars keep clear of this radius so the camera path stays open
// Counts are per REFERENCE_LENGTH of tunnel; the factory scales them by L/REFERENCE_LENGTH
// (linearly for shared-buffer stars, by sqrt for individually-drawn sprites, which are
// draw-call-bound rather than vertex-bound).
const SMALL_STAR_COUNT = 5000;
const FAR_STAR_COUNT = 7000; // second shell beyond the tunnel wall — deep-space backdrop
const FAR_STAR_RADIUS = 140;
const LARGE_STAR_COUNT = 90;
const NEBULA_COUNT = 24; // palette-colored glow clouds per reference length
// Lowered from 0.016 when geometry started living far off the camera path — FogExp2 at
// 0.016 made anything past ~100 units effectively invisible; 0.009 keeps distant giants
// readable while still fading things in as the camera approaches.
const FOG_DENSITY = 0.009;
const BG_COLOR = 0x0a0a12;

const TWO_PI = Math.PI * 2;

// ─── Space-warp distance compression ───────────────────────────────────────────────────
// Everything used to pop into existence at the content-coverage edge (~400 units ahead)
// — especially the unfogged stars. Instead of fading, distant content is now COMPRESSED
// toward the vanishing point: a vertex-level warp scales view-space lateral position
// (and sprite size) down to zero between WARP_START and WARP_END, so new content is born
// as a point on the camera axis and expands/unfolds outward as it approaches — reads as
// extreme distance / relativistic rushing-in rather than pop-in.
const WARP_START = 100; // no distortion inside this view distance
const WARP_END = 395; // fully collapsed to the axis beyond this (inside the 400 coverage)
// Speed-ramp rush enhancement (setTime's `rush` arg, 0..1): at full rush the warp's
// onset distance is pulled this much closer to the camera (content stays funneled
// toward the vanishing point far longer — the tunnel visibly stretches ahead) and the
// FOV widens by RUSH_FOV_BOOST degrees. Both scale linearly with rush, which is 0 at
// the loop seam, so the resting look and loop-seamlessness are untouched.
const RUSH_WARP_PULL = 55;
const RUSH_FOV_BOOST = 14;
const BASE_FOV = 70;
// Star streaking, also driven by rush: every star gets a companion pair of line segments
// along the flight axis whose half-length and opacity scale from nothing at rest to
// STREAK_* at the burst's peak, so the field smears into light-speed streaks and settles
// back to plain points. The layer is hidden outright below RUSH_STREAK_EPS, so the
// resting scene is exactly the one that existed before streaking — and since rush is 0 at
// the loop seam, the seam frame is unaffected and the loop stays seamless.
// STREAK_LENGTH is a look value, not a physical shutter smear: a real frame of travel at
// the peak (~15 units at 30fps) reads as solid lines rather than streaks.
const STREAK_LENGTH = 12;
const STREAK_OPACITY = 0.45;
const STREAK_END_FADE = 0.25; // brightness at a streak's tips, relative to the star
const RUSH_STREAK_EPS = 0.002;

// Mirror of the shader smoothstep for JS-driven sprites (large stars, nebulae).
// `start` is the current (possibly rush-pulled) warp onset distance.
function warpFactor(d, start = WARP_START) {
  if (d <= start) return 1;
  if (d >= WARP_END) return 0;
  const t = (d - start) / (WARP_END - start);
  return 1 - t * t * (3 - 2 * t);
}

// Injects the warp into any chunk-based three.js material (Points/Line/Mesh basic
// materials all share the project_vertex chunk). Pure function of view-space position
// and the scene's shared uWarpStart uniform — deterministic, loop-safe, identical in
// preview and export (the uniform is only ever set from setTime's rush arg).
// `uStreak` (optional) turns the material into the streak layer: each vertex carries an
// `aStreak` attribute in [-1, 1] giving its position along the trail, extruded along the
// flight axis by the uniform's half-length and dimmed toward the tips. Doing it in the
// shader keeps the per-frame JS work to two uniform writes no matter how many stars
// there are, and keeps the extrusion deterministic (a pure function of rush).
function applyWarpShader(mat, uWarpStart, uStreak = null) {
  mat.onBeforeCompile = shader => {
    shader.uniforms.uWarpStart = uWarpStart;
    let decls = 'uniform float uWarpStart;\n';
    if (uStreak) {
      shader.uniforms.uStreak = uStreak;
      decls += 'uniform float uStreak;\nattribute float aStreak;\n';
      shader.vertexShader = shader.vertexShader.replace(
        '#include <begin_vertex>',
        `
      #include <begin_vertex>
      transformed.z += aStreak * uStreak;
      `
      );
      // Taper the trail's brightness toward both tips. The middle vertex of each star's
      // pair of segments sits at aStreak 0, so the line interpolates bright core → dim
      // tip rather than reading as a uniform bar.
      shader.vertexShader = shader.vertexShader.replace(
        '#include <color_vertex>',
        `
      #include <color_vertex>
      vColor *= mix(1.0, ${STREAK_END_FADE.toFixed(2)}, abs(aStreak));
      `
      );
    }
    shader.vertexShader =
      decls +
      shader.vertexShader.replace(
        '#include <project_vertex>',
        `
      vec4 mvPosition = vec4( transformed, 1.0 );
      mvPosition = modelViewMatrix * mvPosition;
      float warpD = -mvPosition.z;
      float warpT = smoothstep(uWarpStart, ${WARP_END.toFixed(1)}, warpD);
      mvPosition.xy *= (1.0 - warpT);
      gl_Position = projectionMatrix * mvPosition;
      `
      );
  };
  return mat;
}

// Streak layer for one star field: ONE segment per star, anchored at the star (aStreak 0,
// full brightness) and trailing away from it (aStreak 1, faded to STREAK_END_FADE).
//
// The trail extends toward +z — AWAY from the camera — which is genuinely where a star
// has been, not where it is going: the stars are static and the camera flies toward +z,
// so in camera-relative terms every star travels from far to near and the smear covers
// the ground already crossed. On screen that puts the bright head at the star's own
// position with the tail receding toward the vanishing point, which is also the classic
// hyperspace read. An earlier version straddled the star (-1 → 0 → +1) and looked wrong
// for exactly this reason (Aaron, 2026-07-28).
//
// Positions never change — the shader extrudes them — so only the color buffer is
// rewritten per frame, and only while the streaks are actually visible.
function makeStarStreaks(field, uWarpStart, uStreak) {
  const n = field.count;
  const pos = new Float32Array(n * 2 * 3);
  const col = new Float32Array(n * 2 * 3);
  const dir = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    const x = field.pos[i * 3];
    const y = field.pos[i * 3 + 1];
    const z = field.pos[i * 3 + 2];
    for (let v = 0; v < 2; v++) {
      pos[(i * 2 + v) * 3] = x;
      pos[(i * 2 + v) * 3 + 1] = y;
      pos[(i * 2 + v) * 3 + 2] = z;
    }
    dir[i * 2] = 0; // at the star
    dir[i * 2 + 1] = 1; // tail tip, one full streak length behind
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setAttribute('aStreak', new THREE.BufferAttribute(dir, 1));
  const mat = applyWarpShader(
    new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: false
    }),
    uWarpStart,
    uStreak
  );
  const lines = [];
  const sync = () => {
    const src = field.colors;
    for (let i = 0; i < n; i++) {
      const s = i * 3;
      const r = src[s];
      const g = src[s + 1];
      const b = src[s + 2];
      for (let v = 0; v < 2; v++) {
        const d = (i * 2 + v) * 3;
        col[d] = r;
        col[d + 1] = g;
        col[d + 2] = b;
      }
    }
    geo.attributes.color.needsUpdate = true;
  };
  return { geo, mat, lines, sync };
}

// ─── Noise ──────────────────────────────────────────────────────────────────
// Deterministic, no RNG involved. Shared with the About section's hexagon dust, which
// clusters its specks the same way — see render/valueNoise.js.

const CLUSTER = {
  freqLarge: 0.04,
  freqMid: 0.1,
  freqFine: 0.28,
  ampLarge: 0.6,
  ampMid: 0.28,
  ampFine: 0.12,
  contrast: 7,
  fill: 3.5
};
// Sampled on tube coordinates wrapped onto a torus in z so density (and therefore star
// clustering) is itself periodic in the content length L — clusters at z=0 continue
// seamlessly from z=L.
function clusterDensity(x, y, z, L) {
  const zAng = (z / L) * TWO_PI;
  const R = L / TWO_PI;
  const tx = Math.cos(zAng) * R;
  const tz = Math.sin(zAng) * R;
  const n = (fx, fy, fz, freq) => valueNoise(fx * freq, fy * freq, fz * freq);
  return (
    n(x + tx, y, tz, CLUSTER.freqLarge) * CLUSTER.ampLarge +
    n(x + tx, y, tz, CLUSTER.freqMid) * CLUSTER.ampMid +
    n(x + tx, y, tz, CLUSTER.freqFine) * CLUSTER.ampFine
  );
}

// ─── Palette helpers ───────────────────────────────────────────────────────────────────
// paletteAt(colors, t) — cyclic interpolation through the design's palette in HSL, with
// t in [0, 1) wrapping back to colors[0], so any color journey driven by timeline
// progress lands exactly where it started (loop-safe).
function toHsl(hex) {
  const { h, s, l } = tinycolor(hex).toHsl();
  return { h: h / 360, s, l };
}
function hueLerp(a, b, t) {
  let d = b - a;
  if (d > 0.5) d -= 1;
  if (d < -0.5) d += 1;
  return (a + d * t + 1) % 1;
}
function paletteAtHsl(hsls, t) {
  const n = hsls.length;
  const x = ((t % 1) + 1) % 1 * n;
  const i = Math.floor(x) % n;
  const j = (i + 1) % n;
  const f = x - Math.floor(x);
  return {
    h: hueLerp(hsls[i].h, hsls[j].h, f),
    s: nLerp(hsls[i].s, hsls[j].s, f),
    l: nLerp(hsls[i].l, hsls[j].l, f)
  };
}

// Star "personalities", adapted from the sound-generator: a mix of palette-tracking
// stars (drift through the design's colors over the cycle) and fixed astronomical types
// (blue-white, warm, near-white) that anchor the field so it always reads as space.
function starPersonality(rng) {
  const t = rng();
  if (t < 0.55) {
    // Palette-tracking — small per-star hue offset around the cycling palette color
    return {
      fixed: false,
      hue: (rng() - 0.5) * 0.08,
      sat: 0.8 + rng() * 0.2,
      lit: 0.5 + rng() * 0.18
    };
  } else if (t < 0.72) {
    // Blue-white (O/B type)
    return { fixed: true, hue: 0.55 + rng() * 0.1, sat: 0.65 + rng() * 0.3, lit: 0.55 + rng() * 0.18 };
  } else if (t < 0.8) {
    // Warm orange (K/M type)
    return { fixed: true, hue: 0.04 + rng() * 0.06, sat: 0.85 + rng() * 0.15, lit: 0.48 + rng() * 0.16 };
  }
  // Near-white / neutral
  return { fixed: false, hue: (rng() - 0.5) * 0.2, sat: 0.08 + rng() * 0.18, lit: 0.68 + rng() * 0.2 };
}

// ─── Star layers ────────────────────────────────────────────────────────────────────────
// Noise-clustered rejection sampling in a tube: pick (angle, radius, z), keep with
// probability from clusterDensity — same organic clumping as the 2D-app-adjacent example,
// bent into a tunnel.
function makeStarField(rng, count, L, rMin = TUNNEL_CORE, rMax = TUNNEL_RADIUS) {
  const pos = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const fixed = new Uint8Array(count);
  const hue = new Float32Array(count);
  const sat = new Float32Array(count);
  const lit = new Float32Array(count);
  // Per-star phase offset into the palette cycle keyed to tunnel depth, so color change
  // sweeps along the tunnel rather than flashing everywhere at once.
  const cyclePhase = new Float32Array(count);

  let placed = 0;
  let guard = count * 400; // rejection sampling escape hatch — never hangs a bad seed
  while (placed < count && guard-- > 0) {
    const ang = rng() * TWO_PI;
    // sqrt for uniform area density before the noise re-clumps it
    const r = rMin + Math.sqrt(rng()) * (rMax - rMin);
    const z = rng() * L;
    const x = Math.cos(ang) * r;
    const y = Math.sin(ang) * r;
    const d = clusterDensity(x, y, z, L);
    if (rng() > Math.pow(d, CLUSTER.contrast) * CLUSTER.fill) continue;

    pos[placed * 3] = x;
    pos[placed * 3 + 1] = y;
    pos[placed * 3 + 2] = z;

    const p = starPersonality(rng);
    fixed[placed] = p.fixed ? 1 : 0;
    hue[placed] = p.hue;
    sat[placed] = p.sat;
    lit[placed] = p.lit;
    cyclePhase[placed] = z / L;
    placed++;
  }

  return { pos, colors, fixed, hue, sat, lit, cyclePhase, count: placed };
}

// ─── Background shader ──────────────────────────────────────────────────────────────────
// A camera-locked sphere rendered behind everything: drifting value-noise blobs of the
// design's palette over a dark base — the 3D counterpart of the 2D radial gradient
// fields. All time terms are sin/cos of (2π·progress·k): exactly periodic per cycle.
const BG_VERT = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = position;
    // Strip translation so the sphere is locked to the camera (skybox-style)
    vec4 mv = viewMatrix * vec4(position + cameraPosition, 1.0);
    gl_Position = projectionMatrix * mv;
  }
`;
const BG_FRAG = /* glsl */ `
  precision highp float;
  varying vec3 vDir;
  uniform vec3 uColors[4];
  uniform float uProgress; // timeline progress 0..1, loops
  uniform float uSeed;

  float hash(vec3 p) {
    return fract(sin(dot(p, vec3(127.1, 311.7, 74.7)) + uSeed) * 43758.5453);
  }
  float noise(vec3 p) {
    vec3 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(mix(hash(i), hash(i + vec3(1,0,0)), f.x),
          mix(hash(i + vec3(0,1,0)), hash(i + vec3(1,1,0)), f.x), f.y),
      mix(mix(hash(i + vec3(0,0,1)), hash(i + vec3(1,0,1)), f.x),
          mix(hash(i + vec3(0,1,1)), hash(i + vec3(1,1,1)), f.x), f.y),
      f.z);
  }

  void main() {
    vec3 d = normalize(vDir);
    float a = uProgress * 6.2831853;
    // Periodic drift offsets — integer multiples of the cycle so t=0 == t=1
    vec3 drift1 = vec3(sin(a), cos(a), sin(a * 2.0)) * 0.55;
    vec3 drift2 = vec3(cos(a * 2.0), sin(a * 3.0), cos(a)) * 0.35;

    // Full-coverage mesh gradient: the four palette colors own regions of the sky and
    // hand dominance around over the cycle -- a NORMALIZED weighted mix (never additive
    // over black), so the whole dome is saturated color edge to edge like the 2D
    // artwork's gradient fields, not dark space with tinted patches.
    float w0 = pow(noise(d * 1.6 + drift2 + 11.0), 2.0) * (0.65 + 0.35 * sin(a));
    float w1 = pow(noise(d * 2.3 + drift1), 2.0)        * (0.65 + 0.35 * sin(a + 1.5707963));
    float w2 = pow(noise(d * 3.1 + drift2 + 7.3), 2.0)  * (0.65 + 0.35 * sin(a + 3.1415927));
    float w3 = pow(noise(d * 1.3 - drift1 + 3.1), 2.0)  * (0.65 + 0.35 * sin(a + 4.7123890));
    float sum = w0 + w1 + w2 + w3 + 1e-4;
    vec3 col = (uColors[0] * w0 + uColors[1] * w1 + uColors[2] * w2 + uColors[3] * w3) / sum;

    // Brightness varies with its own noise field: glowing hot spots vs deep shaded
    // regions, echoing the 2D radial-gradient light. Never fully black.
    float lum = 0.30 + 0.75 * pow(noise(d * 2.0 + drift1 + 19.0), 1.5)
              + 0.25 * pow(noise(d * 5.0 - drift2 + 5.0), 2.0);
    col *= lum;

    gl_FragColor = vec4(col, 1.0);
  }
`;

// ─── Geometric tunnel ─────────────────────────────────────────────────────────────────
// The geometry layer is a continuous lattice TUNNEL the camera flies through — the 2D
// coherent artwork's polygon-ring-and-chord structure swept along the flight path. This
// replaced two earlier attempts (scattered floating lattice monuments, then noise-driven
// floating shards) that never read as intentional: pop-in at the fog line looked wrong,
// and isolated shapes felt arbitrary. A tunnel is always present (no pop-in — it recedes
// into fog ahead and behind), inherently reads as travel, and is literally the brand's
// own geometry.
//
// Structure — reworked for variety (Aaron: "it feels a little samey across the whole
// animation"). One cycle of tunnel is now a sequence of seeded ZONES, each with its own
// architecture (polygon side count from the design's points sliders, radius scale, wire/
// panel density, ripple energy, twist rate, ring-spacing clumpiness), punctuated by 1–2
// dense multi-ring "gate" set-pieces, all threaded on a gently curving centerline (the
// camera still flies dead-straight — the BORE sweeps around it). A second, sparser
// counter-twisted web sits outside the bore for parallax. Ring spacing clusters and gaps
// instead of being metronomic; panels come in three styles (facet / dimmed full-quad
// sail / bright accent). Everything stays a pure function of the seed, and everything is
// periodic in the content length L: ring N wraps to ring 0 via +L offsets with nearest-angle
// index mapping (which also bridges rings of different side counts at zone boundaries),
// and all motion/profiles use integer cycle frequencies — so exports still loop
// seamlessly.
function buildGeometricTunnel(rng, geometry, uWarpStart, L) {
  const clampNum = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
  // Length scaling: counts stretch linearly with content length so structure density
  // per unit distance stays what it was tuned at (REFERENCE_LENGTH); integer spatial
  // frequencies (which live in wrap-safe zFrac space) scale by the rounded factor so
  // bends/waves-per-distance stay constant too — still integers, so still loop-safe.
  const lenScale = L / REFERENCE_LENGTH;
  const fScale = Math.max(1, Math.round(lenScale));
  // coherence 0 (the default) = ragged, hand-bent scaffold; 1 = clean geometric bore
  const jitterBase = 0.45 * (1 - geometry.coherence);
  // `size` scales the whole structure (bore + outer web); `chance` scales structural
  // density (wires/panels). Both are pure multipliers with defaults ≡ 1 (size 0.5,
  // chance 0.4), so default-settings scenes are unchanged and no rng draws move.
  const sizeScale = 0.55 + geometry.size * 0.9;
  const densityScale = 0.35 + geometry.chance * 1.625;
  const radiusBase = (15 + rng() * 9) * sizeScale; // camera flies inside

  // Long-wavelength breathing + complexity waves (integer frequencies → loop-safe)
  const radFreq1 = (1 + Math.floor(rng() * 2)) * fScale;
  const radFreq2 = (2 + Math.floor(rng() * 3)) * fScale;
  const radPhase1 = rng() * TWO_PI;
  const radPhase2 = rng() * TWO_PI;
  const radiusWaveAt = (zFrac) =>
    1 +
    0.35 * Math.sin(zFrac * TWO_PI * radFreq1 + radPhase1) +
    0.18 * Math.sin(zFrac * TWO_PI * radFreq2 + radPhase2);
  const cxFreq = (1 + Math.floor(rng() * 3)) * fScale;
  const cxPhase = rng() * TWO_PI;
  const complexityAt = (zFrac) =>
    0.575 + 0.425 * Math.sin(zFrac * TWO_PI * cxFreq + cxPhase);

  // Zones: 3–5 stretches of the cycle, each rolling its own architecture.
  // High coherence pulls every zone toward one shared, orderly character (uniform twist,
  // even spacing, calm ripple) — the slider changes the whole build philosophy, not just
  // vertex jitter. All of it is a no-op at coherence 0.
  const coh = geometry.coherence;
  const globalTwist = (0.05 + rng() * 0.15) * (rng() < 0.5 ? -1 : 1);
  const zoneCount = Math.max(2, Math.round((3 + Math.floor(rng() * 3)) * lenScale));
  const zones = [];
  {
    const weights = [];
    let sum = 0;
    for (let i = 0; i < zoneCount; i++) {
      const w = 0.6 + rng();
      weights.push(w);
      sum += w;
    }
    let acc = 0;
    for (let i = 0; i < zoneCount; i++) {
      const end = acc + weights[i] / sum;
      // Zone archetype: most zones are 'normal'; some roll 'sparse' (a near-empty
      // breather stretch — a few bare ribs, almost no panels) or 'caged' (densely
      // webbed, panel-heavy). Distinct architecture changes read as travel through
      // different places, where continuous parameter drift alone read as samey.
      const styleRoll = rng();
      const style = styleRoll < 0.2 ? 'sparse' : styleRoll < 0.45 ? 'caged' : 'normal';
      zones.push({
        end,
        style,
        wireMul: style === 'sparse' ? 0.3 : style === 'caged' ? 1.6 : 1,
        panelMul: style === 'sparse' ? 0.25 : style === 'caged' ? 1.5 : 1,
        // Per-zone palette emphasis: each stretch of tunnel leans on a different part
        // of the design's palette, so added colors show up as visibly distinct zones.
        paletteOffset: rng(),
        sides:
          geometry.pointsMin +
          Math.round(rng() * (geometry.pointsMax - geometry.pointsMin)),
        radiusScale: 0.6 + rng() * 0.75,
        density: 0.3 + rng() * 1.0,
        rippleAmp: (0.02 + rng() * 0.14) * (1 - 0.7 * coh), // calm, precise motion when coherent
        twistRate:
          (0.05 + rng() * 0.15) * (rng() < 0.5 ? -1 : 1) * (1 - coh) +
          globalTwist * coh, // one uniform corkscrew at full coherence
        spacingVar: (0.25 + rng() * 0.95) * (1 - coh) // metronomic ring spacing at 1
      });
      acc = end;
    }
  }
  const zoneAt = (zFrac) => {
    const t = ((zFrac % 1) + 1) % 1;
    for (const z of zones) if (t < z.end) return z;
    return zones[zones.length - 1];
  };
  // Bore radius: zone scale steps at boundaries (an intentional architecture change),
  // the breathing wave moves smoothly within them. Clamped so the camera always clears
  // the wall and the bore stays inside the outer web.
  const boreRadiusAt = (zFrac) =>
    clampNum(radiusBase * zoneAt(zFrac).radiusScale * radiusWaveAt(zFrac), 8, 34 * sizeScale);

  // Curved centerline: the bore drifts laterally around the straight camera path.
  // Amplitude scales with (radius - 8) so the camera is always comfortably inside.
  const pfx1 = (1 + Math.floor(rng() * 2)) * fScale;
  const pfx2 = (2 + Math.floor(rng() * 2)) * fScale;
  const pfy1 = (1 + Math.floor(rng() * 2)) * fScale;
  const pfy2 = (2 + Math.floor(rng() * 2)) * fScale;
  const ppx1 = rng() * TWO_PI;
  const ppx2 = rng() * TWO_PI;
  const ppy1 = rng() * TWO_PI;
  const ppy2 = rng() * TWO_PI;
  const pathAt = (zFrac, r) => {
    const s = 0.45 * Math.max(0, r - 8);
    return [
      (0.62 * Math.sin(zFrac * TWO_PI * pfx1 + ppx1) +
        0.38 * Math.sin(zFrac * TWO_PI * pfx2 + ppx2)) * s,
      (0.62 * Math.sin(zFrac * TWO_PI * pfy1 + ppy1) +
        0.38 * Math.sin(zFrac * TWO_PI * pfy2 + ppy2)) * s
    ];
  };

  // Ring list: clustered spacing (rings clump and gap per the zone's spacingVar), plus
  // 1–2 "gates" — several rings packed 2.2 units apart with dense chord webs, the 2D
  // vector-equilibrium look as a flythrough set-piece.
  const rings = []; // { z, sides, step, ang0, r, zone, gate, outer, start }
  {
    const baseCount = Math.round((30 + Math.floor(rng() * 10)) * lenScale);
    const ws = [];
    let sum = 0;
    for (let i = 0; i < baseCount; i++) {
      const zn = zoneAt(i / baseCount);
      const w = 0.4 + rng() * 1.4 * zn.spacingVar;
      ws.push(w);
      sum += w;
    }
    let z = 0;
    for (let i = 0; i < baseCount; i++) {
      rings.push({ z, gate: false, outer: false });
      z += (ws[i] / sum) * L;
    }
  }
  const gateCount = Math.max(1, Math.round((1 + Math.floor(rng() * 2)) * lenScale));
  for (let g = 0; g < gateCount; g++) {
    const zc = rng() * L;
    const n = 3 + Math.floor(rng() * 2);
    for (let k = 0; k < n; k++) {
      rings.push({ z: (zc + k * 2.2) % L, gate: true, outer: false });
    }
  }
  rings.sort((a, b) => a.z - b.z);
  {
    let ang0 = rng() * TWO_PI;
    for (const ring of rings) {
      const zn = zoneAt(ring.z / L);
      ang0 += zn.twistRate;
      ring.zone = zn;
      ring.sides = zn.sides;
      ring.step = TWO_PI / zn.sides;
      ring.ang0 = ang0;
      ring.r = boreRadiusAt(ring.z / L) * (ring.gate ? 1.15 : 1); // gates flare
    }
  }

  // Outer web: a sparser, counter-twisting second lattice outside the bore — two layers
  // of structure in parallax reads far more complex than one.
  const outerRings = [];
  {
    const oSides = 5 + Math.floor(rng() * 4);
    const oCount = Math.round((10 + Math.floor(rng() * 5)) * lenScale);
    const oRadius = (38 + rng() * 5) * sizeScale;
    const oTwist = (0.1 + rng() * 0.2) * (rng() < 0.5 ? -1 : 1);
    let oa = rng() * TWO_PI;
    for (let i = 0; i < oCount; i++) {
      oa += oTwist;
      outerRings.push({
        z: ((i + rng() * 0.4) / oCount) * L,
        sides: oSides,
        step: TWO_PI / oSides,
        ang0: oa,
        r: oRadius,
        zone: null,
        gate: false,
        outer: true
      });
    }
  }

  const allRings = rings.concat(outerRings);
  let vertCount = 0;
  for (const ring of allRings) {
    ring.start = vertCount;
    vertCount += ring.sides;
  }
  const baseAng = new Float32Array(vertCount);
  const baseR = new Float32Array(vertCount);
  const baseZ = new Float32Array(vertCount);
  const centerX = new Float32Array(vertCount); // static curved-centerline offset
  const centerY = new Float32Array(vertCount);
  const ripplePhase = new Float32Array(vertCount);
  const rippleFreq = new Uint8Array(vertCount);
  const rippleAmp = new Float32Array(vertCount); // per-zone ripple energy
  const colorJitter = new Float32Array(vertCount); // per-vertex palette phase offset
  const dim = new Float32Array(vertCount); // outer web renders fainter
  for (const ring of allRings) {
    const zFrac = ring.z / L;
    // Gates read as machined, not hand-bent — much less jitter than their zone
    const jitter = jitterBase * (ring.gate ? 0.3 : 1) * (ring.outer ? 0.6 : 1);
    const [cx, cy] = pathAt(zFrac, boreRadiusAt(zFrac));
    for (let j = 0; j < ring.sides; j++) {
      const v = ring.start + j;
      baseAng[v] = ring.ang0 + j * ring.step + (rng() - 0.5) * ring.step * jitter;
      baseR[v] = ring.r * (1 + (rng() - 0.5) * jitter);
      baseZ[v] = ring.z + (rng() - 0.5) * jitter * 2.0;
      centerX[v] = cx;
      centerY[v] = cy;
      ripplePhase[v] = rng() * TWO_PI;
      rippleFreq[v] = 1 + Math.floor(rng() * 3); // 1–3 ripples per cycle
      rippleAmp[v] = ring.outer
        ? 0.04
        : ring.zone.rippleAmp * (ring.gate ? 0.5 : 1);
      // Wide per-vertex palette offset: adjacent corners land on genuinely different
      // palette stops, so panels get strong multi-color gradients, not near-flat fills.
      // The zone's paletteOffset shifts the whole stretch's emphasis so different tunnel
      // sections visibly foreground different palette colors.
      colorJitter[v] = (rng() - 0.5) * 0.3 + (ring.zone ? ring.zone.paletteOffset : 0);
      dim[v] = ring.outer ? 0.65 : 1;
    }
  }

  // Elements reference vertex indices; zOff carries seam-crossing endpoints one period
  // forward so the last ring connects to (ring 0 + L). Rings with different
  // side counts (zone boundaries, the wrap) are bridged by nearest-ideal-angle mapping.
  const vidx = (ring, j) => ring.start + (((j % ring.sides) + ring.sides) % ring.sides);
  const mapJ = (ringA, j, ringB) =>
    Math.round((ringA.ang0 + j * ringA.step - ringB.ang0) / ringB.step);
  const edges = []; // { a, b, aOff, bOff }
  const panels = []; // { v: [3 indices], off: [3 zOffsets], mul: color multiplier }
  const connectChain = (chain, { wireScale, panelScale }) => {
    for (let i = 0; i < chain.length; i++) {
      const A = chain[i];
      const B = chain[(i + 1) % chain.length];
      const off = i + 1 === chain.length ? L : 0;
      const zFrac = A.z / L;
      const densityMul = (A.zone ? 0.35 + A.zone.density : 1) * densityScale;
      const zoneWireMul = A.zone ? A.zone.wireMul : 1;
      const zonePanelMul = A.zone ? A.zone.panelMul : 1;
      // Patchy wireframe: each ring section rolls its own wire density — some sections
      // nearly bare, others fully caged — modulated by the zone and complexity wave.
      // Coherence raises the wire floor: less patchy, closer to a complete cage
      const wire = clampNum(
        (0.15 + rng() * 0.85 + coh * 0.4) *
          complexityAt(zFrac) * densityMul * zoneWireMul * (A.gate ? 2.2 : 1) * wireScale,
        0,
        1.15
      );
      const panelChance =
        (0.28 + geometry.coherence * 0.3) *
        complexityAt(zFrac) *
        densityMul *
        zonePanelMul *
        panelScale *
        (A.gate ? 0.5 : 1); // gates are wire showpieces, not panel walls
      for (let j = 0; j < A.sides; j++) {
        const jB = mapJ(A, j, B);
        // Ring polygon edge
        if (rng() < 0.8 * wire) edges.push({ a: vidx(A, j), b: vidx(A, j + 1), aOff: 0, bOff: 0 });
        // Longitudinal rail to the next ring
        if (rng() < 0.65 * wire) edges.push({ a: vidx(A, j), b: vidx(B, jB), aOff: 0, bOff: off });
        // Diagonal chord
        if (rng() < 0.3 * wire) edges.push({ a: vidx(A, j), b: vidx(B, jB + 1), aOff: 0, bOff: off });
        // Long in-ring chord (the 2D star-web look; gates web up heavily, and high
        // coherence webs the whole tunnel — the 3D echo of 2D full coherence's chord web)
        if (A.sides >= 5 && rng() < (A.gate ? 0.55 : 0.12 + 0.4 * coh) * wire) {
          const skip = 2 + Math.floor(rng() * (Math.floor(A.sides / 2) - 1));
          edges.push({ a: vidx(A, j), b: vidx(A, j + skip), aOff: 0, bOff: 0 });
        }
        // Gradient panels, three styles: single facet (most), a dimmed full-quad "sail"
        // (rare — deliberately solid), or a brighter accent facet.
        if (rng() < panelChance) {
          const roll = rng();
          if (roll < 0.15) {
            panels.push({ v: [vidx(A, j), vidx(B, jB), vidx(B, jB + 1)], off: [0, off, off], mul: 0.8 });
            panels.push({ v: [vidx(A, j), vidx(B, jB + 1), vidx(A, j + 1)], off: [0, off, 0], mul: 0.8 });
          } else if (roll < 0.3) {
            panels.push({ v: [vidx(A, j), vidx(B, jB), vidx(B, jB + 1)], off: [0, off, off], mul: 1.35 });
          } else {
            panels.push(
              rng() < 0.5
                ? { v: [vidx(A, j), vidx(B, jB), vidx(B, jB + 1)], off: [0, off, off], mul: 1 }
                : { v: [vidx(A, j), vidx(A, j + 1), vidx(B, jB + 1)], off: [0, 0, off], mul: 1 }
            );
          }
        }
      }
    }
  };
  connectChain(rings, { wireScale: 1, panelScale: 1 });
  connectChain(outerRings, { wireScale: 0.45, panelScale: 0.15 });

  // Panels blend normally (not additively), so draw order matters: static centroid z per
  // panel, sorted back-to-front against the camera every frame (buffer order = draw
  // order within one mesh). Edges/stars are additive and order-independent.
  const panelZ = new Float32Array(panels.length);
  for (let pIdx = 0; pIdx < panels.length; pIdx++) {
    const { v, off } = panels[pIdx];
    panelZ[pIdx] =
      (baseZ[v[0]] + off[0] + baseZ[v[1]] + off[1] + baseZ[v[2]] + off[2]) / 3;
  }
  const panelOrder = Array.from(panels, (_, i) => i);
  const panelDepth = new Float32Array(panels.length);

  const group = new THREE.Group();

  const edgePositions = new Float32Array(edges.length * 2 * 3);
  const edgeColors = new Float32Array(edges.length * 2 * 3);
  const edgeGeo = new THREE.BufferGeometry();
  edgeGeo.setAttribute('position', new THREE.BufferAttribute(edgePositions, 3));
  edgeGeo.setAttribute('color', new THREE.BufferAttribute(edgeColors, 3));
  const edgeMat = applyWarpShader(new THREE.LineBasicMaterial({
    vertexColors: true,
    transparent: true,
    opacity: 0.55,
    blending: THREE.AdditiveBlending,
    depthWrite: false
  }), uWarpStart);
  const edgeLines = new THREE.LineSegments(edgeGeo, edgeMat);
  edgeLines.frustumCulled = false; // vertices animate every frame
  group.add(edgeLines);

  const panelPositions = new Float32Array(panels.length * 3 * 3);
  const panelColors = new Float32Array(panels.length * 3 * 3);
  const panelGeo = new THREE.BufferGeometry();
  panelGeo.setAttribute('position', new THREE.BufferAttribute(panelPositions, 3));
  panelGeo.setAttribute('color', new THREE.BufferAttribute(panelColors, 3));
  // Normal blending: additive panels wash to white over the colorful background
  const panelMat = applyWarpShader(new THREE.MeshBasicMaterial({
    vertexColors: true,
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 0.85,
    depthWrite: false
  }), uWarpStart);
  const panelMesh = new THREE.Mesh(panelGeo, panelMat);
  panelMesh.frustumCulled = false;
  group.add(panelMesh);

  // Scratch arrays for the per-frame vertex pass. Panels get their OWN color per vertex
  // (fully saturated, brighter) — sharing the edge colors read muted at panel opacity.
  const vertPos = new Float32Array(vertCount * 3);
  const vertCol = new Float32Array(vertCount * 3);
  const vertColPanel = new Float32Array(vertCount * 3);
  const shimmerAmp = 0.04 * (1 - 0.8 * coh); // angular wobble stills as coherence rises
  const _c = new THREE.Color();

  // update(progress, paletteHsl): one pass computes every ring vertex's animated
  // position (radial ripple traveling down the tunnel — phase advances with z — plus a
  // slight angular shimmer) and its color (the palette cycling along the tunnel's length
  // AND through time, so a wave of the design's colors flows toward the camera), then
  // scatters both into the edge/panel buffers.
  // camZ comes from the caller (setTime) since the camera may lap the content multiple
  // times per cycle — this function only needs the wrapped position for depth sorting.
  function update(progress, paletteHsl, camZ) {
    const a = progress * TWO_PI;
    for (let v = 0; v < vertCount; v++) {
      const zFrac = baseZ[v] / L;
      const ripple =
        1 + rippleAmp[v] * Math.sin(a * rippleFreq[v] + ripplePhase[v] + zFrac * TWO_PI * 2 * fScale);
      const ang = baseAng[v] + shimmerAmp * Math.sin(a + ripplePhase[v]);
      const r = baseR[v] * ripple;
      vertPos[v * 3] = Math.cos(ang) * r + centerX[v];
      vertPos[v * 3 + 1] = Math.sin(ang) * r + centerY[v];
      vertPos[v * 3 + 2] = baseZ[v];

      const p = paletteAtHsl(paletteHsl, zFrac * 2 * fScale + progress + colorJitter[v]);
      _c.setHSL(p.h, Math.min(1, p.s + 0.2), Math.min(0.68, p.l + 0.12));
      vertCol[v * 3] = _c.r * dim[v];
      vertCol[v * 3 + 1] = _c.g * dim[v];
      vertCol[v * 3 + 2] = _c.b * dim[v];
      // Panel variant: full chroma at MID lightness — pushing lightness too high reads
      // pastel/white, not colorful; vivid lives at s=1, l≈0.5 (checked against renders)
      _c.setHSL(p.h, 1, Math.max(0.45, Math.min(0.58, p.l + 0.06)));
      vertColPanel[v * 3] = _c.r * dim[v];
      vertColPanel[v * 3 + 1] = _c.g * dim[v];
      vertColPanel[v * 3 + 2] = _c.b * dim[v];
    }
    for (let e = 0; e < edges.length; e++) {
      const { a: va, b: vb, aOff, bOff } = edges[e];
      const o = e * 6;
      for (let k = 0; k < 3; k++) {
        edgePositions[o + k] = vertPos[va * 3 + k];
        edgePositions[o + 3 + k] = vertPos[vb * 3 + k];
        edgeColors[o + k] = vertCol[va * 3 + k];
        edgeColors[o + 3 + k] = vertCol[vb * 3 + k];
      }
      edgePositions[o + 2] += aOff;
      edgePositions[o + 5] += bOff;
    }
    // Back-to-front panel sort: distance ahead of the camera, wrapped into one period
    // (the ±L copies share buffer slots, so ordering by the wrapped distance keeps
    // every visible copy consistent).
    for (let i = 0; i < panels.length; i++) {
      panelDepth[i] = ((panelZ[i] - camZ) % L + L) % L;
    }
    panelOrder.sort((i, j) => panelDepth[j] - panelDepth[i]);
    for (let slot = 0; slot < panelOrder.length; slot++) {
      const pIdx = panelOrder[slot];
      const { v, off, mul } = panels[pIdx];
      for (let corner = 0; corner < 3; corner++) {
        const o = (slot * 3 + corner) * 3;
        for (let k = 0; k < 3; k++) {
          panelPositions[o + k] = vertPos[v[corner] * 3 + k];
          panelColors[o + k] = Math.min(1, vertColPanel[v[corner] * 3 + k] * mul);
        }
        panelPositions[o + 2] += off[corner];
      }
    }
    edgeGeo.attributes.position.needsUpdate = true;
    edgeGeo.attributes.color.needsUpdate = true;
    panelGeo.attributes.position.needsUpdate = true;
    panelGeo.attributes.color.needsUpdate = true;
  }

  return { group, update };
}

// ─── Nebula clouds ─────────────────────────────────────────────────────────────────────
// Soft radial-gradient sprites in the design's palette, scattered through the tunnel —
// the 3D counterpart of the 2D large radial fields, and a big part of overall color.
// Built as a raw DataTexture, not a Canvas2D gradient: mobile GPUs showed a speckle of
// colored pixels in the sprite centers with the canvas route — Canvas2D stores pixels
// premultiplied and the WebGL upload unpremultiplies them back (lossy at low alpha,
// rounding varies by driver), and some mobile rasterizers also dither gradients. Writing
// the exact non-premultiplied bytes ourselves sidesteps both.
function makeNebulaTexture() {
  const s = 256,
    h = s / 2;
  // Same falloff as the old canvas radial gradient's stops
  const stops = [
    [0, 1.0],
    [0.25, 0.55],
    [0.55, 0.18],
    [0.8, 0.04],
    [1, 0]
  ];
  const alphaAt = (t) => {
    for (let i = 1; i < stops.length; i++) {
      if (t <= stops[i][0]) {
        const [t0, a0] = stops[i - 1];
        const [t1, a1] = stops[i];
        return a0 + ((t - t0) / (t1 - t0)) * (a1 - a0);
      }
    }
    return 0;
  };
  const data = new Uint8Array(s * s * 4);
  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      const dx = x + 0.5 - h;
      const dy = y + 0.5 - h;
      const t = Math.min(1, Math.sqrt(dx * dx + dy * dy) / h);
      const o = (y * s + x) * 4;
      data[o] = data[o + 1] = data[o + 2] = 255;
      data[o + 3] = Math.round(alphaAt(t) * 255);
    }
  }
  const tex = new THREE.DataTexture(data, s, s);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

// ─── Scene factory ────────────────────────────────────────────────────────────────────────
// createTunnelScene({ seed, colors, settings, duration, width, height }) →
//   { scene, camera, setSize, setTime, dispose }
// Where the logo mark sits, in world units ahead of the camera, at the loop seam. Its plane
// is then sized so that at exactly this distance it covers LOGO_SCREEN_FRACTION of the
// vertical FOV -- i.e. the same share of the short edge the 2D overlay uses, so the two
// modes agree at the one moment that matters (frame 1). Everything else about the flight
// differs by design.
const LOGO_SEAM_DISTANCE = 60;
const LOGO_PLANE_SIZE =
  LOGO_SCREEN_FRACTION * 2 * LOGO_SEAM_DISTANCE * Math.tan((BASE_FOV * Math.PI) / 360);
// Texture resolution for the mark. It is line art on a plane that never fills more than
// about a third of the frame, so 512 is ample and keeps the per-frame redraw (needed for
// the stroke build) cheap.
const LOGO_TEXTURE_SIZE = 512;

export function createTunnelScene({ seed, colors = [], settings = null, duration = 10, width, height, logoMark = null }) {
  // A separate rng stream from the 2D artwork's ('-3d' suffix, same convention as the
  // label mark's '-label') so 3D mode can never perturb 2D determinism.
  const rng = makeRng(`${seed}-3d`);
  const geometry = getGeometrySettings(settings);
  const palette = resolveScenePalette(rng, colors);
  const paletteHsl = palette.map(toHsl);

  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(BG_COLOR, FOG_DENSITY);
  // far=450: the biggest structures can sit ~250 units off-axis; fog fades them long
  // before the clip plane, but a hard geometry clip mid-panel is still visible without
  // the headroom.
  const camera = new THREE.PerspectiveCamera(BASE_FOV, (width || 1) / (height || 1), 0.1, 450);

  // Shared warp-onset uniform for every warped material in THIS scene (per-scene, not
  // module-level, so a live preview and a concurrent export can't leak rush state into
  // each other). setTime's rush arg pulls it closer; warpStartNow is the JS mirror for
  // the sprite-scale warp math.
  const uWarpStart = { value: WARP_START };
  let warpStartNow = WARP_START;
  // Streak half-length, shared by both star fields' streak materials. Driven only by
  // setTime's rush arg, so it is per-scene state like uWarpStart.
  const uStreak = { value: 0 };

  // Constant flight speed: total travel per cycle scales with duration. Unique content
  // is capped at MAX_CONTENT_LENGTH; beyond it the camera laps the content an exact
  // integer number of times per cycle (L divides the travel evenly, so the loop seam
  // still lands on identical geometry). lenScale/spriteScale keep density constant.
  const travel = FLIGHT_SPEED * duration;
  const laps = Math.max(1, Math.ceil(travel / MAX_CONTENT_LENGTH));
  const L = travel / laps;
  const lenScale = L / REFERENCE_LENGTH;
  const spriteScale = Math.sqrt(lenScale); // draw-call-bound sprites scale gently

  const disposables = [];

  // Background dome (camera-locked via the vertex shader). A narrow (analogous) palette
  // painted a single-hue wash over the entire scene -- the 2D generator avoids this by
  // biasing its star-field gradient toward the COMPLEMENT of the background hue
  // (GenerateStarField's baseHue bias), guaranteeing a contrasting accent. Same idea
  // here: if the palette's own hue spread is narrow, two dome slots become triadic spins
  // of the base color, so every scene holds at least three distinct hue families at once
  // like the 2D artwork does.
  // The 2D generator never renders single-hue scenes even from a narrow palette because
  // its layers each carry their own colors, with the star field explicitly biased toward
  // the COMPLEMENT of the background hue (GenerateStarField's baseHue bias). Mirror that
  // unconditionally: a seeded complement-side accent palette rides alongside the design's
  // own colors in the dome, the geometry, and the nebulae, so every scene holds several
  // distinct hue families at once (pink+green+yellow, like a typical 2D render) while the
  // design's palette stays dominant.
  const domeHex = [0, 1, 2, 3].map(i => palette[i % palette.length]);
  const dominantHue = paletteHsl[0].h * 360;
  const accents = randomPalette(rng, 2, {
    minSpread: 40,
    maxSpread: 90,
    baseHue: (dominantHue + 150 + rng() * 60) % 360
  });
  // Accent share scales down as the user supplies more colors: a 1–2 color palette
  // still gets two accent slots (avoids the single-hue wash), but once the user has
  // deliberately built a 3+ color palette their colors own 3 of the 4 dome slots —
  // previously accents always took half the dome, which is why adding colors barely
  // changed the background.
  if (palette.length >= 3) {
    domeHex[3] = accents[0];
  } else {
    domeHex[1] = accents[0];
    domeHex[3] = accents[1];
  }
  const bgColors = domeHex.map(hex => new THREE.Color(hex));
  // ~1/3 accent share in the triangles/nebulae keeps the design's palette dominant while
  // guaranteeing multi-hue contrast in every layer.
  const geoPalette = [...palette, ...accents];
  const geoPaletteHsl = geoPalette.map(toHsl);
  const bgMat = new THREE.ShaderMaterial({
    vertexShader: BG_VERT,
    fragmentShader: BG_FRAG,
    uniforms: {
      uColors: { value: bgColors },
      uProgress: { value: 0 },
      uSeed: { value: rng() * 100 }
    },
    side: THREE.BackSide,
    depthWrite: false,
    fog: false
  });
  const bgGeo = new THREE.SphereGeometry(220, 32, 24);
  const bg = new THREE.Mesh(bgGeo, bgMat);
  bg.renderOrder = -1;
  bg.frustumCulled = false;
  scene.add(bg);
  disposables.push(bgGeo, bgMat);

  // Star textures
  // TextureLoader.load returns immediately and decodes async — rendering before the
  // sprite PNGs are ready draws stars as nothing. The preview hides that (it keeps
  // rendering live, stars appear when the decode lands), but the EXPORT encodes frames
  // as fast as it can, so the first ~second of video had no stars. `ready` lets callers
  // await the decode before their first real frame.
  const texLoader = new THREE.TextureLoader();
  const smallMats = []; // materials waiting for the small-star texture
  const largeMats = []; // materials waiting for the large-star texture
  const assignTex = (mats, t) => {
    mats.forEach(m => {
      m.map = t;
      m.needsUpdate = true;
    });
    disposables.push(t);
  };
  const ready = Promise.all([
    texLoader.loadAsync(smallStarUrl).then(t => assignTex(smallMats, t)),
    texLoader.loadAsync(largeStarUrl).then(t => assignTex(largeMats, t))
  ]);

  // Small stars (Points). Drawn 3 times at z offsets -L, 0, +L so the wrap-around camera
  // always sees a continuous field ahead and behind without duplicating buffers.
  const field = makeStarField(rng, Math.round(SMALL_STAR_COUNT * lenScale), L);
  const starGeo = new THREE.BufferGeometry();
  starGeo.setAttribute('position', new THREE.BufferAttribute(field.pos, 3));
  starGeo.setAttribute('color', new THREE.BufferAttribute(field.colors, 3));
  const starMat = applyWarpShader(new THREE.PointsMaterial({
    size: 0.7,
    vertexColors: true,
    transparent: true,
    opacity: 0.95,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    sizeAttenuation: true,
    alphaTest: 0.01,
    fog: false
  }), uWarpStart);
  smallMats.push(starMat);
  disposables.push(starGeo, starMat);
  const starCopies = [];
  for (const zOff of [-L, 0, L]) {
    const pts = new THREE.Points(starGeo, starMat);
    pts.position.z = zOff;
    scene.add(pts);
    starCopies.push(pts);
  }
  const nearStreaks = makeStarStreaks(field, uWarpStart, uStreak);

  // Far star shell — a second, denser layer beyond the tunnel wall so deep space stays
  // populated out to where the largest geometry now lives, instead of stars ending
  // abruptly at the tunnel radius.
  const farField = makeStarField(rng, Math.round(FAR_STAR_COUNT * lenScale), L, TUNNEL_RADIUS, FAR_STAR_RADIUS);
  const farGeo = new THREE.BufferGeometry();
  farGeo.setAttribute('position', new THREE.BufferAttribute(farField.pos, 3));
  farGeo.setAttribute('color', new THREE.BufferAttribute(farField.colors, 3));
  const farMat = applyWarpShader(new THREE.PointsMaterial({
    size: 1.0,
    vertexColors: true,
    transparent: true,
    opacity: 0.85,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    sizeAttenuation: true,
    alphaTest: 0.01,
    fog: false
  }), uWarpStart);
  smallMats.push(farMat);
  disposables.push(farGeo, farMat);
  for (const zOff of [-L, 0, L]) {
    const pts = new THREE.Points(farGeo, farMat);
    pts.position.z = zOff;
    scene.add(pts);
  }
  const farStreaks = makeStarStreaks(farField, uWarpStart, uStreak);

  // Both streak layers, cloned at ±L like the star fields they trail.
  const streakLayers = [nearStreaks, farStreaks];
  for (const layer of streakLayers) {
    disposables.push(layer.geo, layer.mat);
    for (const zOff of [-L, 0, L]) {
      const line = new THREE.LineSegments(layer.geo, layer.mat);
      line.position.z = zOff;
      line.visible = false;
      line.frustumCulled = false; // the shader moves vertices; the CPU-side box lies
      scene.add(line);
      layer.lines.push(line);
    }
  }

  // Large stars — sprites with individual materials for per-star color/scale
  const largeField = makeStarField(rng, Math.round(LARGE_STAR_COUNT * spriteScale), L);
  const largeSprites = [];
  for (let i = 0; i < largeField.count; i++) {
    const mat = new THREE.SpriteMaterial({
      transparent: true,
      opacity: 1,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: false
    });
    largeMats.push(mat);
    disposables.push(mat);
    const baseScale = 1.2 + rng() * 4.2;
    for (const zOff of [-L, 0, L]) {
      const sprite = new THREE.Sprite(mat);
      sprite.scale.setScalar(baseScale);
      sprite.position.set(
        largeField.pos[i * 3],
        largeField.pos[i * 3 + 1],
        largeField.pos[i * 3 + 2] + zOff
      );
      scene.add(sprite);
      largeSprites.push({ sprite, index: i, baseScale });
    }
  }

  // Nebula clouds — soft palette-colored glow sprites scattered through the tunnel.
  // Each drifts through the palette with a per-cloud phase (same loop-safe treatment as
  // the palette-tracking stars).
  const nebulaTex = makeNebulaTexture();
  disposables.push(nebulaTex);
  const nebulae = [];
  const nebulaCount = Math.round(NEBULA_COUNT * spriteScale);
  for (let i = 0; i < nebulaCount; i++) {
    const ang = rng() * TWO_PI;
    const r = rng() * TUNNEL_RADIUS * 0.9;
    const z = rng() * L;
    const mat = new THREE.SpriteMaterial({
      map: nebulaTex,
      transparent: true,
      opacity: 0.22 + rng() * 0.22,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: false,
      rotation: rng() * TWO_PI
    });
    disposables.push(mat);
    const scale = 18 + rng() * 40;
    const aspect = 0.55 + rng() * 0.9;
    const phase = rng();
    const satBoost = 0.85 + rng() * 0.15;
    const sprites = [];
    for (const zOff of [-L, 0, L]) {
      const sprite = new THREE.Sprite(mat);
      sprite.scale.set(scale, scale * aspect, 1);
      sprite.position.set(Math.cos(ang) * r, Math.sin(ang) * r, z + zOff);
      scene.add(sprite);
      sprites.push(sprite);
    }
    nebulae.push({ mat, phase, satBoost, sprites, scale, aspect });
  }

  // The geometric tunnel — one continuous lattice bore the camera flies through (see
  // buildGeometricTunnel). Cloned at ±L like everything else; clones share
  // the buffer geometry, so the single per-frame update animates all copies.
  const tunnel = buildGeometricTunnel(rng, geometry, uWarpStart, L);
  tunnel.group.traverse(obj => {
    if (obj.geometry) disposables.push(obj.geometry);
    if (obj.material) disposables.push(obj.material);
  });
  for (const zOff of [-L, 0, L]) {
    const wrap = zOff === 0 ? tunnel.group : tunnel.group.clone();
    wrap.position.z = zOff;
    scene.add(wrap);
  }

  // ─── Time driver ───────────────────────────────────────────────────────────────────────
  const _col = new THREE.Color();
  const fogBase = new THREE.Color(BG_COLOR);

  function updatePointField(f, geo, progress) {
    const { colors: colArr, fixed, hue, sat, lit, cyclePhase, count } = f;
    for (let i = 0; i < count; i++) {
      if (fixed[i]) {
        _col.setHSL(hue[i], sat[i], lit[i]);
      } else {
        const p = paletteAtHsl(paletteHsl, progress + cyclePhase[i]);
        _col.setHSL((p.h + hue[i] + 1) % 1, Math.min(1, p.s * sat[i] + 0.15), lit[i]);
      }
      colArr[i * 3] = _col.r;
      colArr[i * 3 + 1] = _col.g;
      colArr[i * 3 + 2] = _col.b;
    }
    geo.attributes.color.needsUpdate = true;
  }

  function updateStarColors(progress, camZ) {
    updatePointField(field, starGeo, progress);
    updatePointField(farField, farGeo, progress);

    for (const { sprite, index, baseScale } of largeSprites) {
      if (largeField.fixed[index]) {
        _col.setHSL(largeField.hue[index], largeField.sat[index], largeField.lit[index]);
      } else {
        const p = paletteAtHsl(paletteHsl, progress + largeField.cyclePhase[index]);
        _col.setHSL((p.h + largeField.hue[index] + 1) % 1, p.s, largeField.lit[index]);
      }
      sprite.material.color.copy(_col);
      // JS mirror of the shader warp (sprites aren't chunk-based): shrink toward
      // nothing at extreme distance so they're born as points, not popped in.
      sprite.scale.setScalar(baseScale * warpFactor(sprite.position.z - camZ, warpStartNow));
    }
  }

  // rush (0..1, default 0): speed-ramp enhancement — see rampRush in utils/speedRamp.
  // Widens the FOV and pulls the vanishing-point warp closer so the fast middle of a
  // ramped cycle FEELS faster. Callers derive it from the same linear clock as the
  // warped `seconds`, so it's as deterministic as everything else here; rush is 0 at
  // the loop seam, so setTime(0) and setTime(duration) still produce identical frames.
  // ─── Logo mark (admin-only) ──────────────────────────────────────────────────────────
  // A real plane in the tunnel rather than a flat overlay, so the mark takes the scene's own
  // perspective as it flies past. Its z is set RELATIVE TO THE CAMERA every frame, which is
  // what makes it wrap-safe for free: camZ jumps back by L at the seam, but an offset from
  // camZ has nothing to wrap, so the loop needs no special case and no duplicate copies at
  // ±L (which is what a fixed world position would have required).
  //
  // depthTest off + a high renderOrder: the camera flies through a continuous lattice bore,
  // so anything depth-tested spends most of the window behind a ring. That trades away some
  // depth realism for the mark being legible at all, which is the whole point of it.
  // fog off for the same reason -- at 158 units on the return leg the fog would eat it.
  let logo = null;
  if (logoMark) {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = LOGO_TEXTURE_SIZE;
    const ctx = canvas.getContext('2d');
    const tex = new THREE.CanvasTexture(canvas);
    const geo = new THREE.PlaneGeometry(LOGO_PLANE_SIZE, LOGO_PLANE_SIZE);
    const mat = new THREE.MeshBasicMaterial({
      map: tex,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      fog: false,
      side: THREE.DoubleSide
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.renderOrder = 999;
    mesh.visible = false;
    // Not patched with applyWarpShader on purpose: the warp exists to hide pop-in for
    // content born at the fog line, and this mark is authored to be read, not hidden.
    scene.add(mesh);
    disposables.push(geo, mat, tex);
    logo = { ctx, tex, mat, mesh, lastDraw: -1 };
  }

  function setTime(seconds, rush = 0, logoState = null) {
    const progress = ((seconds / duration) % 1 + 1) % 1;
    const a = progress * TWO_PI;

    camera.fov = BASE_FOV + RUSH_FOV_BOOST * rush;
    camera.updateProjectionMatrix();
    warpStartNow = WARP_START - RUSH_WARP_PULL * rush;
    uWarpStart.value = warpStartNow;

    // Star streaks: length and brightness ride rush, and the whole layer drops out
    // below RUSH_STREAK_EPS so the resting scene renders exactly as it did before
    // streaking existed (and the seam frame, where rush is 0, is untouched).
    const streaking = rush > RUSH_STREAK_EPS;
    uStreak.value = STREAK_LENGTH * rush;
    for (const layer of streakLayers) {
      layer.mat.opacity = STREAK_OPACITY * rush;
      for (const line of layer.lines) line.visible = streaking;
    }

    // Camera: constant flight speed (FLIGHT_SPEED, duration-independent), `laps`
    // content lengths per cycle, position wrapped into [0, L) — the content is
    // periodic in L so the wrap is invisible. Straight down the axis, no positional
    // sway — earlier versions tried both look-target orbiting and gentle positional
    // drift, and both read as aimless/wobbly rather than hand-flown (Aaron's call,
    // twice).
    const camZ = (((progress * laps) % 1) + 1) % 1 * L;
    camera.position.set(0, 0, camZ);
    camera.lookAt(0, 0, camZ + 20);

    // Background + fog: colors journey through the design palette and return. Fog is
    // kept saturated and mid-dark so geometry recedes into COLOR, not gray space.
    bgMat.uniforms.uProgress.value = progress;
    const fogHsl = paletteAtHsl(paletteHsl, progress);
    _col.setHSL(fogHsl.h, Math.min(1, fogHsl.s * 0.9), 0.22);
    scene.fog.color.copy(fogBase).lerp(_col, 0.9);

    updateStarColors(progress, camZ);
    // Trails inherit their star's freshly-computed palette color. Skipped entirely while
    // the layer is hidden, which is most of a cycle.
    if (streaking) for (const layer of streakLayers) layer.sync();
    tunnel.update(progress, geoPaletteHsl, camZ);

    // Nebula clouds drift through the palette, phase-offset per cloud; scale-warped at
    // extreme distance like the large stars
    for (const n of nebulae) {
      const p = paletteAtHsl(geoPaletteHsl, progress + n.phase);
      _col.setHSL(p.h, Math.min(1, p.s * n.satBoost + 0.1), Math.min(0.62, p.l + 0.08));
      n.mat.color.copy(_col);
      for (const sprite of n.sprites) {
        const w = warpFactor(sprite.position.z - camZ, warpStartNow);
        sprite.scale.set(n.scale * w, n.scale * n.aspect * w, 1);
      }
    }

    // Logo mark. Absent for most of a cycle (logoState is null outside its two windows), so
    // the texture redraw -- the only real cost here -- is confined to the seam.
    if (logo) {
      logo.mesh.visible = !!logoState;
      if (logoState) {
        logo.mesh.position.set(0, 0, camZ + LOGO_SEAM_DISTANCE / logoState.scale);
        logo.mat.opacity = logoState.alpha;
        // Redraw only when the build fraction actually moved. Quantized because the stroke
        // geometry can't resolve finer than this and the texture upload is the expensive part.
        const draw = Math.round(logoState.draw * 200) / 200;
        if (draw !== logo.lastDraw) {
          logo.lastDraw = draw;
          logo.ctx.clearRect(0, 0, LOGO_TEXTURE_SIZE, LOGO_TEXTURE_SIZE);
          drawLogoMark(logo.ctx, logoMark, {
            cx: LOGO_TEXTURE_SIZE / 2,
            cy: LOGO_TEXTURE_SIZE / 2,
            size: LOGO_TEXTURE_SIZE,
            draw
          });
          logo.tex.needsUpdate = true;
        }
      }
    }
  }

  function setSize(w, h) {
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }

  function dispose() {
    for (const d of disposables) d.dispose?.();
    scene.clear();
  }

  setTime(0);

  return { scene, camera, setSize, setTime, dispose, ready };
}
