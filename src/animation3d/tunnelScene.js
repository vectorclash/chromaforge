import * as THREE from 'three';
import tinycolor from 'tinycolor2';
import { nLerp, valueNoise } from '../render/valueNoise';
import { makeRng, expandMonochromePalette } from '../render/prng';
import { generateArtwork } from '../render/generateArtwork';
import { getGeometrySettings } from '../render/designSettings';
import GenerateGeometricShape from '../components/Canvas/GenerateGeometricShape';
import GenerateLargeRadialField from '../components/Canvas/GenerateLargeRadialField';
import { LOGO_SCREEN_FRACTION, LOGO_OCTAVES, logoAlpha, logoDraw } from '../utils/logoIntro';
import { drawLogoMark } from '../render/renderLogoMark';
import largeStarUrl from '../assets/images/star-sprite-large-3d.png';
import smallStarUrl from '../assets/images/star-sprite-small-3d.png';

// 3D animation mode: a flight THROUGH the design's own artwork.
//
// The 2D piece is a stack of layers -- a linear gradient, a field of soft radial blobs, a
// tinted star field, a set of large triangles with three-stop gradient fills composited
// 'hard-light', and sometimes a gradient overlay. This scene rebuilds those layers from the
// SAME generators and the same resolved colours, and gives them depth:
//
//   - the SKY is the design's background gradient, camera-locked, stops placed exactly as
//     LinearGradient.js places them, and held still;
//   - the radial field becomes big soft colour volumes the camera passes through;
//   - the stars are tinted from the 2D star field's own contrast gradient;
//   - the geometry is a run of flat PLATES along the flight path, each a real
//     GenerateGeometricShape result drawn as vectors exactly as the 2D canvas draws it (see
//     "The geometry layer"). Every Geometry slider keeps its 2D meaning -- coherence is
//     shards -> lattice, spread is shard size, size is lattice radius, density thins, chance
//     is the share of plates carrying geometry, starsOnTop is layer order;
//   - every layer is composited with the blend mode the 2D render gives it, exactly (see
//     "Compositor"), and nothing fogs to dark: distant things fade into the sky;
//   - nothing moves but the camera.
//
// Everything is a pure function of (seed, colors, settings, duration), and setTime(t) drives
// all motion from the caller's clock, so preview and export step identical frames. The loop
// is seamless: content is periodic in the content length L, and every time term is sin/cos
// of 2*pi*progress*integer.
//
// History, so it is not re-proposed: a wireframe lattice tunnel (2026-07 to 2026-09) read as
// a different object from the artwork -- LINES over a dark fog -- and its sliders only filled
// the scaffold. The 2026-09-29 rebuild went through 3D triangle sheets (flat cards turning back
// and forth, unplayable at full coherence), a mirror-tube kaleidoscope, and loose mirrors,
// before Aaron picked plain static plates.

// ─── Flight ───────────────────────────────────────────────────────────────────────────
const FLIGHT_SPEED = 240; // world units/sec, duration-independent (Aaron, 2026-07-18)
const MAX_CONTENT_LENGTH = 2400;
const REFERENCE_LENGTH = 400;
// World sizes are set through this field of view (PX below): the 2D canvas fills the frame at
// FRAME_D through a 70-degree lens. Changing it resizes the world, not the picture.
const REF_FOV = 70;
// The camera's lens, as a vertical field of view. Wider, and everything sits smaller and closer
// to the vanishing point. Distance gathers things into the centre through the warp past
// WARP_START (see "The space"); nearer than that this lens is all there is.
const LENS_FOV = 100;
const RUSH_FOV_BOOST = 14;
const TWO_PI = Math.PI * 2;

// ─── Framing ──────────────────────────────────────────────────────────────────────────
// Generation happens on the studio's own canvas, so shapes and blobs have exactly the sizes
// the studio gives them. FRAME_D is the distance at which the 2D canvas would fill the frame;
// PX converts reference pixels to world units at that framing.
const REF_W = 3840;
const REF_H = 2160;
const FRAME_D = 100;
const TAN_REF = Math.tan((REF_FOV * Math.PI) / 360);
const PX = (2 * FRAME_D * TAN_REF) / REF_H;

// ─── The space ────────────────────────────────────────────────────────────────────────
// Every element -- plates, cage, stars, blobs -- sits at a real place in ONE space and is seen
// through one camera. Two things hide distance, and both are functions of depth alone, applied
// identically to every layer, so nothing grows on screen at a rate of its own.
//
// The WARP gathers far things into the vanishing point. Past WARP_START each element's distance
// from the flight axis is scaled by warpW(d) -- the same picture as plain perspective seen from
// an effective depth D = d / warpW(d). D is d up to WARP_START and then bends smoothly (no jump
// in growth rate) into D ~ d^WARP_POWER. On screen a thing still grows in proportion to the
// camera's speed, slowly when far and faster on approach -- perspective's shape, only steeper.
// Needed because the haze alone could not hide large geometry: at Spread 1.0 a shape was still
// half the screen tall while a 2% ghost (Aaron, 2026-10-01: big plates "just pop in from the
// haze"). Under this warp it is under 3% of its plain size by depth 300.
// Two warps were tried before this, and both gave far geometry a clock of its own -- a
// smoothstep to zero at 395 (burst, stall, rush), then (d/s) * exp(-(d-s)/s), whose D grew
// EXPONENTIALLY, so everything past 78 grew at one fixed rate however far away it was, and the
// rush pulled it in, zooming the scene. Do not bring either back; and this one deliberately has
// no rush term. A screen-space lens and per-shape arrival were also prototyped against the same
// pop on 2026-10-01 and rejected on sight.
//
// The HAZE lowers alpha with real distance, so each piece melts into whatever is behind it -- the
// design's own sky at that pixel, or a further layer -- never into a fog colour. Under the warp
// it only ever acts on figures already shrunk to specks: rendered at haze 150/150 against
// 450/300 the frames differ by 0.13/255 on average, so it stays at the cheapest setting (a longer
// haze keeps more plates, each a full-screen pass, in the draw list).
const WARP_START = 60; // Aaron's pick, 2026-10-01; also LOGO_SEAM_DISTANCE, so the seam pose is unwarped
const WARP_POWER = 4; // the strength, Aaron's pick (the top of the range he tried, 1-4)
function warpW(d) {
  if (d <= WARP_START) return 1;
  const x = (d - WARP_START) / WARP_START;
  return Math.pow(1 + x * x, -0.5 * (WARP_POWER - 1));
}
const HAZE_CLEAR = 150; // the air is clear nearer than this
const HAZE_DEPTH = 150; // gaussian fall-off length beyond it
// Where the haze has left under 0.12%: nothing is drawn past it. Must stay under the shortest
// loop's content length (FLIGHT_SPEED * 5s = 1200) less BEHIND, or a plate would be counted
// once where it should appear twice.
const VIEW_FAR = Math.round(HAZE_CLEAR + 2.6 * HAZE_DEPTH);
function haze(d) {
  const x = Math.max(0, d - HAZE_CLEAR) / HAZE_DEPTH;
  return Math.exp(-x * x);
}
const SPACE_GLSL = `float haze(float d) { float x = max(0.0, d - ${HAZE_CLEAR.toFixed(1)}) / ${HAZE_DEPTH.toFixed(1)}; return exp(-x * x); }
float warpW(float d) { if (d <= ${WARP_START.toFixed(1)}) return 1.0; float x = (d - ${WARP_START.toFixed(1)}) / ${WARP_START.toFixed(1)}; return pow(1.0 + x * x, ${(-0.5 * (WARP_POWER - 1)).toFixed(3)}); }
`;

// ─── Plates ───────────────────────────────────────────────────────────────────────────
const PLATE_SPACING = 150; // world units between plates
const BEHIND = 30; // how far behind the camera something stays in the visible list

// Near fade, as view-space depth: a plate the camera is passing through dissolves instead of
// popping off. Far, the haze takes it.
const PLATE_NEAR_FADE = [0.5, 4];
// A plate the camera is reaching OPENS FROM ITS CENTRE, shape by shape: an opening grows from
// the flight axis outward, each shape fading out whole as it reaches it, and the plate's outer
// parts stream off the edges.
// Through the opening the next plate is visible growing out of the vanishing point, so the
// artwork flows outward from the centre continuously. Before this the nearest plate covered
// the whole screen until it faded out, hiding the next one until it was already mid-size (Aaron:
// they "just appear half way through rather than coming in from the center").
// Radius in half-heights of the screen, opening from PLATE_HOLE[0] units of depth to [1] --
// depth as the plate LOOKS, i.e. as REF_FOV would show it, so a plate opens at the same size on
// screen whatever the lens or the rush's FOV boost makes of its distance. Driven by raw depth
// (plus 50 at the ramp's peak), the opening once ran ahead of plates that still looked tiny, and
// some flashed up small and dissolved without ever growing (Aaron, iPhone, 2026-09-30).
const PLATE_HOLE = [170, 6];
const PLATE_HOLE_SOFT = 0.35; // how far ahead of the opening a shape starts fading, in half-heights
const BLOB_NEAR_FADE = [4, 40];

// ─── Radial field ─────────────────────────────────────────────────────────────────────
const BLOBS_PER_REF = 5; // per REFERENCE_LENGTH of flight
const BLOB_SCALE = 1.0; // world size relative to the 2D blob at FRAME_D framing

// ─── Stars ────────────────────────────────────────────────────────────────────────────
const TUNNEL_RADIUS = 46;
const TUNNEL_CORE = 5;
const SMALL_STAR_COUNT = 5000;
const FAR_STAR_COUNT = 7000;
const FAR_STAR_RADIUS = 140;
const LARGE_STAR_COUNT = 90;
// The FOV boost follows `surge` = rush squared. It changes how big everything looks without the
// camera moving, so its shape over the cycle matters at both ends:
//   - The seam. rush is lowest exactly there, where the camera is nearly stopped, and on plain
//     rush they zoomed the geometry in as a loop ended and back out as the next began -- an
//     overshoot (Aaron, 2026-09-30). Squared, near the seam growth tracks the camera's own
//     motion to within 2.7% on average (on plain rush it strayed 30%).
//   - The peak. rush now has zero slope there (speedRamp's rounded rise), so the zoom rate
//     turns over smoothly: 2% across two frames. On the old cornered ramp it flipped 27%, and
//     cubing that ramp to fix the seam made it 63% -- "a very weird glitch in the motion".
// The streaks keep plain rush; they resize nothing.
function surgeOf(rush) {
  return rush * rush;
}
const STREAK_LENGTH = 12;
// Lower than the tunnel's 0.45: at 0.45 the streak layer turned the frame hairy.
const STREAK_OPACITY = 0.3;
const STREAK_END_FADE = 0.25;
const RUSH_STREAK_EPS = 0.002;

// ─── Colour helpers ───────────────────────────────────────────────────────────────────
// Colours go to the GPU as raw sRGB and are written out raw (no colorspace_fragment), so
// every blend below happens in sRGB -- which is what Canvas2D does, and what makes the
// hard-light here land on the same colours as the 2D piece.
function srgb(hex) {
  const { r, g, b } = tinycolor(hex).toRgb();
  return [r / 255, g / 255, b / 255];
}
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
  const x = (((t % 1) + 1) % 1) * n;
  const i = Math.floor(x) % n;
  const j = (i + 1) % n;
  const f = x - Math.floor(x);
  return {
    h: hueLerp(hsls[i].h, hsls[j].h, f),
    s: nLerp(hsls[i].s, hsls[j].s, f),
    l: nLerp(hsls[i].l, hsls[j].l, f)
  };
}

