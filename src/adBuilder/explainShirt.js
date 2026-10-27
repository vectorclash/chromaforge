import { generateArtwork } from '../render/generateArtwork';
import renderArtwork from '../render/renderArtwork';
import { resolveDesignPalette } from '../render/resolvedPalette';
import { makeRng } from '../render/prng';
import { createTshirtSwirl } from '../components/tshirtSwirl';
import {
  composeShirtSheet,
  AberrationShader,
  SWIRL_ROOM,
  BODY_RENDER,
  SLEEVE_RENDER
} from '../components/TshirtPreview';
import {
  HOODIE_URL,
  HOODIE_RENDER,
  GARMENT_FRAME_FILL,
  composeHoodieSheet
} from '../components/hoodieModel';
// The homepage tee's own source model at FULL detail (154k triangles, 2.9MB), for video-frame
// sizes. The homepage's build is simplified to 10% for a 190px shirt, and at the size of a frame
// that showed: crumpled, glittering sleeve hems and a lumpy torso (Aaron, 2026-10-26: "the shirt
// model is badly degraded"). This build is the archival source (src/assets/models/tshirt/) through
// the same pipeline minus `simplify` -- dedup, weld, quantize, prune -- so its UVs, and the island
// rects TshirtPreview measured, are unchanged. Imported as a URL so it is only ever served to the
// dev-only ad builder and never ships with the site.
import teeHdUrl from '../assets/models/tshirt-hd/tshirt-hd.glb?url';

// The homepage hero's t-shirt, for the explainer: the same model, sheet, shockwave and spark swirl
// as TshirtPreview, but drawn from a timeline (`draw(t, event)`) instead of a frame loop and the
// mouse, so the preview and the export show the same frame for the same time. Or the hoodie
// (components/hoodieModel.js), under the same lighting and effects.
//
// THE LIGHTING IS NOT THE HERO'S, deliberately. The hero is calibrated so each texel shows the
// colour it has on the wall behind it -- nearly all ambient, a weak key -- which is right for a
// 190px shirt beside the artwork it previews, and at the size of a video frame read as a flat
// cut-out (Aaron, 2026-10-26: "very flat with texture and lighting"). Here there is a real key
// light, rims from behind, a fine knit normal map and a stronger sheen, and the sheet is twice the
// hero's resolution.
//
// `size` is the shirt's own box in pixels; the canvas is SWIRL_ROOM times that, as on the
// homepage, so the sparks have room to orbit.

const render = (design, w, h) =>
  renderArtwork(generateArtwork(design.seed, w, h, design.colors || [], design.settings ?? null));

const easeOut = x => 1 - (1 - x) ** 2;
const easeInOut = x => (x < 0.5 ? 2 * x * x : 1 - (-2 * x + 2) ** 2 / 2);
const clamp01 = x => (x < 0 ? 0 : x > 1 ? 1 : x);

// What differs between the two garments: the model, how its sheet is made, the lighting term and
// how the camera frames it. The tee keeps TshirtPreview's bounding-sphere framing exactly; the
// hoodie's hood makes it tall and narrow, so it is framed by height to the same fill.
const halfFov = (14 * Math.PI) / 180;
const SHEET = 2048;
const GARMENTS = {
  tee: {
    url: teeHdUrl,
    distance: (box, sphere) => sphere.radius * 3.1,
    sheet: design =>
      composeShirtSheet(
        render(design, SHEET, SHEET),
        render(design, BODY_RENDER.w, BODY_RENDER.h),
        render(design, SLEEVE_RENDER.w, SLEEVE_RENDER.h),
        SHEET
      )
  },
  hoodie: {
    url: HOODIE_URL,
    distance: box => (box.max.y - box.min.y) / (GARMENT_FRAME_FILL * 2 * Math.tan(halfFov)),
    sheet: design => composeHoodieSheet(render(design, HOODIE_RENDER.w, HOODIE_RENDER.h), SHEET)
  }
};

