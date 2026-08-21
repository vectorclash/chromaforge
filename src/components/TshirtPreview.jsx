import React, { useEffect, useRef, useState } from 'react';
import { gsap } from 'gsap/all';
import ArrowIcon from './buttons/ArrowIcon';
import { useStudio } from '../context/StudioContext';
import { DURATION_FAST, DURATION_SLOW } from '../utils/motionTokens';
import { capMockupRenderSize } from '../lib/printful';

// Small live 3D garment preview for the homepage hero panel: the current design rendered
// as the base-color texture of a t-shirt model, slowly rotating. three.js is dynamically
// imported (same lazy-chunk treatment as Animation3DPreview) so it never loads for
// visitors who bounce before the hero settles.
//
// Model: "Tshirt" (https://sketchfab.com/3d-models/tshirt-a88d6e25d67c4b0c91b9ea013e679870)
// by khalilchahi99 (https://sketchfab.com/khalilchahi99), CC-BY-4.0 -- served from
// public/models/tshirt/ (fetched by URL, which Vite's import pipeline can't resolve from
// src/assets). license.txt ships alongside it and is a licence obligation, not optional.
//
// The .glb here is an OPTIMIZED build of the Sketchfab download, not the download itself:
// 4717KB across 5 requests (scene.gltf + scene.bin + 3 textures) -> 708KB in one. The
// source asset is scan-density -- 154,048 triangles for something drawn at 190 CSS px --
// so it is welded, simplified to 10% (22,624 tris, still well past what that size can
// resolve), quantized, and pruned, with the textures embedded. Rebuild with:
//   gltf-transform dedup  in.gltf p1.glb   &&  gltf-transform weld     p1.glb p2.glb
//   gltf-transform simplify p2.glb p3.glb --ratio 0.1 --error 0.001
//   gltf-transform quantize p3.glb p4.glb  &&  gltf-transform prune    p4.glb tshirt.glb
// The unmodified original is kept at src/assets/models/tshirt/ as the archival source.
//
// Two properties this pipeline had to preserve, since everything below depends on them:
// the UV LAYOUT (island rects are measured in atlas space -- simplification must not move
// them; verified identical bounds before/after, modulo ~0.0002 of int16 quantization
// rounding, i.e. sub-pixel on a 2048 sheet) and the MATERIAL NAMES/mesh split, which the
// traverse below relies on. It needs no loader plugin: KHR_mesh_quantization is the only
// required extension and three.js supports it natively. Deliberately NOT meshopt/Draco --
// both would shave another ~270KB but drag in a decoder for one small model.
//
// Texture spec (from the model's own baseColor atlas): a single square 2048x2048 sheet
// holding the front/back body panels, two sleeves, and hem-strip UV islands as flat
// cut-pattern shapes. A naive full-bleed square render put an arbitrary off-center CROP
// of the artwork on each panel (each island samples its own region of the sheet) -- the
// design never read as centered on the shirt. Instead, each island gets its own
// recompose-per-ratio render (same philosophy as the print pipeline: a sibling
// composition generated fresh from the seed), composited into the island's measured
// rect. Rects were flood-fill measured off the model's own material_baseColor.jpeg
// (2048-space, generous bounding boxes; the curved neckline/hem edges just clip
// whatever falls outside the island -- invisible, same as any print overhang). Both body
// panels share one render, as do the sleeves (matching the real product's own printfile
// sharing -- see below); the tiny hem strips sample the full-bleed base layer drawn
// underneath.
//
// Render size matches EXACTLY what a real mockup preview generates for this garment's
// front/back and sleeve panels -- not just the aspect ratio, but the actual resolution,
// via capMockupRenderSize (the same cap-and-scale math capRenderStrategy in lib/printful.js
// uses for real Printful mockup source images, factored out so both stay numerically
// identical). Body/sleeve printfile dims (product 257 -- All-Over Print Men's Crew Neck
// T-Shirt, the closest real product to this decorative model, from
// `scripts/printful-catalog-baseline.json`: front/back share printfile 94 at 4200x5400,
// both sleeves share printfile 95 at 3000x1800) are the same numbers a real mockup/order
// for this product would use.
//
// Matching only the ASPECT ratio (an earlier version of this fix) wasn't enough: the
// generator is ratio-aware, and getCountScale (render/scale.js) scales element counts off
// the render's ABSOLUTE area relative to the studio's reference resolution, not the aspect
// alone -- rendering at a small island-sized canvas (the original bug) or even a modest
// same-aspect canvas (this component's first attempted fix) still lands far below a real
// mockup's ~61%-of-reference density (RENDER_CAP=2000's own comment has the math), so the
// shirt visibly showed fewer stars/geometry and a different color structure than an actual
// Printful mockup of the same design (Aaron, live comparison). Rendering at the mockup
// pipeline's own resolution and then downscaling into the small UV islands (via drawCover,
// below) keeps the generated COMPOSITION itself density-matched to a real mockup; only the
// on-screen presentation is small, same as thumbnailing any other full-resolution image.
const TEXTURE_SIZE = 1024;
const ATLAS = 2048;
// [0] is the FRONT panel, [1] is the BACK -- the order is load-bearing (the back is drawn
// mirrored, see the draw call) and is NOT guessable from the rects, so it was measured off
// the model rather than assumed: for every triangle whose UV lands inside each rect, the mean
// POSITION z is +0.170 for [0] and -0.198 for [1], and the camera sits at +z looking at the
// origin with no base rotation on the pivot. Normals are useless for this -- the mesh is a
// closed solid, so each panel carries an inner and an outer surface and the +z/-z counts come
// out even (2632 vs 2606 on [0]). Re-measure if the model is ever replaced.
const BODY_ISLANDS = [
  { x: 61, y: 440, w: 916, h: 1332 },
  { x: 1114, y: 520, w: 872, h: 1267 }
];
const SLEEVE_ISLANDS = [
  { x: 125, y: 30, w: 729, h: 385 },
  { x: 1196, y: 33, w: 729, h: 385 }
];
// The 8 thin trim strips (flood-fill measured like the islands above; identities confirmed
// on a headless harness render with each strip painted a distinct color): the two 918-wide
// strips are the front/back hem trim, the two 725-wide are the sleeve cuffs, and the
// remaining four are collar ribbing/interior facings (two of those never show on the
// exterior at any angle -- interior facings; painting them the same way is harmless).
// Each strip gets a thin edge-band slice of the composition it sits against on the worn
// garment (hem = body bottom, cuff = sleeve bottom, collar = body top) so the trim reads
// as the print continuing over the seam -- previously they sampled arbitrary rows of the
// unrelated full-bleed base layer, which read as random off-design stripes (user-caught).
// Each cuff strip winds around its cuff in the SAME horizontal direction as its sleeve
// island's UVs, so a cuff band must mirror exactly when its sleeve's draw does: the
// y1879 strip belongs to the second sleeve island (the one drawn flipX for worn
// left/right symmetry) and takes the same `flip`; the y1919 strip belongs to the
// unmirrored sleeve and draws as-is. Confirmed by live user feedback both ways —
// flipping the y1919 band instead made BOTH cuffs read as mismatched ("wearer's left"
// = viewer-right = the y1879/mirrored-sleeve cuff was the off one).
const STRIP_ISLANDS = [
  { x: 29, y: 1797, w: 918, h: 34, from: 'body', edge: 'bottom', flip: true }, // back hem (mirrored body panel)
  { x: 30, y: 1838, w: 917, h: 34, from: 'body', edge: 'bottom' }, // front hem
  { x: 29, y: 1879, w: 725, h: 34, from: 'sleeve', edge: 'bottom', flip: true }, // cuff (mirrored sleeve)
  { x: 29, y: 1919, w: 725, h: 34, from: 'sleeve', edge: 'bottom' }, // cuff
  { x: 1219, y: 1811, w: 634, h: 26, from: 'body', edge: 'top' }, // facing (interior)
  { x: 1209, y: 1848, w: 646, h: 26, from: 'body', edge: 'top' }, // facing (interior)
  { x: 29, y: 1960, w: 494, h: 25, from: 'body', edge: 'top' }, // collar
  { x: 30, y: 1993, w: 329, h: 26, from: 'body', edge: 'top' } // collar
];
// Fraction of the source composition's height a trim strip samples from its edge.
const STRIP_BAND_FRAC = 0.06;
const BODY_PRINTFILE = { width: 4200, height: 5400 }; // product 257, printfile 94 (front+back)
const SLEEVE_PRINTFILE = { width: 3000, height: 1800 }; // product 257, printfile 95 (both sleeves)
const bodyCap = capMockupRenderSize(BODY_PRINTFILE.width, BODY_PRINTFILE.height);
const sleeveCap = capMockupRenderSize(SLEEVE_PRINTFILE.width, SLEEVE_PRINTFILE.height);
const BODY_RENDER = { w: bodyCap.width, h: bodyCap.height };
const SLEEVE_RENDER = { w: sleeveCap.width, h: sleeveCap.height };