// ─── Layer materials ──────────────────────────────────────────────────────────────────
// The radial blobs draw into their own transparent layer, source-over among themselves
// (the 2D field overlays them, which depends on the backdrop; source-over is the nearest
// transparent-layer form), and the compositor then blends the finished layer. The gradient
// passes write straight colour.
const BLEND_GLSL = /* glsl */ `
  uniform int uMode; // 0 straight colour, 8 source-over onto a transparent layer
  vec4 blendOut(vec3 s, float a) {
    if (uMode == 8) return vec4(s * a, a);
    return vec4(s, a);
  }
`;

function blendMaterials(family, { vertexShader, fragmentShader, uniforms = {} }) {
  const mat = new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader: BLEND_GLSL + fragmentShader,
    uniforms: { ...uniforms, uMode: { value: family === 'layer-over' ? 8 : 0 } },
    transparent: true,
    depthTest: false,
    depthWrite: false,
    side: THREE.DoubleSide
  });
  if (family === 'layer-over') {
    mat.blending = THREE.CustomBlending;
    mat.blendEquation = THREE.AddEquation;
    mat.blendSrc = THREE.OneFactor;
    mat.blendDst = THREE.OneMinusSrcAlphaFactor;
    mat.blendSrcAlpha = THREE.OneFactor;
    mat.blendDstAlpha = THREE.OneMinusSrcAlphaFactor;
  } else {
    mat.blending = THREE.NormalBlending;
  }
  return [mat];
}

// Canvas's separable blend modes, shared by the compositor and the plate pass.
const BLEND_FUNCS = /* glsl */ `
  vec3 screenB(vec3 b, vec3 s) { return b + s - b * s; }
  vec3 hardLight(vec3 b, vec3 s) {
    return mix(screenB(b, 2.0 * s - 1.0), 2.0 * s * b, step(s, vec3(0.5)));
  }
  vec3 softLight(vec3 b, vec3 s) {
    vec3 d = mix(sqrt(b), ((16.0 * b - 12.0) * b + 4.0) * b, step(b, vec3(0.25)));
    return mix(b + (2.0 * s - 1.0) * (d - b), b - (1.0 - 2.0 * s) * b * (1.0 - b), step(s, vec3(0.5)));
  }
  // 0 source-over 1 screen 2 multiply 3 hard-light 4 overlay 5 soft-light 6 lighten 7 darken
  vec3 blendB(vec3 cb, vec3 cs) {
    if (uBlend == 1) return screenB(cb, cs);
    if (uBlend == 2) return cb * cs;
    if (uBlend == 3) return hardLight(cb, cs);
    if (uBlend == 4) return hardLight(cs, cb);
    if (uBlend == 5) return softLight(cb, cs);
    if (uBlend == 6) return max(cb, cs);
    if (uBlend == 7) return min(cb, cs);
    return cs;
  }
`;

// ─── Gradient layers (sky + overlay) ──────────────────────────────────────────────────
// A camera-locked full-screen quad painting a 2D linear gradient config exactly as
// LinearGradient.js does -- stops at i/n, clamped at both ends -- mapped onto the viewport
// by covering it with the 16:9 reference canvas, so the ground of the flight IS the
// design's ground at any export ratio. It sways slowly about the centre (periodic).
const MAX_STOPS = 6;
const GRADIENT_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = position.xy * 0.5 + 0.5;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;
const GRADIENT_FRAG = /* glsl */ `
  varying vec2 vUv;
  uniform vec3 uStops[${MAX_STOPS}];
  uniform float uCount;
  uniform vec2 uP1;
  uniform vec2 uP2;
  uniform vec2 uView;
  uniform float uAngle;
  uniform float uAlpha;
  void main() {
    vec2 ref = vec2(${REF_W.toFixed(1)}, ${REF_H.toFixed(1)});
    float scale = max(uView.x / ref.x, uView.y / ref.y);
    vec2 p = (vUv - 0.5) * uView / scale;
    p.y = -p.y; // canvas y runs down
    float c = cos(uAngle), s = sin(uAngle);
    p = mat2(c, s, -s, c) * p + ref * 0.5;
    vec2 d = uP2 - uP1;
    float t = clamp(dot(p - uP1, d) / max(dot(d, d), 1e-4), 0.0, 1.0);
    float x = t * uCount;
    vec3 col = uStops[0];
    for (int i = 1; i < ${MAX_STOPS}; i++) {
      if (float(i) >= uCount) break;
      col = mix(col, uStops[i], clamp(x - float(i - 1), 0.0, 1.0));
    }
    gl_FragColor = blendOut(col, uAlpha);
  }
`;

function gradientUniforms(cfg, alpha) {
  const stops = cfg.colors.slice(0, MAX_STOPS).map(c => new THREE.Vector3(...srgb(c)));
  while (stops.length < MAX_STOPS) stops.push(stops[stops.length - 1].clone());
  const dir = cfg.gradientDirection;
  return {
    uStops: { value: stops },
    uCount: { value: Math.min(MAX_STOPS, cfg.colors.length) },
    uP1: { value: new THREE.Vector2(dir.x1, dir.y1) },
    uP2: { value: new THREE.Vector2(dir.x2, dir.y2) },
    uView: { value: new THREE.Vector2(REF_W, REF_H) },
    uAngle: { value: 0 },
    uAlpha: { value: alpha }
  };
}

// ─── The geometry layer: vector plates ────────────────────────────────────────────────
// The geometry is a run of PLATES along the flight path, each one a 2D geometry layer, flat
// and fixed in the world: nothing turns or wobbles, so the only motion is the flight (Aaron,
// 2026-09-29: "it still does the weird rotation one way, then the other... maybe drop the
// rotation"; of three rotation-free variants he picked plain plates over a mirror tube and
// loose mirrors).
//
// Each plate is drawn as VECTORS, per pixel, in one full-screen pass: this pixel's ray meets
// the plate's plane, and the shader walks the plate's triangles covering that point, in their
// 2D draw order, compositing each exactly as GeometricShape.js does on its canvas (three-stop
// linear gradient from point 0 to point 2, hard-light onto the layer so far), with each edge
// antialiased to one screen pixel. The finished layer then blends onto the frame with the
// design's geometry blend. Edges stay crisp at any distance.
//
// Two earlier forms of this, and why they went:
//   - Triangles as 3D sheets, three exact hard-light passes per triangle: thousands of draw
//     calls at full coherence (28 fps, 85ms stalls, measured in the studio).
//   - Plates baked to textures once: cheap, but a plate nearer than its 2D framing distance
//     was magnified 2-5x on a retina screen and every shape edge went soft, and hiding the
//     texture's border needed a circular fade that softened them further (Aaron: "the soft
//     edges on the shapes look weird").
//
// Caching: a plate is flat, fixed and centred on the flight path, so between frames its image
// only scales outward about the centre. Each visible plate's vector render is cached at
// screen resolution through a field PLATE_CACHE_MARGIN wider than the camera's, and redrawn
// only when showing it would magnify it past PLATE_CACHE_MAX_ZOOM, at most one such plate a
// frame (forced past PLATE_CACHE_FORCE_ZOOM) -- instead of every frame for every plate. At full coherence 360
// lattice triangles genuinely overlap at a figure's centre, and redrawing that per frame for
// every visible plate ran at 25 fps on a retina screen. An export passes `exact`, which
// redraws every frame, so files (and the loop seam) are exact.
//
// Cost control: each plate's triangles are binned into a GRID of cells once, at build time,
// in the plate's own coordinates (plates never move), so a pixel only tests the triangles
// that can touch its cell. The lists keep 2D draw order, which hard-light depends on.
const UNIQUE_PLATES = 6; // distinct plate contents; placements reuse them at their own offsets
const PLATE_OFFSET = 0.22; // lateral plate offset, as a fraction of frame height
const GRID = 32; // cells per side of each plate's triangle grid
const PLATE_CACHE_MARGIN = 1.15;
const PLATE_CACHE_MAX_ZOOM = 1.25; // redraw from here, one plate per frame (most zoomed first)
const PLATE_CACHE_FORCE_ZOOM = 1.6; // redraw regardless -- the budget never lets edges go softer
// A plate covering less than this fraction of the screen is redrawn every frame instead of
// scaled from its cache. The pass costs roughly what the plate covers, so a small plate is cheap
// -- and a small plate is one growing out of the vanishing point, where a cached image magnified
// soft and then snapping sharp on its redraw read as the geometry popping in rather than
// scaling up (2026-09-30).
const PLATE_CACHE_MIN_COVER = 0.12;
// Cache resolution in device pixels per CSS pixel. On a retina screen that is 1.5 rather than
// 2, which keeps each edge's antialiasing ramp under one CSS pixel wide while drawing 44%
// fewer pixels in the expensive pass; at a pixel ratio of 1.5 or less, and in exports, the
// cache is full resolution.
const PLATE_CACHE_MAX_DPR = 1.5;
const TRI_TEXELS = 6; // per triangle: points (2), gradient (1), three colours
const DATA_WIDTH = 2048; // texel row width of the packed data textures

// Plate content in display coordinates (reference px, y up): GeometricShape.js draws its
// container rotated 90 degrees on a canvas whose y runs down, which maps a shape point
// (x, y) to (-y, -x). Degenerate (zero-area) triangles are dropped here; they draw nothing
// in 2D either.
function plateTriangles(config) {
  const tris = [];
  for (const shape of config.shapes) {
    const p = shape.points.map(([x, y]) => [-y, -x]);
    const area = (p[1][0] - p[0][0]) * (p[2][1] - p[0][1]) - (p[1][1] - p[0][1]) * (p[2][0] - p[0][0]);
    if (Math.abs(area) < 1e-3) continue;
    tris.push({ p, orient: Math.sign(area), colors: shape.colors.slice(0, 3).map(srgb) });
  }
  return tris;
}