// A tileable fabric bump as a tangent-space normal map: JERSEY KNIT, what both garments are made
// of -- columns (wales) of small V-shaped stitches. The first version was isotropic value noise,
// and noise the same in every direction reads as a wall, not cloth (Aaron, 2026-10-26: "like wall
// plaster"). A stitch is STITCH texels square; at FABRIC_REPEAT over the atlas that is ~170
// stitches across the hoodie's front, a little coarser than real jersey, so the grain survives as
// a fine directional texture once mipmapped to frame size rather than resolving into a visible
// pattern. Both atlases are close to one texel density throughout, and pieces are laid upright,
// so the wales run down the garment everywhere.
const FABRIC_SIZE = 512;
const FABRIC_REPEAT = 8;
const STITCH = 8;
function fabricNormals() {
  const n = FABRIC_SIZE;
  const rng = makeRng('explain-fabric');
  const h = new Float32Array(n * n);
  const lobe = (u, c) => Math.exp(-((u - c) ** 2) / (2 * 0.11 ** 2));
  for (let y = 0; y < n; y++) {
    const v = (y % STITCH) / STITCH;
    // Each stitch's two legs lean in toward the bottom of the V; the course between rows dips.
    const lean = 0.14 * (v - 0.5);
    const course = 0.8 + 0.2 * Math.sin(Math.PI * v);
    for (let x = 0; x < n; x++) {
      const u = (x % STITCH) / STITCH;
      h[y * n + x] = (lobe(u, 0.27 + lean) + lobe(u, 0.73 - lean)) * course + (rng() - 0.5) * 0.08;
    }
  }
  const data = new Uint8Array(n * n * 4);
  const STRENGTH = 1.5;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const dx = h[y * n + ((x + 1) % n)] - h[y * n + ((x + n - 1) % n)];
      const dy = h[((y + 1) % n) * n + x] - h[((y + n - 1) % n) * n + x];
      const nx = -dx * STRENGTH;
      const ny = -dy * STRENGTH;
      const len = Math.hypot(nx, ny, 1);
      const i = (y * n + x) * 4;
      data[i] = Math.round(((nx / len) * 0.5 + 0.5) * 255);
      data[i + 1] = Math.round(((ny / len) * 0.5 + 0.5) * 255);
      data[i + 2] = Math.round(((1 / len) * 0.5 + 0.5) * 255);
      data[i + 3] = 255;
    }
  }
  return data;
}

/**
 * @param {{ design: { seed: string, colors?: string[], settings?: any }, size: number, garment?: 'tee' | 'hoodie' }} o
 */