// Crops `img` to `dw`x`dh`'s aspect (centered) and draws it filling the dest rect exactly
// -- no stretching. Needed now that each render's aspect intentionally matches the real
// print file rather than the destination island's own shape.
//
// Every island in this model's atlas is UV-mapped VERTICALLY FLIPPED on the garment
// (confirmed on a headless harness render with orientation-marked test textures: a
// top-of-rect marker lands at the hem, and labels read as vertical mirrors, not 180°
// rotations) -- so all body/sleeve draws pass flipY to counter it, otherwise the design
// appears upside down on the shirt relative to the hero background (user-caught).
function drawCover(ctx, img, dx, dy, dw, dh, { flipX = false, flipY = false } = {}) {
  const srcAspect = img.width / img.height;
  const destAspect = dw / dh;
  let sx, sy, sw, sh;
  if (srcAspect > destAspect) {
    sh = img.height;
    sw = sh * destAspect;
    sx = (img.width - sw) / 2;
    sy = 0;
  } else {
    sw = img.width;
    sh = sw / destAspect;
    sx = 0;
    sy = (img.height - sh) / 2;
  }
  ctx.save();
  ctx.translate(dx + (flipX ? dw : 0), dy + (flipY ? dh : 0));
  ctx.scale(flipX ? -1 : 1, flipY ? -1 : 1);
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, dw, dh);
  ctx.restore();
}