// Packs every plate content's triangles and cell lists into two float textures.
//   triTex:  TRI_TEXELS texels per triangle
//     0: a.xy b.xy     1: c.xy -- the corners in counter-clockwise order, so the inside test
//                         needs only these two reads and no orientation sign
//     2: gradient origin p0.xy, axis d/|d|^2 (so t = dot(q - p0, axis)) -- the ORIGINAL p0
//        and p2, since GeometricShape.js runs the gradient from point 0 to point 2
//     3: c0.rgb        4: c1.rgb        5: c2.rgb
//   cellTex: per plate content, GRID*GRID texels of (listStart, listCount), then the list
//     entries themselves in 2D draw order, TWO texels each: (a.xy, b.xy), (c.xy, triIndex, 0)
//     -- the inside test's data copied inline, so a pixel reads its candidates in one
//     contiguous run and only touches triTex (colours, gradient) for triangles that hit.
function packPlateData(contents) {
  const triCount = contents.reduce((n, c) => n + c.tris.length, 0);
  const triTexels = Math.max(1, triCount * TRI_TEXELS);
  const triRows = Math.ceil(triTexels / DATA_WIDTH);
  const tri = new Float32Array(DATA_WIDTH * triRows * 4);
  const cellEntries = [];
  let base = 0;
  let maxList = 1;
  let listTotal = 0;
  let cellTotal = 0;
  for (const c of contents) {
    c.triBase = base;
    let half = 1;
    c.tris.forEach((t, i) => {
      for (const [x, y] of t.p) half = Math.max(half, Math.abs(x), Math.abs(y));
      const [p0, p1, p2] = t.p;
      const dx = p2[0] - p0[0];
      const dy = p2[1] - p0[1];
      const dd = Math.max(1e-6, dx * dx + dy * dy);
      const o = (base + i) * TRI_TEXELS * 4;
      const [a, b, cc] = t.orient > 0 ? [p0, p1, p2] : [p0, p2, p1];
      tri.set([a[0], a[1], b[0], b[1]], o);
      tri.set([cc[0], cc[1], 0, 0], o + 4);
      tri.set([p0[0], p0[1], dx / dd, dy / dd], o + 8);
      tri.set([...t.colors[0], 0], o + 12);
      tri.set([...t.colors[1], 0], o + 16);
      tri.set([...t.colors[2], 0], o + 20);
    });
    c.half = half * 1.001;
    // Bin EXACTLY: a triangle goes in a cell only if it really overlaps it (separating-axis
    // test against the cell, padded by a margin for the antialiased edge). Bounding-box binning
    // was the first version, and a long thin chord triangle's box spans far more cells than
    // the triangle does -- at full coherence that put hundreds of dead candidates in the lists
    // near the middle of a lattice, and the preview fell to 25 fps on a retina screen.
    const cell = (2 * c.half) / GRID;
    const pad = cell * 0.02;
    const lists = Array.from({ length: GRID * GRID }, () => []);
    c.tris.forEach((t, i) => {
      const xs = t.p.map(p => p[0]);
      const ys = t.p.map(p => p[1]);
      const x0 = Math.max(0, Math.floor((Math.min(...xs) + c.half) / cell));
      const x1 = Math.min(GRID - 1, Math.floor((Math.max(...xs) + c.half) / cell));
      const y0 = Math.max(0, Math.floor((Math.min(...ys) + c.half) / cell));
      const y1 = Math.min(GRID - 1, Math.floor((Math.max(...ys) + c.half) / cell));
      const axes = [0, 1, 2].map(e => {
        const [ax, ay] = t.p[e];
        const [bx, by] = t.p[(e + 1) % 3];
        return [-(by - ay), bx - ax];
      });
      const triProj = axes.map(([nx, ny]) => {
        const v = t.p.map(([x, y]) => nx * x + ny * y);
        return [Math.min(...v), Math.max(...v)];
      });
      for (let gy = y0; gy <= y1; gy++) {
        for (let gx = x0; gx <= x1; gx++) {
          const bx0 = -c.half + gx * cell - pad;
          const by0 = -c.half + gy * cell - pad;
          const bx1 = bx0 + cell + 2 * pad;
          const by1 = by0 + cell + 2 * pad;
          let hit = true;
          for (let e = 0; e < 3 && hit; e++) {
            const [nx, ny] = axes[e];
            const v = [nx * bx0 + ny * by0, nx * bx1 + ny * by0, nx * bx0 + ny * by1, nx * bx1 + ny * by1];
            if (Math.max(...v) < triProj[e][0] || Math.min(...v) > triProj[e][1]) hit = false;
          }
          if (hit) lists[gy * GRID + gx].push(base + i);
        }
      }
    });
    c.cellBase = cellEntries.length;
    const headers = [];
    cellEntries.push(...new Array(GRID * GRID).fill(null));
    lists.forEach((list, k) => {
      headers[k] = [cellEntries.length, list.length, 0, 0];
      maxList = Math.max(maxList, list.length);
      listTotal += list.length;
      cellTotal++;
      for (const idx of list) {
        const t = c.tris[idx - base];
        const [p0, p1, p2] = t.p;
        const [a, b, cc] = t.orient > 0 ? [p0, p1, p2] : [p0, p2, p1];
        cellEntries.push([a[0], a[1], b[0], b[1]], [cc[0], cc[1], idx, 0]);
      }
    });
    headers.forEach((h, k) => (cellEntries[c.cellBase + k] = h));
    base += c.tris.length;
  }
  const cellRows = Math.max(1, Math.ceil(cellEntries.length / DATA_WIDTH));
  const cell = new Float32Array(DATA_WIDTH * cellRows * 4);
  cellEntries.forEach((e, i) => cell.set(e, i * 4));
  const makeTex = (data, rows) => {
    const tex = new THREE.DataTexture(data, DATA_WIDTH, rows, THREE.RGBAFormat, THREE.FloatType);
    tex.minFilter = tex.magFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
    return tex;
  };
  return { triTex: makeTex(tri, triRows), cellTex: makeTex(cell, cellRows), maxList, meanList: listTotal / Math.max(1, cellTotal) };
}

const PLATE_FRAG = /* glsl */ `
  varying vec2 vUv;
  uniform sampler2D uTris;
  uniform sampler2D uCells;
  uniform int uBlend; // unused here, but the shared blend functions reference it
  uniform float uDepth;
  uniform vec2 uTanHalf;
  uniform vec2 uRot;      // plate orientation (cos, sin)
  uniform vec2 uOffset;   // plate centre, world units
  uniform float uPx;      // world units per reference pixel
  uniform float uHalf;    // plate content half-extent, reference px
  uniform float uCellBase;
  uniform int uMaxList;
  uniform float uHoleQ;     // aperture radius around the flight axis, reference px (0 = closed)
  uniform float uHoleSoftQ; // how far ahead of the aperture a shape starts to fade
  float segDist(vec2 p, vec2 a, vec2 b) {
    vec2 pa = p - a, ba = b - a;
    float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-6), 0.0, 1.0);
    return length(pa - ba * h);
  }
  BLEND_FUNCS
  vec4 fetch(float i) {
    return texelFetch(uTris, ivec2(int(mod(i, ${DATA_WIDTH}.0)), int(floor(i / ${DATA_WIDTH}.0))), 0);
  }
  vec4 fetchCell(float i) {
    return texelFetch(uCells, ivec2(int(mod(i, ${DATA_WIDTH}.0)), int(floor(i / ${DATA_WIDTH}.0))), 0);
  }
  // Signed distance from q to edge a->b of a counter-clockwise triangle, positive inside
  float edgeDist(vec2 q, vec2 a, vec2 b) {
    vec2 e = b - a;
    return (e.x * (q.y - a.y) - e.y * (q.x - a.x)) / max(length(e), 1e-6);
  }
  void main() {
    vec2 world = (vUv * 2.0 - 1.0) * uTanHalf * uDepth;
    vec2 d = world - uOffset;
    vec2 q = vec2(uRot.x * d.x + uRot.y * d.y, -uRot.y * d.x + uRot.x * d.y) / uPx;
    // One screen pixel in plate units, for the antialiased edges
    float pix = max(length(fwidth(q)) * 0.7071, 1e-4);
    vec2 g = floor((q + uHalf) / (2.0 * uHalf) * ${GRID}.0);
    if (g.x < 0.0 || g.y < 0.0 || g.x >= ${GRID}.0 || g.y >= ${GRID}.0) { gl_FragColor = vec4(0.0); return; }
    vec2 da = -uOffset;
    vec2 axis = vec2(uRot.x * da.x + uRot.y * da.y, -uRot.y * da.x + uRot.x * da.y) / uPx;
    vec4 head = fetchCell(uCellBase + g.y * ${GRID}.0 + g.x);
    float start = head.x;
    int count = int(head.y);
    // The layer so far, premultiplied, starting transparent -- exactly the 2D shapes canvas
    vec3 C = vec3(0.0);
    float A = 0.0;
    for (int k = 0; k < 4096; k++) {
      if (k >= count || k >= uMaxList) break;
      vec4 t0 = fetchCell(start + float(k) * 2.0);
      vec4 t1 = fetchCell(start + float(k) * 2.0 + 1.0);
      float dist = min(min(edgeDist(q, t0.xy, t0.zw), edgeDist(q, t0.zw, t1.xy)), edgeDist(q, t1.xy, t0.xy));
      float cov = clamp(0.5 + dist / pix, 0.0, 1.0);
      if (cov <= 0.0) continue;
      if (uHoleQ > 0.0) {
        // The aperture opens SHAPE BY SHAPE: a shape fades out whole as the opening reaches its
        // nearest point to the flight axis, so the opening is made of the artwork's own shapes
        // -- a screen-space circle cut a feathered ring through them.
        float inA = min(min(edgeDist(axis, t0.xy, t0.zw), edgeDist(axis, t0.zw, t1.xy)), edgeDist(axis, t1.xy, t0.xy));
        float dTri = inA >= 0.0 ? 0.0 : min(min(segDist(axis, t0.xy, t0.zw), segDist(axis, t0.zw, t1.xy)), segDist(axis, t1.xy, t0.xy));
        cov *= smoothstep(uHoleQ - uHoleSoftQ, uHoleQ, dTri);
        if (cov <= 0.0) continue;
      }
      float b = t1.z * ${TRI_TEXELS}.0;
      vec4 gr = fetch(b + 2.0);
      vec3 c0 = fetch(b + 3.0).rgb;
      vec3 c1 = fetch(b + 4.0).rgb;
      vec3 c2 = fetch(b + 5.0).rgb;
      float t = clamp(dot(q - gr.xy, gr.zw), 0.0, 1.0);
      vec3 cs = t < 0.5 ? mix(c0, c1, t * 2.0) : mix(c1, c2, t * 2.0 - 1.0);
      // canvas hard-light onto the layer: co = cs*as*(1-ab) + Cb*(1-as) + as*ab*B(cb, cs)
      vec3 cb = A > 0.0 ? C / A : vec3(0.0);
      C = cs * cov * (1.0 - A) + C * (1.0 - cov) + cov * A * hardLight(cb, cs);
      A = cov + A * (1.0 - cov);
    }
    gl_FragColor = vec4(C, A);
  }
`;

// Blends a plate's cached layer onto the frame. The cache is the plate as seen from depth
// uDepthC through a slightly wider field; since the plate is flat, fixed and centred on the
// flight path, the view now is that image scaled about the centre by uScale (<= 1).
const PLATE_COMP_FRAG = /* glsl */ `
  varying vec2 vUv;
  uniform sampler2D uBack;
  uniform sampler2D uCache;
  uniform int uBlend;
  uniform float uAlpha;
  uniform float uScale;
  BLEND_FUNCS
  void main() {
    vec3 cb = texture2D(uBack, vUv).rgb;
    vec4 L = texture2D(uCache, (vUv - 0.5) * uScale + 0.5) * uAlpha;
    float as = L.a;
    if (as < 0.0005) { gl_FragColor = vec4(cb, 1.0); return; }
    vec3 cs = clamp(L.rgb / as, 0.0, 1.0);
    gl_FragColor = vec4(cb * (1.0 - as) + as * blendB(cb, cs), 1.0);
  }
`;

// Placements along the flight: which plate content, and where it sits. Layout comes from the
// scene stream and shapes from each content's own stream, so a slider change re-shapes plates
// without moving where they sit, and vice versa.
function buildPlates(seed, designGeometry, paletteColors, settings, geometry, L) {
  const coh = geometry.coherence;
  const frameHalf = FRAME_D * Math.tan((REF_FOV * Math.PI) / 360);

  // Plate contents. Content 0 is the design's own geometry layer when it has one.
  const contents = [];
  for (let u = 0; u < UNIQUE_PLATES; u++) {
    let config = null;
    if (u === 0 && designGeometry) {
      config = designGeometry;
    } else {
      const prng = makeRng(`${seed}-3d-plate-${u}`);
      const shapeNum = 10 + Math.round(prng() * 30);
      config = new GenerateGeometricShape(REF_W, REF_H, shapeNum, paletteColors, prng, settings);
    }
    const tris = config ? plateTriangles(config) : [];
    if (tris.length) contents.push({ tris });
  }
  const data = packPlateData(contents);

  const count = plateCount(L);
  const plates = [];
  for (let k = 0; k < count; k++) {
    // Each placement on its own stream, keyed by its index, so plate k is the same plate at any
    // Duration: a longer flight is this one with more plates, not a re-roll of all of them. On the
    // shared stream every Duration change re-rolled every plate's presence, turn and offset, since
    // the blobs and large stars drawn before them take a length-dependent number of draws.
    const prng = makeRng(`${seed}-3d-place-${k}`);
    // Plate 0 carries the design's own geometry, if the design has any; the rest follow the
    // Chance slider, so low chance leaves stretches of open sky.
    const odds = prng();
    const present = contents.length > 0 && (k === 0 ? !!designGeometry : odds < geometry.chance);
    const ang = prng() * TWO_PI;
    plates.push({
      z: (k / count) * L,
      present,
      content: contents.length ? contents[k % contents.length] : null,
      rot: [Math.cos(ang), Math.sin(ang)],
      // Coherent lattices close onto the flight path, so the camera flies through them
      ox: (prng() - 0.5) * 2 * PLATE_OFFSET * frameHalf * 2 * (1 - coh),
      oy: (prng() - 0.5) * 2 * PLATE_OFFSET * frameHalf * 1.4 * (1 - coh)
    });
  }
  return { plates, data };
}