export async function createExplainShirt({ design, size, garment = 'tee' }) {
  const g = GARMENTS[garment] ?? GARMENTS.tee;
  const [THREE, { GLTFLoader }, { EffectComposer }, { RenderPass }, { ShaderPass }, { Pass }] =
    await Promise.all([
      import('three'),
      import('three/examples/jsm/loaders/GLTFLoader.js'),
      import('three/examples/jsm/postprocessing/EffectComposer.js'),
      import('three/examples/jsm/postprocessing/RenderPass.js'),
      import('three/examples/jsm/postprocessing/ShaderPass.js'),
      import('three/examples/jsm/postprocessing/Pass.js')
    ]);

  const canvasSize = size + 2 * Math.round((size * (SWIRL_ROOM - 1)) / 2);
  const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: false });
  renderer.setPixelRatio(1);
  renderer.setSize(canvasSize, canvasSize, false);
  renderer.toneMapping = THREE.NoToneMapping;
  const disposers = [
    () => {
      renderer.dispose();
      renderer.forceContextLoss();
    }
  ];
  const dispose = () => {
    for (const d of disposers.reverse()) d();
    disposers.length = 0;
  };

  try {
    // A studio setup: a key from the upper left, a dim fill from the right, two rims from behind
    // to pull the silhouette off the background, and little ambient, so the folds model. A surface
    // facing the key lands near the print's own colour (ambient + env + key ~ 0.9 of pi); one
    // turned away from it drops to about a third.
    const ENV_IRRADIANCE = 0.15;
    const scene = new THREE.Scene();
    const fov = (2 * Math.atan((canvasSize / size) * Math.tan(halfFov)) * 180) / Math.PI;
    const camera = new THREE.PerspectiveCamera(fov, 1, 0.05, 50);
    scene.add(new THREE.AmbientLight(0xffffff, 0.6));
    const lights = [
      [2.4, -2.4, 3.6, 4],
      [0.35, 3, 0.5, 3],
      [1.5, 3.5, 1.8, -4],
      [1.2, -3.5, 1.2, -4]
    ];
    for (const [intensity, x, y, z] of lights) {
      const light = new THREE.DirectionalLight(0xffffff, intensity);
      light.position.set(x, y, z);
      scene.add(light);
    }

    const H = 64;
    const rows = new Float32Array(H);
    let weighted = 0;
    let weight = 0;
    for (let y = 0; y < H; y++) {
      const t = (y + 0.5) / H;
      const solid = Math.sin(t * Math.PI);
      rows[y] = 1 - t;
      weighted += rows[y] * solid;
      weight += solid;
    }
    const norm = ENV_IRRADIANCE / (weighted / weight);
    const data = new Float32Array(H * 2 * H * 4);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < H * 2; x++) {
        const i = (y * H * 2 + x) * 4;
        data[i] = data[i + 1] = data[i + 2] = rows[y] * norm;
        data[i + 3] = 1;
      }
    }
    const envTex = new THREE.DataTexture(data, H * 2, H, THREE.RGBAFormat, THREE.FloatType);
    envTex.mapping = THREE.EquirectangularReflectionMapping;
    envTex.colorSpace = THREE.LinearSRGBColorSpace;
    envTex.needsUpdate = true;
    const pmrem = new THREE.PMREMGenerator(renderer);
    const envMap = pmrem.fromEquirectangular(envTex).texture;
    pmrem.dispose();
    envTex.dispose();
    scene.environment = envMap;
    disposers.push(() => envMap.dispose());

    const gltf = await new GLTFLoader().loadAsync(g.url);
    const pivot = new THREE.Group();
    const box = new THREE.Box3().setFromObject(gltf.scene);
    gltf.scene.position.sub(box.getCenter(new THREE.Vector3()));
    pivot.add(gltf.scene);
    scene.add(pivot);
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    camera.position.set(0, 0, g.distance(box, sphere));
    camera.lookAt(0, 0, 0);

    const swirl = createTshirtSwirl(THREE, Pass, {
      camera,
      radius: sphere.radius,
      // The homepage's 6 CSS px heads on a 190px shirt at a 2x pixel ratio, scaled to this size.
      pixelSize: (12 * size) / 380
    });
    swirl.setPalette(resolveDesignPalette(design), 0);
    disposers.push(() => swirl.dispose());

    const fabric = new THREE.DataTexture(fabricNormals(), FABRIC_SIZE, FABRIC_SIZE);
    fabric.wrapS = fabric.wrapT = THREE.RepeatWrapping;
    fabric.repeat.set(FABRIC_REPEAT, FABRIC_REPEAT);
    fabric.generateMipmaps = true;
    fabric.minFilter = THREE.LinearMipmapLinearFilter;
    fabric.magFilter = THREE.LinearFilter;
    fabric.anisotropy = renderer.capabilities.getMaxAnisotropy();
    fabric.needsUpdate = true;
    disposers.push(() => fabric.dispose());
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
      mat.sheen = 0.8;
      mat.sheenRoughness = 0.6;
      mat.sheenColor = new THREE.Color(0xffffff);
      mat.roughness = 0.9;
      mat.metalness = 0;
      mat.normalMap = fabric;
      mat.normalScale = new THREE.Vector2(0.22, 0.22);
      mat.needsUpdate = true;
      materials.push(mat);
    });

    // The blank garment (the tee's own white sheet; the hoodie ships with none), and the design's
    // sheet; the texture is a blend of the two, redrawn only when the blend changes.
    const blank = document.createElement('canvas');
    blank.width = blank.height = SHEET;
    const original = materials.find(m => m.map?.image)?.map?.image;
    const bctx = blank.getContext('2d');
    if (original) bctx.drawImage(original, 0, 0, SHEET, SHEET);
    else {
      bctx.fillStyle = '#f4f4f4';
      bctx.fillRect(0, 0, SHEET, SHEET);
    }
    const sheet = g.sheet(design);
    const texCanvas = document.createElement('canvas');
    texCanvas.width = texCanvas.height = SHEET;
    const tctx = texCanvas.getContext('2d');
    const texture = new THREE.CanvasTexture(texCanvas);
    texture.flipY = false;
    texture.colorSpace = THREE.SRGBColorSpace;
    for (const mat of materials) {
      const old = mat.map;
      mat.map = texture;
      mat.needsUpdate = true;
      old?.dispose();
    }
    disposers.push(() => {
      texture.dispose();
      materials.forEach(m => m.dispose());
    });
    let shownMix = -1;
    const setMix = mix => {
      const m = Math.round(mix * 64) / 64;
      if (m === shownMix) return;
      shownMix = m;
      tctx.globalAlpha = 1;
      tctx.drawImage(blank, 0, 0);
      tctx.globalAlpha = m;
      tctx.drawImage(sheet, 0, 0);
      tctx.globalAlpha = 1;
      texture.needsUpdate = true;
    };

    const composer = new EffectComposer(
      renderer,
      new THREE.WebGLRenderTarget(canvasSize, canvasSize, {
        type: THREE.HalfFloatType,
        samples: 4,
        depthTexture: new THREE.DepthTexture(canvasSize, canvasSize)
      })
    );
    composer.setPixelRatio(1);
    composer.setSize(canvasSize, canvasSize);
    composer.addPass(new RenderPass(scene, camera));
    composer.addPass(swirl.pass);
    const aberration = new ShaderPass(AberrationShader);
    aberration.needsSwap = false;
    aberration.uniforms.uScale.value = canvasSize / size;
    aberration.uniforms.tSparks.value = swirl.texture;
    // One shockwave shape for the whole ad, so every frame of it agrees.
    aberration.uniforms.uStrikeShape.value = [0.42, 0.61, 0.55, 0.8];
    composer.addPass(aberration);
    disposers.push(() => composer.dispose?.());

    /**
     * Draws the frame at time `t` onto the shirt's canvas.
     * `ev`: when the glitch strikes, when the design lands (texture crossfade, glitch easing off,
     * sparks released), how long the landing takes, and the shirt's turn in radians.
     * @param {number} t
     * @param {{ strikeAt: number, landAt: number, land: number, rise: number, yaw: number }} ev
     */
    function draw(t, { strikeAt, landAt, land, rise, yaw }) {
      let amount = 0;
      if (t >= strikeAt) amount = easeOut(clamp01((t - strikeAt) / rise));
      if (t >= landAt) amount *= 1 - easeInOut(clamp01((t - landAt) / land));
      aberration.uniforms.uAmount.value = amount;
      aberration.uniforms.uTime.value = t;
      aberration.uniforms.uStrike.value = strikeAt;
      setMix(t < landAt ? 0 : easeInOut(clamp01((t - landAt) / land)));
      swirl.pose(t, strikeAt, landAt);
      pivot.rotation.y = yaw;
      composer.render();
      return renderer.domElement;
    }

    return { canvas: renderer.domElement, draw, dispose };
  } catch (e) {
    dispose();
    throw e;
  }
}