// Generate-transition pass: chromatic aberration + animated wavy distortion, both scaled
// by one normalized strength uniform (uAmount 0..1) so they rise and fall together.
// The aberration is a uniform LATERAL RGB split (red left, blue right) rather than
// radial-from-center -- radial was tried first and didn't read as aberration at this
// size (nothing happens at the centered shirt's chest while the edges turn into
// misregistered anaglyph channels); a small constant split gives the classic crisp
// red/blue ghost edges everywhere. The distortion is two crossed sine waves scrolling
// via uTime (fed from the rAF clock), so the shirt shimmers like heat-haze while the
// render is in flight. Alpha takes the max of the three taps so the fringe isn't
// clipped at the silhouette.
const ABERRATION_PEAK = 1;
const AberrationShader = {
  uniforms: {
    tDiffuse: { value: null },
    uAmount: { value: 0 },
    uTime: { value: 0 }
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uAmount;
    uniform float uTime;
    varying vec2 vUv;
    void main() {
      vec2 uv = vUv;
      // Two incommensurate octaves per axis with cross-axis phase terms -- a single
      // sine per axis read as a uniform corrugated ripple; the mixed frequencies give
      // larger, irregular blob-like warps instead.
      float nx = sin(uv.y * 6.8 + uTime * 3.1)
               + 0.6 * sin(uv.y * 13.7 - uTime * 4.3 + uv.x * 5.2);
      float ny = cos(uv.x * 5.9 - uTime * 2.6)
               + 0.6 * cos(uv.x * 11.3 + uTime * 3.8 + uv.y * 4.4);
      uv.x += nx * 0.012 * uAmount;
      uv.y += ny * 0.009 * uAmount;
      vec2 off = vec2(0.06 * uAmount, 0.0);
      vec4 cr = texture2D(tDiffuse, uv - off);
      vec4 cc = texture2D(tDiffuse, uv);
      vec4 cb = texture2D(tDiffuse, uv + off);
      gl_FragColor = vec4(cr.r, cc.g, cb.b, max(max(cr.a, cc.a), cb.a));
    }
  `
};

// `waiting` is the hero background's own isLoading (true from the Generate click until
// setImage fades the new artwork in). The shirt NEVER leaves during a generate (an
// earlier dip-out/return version made the centered shirt+buttons+loader arrangement
// visibly lose its left element for the whole render, user-rejected) -- instead the new
// design's sheet is staged as soon as it's composited (~200ms, long before the 4K
// background render finishes) and COMMITTED as a texture-level crossfade the moment
// `waiting` flips false, i.e. on the same beat the new background fades in. The
// crossfade redraws the material's single canvas each frame as an old/new blend
// (drawSheet with globalAlpha), which sidesteps the z-fighting/depth-sorting artifacts a
// literal second shirt mesh fading on top of the first would have.
export default function TshirtPreview({ size = 116, waiting = false, onShopClick }) {
  const mountRef = useRef(null);
  // Bridge between the async scene init and the async texture renders, whichever finishes
  // first: `api` appears once the scene is live; `stagedSheet` holds the latest composited
  // design sheet until it can be committed (scene ready AND background landed).
  // `hasTexture` gates the one-time entrance fade; `waiting` mirrors the prop for the
  // async paths.
  const stateRef = useRef({ api: null, stagedSheet: null, hasTexture: false, waiting });
  // Set by the touch-drag rotation the moment a press turns into a drag, so the click
  // that fires on release doesn't ALSO navigate to the shop (see the button's onClick).
  const dragSuppressClickRef = useRef(false);
  const [failed, setFailed] = useState(false);
  const { currentDesign, renderDesignBlob } = useStudio();

  stateRef.current.waiting = waiting;

  // Commit the staged sheet if every gate is open: scene live, sheet ready, background
  // landed. Called from all three places a gate can open. Always a texture-level
  // crossfade -- the scene comes up already wearing the model's white sheet (see init),
  // so even the first design has something to dissolve from.
  const commitStagedSheet = () => {
    const s = stateRef.current;
    if (!s.api || !s.stagedSheet || s.waiting) return;
    const sheet = s.stagedSheet;
    s.stagedSheet = null;
    s.api.setSheet(sheet, { animate: true });
  };

  // Chromatic aberration rides the same signal: snaps up when a generate starts, eases
  // back to zero over the same span as the texture crossfade when the new design lands.
  useEffect(() => {
    if (waiting) {
      stateRef.current.api?.setAberration(ABERRATION_PEAK, DURATION_FAST);
    } else {
      commitStagedSheet();
      stateRef.current.api?.setAberration(0, DURATION_SLOW);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waiting]);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return undefined;
    let disposed = false;
    let cleanup = null;

    (async () => {
      try {
        const [THREE, { GLTFLoader }, { EffectComposer }, { RenderPass }, { ShaderPass }] =
          await Promise.all([
            import('three'),
            import('three/examples/jsm/loaders/GLTFLoader.js'),
            import('three/examples/jsm/postprocessing/EffectComposer.js'),
            import('three/examples/jsm/postprocessing/RenderPass.js'),
            import('three/examples/jsm/postprocessing/ShaderPass.js')
          ]);
        if (disposed) return;

        // WebGL context creation can genuinely fail (GPU blocklists, headless) -- the
        // catch below hides the preview instead of leaving a dead canvas.
        const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        renderer.setSize(size, size);
        // LIGHTING IS CALIBRATED SO THE SHIRT REPRODUCES THE TEXTURE, NOT MERELY SO IT
        // LOOKS LIT. The shirt sits directly beside the same design rendered flat as the
        // page background, so any deviation reads as the two being different colours --
        // reported live (2026-08-05) as the shirt's colours "feeling different" on bright,
        // saturated designs.
        //
        // The previous setup (ambient 3.2 / key 1.6 under ACESFilmicToneMapping) had the
        // whole garment past white before tone mapping: the diffuse term is
        // irradiance * albedo/pi, so even the DIMMEST, ambient-only part of the shirt sat at
        // 3.2/pi = 1.02, and the lit side at 1.53. That put every pixel of the garment inside
        // the compressed shoulder of the ACES curve, which desaturates and hue-shifts as it
        // rolls off. Measured against three.js's own ACES fit, front-facing fabric averaged
        // dE 17.5 off the true texture colour and peaked at 37.5 -- cyan #00e5ff rendered as
        // #a5e6ea, a pale grey-cyan with its red channel pushed from 0 to 165. Saturated
        // brights were the worst hit, which is exactly the case that was reported.
        //
        // The fix is to keep the whole garment on the LINEAR part of the response instead:
        // no tone mapping, and the total irradiance chosen so the fabric lands at a factor
        // of 1.0, where a texel survives sRGB-decode -> multiply -> sRGB-encode unchanged
        // and the garment is the same colour as the flat background beside it.
        //
        // WHICH PART of the garment that factor is calibrated ON is the whole game, and the
        // first version got it wrong (reported again 2026-08-05: the shirt still "feels
        // darker"). It solved for a surface facing the camera dead-on -- but on a t-shirt
        // that is the BRIGHTEST fabric on screen, not the typical fabric. Measured over the
        // real .glb (every camera-visible triangle, weighted by its projected screen area):
        // the front-facing 0.964 sat at the top of a 0.78 -> 1.05 spread whose area-weighted
        // MEAN was 0.921, with a THIRD of the visible garment below 0.9. So the calibration
        // was correct at its reference point and the shirt was still genuinely darker than
        // the background nearly everywhere -- which is exactly what the eye reports, since
        // it judges the garment as a whole and not its brightest facet.
        //
        // So the target is the area-weighted mean, not the peak: ambient + key * <mean N.L>
        // = pi. `key` then only picks how wide the spread around that mean is, and it costs
        // clipping at the top -- holding the mean at 1.0, key 1.04 runs 0.81 -> 1.12 (any
        // texel above 0.89 blows out on the lit shoulder, the same desaturation of saturated
        // brights this calibration exists to prevent), while key 0.55 runs 0.89 -> 1.07.
        // Chose the latter: the model carries no normal map, no AO and no vertex colours
        // (verified in the .glb), so the only thing a big `key` buys is a soft gradient
        // across a 190px shirt -- not worth spending the highlights on.
        //
        // DO NOT "RESTORE" A BIGGER KEY TO GET DEPTH BACK without re-running the numbers:
        // the two values are one calibration. To retune, pick a `key` and solve
        // ambient = pi * (1 - ENV_IRRADIANCE) - key * 0.743 (0.743 being the measured
        // area-weighted mean of N.L over the visible garment for this model and this light
        // direction). AMBIENT below does exactly that, so `key` and ENV_IRRADIANCE are the
        // only two numbers to touch -- the sum is always conserved.
        //
        // WHY THERE IS AN ENVIRONMENT AND A SHEEN AT ALL, given flat fill is what reproduces
        // the texture: with no env map, a roughness-1 standard material has nothing to
        // reflect, so the garment is a printed SURFACE rather than cloth. The two additions
        // below are the fabric cues, both chosen because they leave camera-facing colour
        // alone (which is the whole calibration):
        //   - a vertical sky/floor gradient environment, which replaces a slice of the flat
        //     ambient with light that has a DIRECTION, so the shoulders read lit-from-above
        //     and the hem falls off. Its mean radiance is normalised to ENV_IRRADIANCE
        //     exactly (see makeGradientEnv), and a uniform-radiance environment contributes
        //     irradiance pi*L -- i.e. a displayed factor of exactly L -- so it can be traded
        //     against AmbientLight one-for-one with no net brightness change.
        //   - sheen, the retroreflective fibre rim real cloth has. It peaks at GRAZING
        //     angles and falls to ~0 head-on, so it draws the silhouette's edge without
        //     touching the fabric facing the viewer.
        // DELIBERATELY NOT a spotlight, which is the usual reach here: a spotlight has
        // distance decay, so brightness would depend on where a triangle sits in space and
        // no single factor could map a texel to the background's colour any more.
        const KEY_INTENSITY = 0.55;
        const ENV_IRRADIANCE = 0.25; // share of the total taken by the environment
        const AMBIENT = Math.PI * (1 - ENV_IRRADIANCE) - KEY_INTENSITY * 0.743;
        renderer.toneMapping = THREE.NoToneMapping;

        const scene = new THREE.Scene();
        const camera = new THREE.PerspectiveCamera(28, 1, 0.05, 50);
        scene.add(new THREE.AmbientLight(0xffffff, AMBIENT));
        const key = new THREE.DirectionalLight(0xffffff, KEY_INTENSITY);
        key.position.set(2, 3, 4);
        scene.add(key);

        // Equirect gradient, built here rather than loaded: an HDR/RoomEnvironment would be
        // another request (and RoomEnvironment's coloured emissive panels would tint the
        // garment, which is exactly what this calibration cannot afford). Rows are weighted
        // by sin(theta) -- their real solid angle -- when normalising, so the mean radiance
        // lands on ENV_IRRADIANCE as seen by a surface, not merely as an average of pixels.
        const makeGradientEnv = () => {
          const H = 64;
          const rows = new Float32Array(H);
          let weighted = 0;
          let weight = 0;
          for (let y = 0; y < H; y++) {
            const t = (y + 0.5) / H; // 0 = up
            const solid = Math.sin(t * Math.PI);
            rows[y] = 1 - t; // bright sky above, dark floor below
            weighted += rows[y] * solid;
            weight += solid;
          }
          const norm = ENV_IRRADIANCE / (weighted / weight);
          const data = new Float32Array(H * 2 * H * 4);
          for (let y = 0; y < H; y++) {
            const v = rows[y] * norm;
            for (let x = 0; x < H * 2; x++) {
              const i = (y * H * 2 + x) * 4;
              data[i] = data[i + 1] = data[i + 2] = v;
              data[i + 3] = 1;
            }
          }
          const tex = new THREE.DataTexture(data, H * 2, H, THREE.RGBAFormat, THREE.FloatType);
          tex.mapping = THREE.EquirectangularReflectionMapping;
          tex.colorSpace = THREE.LinearSRGBColorSpace;
          tex.needsUpdate = true;
          const pmrem = new THREE.PMREMGenerator(renderer);
          const env = pmrem.fromEquirectangular(tex).texture;
          pmrem.dispose();
          tex.dispose();
          return env;
        };
        const envMap = makeGradientEnv();
        scene.environment = envMap; // lights the garment; never scene.background (transparent)

        const gltf = await new GLTFLoader().loadAsync('/models/tshirt/tshirt.glb');
        if (disposed) {
          renderer.dispose();
          return;
        }

        // Center the model in a pivot group so rotation spins it about its own axis.
        const pivot = new THREE.Group();
        const box = new THREE.Box3().setFromObject(gltf.scene);
        const center = box.getCenter(new THREE.Vector3());
        gltf.scene.position.sub(center);
        pivot.add(gltf.scene);
        scene.add(pivot);

        const sphere = box.getBoundingSphere(new THREE.Sphere());
        camera.position.set(0, 0, sphere.radius * 3.1);
        camera.lookAt(0, 0, 0);

        // Sheen only exists on MeshPhysicalMaterial, and the model ships one of each (a
        // Physical body and a Standard trim mesh -- verified in the .glb), so the Standard
        // one is promoted. The promotion borrows MeshStandardMaterial's OWN copy rather than
        // calling `physical.copy(mat)`: MeshPhysicalMaterial.copy reads physical-only fields
        // off its source and would throw on a Standard one (`clearcoatNormalScale.copy(
        // undefined )`). Borrowing it carries every base + standard field across and leaves
        // the physical extras at their constructed defaults, which is exactly what's wanted.
        // The promoted material is written back onto the mesh and `materials` holds the live
        // ones either way, so the texture plumbing below is unaffected.
        //
        // sheenRoughness is deliberately high: a tight sheen lobe reads as satin/silk, and
        // this is a cotton tee. Low `sheen` for the same reason -- it is meant to be felt at
        // the silhouette, not seen as a rim light.
        const SHEEN = 0.3;
        const materials = [];
        gltf.scene.traverse(obj => {
          if (!obj.isMesh) return;
          let mat = obj.material;
          if (!mat.isMeshPhysicalMaterial) {
            const physical = new THREE.MeshPhysicalMaterial();
            THREE.MeshStandardMaterial.prototype.copy.call(physical, mat);
            mat.dispose();
            obj.material = physical;
            mat = physical;
          }
          mat.sheen = SHEEN;
          mat.sheenRoughness = 0.85;
          mat.sheenColor = new THREE.Color(0xffffff);
          mat.needsUpdate = true;
          materials.push(mat);
        });

        // One persistent canvas backs the material texture for the shirt's whole life;
        // setSheet either stamps a new design sheet onto it directly or crossfades to it
        // by re-blending old over new each tween frame (globalAlpha), so design changes
        // dissolve on the garment without the shirt itself ever leaving the scene.
        const textureCanvas = document.createElement('canvas');
        textureCanvas.width = TEXTURE_SIZE;
        textureCanvas.height = TEXTURE_SIZE;
        const textureCtx = textureCanvas.getContext('2d');
        // Seed with the model's own white baseColor sheet so the shirt is presentable
        // (a plain blank tee) the moment the scene is up, instead of the element staying
        // hidden until the first design render lands -- the first design then crossfades
        // in from white like any later design change. The seed lives on its own canvas
        // (not just stamped into textureCanvas) because setSheet's blend needs a stable
        // `from` source: drawing textureCanvas onto itself would compound per frame.
        const initialSheet = document.createElement('canvas');
        initialSheet.width = TEXTURE_SIZE;
        initialSheet.height = TEXTURE_SIZE;
        const initialCtx = initialSheet.getContext('2d');
        const originalImage = materials.find(mat => mat.map?.image)?.map?.image;
        if (originalImage) {
          initialCtx.drawImage(originalImage, 0, 0, TEXTURE_SIZE, TEXTURE_SIZE);
        } else {
          initialCtx.fillStyle = '#f4f4f4';
          initialCtx.fillRect(0, 0, TEXTURE_SIZE, TEXTURE_SIZE);
        }
        textureCtx.drawImage(initialSheet, 0, 0);
        const texture = new THREE.CanvasTexture(textureCanvas);
        texture.flipY = false; // glTF UV convention
        texture.colorSpace = THREE.SRGBColorSpace;
        materials.forEach(mat => {
          const old = mat.map;
          mat.map = texture;
          mat.needsUpdate = true;
          if (old) old.dispose();
        });

        let currentSheet = initialSheet;
        let crossfadeTween = null;
        const setSheet = (sheet, { animate }) => {
          crossfadeTween?.kill();
          const from = currentSheet;
          currentSheet = sheet;
          if (!animate || !from) {
            textureCtx.globalAlpha = 1;
            textureCtx.drawImage(sheet, 0, 0);
            texture.needsUpdate = true;
            stateRef.current.wake?.();
            return;
          }
          const f = { t: 0 };
          crossfadeTween = gsap.to(f, {
            t: 1,
            duration: DURATION_SLOW,
            ease: 'power2.inOut',
            onUpdate: () => {
              textureCtx.globalAlpha = 1;
              textureCtx.drawImage(from, 0, 0);
              textureCtx.globalAlpha = f.t;
              textureCtx.drawImage(sheet, 0, 0);
              texture.needsUpdate = true;
            },
            onComplete: () => {
              textureCtx.globalAlpha = 1;
              textureCtx.drawImage(sheet, 0, 0);
              texture.needsUpdate = true;
              crossfadeTween = null;
              // The final frame of the crossfade is drawn here, after the loop's last render;
              // one more frame is needed to actually show it.
              stateRef.current.wake?.();
            }
          });
          stateRef.current.wake?.();
        };

        mount.appendChild(renderer.domElement);

        // No idle spin -- the shirt faces forward and turns slowly toward the mouse
        // (desktop) or with the phone's left/right tilt (touch devices, deviceorientation
        // gamma), capped at ±25° of yaw either way. Static under prefers-reduced-motion.
        const MAX_YAW = (25 * Math.PI) / 180;
        const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        const isTouch = window.matchMedia('(pointer: coarse)').matches;
        let targetYaw = 0;
        const inputCleanups = [];

        const onMouseMove = e => {
          const rect = renderer.domElement.getBoundingClientRect();
          const centerX = rect.left + rect.width / 2;
          // Normalize by half the viewport so the cap is only reached at the screen edges.
          const t = (e.clientX - centerX) / (window.innerWidth / 2);
          targetYaw = Math.max(-1, Math.min(1, t)) * MAX_YAW;
          stateRef.current.wake?.();
        };

        // Phones have no hover, so gamma (side-to-side tilt, degrees) stands in for the
        // mouse: ±25° of tilt from the holding angle covers the full yaw range. There's no
        // universal "neutral" grip, so the baseline is the first reading, then drifts
        // slowly toward the live angle -- shift how you're holding the phone and the shirt
        // eases back to center instead of sticking at the cap forever.
        let baseGamma = null;
        const onOrientation = e => {
          if (e.gamma == null) return;
          if (baseGamma === null) baseGamma = e.gamma;
          baseGamma += (e.gamma - baseGamma) * 0.01;
          const t = (e.gamma - baseGamma) / 25;
          targetYaw = Math.max(-1, Math.min(1, t)) * MAX_YAW;
          stateRef.current.wake?.();
        };
        const startOrientation = () => {
          window.addEventListener('deviceorientation', onOrientation);
          inputCleanups.push(() => window.removeEventListener('deviceorientation', onOrientation));
        };

        // Touch devices can also DRAG the shirt to rotate it -- clamped to ±40°
        // (wider than the ±25° ambient yaw, but not a free spin), returning to
        // forward-facing once the finger lifts. The shirt is still a shop link: a
        // press only becomes a drag past a horizontal 8px threshold (and only when
        // horizontal movement dominates -- vertical swipes stay with the page scroll
        // via touch-action: pan-y on the button, which fires pointercancel once the
        // browser takes the gesture), and a real drag suppresses the click that
        // fires on release. Allowed under prefers-reduced-motion (direct
        // manipulation, not ambient animation); the eased return is skipped there
        // in favor of an immediate reset.
        let dragYaw = 0;
        let dragging = false;
        if (isTouch) {
          const DRAG_THRESHOLD = 8;
          const DRAG_MAX_YAW = (40 * Math.PI) / 180;
          let pressed = false;
          let startX = 0;
          let startY = 0;
          let lastX = 0;
          const onPointerDown = e => {
            pressed = true;
            dragging = false;
            startX = lastX = e.clientX;
            startY = e.clientY;
          };
          const onPointerMove = e => {
            if (!pressed) return;
            if (!dragging) {
              const dxTotal = e.clientX - startX;
              if (
                Math.abs(dxTotal) < DRAG_THRESHOLD ||
                Math.abs(dxTotal) < Math.abs(e.clientY - startY)
              )
                return;
              dragging = true;
              dragSuppressClickRef.current = true;
              mount.setPointerCapture?.(e.pointerId);
              lastX = e.clientX;
              return;
            }
            const dx = e.clientX - lastX;
            const dYaw = dx * 0.012; // ~0.7° of spin per pixel
            dragYaw = Math.max(-DRAG_MAX_YAW, Math.min(DRAG_MAX_YAW, dragYaw + dYaw));
            stateRef.current.wake?.();
            lastX = e.clientX;
          };
          const onPointerEnd = () => {
            pressed = false;
            dragging = false;
            if (reducedMotion) dragYaw = 0;
          };
          mount.addEventListener('pointerdown', onPointerDown);
          mount.addEventListener('pointermove', onPointerMove);
          mount.addEventListener('pointerup', onPointerEnd);
          mount.addEventListener('pointercancel', onPointerEnd);
          inputCleanups.push(() => {
            mount.removeEventListener('pointerdown', onPointerDown);
            mount.removeEventListener('pointermove', onPointerMove);
            mount.removeEventListener('pointerup', onPointerEnd);
            mount.removeEventListener('pointercancel', onPointerEnd);
          });
        }

        if (!reducedMotion) {
          if (isTouch && typeof DeviceOrientationEvent !== 'undefined') {
            // Only where orientation works WITHOUT a permission prompt (Android). iOS 13+
            // gates it behind DeviceOrientationEvent.requestPermission(), which must be
            // called from a tap -- tried and user-rejected: the natural first tap is the
            // shirt itself, so the prompt appeared after navigating away to the shop.
            // A permission dialog isn't worth a decorative tilt; iOS gets a static shirt.
            if (typeof DeviceOrientationEvent.requestPermission !== 'function') {
              startOrientation();
            }
          } else {
            window.addEventListener('mousemove', onMouseMove);
            inputCleanups.push(() => window.removeEventListener('mousemove', onMouseMove));
          }
        }

        // Postprocessing chain for the generate-transition chromatic aberration. The
        // pass stays in the chain at uAmount 0 (visually identity) -- swapping between
        // composer/direct rendering per state isn't worth the branching at this size.
        const composer = new EffectComposer(renderer);
        composer.setPixelRatio(renderer.getPixelRatio());
        composer.setSize(size, size);
        composer.addPass(new RenderPass(scene, camera));
        const aberrationPass = new ShaderPass(AberrationShader);
        composer.addPass(aberrationPass);
        let aberrationTween = null;
        const setAberration = (value, duration) => {
          aberrationTween?.kill();
          stateRef.current.wake?.();
          aberrationTween = gsap.to(aberrationPass.uniforms.uAmount, {
            value,
            duration,
            ease: value > 0 ? 'power2.out' : 'power2.inOut'
          });
        };

        // Two gates on the render loop, because neither is enough alone and this scene is the
        // most expensive thing on the page per frame (a RenderPass plus a full-screen
        // ShaderPass). It used to render unconditionally, 60 times a second, for as long as the
        // page was open -- including while you were reading About or sitting at the footer,
        // with a motionless shirt.
        //
        //   onScreen  -- the mount is actually in view. Nothing below matters if it isn't.
        //   settled   -- the shirt has reached its target angle and no effect is running, so
        //                consecutive frames would be identical.
        //
        // Any input, any generate, and any texture change has to clear `settled` or the change
        // never reaches the screen; `wake()` is that one door, and everything that mutates the
        // scene goes through it.
        let raf = 0;
        let onScreen = true;
        let settled = false;
        const wake = () => {
          settled = false;
          // Off-screen input still updates targetYaw and the texture -- it just doesn't get
          // rendered until the mount comes back, which the observer below handles. Without the
          // onScreen check here, every mousemove anywhere on the page would render one frame of
          // a shirt nobody can see.
          if (!raf && onScreen) raf = requestAnimationFrame(animate);
        };
        stateRef.current.wake = wake;

        function animate(now) {
          raf = 0;
          // After release, ease the drag rotation back to forward-facing.
          if (!dragging && dragYaw !== 0) {
            dragYaw *= 0.92;
            if (Math.abs(dragYaw) < 0.001) dragYaw = 0;
          }
          // Direct manipulation tracks the finger tightly; ambient follow stays lazy.
          const followRate = dragging ? 0.35 : 0.04;
          const before = pivot.rotation.y;
          pivot.rotation.y += (dragYaw + targetYaw - pivot.rotation.y) * followRate;
          aberrationPass.uniforms.uTime.value = now * 0.001;
          composer.render();
          // Idle only once the shirt has stopped moving AND the aberration pass is back at
          // identity -- its uTime drives a live distortion, so a non-zero uAmount means the
          // picture is still changing even with the shirt still.
          const still =
            !crossfadeTween &&
            !dragging &&
            dragYaw === 0 &&
            Math.abs(pivot.rotation.y - before) < 1e-4 &&
            aberrationPass.uniforms.uAmount.value < 1e-3;
          settled = still;
          if (!settled && onScreen) raf = requestAnimationFrame(animate);
        }
        wake();

        // Scrolling away stops it outright; coming back resumes from wherever it was, which is
        // correct -- nothing here is driven by wall-clock time.
        const io = new IntersectionObserver(
          entries => {
            onScreen = entries[0]?.isIntersecting ?? true;
            if (onScreen) wake();
            else if (raf) {
              cancelAnimationFrame(raf);
              raf = 0;
            }
          },
          { rootMargin: '80px' }
        );
        io.observe(mount);
        inputCleanups.push(() => io.disconnect());

        stateRef.current.api = { setSheet, setAberration };
        // If a generate is already in flight when the scene comes up, join it mid-state.
        if (stateRef.current.waiting) setAberration(ABERRATION_PEAK, DURATION_FAST);
        // The white tee is already on the canvas -- show the shirt now. hasTexture is set
        // here (not on the first design commit) so that first commit crossfades from
        // white instead of applying instantly.
        if (!stateRef.current.hasTexture) {
          stateRef.current.hasTexture = true;
          gsap.to(mount, { autoAlpha: 1, scale: 1, duration: DURATION_SLOW, ease: 'power2.out' });
        }
        commitStagedSheet();

        cleanup = () => {
          stateRef.current.wake = null;
          cancelAnimationFrame(raf);
          inputCleanups.forEach(fn => fn());
          crossfadeTween?.kill();
          aberrationTween?.kill();
          stateRef.current.api = null;
          texture.dispose();
          envMap.dispose(); // PMREM render target texture -- not owned by any material
          materials.forEach(mat => mat.dispose());
          composer.dispose?.();
          renderer.dispose();
          if (renderer.domElement.parentNode === mount) mount.removeChild(renderer.domElement);
        };
      } catch (err) {
        console.error('TshirtPreview init failed:', err);
        if (!disposed) setFailed(true);
      }
    })();

    return () => {
      disposed = true;
      cleanup?.();
    };
  }, [size]);

  // Re-render the texture whenever the design changes. renderDesignBlob needs nothing
  // preloaded now that both star shapes are drawn from code, so there is no readiness gate.
  useEffect(() => {
    if (failed) return undefined;
    let cancelled = false;
    (async () => {
      try {
        const [baseBlob, bodyBlob, sleeveBlob] = await Promise.all([
          renderDesignBlob(currentDesign, TEXTURE_SIZE, TEXTURE_SIZE),
          renderDesignBlob(currentDesign, BODY_RENDER.w, BODY_RENDER.h),
          renderDesignBlob(currentDesign, SLEEVE_RENDER.w, SLEEVE_RENDER.h)
        ]);
        const [base, body, sleeve] = await Promise.all(
          [baseBlob, bodyBlob, sleeveBlob].map(b => createImageBitmap(b))
        );
        if (cancelled) return;
        const canvas = document.createElement('canvas');
        canvas.width = TEXTURE_SIZE;
        canvas.height = TEXTURE_SIZE;
        const ctx = canvas.getContext('2d');
        const sc = TEXTURE_SIZE / ATLAS;
        ctx.drawImage(base, 0, 0, TEXTURE_SIZE, TEXTURE_SIZE);
        // flipY on every island counters the atlas's flipped UV mapping (see drawCover).
        // flipX on index 1 (the BACK panel) mirrors it, matching what a real order does:
        // PRODUCT_MOCKUP_CONFIG's mirrorPlacements puts every product with a distinct back
        // on a flipped back panel by default, so an unmirrored back here showed the shirt
        // differently from the thing you would actually receive (Aaron, 2026-08-02).
        BODY_ISLANDS.forEach((r, i) =>
          drawCover(ctx, body, r.x * sc, r.y * sc, r.w * sc, r.h * sc, {
            flipY: true,
            flipX: i === 1
          })
        );
        // The two sleeve islands map onto the garment in opposite orientations, so the
        // second draw is additionally horizontally mirrored -- identical draws made one
        // worn sleeve read as flipped relative to the other (user-caught); mirroring
        // restores left/right symmetry on the shirt.
        SLEEVE_ISLANDS.forEach((r, i) =>
          drawCover(ctx, sleeve, r.x * sc, r.y * sc, r.w * sc, r.h * sc, {
            flipY: true,
            flipX: i === 1
          })
        );
        // Trim strips: a thin edge-band of the adjacent panel's composition, stretched to
        // the strip (see STRIP_ISLANDS). Slight overdraw past the measured rect so the
        // base layer can't peek through at the rounded strip ends.
        STRIP_ISLANDS.forEach(s => {
          const img = s.from === 'body' ? body : sleeve;
          const bandH = img.height * STRIP_BAND_FRAC;
          const srcY = s.edge === 'bottom' ? img.height - bandH : 0;
          const dx = s.x * sc - 2;
          const dy = s.y * sc - 2;
          const dw = s.w * sc + 4;
          const dh = s.h * sc + 4;
          ctx.save();
          // The vertical flip is the SAME atlas-UV correction every panel island needs
          // (see drawCover) -- without it a trim reads upside down against the panel it
          // continues from, which is exactly how it shipped (Aaron, 2026-08-03: front hem
          // and both cuffs upside down). The horizontal `flip` additionally matches a
          // strip to a panel that is itself drawn mirrored: the cuff of the flipX sleeve,
          // and the back hem, which had been left unmirrored when the back panel gained
          // its flipX and so wound opposite the print above it.
          ctx.translate(dx + (s.flip ? dw : 0), dy + dh);
          ctx.scale(s.flip ? -1 : 1, -1);
          ctx.drawImage(img, 0, srcY, img.width, bandH, 0, 0, dw, dh);
          ctx.restore();
        });
        [base, body, sleeve].forEach(b => b.close());
        stateRef.current.stagedSheet = canvas;
        commitStagedSheet();
      } catch {
        /* render assets mid-load or bitmap decode failure -- keep the previous texture */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [currentDesign, renderDesignBlob, failed]);

  if (failed) return null;

  // The shirt is a link to the shop -- the design carries over via StudioContext
  // (ProductPage's default artwork choice is the current studio design). The hover hint
  // label is the discoverability cue; the WebGL mount stays aria-hidden (decorative)
  // while the button carries the accessible name. The hover scale lives on the button,
  // not the mount div, because GSAP owns the mount's inline transform (entrance fade)
  // and inline styles would override a CSS hover transform there.
  return (
    <button
      type="button"
      onClick={() => {
        // A touch-drag spin ends in a click on release -- that's rotation, not a
        // navigation intent; only a clean tap/click goes to the shop.
        if (dragSuppressClickRef.current) {
          dragSuppressClickRef.current = false;
          return;
        }
        onShopClick?.();
      }}
      aria-label="Shop this design on merch"
      className="tshirt-preview-btn group relative shrink-0 cursor-pointer border-0 bg-transparent p-0 transition-transform duration-300 hover:scale-[1.04]"
      style={{ width: size, height: size, touchAction: 'pan-y' }}
    >
      <div
        ref={mountRef}
        aria-hidden
        className="tshirt-preview h-full w-full"
        style={{ opacity: 0 }}
      />
      <span className="tshirt-shop-hint" aria-hidden>
        Shop <ArrowIcon size={12} />
      </span>
    </button>
  );
}