function plateUniforms(plate, out) {
  out.uRot.value.set(plate.rot[0], plate.rot[1]);
  out.uOffset.value.set(plate.ox, plate.oy);
  out.uHalf.value = plate.content.half;
  out.uCellBase.value = plate.content.cellBase;
}

// ─── The cage ─────────────────────────────────────────────────────────────────────────
// The previous scene's lattice tunnel, brought back as a frame to fly through around the
// plates (Aaron, 2026-09-29: "with that cage tunnel thing also in there, but never fully filled
// like it can get with the settings all the way up"). Ported from that scene with three
// changes: wire and panel density are CAPPED (CAGE_MAX_WIRE, CAGE_MAX_PANEL), so no setting can
// fill it into a solid bore; the angular shimmer is gone (nothing turns back and forth); and it
// draws with the design's resolved palette instead of the old scene's own. Its twist is built
// into the geometry and its ripple is radial, so neither reads as rotation. It runs on its own
// '-3d-cage' rng stream, so it moves nothing else in the scene.
const CAGE_MAX_WIRE = 0.5;
const CAGE_MAX_PANEL = 0.2;
const CAGE_LINE_OPACITY = 0.75;
const CAGE_PANEL_OPACITY = 0.7;
// Fades out as the camera passes it, and into the haze with distance like everything else. It
// used to stop at 230 because distant rings projected into the centre as a scribble; under the
// haze they are faint by the time they get that small.
const CAGE_NEAR_FADE = [2, 24];
// The wires' real thickness, world units. GL draws a line one pixel wide at any distance, so a
// far wire would stay full strength while everything around it shrank, and the receding cage
// piled into a bright tangle at the vanishing point. Below a pixel a wire's alpha scales with the
// width it really covers, as a star's does with its area -- which also keeps a 4K export and a
// phone preview showing the same cage. About a pixel at 60 units on a 1080p screen.
const CAGE_WIRE_WIDTH = 0.12;

// uViewHalfH (half the drawing buffer's height, px) makes it a wire: see CAGE_WIRE_WIDTH.
function applyDepthFade(mat, uViewHalfH = null) {
  mat.onBeforeCompile = shader => {
    let cover = '';
    if (uViewHalfH) {
      shader.uniforms.uViewHalfH = uViewHalfH;
      // projectionMatrix[1][1] is 1 / tan(fov / 2): pixels per world unit at distance 1, over H/2
      cover = ` * clamp(${CAGE_WIRE_WIDTH.toFixed(3)} * uViewHalfH * projectionMatrix[1][1] / max(-mvPosition.z, 0.01), 0.0, 1.0)`;
    }
    shader.vertexShader =
      'varying float vCageFade;\n' + (uViewHalfH ? 'uniform float uViewHalfH;\n' : '') + SPACE_GLSL +
      shader.vertexShader.replace(
        '#include <project_vertex>',
        `#include <project_vertex>
      float cageW = warpW(-mvPosition.z);
      mvPosition.xy *= cageW;
      gl_Position = projectionMatrix * mvPosition;
      vCageFade = smoothstep(${CAGE_NEAR_FADE[0].toFixed(1)}, ${CAGE_NEAR_FADE[1].toFixed(1)}, -mvPosition.z) * haze(-mvPosition.z)${cover ? cover + ' * cageW' : ''};`
      );
    shader.fragmentShader =
      'varying float vCageFade;\n' +
      shader.fragmentShader.replace(
        '#include <premultiplied_alpha_fragment>',
        'gl_FragColor.a *= vCageFade;\n#include <premultiplied_alpha_fragment>'
      );
  };
  mat.customProgramCacheKey = () => `cage-${mat.type}-${!!uViewHalfH}`;
  return mat;
}

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
function buildCage(rng, geometry, L, uViewHalfH) {
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
  //
  // `chance` here is the studio slider's PROBABILITY, which is the only thing it ever means:
  // buildThreeDDesign hands this the live slider state, and a stored design carries no chance
  // at all (it states `present` instead -- see designSettings). So if 3D replay of a SAVED
  // design is ever built, this falls back to the legacy value for it; feed it
  // getGenerationSettings(design) if the user's own odds are wanted instead.
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
  // Built in two passes: pushed as { z, gate, outer } here, then given zone/sides/step/ang0/r
  // below once the zone walk knows them. tsc infers the element type from the first literal and
  // rejects the later additions, so the shape is declared loosely rather than restructuring a
  // working generator. Comment only -- no runtime effect.
  /** @type {any[]} */
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
      // Capped at CAGE_MAX_WIRE: the old tunnel let this reach 1.15, and with the sliders up
      // it became a fully caged bore. The cage is a frame to fly through now, never a wall.
      const wire = clampNum(
        (0.15 + rng() * 0.85 + coh * 0.4) *
          complexityAt(zFrac) * densityMul * zoneWireMul * (A.gate ? 2.2 : 1) * wireScale,
        0,
        CAGE_MAX_WIRE
      );
      const panelChance = Math.min(
        CAGE_MAX_PANEL,
        (0.28 + geometry.coherence * 0.3) *
          complexityAt(zFrac) *
          densityMul *
          zonePanelMul *
          panelScale *
          (A.gate ? 0.5 : 1) // gates are wire showpieces, not panel walls
      );
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
  // Drawn into the cage's own transparent layer: lines accumulate additively (so they glow
  // where they cross), panels go source-over, and the finished layer is composited once.
  const layerAdd = mat => {
    mat.blending = THREE.CustomBlending;
    mat.blendEquation = THREE.AddEquation;
    mat.blendSrc = THREE.SrcAlphaFactor;
    mat.blendDst = THREE.OneFactor;
    mat.blendSrcAlpha = THREE.OneFactor;
    mat.blendDstAlpha = THREE.OneMinusSrcAlphaFactor;
    mat.depthTest = false;
    return mat;
  };
  const layerOver = mat => {
    mat.blending = THREE.CustomBlending;
    mat.blendEquation = THREE.AddEquation;
    mat.blendSrc = THREE.SrcAlphaFactor;
    mat.blendDst = THREE.OneMinusSrcAlphaFactor;
    mat.blendSrcAlpha = THREE.OneFactor;
    mat.blendDstAlpha = THREE.OneMinusSrcAlphaFactor;
    mat.depthTest = false;
    return mat;
  };
  const edgeMat = applyDepthFade(layerAdd(new THREE.LineBasicMaterial({
    vertexColors: true,
    transparent: true,
    opacity: CAGE_LINE_OPACITY,
    depthWrite: false,
    fog: false
  })), uViewHalfH);
  const edgeLines = new THREE.LineSegments(edgeGeo, edgeMat);
  edgeLines.frustumCulled = false; // vertices animate every frame
  group.add(edgeLines);

  const panelPositions = new Float32Array(panels.length * 3 * 3);
  const panelColors = new Float32Array(panels.length * 3 * 3);
  const panelGeo = new THREE.BufferGeometry();
  panelGeo.setAttribute('position', new THREE.BufferAttribute(panelPositions, 3));
  panelGeo.setAttribute('color', new THREE.BufferAttribute(panelColors, 3));
  // Normal blending: additive panels wash to white over the colorful background
  const panelMat = applyDepthFade(layerOver(new THREE.MeshBasicMaterial({
    vertexColors: true,
    side: THREE.DoubleSide,
    transparent: true,
    opacity: CAGE_PANEL_OPACITY,
    depthWrite: false,
    fog: false
  })));
  const panelMesh = new THREE.Mesh(panelGeo, panelMat);
  panelMesh.frustumCulled = false;
  group.add(panelMesh);

  // Scratch arrays for the per-frame vertex pass. Panels get their OWN color per vertex
  // (fully saturated, brighter) — sharing the edge colors read muted at panel opacity.
  const vertPos = new Float32Array(vertCount * 3);
  const vertCol = new Float32Array(vertCount * 3);
  const vertColPanel = new Float32Array(vertCount * 3);
  // The old angular shimmer (a sine wobble of every vertex's angle) is gone: nothing in the
  // scene turns back and forth any more. The ripple below is radial, not a turn.
  const shimmerAmp = 0;
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
      _c.setHSL(p.h, Math.min(1, p.s + 0.2), Math.min(0.68, p.l + 0.12), THREE.LinearSRGBColorSpace);
      vertCol[v * 3] = _c.r * dim[v];
      vertCol[v * 3 + 1] = _c.g * dim[v];
      vertCol[v * 3 + 2] = _c.b * dim[v];
      // Panel variant: full chroma at MID lightness — pushing lightness too high reads
      // pastel/white, not colorful; vivid lives at s=1, l≈0.5 (checked against renders)
      _c.setHSL(p.h, 1, Math.max(0.45, Math.min(0.58, p.l + 0.06)), THREE.LinearSRGBColorSpace);
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

  return { group, update, edgeLines, panelMesh };
}

// ─── Compositor ───────────────────────────────────────────────────────────────────────
// renderArtwork composites every layer onto the piece with a canvas blend mode. Fixed-
// function blending cannot express most of them (overlay, soft-light, lighten and darken
// all depend on the BACKDROP), so the flight is built the same way the 2D piece is: each
// layer renders into its own transparent target, and this shader blends it onto the
// accumulated frame, reading both. Canvas's separable-blend formula over an opaque
// backdrop, with the layer premultiplied:  co = cb * (1 - as) + as * B(cb, cs).
const COMPOSITE_FRAG = /* glsl */ `
  varying vec2 vUv;
  uniform sampler2D uBack;
  uniform sampler2D uLayer;
  uniform int uBlend; // 0 source-over 1 screen 2 multiply 3 hard-light 4 overlay 5 soft-light 6 lighten 7 darken
  uniform float uAlpha;
  vec3 screenB(vec3 b, vec3 s) { return b + s - b * s; }
  vec3 hardLight(vec3 b, vec3 s) {
    return mix(screenB(b, 2.0 * s - 1.0), 2.0 * s * b, step(s, vec3(0.5)));
  }
  vec3 softLight(vec3 b, vec3 s) {
    vec3 d = mix(sqrt(b), ((16.0 * b - 12.0) * b + 4.0) * b, step(b, vec3(0.25)));
    return mix(b + (2.0 * s - 1.0) * (d - b), b - (1.0 - 2.0 * s) * b * (1.0 - b), step(s, vec3(0.5)));
  }
  void main() {
    vec3 cb = texture2D(uBack, vUv).rgb;
    vec4 L = texture2D(uLayer, vUv) * uAlpha;
    float as = L.a;
    if (as < 0.0005) { gl_FragColor = vec4(cb, 1.0); return; }
    vec3 cs = clamp(L.rgb / as, 0.0, 1.0);
    vec3 B;
    if (uBlend == 1) B = screenB(cb, cs);
    else if (uBlend == 2) B = cb * cs;
    else if (uBlend == 3) B = hardLight(cb, cs);
    else if (uBlend == 4) B = hardLight(cs, cb);
    else if (uBlend == 5) B = softLight(cb, cs);
    else if (uBlend == 6) B = max(cb, cs);
    else if (uBlend == 7) B = min(cb, cs);
    else if (uBlend == 8) {
      // Legible anywhere (the cage's lines): light over a dark backdrop, darkened over a
      // bright one, crossfading on the backdrop's own luminance under this pixel.
      float lum = dot(cb, vec3(0.2126, 0.7152, 0.0722));
      B = mix(screenB(cb, cs), cb * mix(vec3(1.0), cs * 0.6, 0.75), smoothstep(0.45, 0.75, lum));
    }
    else B = cs;
    gl_FragColor = vec4(cb * (1.0 - as) + as * B, 1.0);
  }
`;
const BLEND_INDEX = {
  'source-over': 0,
  screen: 1,
  multiply: 2,
  'hard-light': 3,
  overlay: 4,
  'soft-light': 5,
  lighten: 6,
  darken: 7
};
const COPY_FRAG = /* glsl */ `
  varying vec2 vUv;
  uniform sampler2D uSrc;
  void main() { gl_FragColor = vec4(texture2D(uSrc, vUv).rgb, 1.0); }
`;

// ─── Radial blobs ─────────────────────────────────────────────────────────────────────
const BLOB_VERT = /* glsl */ `
  attribute vec2 aUv;
  attribute vec3 aC0;
  attribute vec3 aC1;
  attribute vec3 aC2;
  attribute vec3 aC3;
  attribute vec3 aC4;
  attribute float aN;
  attribute float aA;
  varying vec2 vUv;
  varying vec3 vC0; varying vec3 vC1; varying vec3 vC2; varying vec3 vC3; varying vec3 vC4;
  varying float vN;
  varying float vA;
  varying float vDepth;
  void main() {
    vUv = aUv; vC0 = aC0; vC1 = aC1; vC2 = aC2; vC3 = aC3; vC4 = aC4; vN = aN; vA = aA;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vDepth = -mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;
// RadialGradient.js: stops at i/n, then 'transparent' at 1 -- canvas interpolates that last
// segment premultiplied, so the colour holds and only alpha falls away.
const BLOB_FRAG = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vC0; varying vec3 vC1; varying vec3 vC2; varying vec3 vC3; varying vec3 vC4;
  varying float vN;
  varying float vA;
  varying float vDepth;
  uniform vec2 uFade;
  ${SPACE_GLSL}
  void main() {
    float r = length(vUv);
    if (r >= 1.0) discard;
    float x = r * vN;
    vec3 col = vC0;
    col = mix(col, vC1, clamp(x - 0.0, 0.0, 1.0) * step(1.5, vN));
    col = mix(col, vC2, clamp(x - 1.0, 0.0, 1.0) * step(2.5, vN));
    col = mix(col, vC3, clamp(x - 2.0, 0.0, 1.0) * step(3.5, vN));
    col = mix(col, vC4, clamp(x - 3.0, 0.0, 1.0) * step(4.5, vN));
    // Soft over the whole radius, not just the last stop's segment: a 2D blob is huge and
    // overlaid inside its own field, so its rim never reads; here a lone disc with a
    // last-segment fade reads as a ring.
    float edge = pow(1.0 - smoothstep(0.0, 1.0, r), 1.6);
    float a = vA * edge
      * smoothstep(uFade.x, uFade.y, vDepth)
      * haze(vDepth);
    if (a < 0.002) discard;
    gl_FragColor = blendOut(col, a);
  }
`;

function buildBlobs(rng, seed, designRadial, paletteColors, L) {
  // The design's own blobs first, then more from the same generator on side streams until
  // the flight is populated -- same colours, alphas and size distribution as the 2D layer.
  const pool = [];
  if (designRadial) pool.push(...designRadial.radGradients.map(b => ({ b, size: designRadial.radGradSize })));
  const want = Math.max(4, Math.round(BLOBS_PER_REF * (L / REFERENCE_LENGTH)));
  for (let k = 0; pool.length < want && k < 50; k++) {
    // Generate* constructors return their config object, not an instance (see
    // GenerateGeometricShape's note), which tsc cannot see.
    const f = /** @type {any} */ (new GenerateLargeRadialField(REF_W, REF_H, paletteColors, makeRng(`${seed}-3d-radial-${k}`)));
    pool.push(...f.radGradients.map(b => ({ b, size: f.radGradSize })));
  }
  const blobs = pool.slice(0, want).map(({ b }, i) => {
    const size = b.size * PX * BLOB_SCALE;
    // Centre in the 2D canvas (drawImage places the square's top-left at x,y)
    const cx = (b.x + b.size / 2 - REF_W / 2) * PX;
    const cy = -(b.y + b.size / 2 - REF_H / 2) * PX;
    return {
      z: ((i + rng()) / want) * L,
      cx,
      cy,
      half: size / 2,
      alpha: Number(b.alpha),
      colors: b.colors.slice(0, 5).map(srgb)
    };
  });

  const n = blobs.length;
  const positions = new Float32Array(n * 4 * 3);
  const uv = new Float32Array(n * 4 * 2);
  const cols = [0, 1, 2, 3, 4].map(() => new Float32Array(n * 4 * 3));
  const nAttr = new Float32Array(n * 4);
  const aAttr = new Float32Array(n * 4);
  const index = new Uint32Array(n * 6);
  const corners = [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1]
  ];
  blobs.forEach((blob, i) => {
    for (let c = 0; c < 4; c++) {
      const v = i * 4 + c;
      uv.set(corners[c], v * 2);
      for (let s = 0; s < 5; s++) cols[s].set(blob.colors[Math.min(s, blob.colors.length - 1)], v * 3);
      nAttr[v] = blob.colors.length;
      aAttr[v] = blob.alpha;
    }
  });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage));
  geo.setAttribute('aUv', new THREE.BufferAttribute(uv, 2));
  cols.forEach((arr, s) => geo.setAttribute(`aC${s}`, new THREE.BufferAttribute(arr, 3)));
  geo.setAttribute('aN', new THREE.BufferAttribute(nAttr, 1));
  geo.setAttribute('aA', new THREE.BufferAttribute(aAttr, 1));
  geo.setIndex(new THREE.BufferAttribute(index, 1).setUsage(THREE.DynamicDrawUsage));
  const materials = blendMaterials('layer-over', {
    vertexShader: BLOB_VERT,
    fragmentShader: BLOB_FRAG,
    uniforms: { uFade: { value: new THREE.Vector2(...BLOB_NEAR_FADE) } }
  });
  const mesh = new THREE.Mesh(geo, materials);
  mesh.frustumCulled = false;

  const depth = new Float32Array(n);
  const order = [];
  function update(camZ) {
    order.length = 0;
    for (let i = 0; i < n; i++) {
      const b = blobs[i];
      let dz = (((b.z - camZ) % L) + L) % L;
      if (dz > L - BEHIND) dz -= L;
      if (dz > VIEW_FAR || dz < -BEHIND) continue;
      depth[i] = dz;
      const w = warpW(dz);
      for (let c = 0; c < 4; c++) {
        const o = (i * 4 + c) * 3;
        positions[o] = (b.cx + corners[c][0] * b.half) * w;
        positions[o + 1] = (b.cy + corners[c][1] * b.half) * w;
        positions[o + 2] = camZ + dz;
      }
      order.push(i);
    }
    order.sort((i, j) => depth[j] - depth[i]);
    geo.clearGroups();
    for (let s = 0; s < order.length; s++) {
      const b = order[s] * 4;
      index.set([b, b + 1, b + 2, b, b + 2, b + 3], s * 6);
      for (let m = 0; m < materials.length; m++) geo.addGroup(s * 6, 6, m);
    }
    geo.index.needsUpdate = true;
    geo.attributes.position.needsUpdate = true;
  }
  return { mesh, materials, geo, update, count: n };
}

// ─── Stars ────────────────────────────────────────────────────────────────────────────
// Haze for the star layers, and for points their size below a pixel: GL never draws a point
// smaller than one pixel, so without this a far star stays a full-strength dot however far
// away it is (and a 4K export's would read dimmer than the same star in a 1080p preview).
// Scaling by the covered area keeps a star's total light what its real size gives it.
function applyHazeShader(mat, uStreak = null, points = false) {
  mat.onBeforeCompile = shader => {
    let decls = 'varying float vHaze;\n' + SPACE_GLSL;
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
        '#include <project_vertex>\n      float starW = warpW(-mvPosition.z);\n      mvPosition.xy *= starW;\n      gl_Position = projectionMatrix * mvPosition;\n      vHaze = haze(-mvPosition.z);'
      );
    if (points) {
      // three sizes an attenuated point by distance alone, leaving out the lens, so on a wide lens
      // the stars would stay their pixel size while everything else shrank. projectionMatrix[1][1]
      // is 1 / tan(fov / 2); scaled by REF_FOV's tan, star sizes read as tuned at REF_FOV.
      shader.vertexShader = shader.vertexShader.replace(
        '#include <logdepthbuf_vertex>',
        `gl_PointSize *= projectionMatrix[1][1] * ${TAN_REF.toFixed(5)} * starW;
      vHaze *= clamp(gl_PointSize * gl_PointSize, 0.0, 1.0);
      gl_PointSize = max(gl_PointSize, 1.0);
      #include <logdepthbuf_vertex>`
      );
    }
    shader.fragmentShader =
      'varying float vHaze;\n' +
      shader.fragmentShader.replace('#include <premultiplied_alpha_fragment>', 'gl_FragColor.a *= vHaze;\n#include <premultiplied_alpha_fragment>');
  };
  // three keys compiled programs on onBeforeCompile's source, which both variants share
  mat.customProgramCacheKey = () => `haze-${mat.type}-${points}-${!!uStreak}`;
  return mat;
}

// Star colours are computed ON THE GPU, from the palette and the cycle's progress. Every star's
// colour moves with time (it drifts through the star palette), and recomputing ~70,000 of them
// in JavaScript each frame and re-uploading them was nearly the whole frame: 8.5ms on a desktop
// CPU, 35ms with the CPU throttled 4x, against 0.6ms for ALL the GPU work, and it held an
// iPhone 18 Pro to 22-26 fps (Aaron, 2026-09-29). Each star now carries only its fixed traits
// -- palette phase, hue offset, saturation, lightness offset, near-white flag -- and the vertex
// shader applies the same formula the JavaScript did (paletteAtHsl, then HSL -> RGB).
const MAX_STAR_PALETTE = 8;
const STAR_COLOR_GLSL = /* glsl */ `
  uniform vec3 uStarPal[${MAX_STAR_PALETTE}];
  uniform float uStarPalN;
  uniform float uStarProgress;
  attribute vec4 aStar;   // palette phase, hue offset, saturation factor, lightness offset
  attribute float aWhite; // 1 for the near-white share
  float starHueLerp(float a, float b, float t) {
    float d = b - a;
    if (d > 0.5) d -= 1.0;
    if (d < -0.5) d += 1.0;
    return fract(a + d * t + 1.0);
  }
  vec3 starHsl2rgb(vec3 c) {
    vec3 rgb = clamp(abs(mod(c.x * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
    return c.z + c.y * (rgb - 0.5) * (1.0 - abs(2.0 * c.z - 1.0));
  }
  vec3 starColour() {
    float x = fract(uStarProgress + aStar.x) * uStarPalN;
    float fi = floor(x);
    int i = int(mod(fi, uStarPalN));
    int j = int(mod(fi + 1.0, uStarPalN));
    float f = x - fi;
    vec3 a = uStarPal[i];
    vec3 b = uStarPal[j];
    vec3 p = vec3(starHueLerp(a.x, b.x, f), mix(a.y, b.y, f), mix(a.z, b.z, f));
    if (aWhite > 0.5) return starHsl2rgb(vec3(p.x, 0.15, 0.9));
    return starHsl2rgb(vec3(fract(p.x + aStar.y + 1.0), min(1.0, p.y * aStar.z + 0.08), clamp(p.z + aStar.w, 0.2, 0.85)));
  }
`;

// Per-star traits as vertex attributes, each star's values repeated `dup` times (streaks draw
// two vertices per star).
function starTraitAttributes(geo, field, dup = 1) {
  const n = field.count;
  const traits = new Float32Array(n * dup * 4);
  const white = new Float32Array(n * dup);
  for (let i = 0; i < n; i++) {
    for (let d = 0; d < dup; d++) {
      const v = i * dup + d;
      traits.set([field.cyclePhase[i], field.hue[i], field.sat[i], field.lit[i]], v * 4);
      white[v] = field.white[i];
    }
  }
  geo.setAttribute('aStar', new THREE.BufferAttribute(traits, 4));
  geo.setAttribute('aWhite', new THREE.BufferAttribute(white, 1));
}

// Chains onto a material's existing onBeforeCompile (the haze, and for streaks the extrusion)
// and replaces the vertex-colour read with the computed colour.
function withStarColour(mat, uniforms) {
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader, renderer) => {
    prev?.(shader, renderer);
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = STAR_COLOR_GLSL + shader.vertexShader.replace('#include <color_vertex>', 'vColor = vec4(starColour(), 1.0);');
  };
  mat.customProgramCacheKey = () => `star-colour-${mat.type}-${!!prev}`;
  return mat;
}

function makeStarStreaks(field, uStreak) {
  const n = field.count;
  const pos = new Float32Array(n * 2 * 3);
  const col = new Float32Array(n * 2 * 3);
  const dir = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    for (let v = 0; v < 2; v++) pos.set(field.pos.subarray(i * 3, i * 3 + 3), (i * 2 + v) * 3);
    dir[i * 2 + 1] = 1;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setAttribute('aStreak', new THREE.BufferAttribute(dir, 1));
  starTraitAttributes(geo, field, 2);
  const mat = applyHazeShader(
    new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: false
    }),
    uStreak
  );
  const lines = [];
  return { geo, mat, lines };
}

const CLUSTER = { freqLarge: 0.04, freqMid: 0.1, freqFine: 0.28, ampLarge: 0.6, ampMid: 0.28, ampFine: 0.12, contrast: 7, fill: 3.5 };
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

// Every star tracks the 2D star field's tint gradient (the contrast palette the 2D stars are
// painted with), with a share running near-white. The tunnel's fixed astronomical types
// (blue-white, orange) are gone: they put colours in the scene that the design never chose.
function starPersonality(rng) {
  // lit is an OFFSET on the palette's own lightness: the 2D contrast palette already puts
  // its lightness where it reads against this design's sky.
  const white = rng() >= 0.82;
  return { white, hue: (rng() - 0.5) * 0.05, sat: 0.9 + rng() * 0.1, lit: (rng() - 0.3) * 0.12 };
}

// The small and far star layouts are the same for every design at a given content length, so
// they are placed once and cached: placement is rejection sampling against a three-octave noise
// field, and it was ~220ms of every scene build -- nearly the whole freeze after pressing
// Generate (Aaron, 2026-09-29: "it just sort of freezes"). Colour is per design (on the GPU),
// and each design turns and slides the shared layout (see createTunnelScene), so fields still
// differ between designs. The large sprites stay per seed; there are only a few hundred.
// Placement is still ~500ms on a phone the first time a content length is seen (the first press of
// the Animation tab, or a new Duration), all in one task -- it froze the hexagon loader mid-stroke
// (Aaron, 2026-09-30). So it is a generator: cachedStarField runs it to completion, and
// warmTunnelStars runs the same generator in ~8ms slices ahead of a build. One generator for both
// is what keeps a warmed layout identical to one placed in a single pass. A build that arrives
// mid-warm finishes the pending generator rather than starting over.
const STAR_FIELD_CACHE = new Map();
const STAR_FIELD_CACHE_MAX = 6;
const STAR_FIELD_PENDING = new Map();
const starFieldKey = (kind, count, L) => `${kind}|${count}|${L}`;
function storeStarField(key, field) {
  STAR_FIELD_PENDING.delete(key);
  STAR_FIELD_CACHE.set(key, field);
  if (STAR_FIELD_CACHE.size > STAR_FIELD_CACHE_MAX) STAR_FIELD_CACHE.delete(STAR_FIELD_CACHE.keys().next().value);
  return field;
}
function starFieldGenerator(kind, count, L, rMin, rMax) {
  const key = starFieldKey(kind, count, L);
  let gen = STAR_FIELD_PENDING.get(key);
  if (!gen) {
    gen = starFieldSteps(makeRng(`3d-stars-${key}`), count, L, rMin, rMax);
    STAR_FIELD_PENDING.set(key, gen);
  }
  return gen;
}
function cachedStarField(kind, count, L, rMin, rMax) {
  const key = starFieldKey(kind, count, L);
  const hit = STAR_FIELD_CACHE.get(key);
  if (hit) return hit;
  const gen = starFieldGenerator(kind, count, L, rMin, rMax);
  let step = gen.next();
  while (!step.done) step = gen.next();
  return storeStarField(key, step.value);
}

// A flight's layout for a Duration: the content length L the camera laps, how many laps a cycle
// takes, and how many plates sit along L.
function plateCount(L) {
  return Math.max(3, Math.round(L / PLATE_SPACING));
}
function flightLayout(duration) {
  const travel = FLIGHT_SPEED * duration;
  const laps = Math.max(1, Math.ceil(travel / MAX_CONTENT_LENGTH));
  const L = travel / laps;
  return { L, laps, plates: plateCount(L) };
}

// The two star fields a scene of this duration uses -- the same derivation as createTunnelScene
function starFieldSpecs(duration) {
  const { L } = flightLayout(duration);
  const lenScale = L / REFERENCE_LENGTH;
  return [
    ['near', Math.round(SMALL_STAR_COUNT * lenScale), L, TUNNEL_CORE, TUNNEL_RADIUS],
    ['far', Math.round(FAR_STAR_COUNT * lenScale), L, TUNNEL_RADIUS, FAR_STAR_RADIUS]
  ];
}

// Places the star layout for a duration without holding the main thread for more than ~budgetMs
// at a time, so a createTunnelScene straight after it finds the cache warm.
export async function warmTunnelStars(duration, budgetMs = 8) {
  for (const [kind, count, L, rMin, rMax] of starFieldSpecs(duration)) {
    const key = starFieldKey(kind, count, L);
    while (!STAR_FIELD_CACHE.has(key)) {
      const gen = starFieldGenerator(kind, count, L, rMin, rMax);
      const until = performance.now() + budgetMs;
      let step = gen.next();
      while (!step.done && performance.now() < until) step = gen.next();
      if (step.done) storeStarField(key, step.value);
      else await new Promise(r => setTimeout(r, 0));
    }
  }
}

function makeStarField(rng, count, L, rMin, rMax) {
  const gen = starFieldSteps(rng, count, L, rMin, rMax);
  let step = gen.next();
  while (!step.done) step = gen.next();
  return step.value;
}

function* starFieldSteps(rng, count, L, rMin = TUNNEL_CORE, rMax = TUNNEL_RADIUS) {
  const pos = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const hue = new Float32Array(count);
  const sat = new Float32Array(count);
  const lit = new Float32Array(count);
  const white = new Uint8Array(count);
  const cyclePhase = new Float32Array(count);
  let placed = 0;
  let guard = count * 400;
  let tries = 0;
  while (placed < count && guard-- > 0) {
    if (++tries % 512 === 0) yield;
    const ang = rng() * TWO_PI;
    const r = rMin + Math.sqrt(rng()) * (rMax - rMin);
    const z = rng() * L;
    const x = Math.cos(ang) * r;
    const y = Math.sin(ang) * r;
    if (rng() > Math.pow(clusterDensity(x, y, z, L), CLUSTER.contrast) * CLUSTER.fill) continue;
    pos[placed * 3] = x;
    pos[placed * 3 + 1] = y;
    pos[placed * 3 + 2] = z;
    const p = starPersonality(rng);
    hue[placed] = p.hue;
    sat[placed] = p.sat;
    lit[placed] = p.lit;
    white[placed] = p.white ? 1 : 0;
    // Palette position from where the star sits around the axis (the 2D tint is a gradient
    // ACROSS the canvas), drifting with depth so colour sweeps along the flight.
    cyclePhase[placed] = ang / TWO_PI + (z / L) * 0.5;
    placed++;
  }
  return { pos, colors, hue, sat, lit, white, cyclePhase, count: placed };
}

// ─── Logo mark ────────────────────────────────────────────────────────────────────────
// The mark is an object IN the flight: it sits LOGO_SEAM_DISTANCE ahead of where the camera is
// at the loop seam, and the camera's own travel carries it -- approaching from the distance as a
// loop ends, holding at its seam pose through the ramp's near-stop, and flying past as the next
// loop gets under way -- in the same space as the plates. Its size, fade and
// stroke come from logoIntro's curves, evaluated at its real distance (s = 0 at the seam, +/-1
// where the mark is 2^+/-LOGO_OCTAVES of its seam size), so the seam frame is exactly the pose it
// always was. It used to hang a fixed distance ahead of the camera and move on logoIntro's own
// clock, whose floor (0.25x) is not the flight's (0.03x): through the near-stop it zoomed about
// four times faster than the world around it (Aaron, 2026-09-30: "make sure the logo animation is
// in sync too"). 2D keeps logoIntro's clock, which there IS the animation's own ramp.
const LOGO_SEAM_DISTANCE = 60;
const LOGO_PLANE_SIZE = LOGO_SCREEN_FRACTION * 2 * LOGO_SEAM_DISTANCE * Math.tan((LENS_FOV * Math.PI) / 360);
const LOGO_TEXTURE_SIZE = 512;

// The palette a scene renders with, for callers outside it (the logo mark's accent): the
// 2D resolved background palette, which is what the sky is painted with.
export function sceneBasePalette(seed, colors = [], settings = null) {
  return generateArtwork(seed, 320, 320, colors, settings).gradientBackgroundConfig.colors.slice();
}

// ─── Scene factory ────────────────────────────────────────────────────────────────────
export function createTunnelScene({ seed, colors = [], settings = null, duration = 10, width, height, logoMark = null, exact = false, cage: cageOn = true }) {
  const rng = makeRng(`${seed}-3d`);
  // The 2D artwork for this seed, on the studio canvas. Everything in the flight derives
  // from it or from the generators that built it.
  const art = generateArtwork(seed, REF_W, REF_H, colors, settings);

  const geometry = getGeometrySettings(settings);
  const paletteColors =
    colors.length === 1 ? expandMonochromePalette(colors[0], makeRng(`${seed}-palette`)) : colors;

  const camera = new THREE.PerspectiveCamera(LENS_FOV, (width || 1) / (height || 1), 0.1, VIEW_FAR + 100);
  const { L, laps } = flightLayout(duration);
  const lenScale = L / REFERENCE_LENGTH;
  const spriteScale = Math.sqrt(lenScale);
  const disposables = [];
  const view = new THREE.Vector2(width || REF_W, height || REF_H);
  const quad = new THREE.PlaneGeometry(2, 2);
  disposables.push(quad);
  const screenQuad = mat => {
    const mesh = new THREE.Mesh(quad, mat);
    mesh.frustumCulled = false;
    disposables.push(mat);
    return mesh;
  };
  const passMaterial = (fragmentShader, uniforms) =>
    new THREE.ShaderMaterial({
      vertexShader: GRADIENT_VERT,
      fragmentShader,
      uniforms,
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending
    });

  const uStreak = { value: 0 };
  const uViewHalfH = { value: (height || REF_H) / 2 };

  // ── Sky: the design's own background gradient
  const skyScene = new THREE.Scene();
  const skyUniforms = gradientUniforms(art.gradientBackgroundConfig, 1);
  skyUniforms.uView.value = view;
  skyScene.add(screenQuad(passMaterial(BLEND_GLSL + GRADIENT_FRAG, { ...skyUniforms, uMode: { value: 0 } })));

  // ── Radial field layer
  const radialScene = new THREE.Scene();
  const blobs = buildBlobs(rng, seed, art.radialFieldConfig, paletteColors, L);
  radialScene.add(blobs.mesh);
  disposables.push(blobs.geo, ...blobs.materials);

  // ── Star layer, tinted by the 2D star field's gradient
  const starScene = new THREE.Scene();
  // Rush streaks are their own layer, composited 'screen': light speed-lines that never
  // darken. Inside the star layer (source-over) they laid a grey veil over pale skies.
  const streakScene = new THREE.Scene();
  const starPaletteHsl = art.starFieldConfig.gradientConfig.colors.map(toHsl);
  const starPal = starPaletteHsl.slice(0, MAX_STAR_PALETTE).map(c => new THREE.Vector3(c.h, c.s, c.l));
  while (starPal.length < MAX_STAR_PALETTE) starPal.push(starPal[starPal.length - 1].clone());
  const starColourUniforms = {
    uStarPal: { value: starPal },
    uStarPalN: { value: Math.min(MAX_STAR_PALETTE, starPaletteHsl.length) },
    uStarProgress: { value: 0 }
  };
  const texLoader = new THREE.TextureLoader();
  const smallMats = [];
  const largeMats = [];
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
  // Stars accumulate additively INTO their own transparent layer (a bright core reads as a
  // star), and the finished layer then composites with the 2D star blend -- source-over for
  // most designs, which is what lets a contrast-coloured star read on a pale sky, where an
  // additive star drawn onto the scene simply vanished.
  const starBlend = mat => {
    mat.blending = THREE.CustomBlending;
    mat.blendEquation = THREE.AddEquation;
    mat.blendSrc = THREE.SrcAlphaFactor;
    mat.blendDst = THREE.OneFactor;
    mat.blendSrcAlpha = THREE.OneFactor;
    mat.blendDstAlpha = THREE.OneMinusSrcAlphaFactor;
    mat.transparent = true;
    mat.depthWrite = false;
    mat.depthTest = false;
    return mat;
  };
  const pointLayer = (field, size, opacity) => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(field.pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(field.colors, 3));
    starTraitAttributes(geo, field);
    const mat = withStarColour(
      applyHazeShader(
        starBlend(
          new THREE.PointsMaterial({ size, vertexColors: true, opacity, sizeAttenuation: true, alphaTest: 0.01, fog: false })
        ),
        null,
        true
      ),
      starColourUniforms
    );
    smallMats.push(mat);
    disposables.push(geo, mat);
    for (const zOff of [-L, 0, L]) {
      const pts = new THREE.Points(geo, mat);
      pts.position.z = zOff;
      pts.userData.zOff = zOff;
      starScene.add(pts);
    }
  };
  const field = cachedStarField('near', Math.round(SMALL_STAR_COUNT * lenScale), L, TUNNEL_CORE, TUNNEL_RADIUS);
  pointLayer(field, 0.7, 0.95);
  const farField = cachedStarField('far', Math.round(FAR_STAR_COUNT * lenScale), L, TUNNEL_RADIUS, FAR_STAR_RADIUS);
  pointLayer(farField, 1.0, 0.85);
  // Each design turns the shared layout about the flight axis and slides it along the loop,
  // so no two designs' fields line up. Applied to the objects, so it costs nothing per frame.
  const starTurn = rng() * TWO_PI;
  const starSlide = rng() * L;

  const streakLayers = [makeStarStreaks(field, uStreak), makeStarStreaks(farField, uStreak)];
  for (const layer of streakLayers) {
    starBlend(layer.mat);
    withStarColour(layer.mat, starColourUniforms);
    disposables.push(layer.geo, layer.mat);
    for (const zOff of [-L, 0, L]) {
      const line = new THREE.LineSegments(layer.geo, layer.mat);
      line.position.z = zOff;
      line.userData.zOff = zOff;
      line.visible = false;
      line.frustumCulled = false;
      streakScene.add(line);
      layer.lines.push(line);
    }
  }
  for (const scene of [starScene, streakScene]) {
    for (const obj of scene.children) {
      if (obj.userData.zOff === undefined) continue;
      obj.rotation.z = starTurn;
      obj.position.z = obj.userData.zOff + starSlide;
    }
  }
  const largeField = makeStarField(rng, Math.round(LARGE_STAR_COUNT * spriteScale), L);
  const largeSprites = [];
  for (let i = 0; i < largeField.count; i++) {
    const mat = starBlend(new THREE.SpriteMaterial({ fog: false }));
    largeMats.push(mat);
    disposables.push(mat);
    const baseScale = 1.2 + rng() * 4.2;
    for (const zOff of [-L, 0, L]) {
      const sprite = new THREE.Sprite(mat);
      sprite.scale.setScalar(baseScale);
      sprite.position.set(largeField.pos[i * 3], largeField.pos[i * 3 + 1], largeField.pos[i * 3 + 2] + zOff);
      starScene.add(sprite);
      largeSprites.push({ sprite, index: i, baseScale, x: sprite.position.x, y: sprite.position.y });
    }
  }

  // ── Geometry plates, drawn as vectors (see "The geometry layer")
  const { plates, data: plateData } = buildPlates(seed, art.geometryConfig || null, paletteColors, settings, geometry, L);
  disposables.push(plateData.triTex, plateData.cellTex);
  const plateUniformsState = {
    uTris: { value: plateData.triTex },
    uCells: { value: plateData.cellTex },
    uBlend: { value: 0 },
    uDepth: { value: 100 },
    uTanHalf: { value: new THREE.Vector2(1, 1) },
    uRot: { value: new THREE.Vector2(1, 0) },
    uOffset: { value: new THREE.Vector2() },
    uPx: { value: PX },
    uHalf: { value: 1 },
    uCellBase: { value: 0 },
    uHoleQ: { value: 0 },
    uHoleSoftQ: { value: 1 },
    uMaxList: { value: plateData.maxList }
  };
  const plateScene = new THREE.Scene();
  plateScene.add(screenQuad(passMaterial(PLATE_FRAG.replace('BLEND_FUNCS', BLEND_FUNCS), plateUniformsState)));
  const plateCompUniforms = {
    uBack: { value: null },
    uCache: { value: null },
    uBlend: { value: BLEND_INDEX[art.thirdBlend || 'source-over'] ?? 0 },
    uAlpha: { value: 1 },
    uScale: { value: 1 }
  };
  const plateCompScene = new THREE.Scene();
  plateCompScene.add(screenQuad(passMaterial(PLATE_COMP_FRAG.replace('BLEND_FUNCS', BLEND_FUNCS), plateCompUniforms)));
  // ── The cage (see "The cage"), on its own rng stream
  // Two layers. The panels composite with the design's own geometry blend, so they sit in the
  // frame the way its shapes do. The lines are light over dark and dark over bright, decided per
  // pixel from what is actually beneath them: screen alone vanished on a near-white sky, and a
  // sky-wide switch turned a vivid design's cage into dark scratches.
  const cageLineBlend = 8; // COMPOSITE_FRAG's per-pixel light-or-dark mode
  const cageLineScene = new THREE.Scene();
  const cagePanelScene = new THREE.Scene();
  let cage = null;
  // Its colours: the design's resolved palette plus the 2D star field's contrast palette, so it
  // carries hues the sky does not already have.
  const cagePaletteHsl = [...art.gradientBackgroundConfig.colors, ...art.starFieldConfig.gradientConfig.colors].map(toHsl);
  if (cageOn) {
    cage = buildCage(makeRng(`${seed}-3d-cage`), geometry, L, uViewHalfH);
    cage.group.traverse(obj => {
      if (obj.geometry) disposables.push(obj.geometry);
      if (obj.material) disposables.push(obj.material);
    });
    for (const zOff of [-L, 0, L]) {
      const lines = zOff === 0 ? cage.edgeLines : cage.edgeLines.clone();
      const panels = zOff === 0 ? cage.panelMesh : cage.panelMesh.clone();
      lines.position.z = zOff;
      panels.position.z = zOff;
      cageLineScene.add(lines);
      cagePanelScene.add(panels);
    }
  }
  // Cache targets, handed to the plates in view and taken back when they leave it
  const cachePool = [];
  const cacheOf = new Map(); // plate -> { rt, dz, tan }
  let visiblePlates = [];

  // ── Overlay layer
  let overlayScene = null;
  let overlayUniforms = null;
  if (art.overlayConfig) {
    overlayScene = new THREE.Scene();
    overlayUniforms = gradientUniforms(art.overlayConfig, 1);
    overlayUniforms.uView.value = view;
    overlayScene.add(screenQuad(passMaterial(BLEND_GLSL + GRADIENT_FRAG, { ...overlayUniforms, uMode: { value: 0 } })));
  }

  // ── Logo mark: drawn straight onto the finished frame
  const logoScene = new THREE.Scene();
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
    mesh.visible = false;
    logoScene.add(mesh);
    disposables.push(geo, mat, tex);
    logo = { ctx, tex, mat, mesh, lastDraw: -1 };
  }

  // ── Compositor targets and passes
  // Two layer targets. Multisampling only smooths hard triangle and line edges -- the cage and
  // the rush streaks -- and every pass through a multisampled target pays for a resolve, which
  // measured at two-thirds of the whole frame's GPU time (4.9ms -> 1.7ms at a phone's 804x1748,
  // 2026-09-30). The sky blobs, stars and overlay are soft sprites and full-screen quads, which
  // multisampling barely touches (only the faint outer border of each star's quad, measured
  // across four designs), so they go through the plain target. Halves the frame on every design.
  const layerTargetAA = new THREE.WebGLRenderTarget(1, 1, { samples: 4 });
  const layerTarget = new THREE.WebGLRenderTarget(1, 1);
  let accum = new THREE.WebGLRenderTarget(1, 1);
  let spare = new THREE.WebGLRenderTarget(1, 1);
  const compositeUniforms = {
    uBack: { value: null },
    uLayer: { value: null },
    uBlend: { value: 0 },
    uAlpha: { value: 1 }
  };
  const orthoCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const compositeScene = new THREE.Scene();
  compositeScene.add(screenQuad(passMaterial(COMPOSITE_FRAG, compositeUniforms)));
  const copyUniforms = { uSrc: { value: null } };
  const copyScene = new THREE.Scene();
  copyScene.add(screenQuad(passMaterial(COPY_FRAG, copyUniforms)));

  const blendOf = mode => BLEND_INDEX[mode] ?? 0;
  const radialBlend = blendOf(art.firstBlend);
  const starsBlend = blendOf(art.secondBlend);
  const overlayBlend = blendOf(art.overlayBlend);
  const overlayAlpha = Number(art.overlayAlpha) || 0;

  const _col = new THREE.Color();
  // Star colours are written as raw sRGB (setHSL's colour-space argument says "no
  // conversion") so the star layer lands in the compositor in the same space as the rest.
  const RAW = THREE.LinearSRGBColorSpace;
  function starColor(f, i, progress) {
    const p = paletteAtHsl(starPaletteHsl, progress + f.cyclePhase[i]);
    if (f.white[i]) return _col.setHSL(p.h, 0.15, 0.9, RAW);
    return _col.setHSL(
      (p.h + f.hue[i] + 1) % 1,
      Math.min(1, p.s * f.sat[i] + 0.08),
      Math.min(0.85, Math.max(0.2, p.l + f.lit[i])),
      RAW
    );
  }
  const smooth = (e0, e1, x) => {
    const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
    return t * t * (3 - 2 * t);
  };
  let streaksOn = false;

  // showLogo: whether the mark is drawn at all (the scene must also have been built with one);
  // where it is and how it looks come from the flight -- see "Logo mark".
  function setTime(seconds, rush = 0, showLogo = false) {
    const progress = (((seconds / duration) % 1) + 1) % 1;

    const surge = surgeOf(rush);
    camera.fov = LENS_FOV + RUSH_FOV_BOOST * surge;
    camera.updateProjectionMatrix();
    const streaking = rush > RUSH_STREAK_EPS;
    streaksOn = streaking;
    uStreak.value = STREAK_LENGTH * rush;
    for (const layer of streakLayers) {
      layer.mat.opacity = STREAK_OPACITY * rush;
      for (const line of layer.lines) line.visible = streaking;
    }

    const camZ = ((((progress * laps) % 1) + 1) % 1) * L;
    camera.position.set(0, 0, camZ);
    camera.lookAt(0, 0, camZ + 20);

    // The sky and overlay hold still. They used to sway on a sine over the cycle, which read
    // as the whole frame rocking one way and then the other.

    starColourUniforms.uStarProgress.value = progress;
    // A large star's three copies (-L, 0, +L) share one material, and at most one of them is
    // inside the draw distance, so the wrapped distance gives that copy's haze.
    for (const { sprite, index, baseScale, x, y } of largeSprites) {
      sprite.material.color.copy(starColor(largeField, index, progress));
      const w = warpW(sprite.position.z - camZ);
      sprite.scale.setScalar(baseScale * w);
      sprite.position.x = x * w;
      sprite.position.y = y * w;
      let dz = (((sprite.position.z - camZ) % L) + L) % L;
      if (dz > L - BEHIND) dz -= L;
      sprite.material.opacity = haze(dz);
    }

    blobs.update(camZ);
    if (cage) cage.update(progress, cagePaletteHsl, camZ);

    // Plates in view, far to near, each with its fade
    const tanNow = Math.tan((camera.fov * Math.PI) / 360);
    visiblePlates = [];
    for (const plate of plates) {
      if (!plate.present) continue;
      let dz = (((plate.z - camZ) % L) + L) % L;
      if (dz > L - BEHIND) dz -= L;
      if (dz > VIEW_FAR) continue;
      const alpha = smooth(PLATE_NEAR_FADE[0], PLATE_NEAR_FADE[1], dz) * haze(dz);
      // The warp, for a plate: it sits at one depth, so it is a uniform shrink toward the axis,
      // the same picture as drawing it at its effective depth.
      const effD = Math.max(0.5, dz) / warpW(dz);
      if (alpha < 0.002) continue;
      // Aperture radius: nothing until PLATE_HOLE[0], past the screen's corners by PLATE_HOLE[1].
      // Squared, so it opens gently and then races outward the way perspective does. Driven by
      // how big the plate looks (its warped depth as REF_FOV would show it), so it opens at the
      // same size on screen whatever the lens, the warp or the rush's FOV boost.
      const seen = (effD * tanNow) / TAN_REF;
      const ht = Math.min(1, Math.max(0, (PLATE_HOLE[0] - seen) / (PLATE_HOLE[0] - PLATE_HOLE[1])));
      const hole = ht * ht * (Math.hypot(camera.aspect, 1) + PLATE_HOLE_SOFT);
      if (ht >= 1) continue;
      visiblePlates.push({ plate, dz: effD, alpha, hole });
    }
    visiblePlates.sort((p, q) => q.dz - p.dz);

    if (logo) {
      // The mark's distance ahead along the cycle's whole travel (laps * L), so it comes round
      // once per cycle however many laps the camera makes
      const total = laps * L;
      const travel = progress * total;
      const ahead = travel < total / 2 ? LOGO_SEAM_DISTANCE - travel : total + LOGO_SEAM_DISTANCE - travel;
      const depth = Math.max(0.5, ahead);
      const s = Math.log2(LOGO_SEAM_DISTANCE / depth) / LOGO_OCTAVES;
      const on = showLogo && ahead > 0 && Math.abs(s) < 1;
      logo.mesh.visible = on;
      if (on) {
        logo.mesh.position.set(0, 0, camZ + depth);
        logo.mesh.scale.setScalar(warpW(depth)); // 1 at and inside the seam distance
        logo.mat.opacity = logoAlpha(s);
        const draw = Math.round(logoDraw(s) * 200) / 200;
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

  // The fraction of the screen a plate's bounding square covers, at view depth `depth`
  const plateCover = (plate, depth, tanY) => {
    const e = (plate.content.half * Math.SQRT2 * PX + Math.hypot(plate.ox, plate.oy)) / (depth * tanY);
    return (Math.min(e, camera.aspect) * Math.min(e, 1)) / camera.aspect;
  };

  // Callers draw with world.render(renderer). The frame is assembled layer by layer in the
  // order renderArtwork uses -- sky, radial field, stars, geometry (stars after it instead
  // if they sit on top), overlay -- then copied out, and the logo drawn over it.
  const _size = new THREE.Vector2();
  const _clear = new THREE.Color();
  function render(renderer) {
    renderer.getDrawingBufferSize(_size);
    uViewHalfH.value = _size.y / 2;
    for (const t of [layerTarget, layerTargetAA, accum, spare]) {
      if (t.width !== _size.x || t.height !== _size.y) t.setSize(_size.x, _size.y);
    }
    const target = renderer.getRenderTarget();
    const autoClear = renderer.autoClear;
    const clearAlpha = renderer.getClearAlpha();
    renderer.getClearColor(_clear);
    renderer.autoClear = false;

    renderer.setRenderTarget(accum);
    renderer.render(skyScene, orthoCam);

    const swap = () => {
      const t = accum;
      accum = spare;
      spare = t;
    };
    const composite = (layerScene, blend, alpha = 1, cam = camera, aa = false) => {
      const lt = aa ? layerTargetAA : layerTarget;
      compositeUniforms.uLayer.value = lt.texture;
      renderer.setRenderTarget(lt);
      renderer.setClearColor(0x000000, 0);
      renderer.clear();
      renderer.render(layerScene, cam);
      compositeUniforms.uBack.value = accum.texture;
      compositeUniforms.uBlend.value = blend;
      compositeUniforms.uAlpha.value = alpha;
      renderer.setRenderTarget(spare);
      renderer.render(compositeScene, orthoCam);
      swap();
    };

    if (blobs.count) composite(radialScene, radialBlend);
    if (!art.starsOnTop) composite(starScene, starsBlend);
    // One full-screen pass per plate in view, reading the frame so far and blending the
    // plate on with the design's geometry blend.
    const tanY = Math.tan((camera.fov * Math.PI) / 360);
    // Return the caches of plates that left the view
    const inView = new Set(visiblePlates.map(v => v.plate));
    for (const [plate, c] of cacheOf) {
      if (!inView.has(plate)) {
        cachePool.push(c.rt);
        cacheOf.delete(plate);
      }
    }
    // Which plate gets this frame's optional redraw: the most magnified one past the threshold.
    // Spreading redraws this way is what keeps a busy frame from redrawing several plates.
    let budgetPlate = null;
    let budgetScale = 1 / PLATE_CACHE_MAX_ZOOM;
    for (const { plate, dz } of visiblePlates) {
      const c = cacheOf.get(plate);
      if (!c || !c.fresh) continue;
      const sc = (tanY * dz) / (c.tan * c.dz);
      if (sc < budgetScale) {
        budgetScale = sc;
        budgetPlate = plate;
      }
    }
    const cacheRes = exact ? 1 : Math.min(1, PLATE_CACHE_MAX_DPR / renderer.getPixelRatio());
    const cw = Math.max(1, Math.round(_size.x * cacheRes));
    const ch = Math.max(1, Math.round(_size.y * cacheRes));
    for (const { plate, dz, alpha, hole } of visiblePlates) {
      const depth = dz;
      let c = cacheOf.get(plate);
      if (!c) {
        const rt = cachePool.pop() || new THREE.WebGLRenderTarget(cw, ch);
        c = { rt, dz: 0, tan: 0, fresh: false };
        cacheOf.set(plate, c);
      }
      if (c.rt.width !== cw || c.rt.height !== ch) {
        c.rt.setSize(cw, ch);
        c.fresh = false;
      }
      // How much of the cached view the current view spans (1 = all of it)
      let scale = c.fresh ? (tanY * depth) / (c.tan * c.dz) : 0;
      // The aperture is baked into the render, so a plate whose opening has moved AT ALL is
      // redrawn. A threshold here (it was 0.02 half-heights) advanced the opening in steps: near
      // the loop ends, where the camera is slow, a plate held for several frames and then its
      // fading shapes jumped.
      const holeMoved = hole !== (c.hole ?? 0);
      if (exact || !c.fresh || holeMoved || plateCover(plate, depth, tanY) < PLATE_CACHE_MIN_COVER || scale > 1 || scale < 1 / PLATE_CACHE_FORCE_ZOOM || plate === budgetPlate) {
        const tanC = exact ? tanY : tanY * PLATE_CACHE_MARGIN;
        plateUniforms(plate, plateUniformsState);
        // Aperture in the plate's own units, fixed in the world: screen half-heights at this depth
        plateUniformsState.uHoleQ.value = (hole * tanY * depth) / PX;
        plateUniformsState.uHoleSoftQ.value = (PLATE_HOLE_SOFT * tanY * depth) / PX;
        c.hole = hole;
        plateUniformsState.uTanHalf.value.set(tanC * camera.aspect, tanC);
        plateUniformsState.uDepth.value = depth;
        renderer.setRenderTarget(c.rt);
        renderer.render(plateScene, orthoCam);
        c.dz = depth;
        c.tan = tanC;
        c.fresh = true;
        scale = (tanY * depth) / (tanC * depth);
      }
      plateCompUniforms.uCache.value = c.rt.texture;
      plateCompUniforms.uScale.value = scale;
      plateCompUniforms.uAlpha.value = alpha;
      plateCompUniforms.uBack.value = accum.texture;
      renderer.setRenderTarget(spare);
      renderer.render(plateCompScene, orthoCam);
      swap();
    }
    if (cage) {
      composite(cagePanelScene, BLEND_INDEX[art.thirdBlend || 'source-over'] ?? 0, 1, camera, true);
      composite(cageLineScene, cageLineBlend, 1, camera, true);
    }
    if (art.starsOnTop) composite(starScene, starsBlend);
    if (streaksOn) composite(streakScene, BLEND_INDEX.screen, 1, camera, true);
    if (overlayScene) composite(overlayScene, overlayBlend, overlayAlpha, orthoCam);

    renderer.setRenderTarget(target);
    copyUniforms.uSrc.value = accum.texture;
    renderer.render(copyScene, orthoCam);
    if (logo && logo.mesh.visible) renderer.render(logoScene, camera);

    renderer.setClearColor(_clear, clearAlpha);
    renderer.autoClear = autoClear;
  }

  function setSize(w, h) {
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    view.set(w, h);
  }

  function dispose() {
    for (const d of disposables) d.dispose?.();
    layerTarget.dispose();
    layerTargetAA.dispose();
    accum.dispose();
    spare.dispose();
    for (const c of cacheOf.values()) c.rt.dispose();
    for (const rt of cachePool) rt.dispose();
  }

  setTime(0);
  return { scene: skyScene, camera, render, setSize, setTime, dispose, ready, plates, plateStats: { maxList: plateData.maxList, meanList: plateData.meanList } };
}

export default createTunnelScene;
