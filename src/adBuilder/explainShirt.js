import { generateArtwork } from '../render/generateArtwork';
import renderArtwork from '../render/renderArtwork';
import { resolveDesignPalette } from '../render/resolvedPalette';
import { createTshirtSwirl } from '../components/tshirtSwirl';
import { addStudioLighting, makeFabricTexture, applyFabricToShells } from '../components/shirtStudio';
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
// The lighting and fabric (a real key light, rims from behind, a fine knit normal map, sheen) are
// shared with the hero through components/shirtStudio.js; they were made here first, and the hero
// adopted them. The sheet is twice the hero's resolution, for video-frame sizes.
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
    const scene = new THREE.Scene();
    const fov = (2 * Math.atan((canvasSize / size) * Math.tan(halfFov)) * 180) / Math.PI;
    const camera = new THREE.PerspectiveCamera(fov, 1, 0.05, 50);
    // The lighting and fabric are the homepage shirt's (components/shirtStudio.js).
    disposers.push(addStudioLighting(THREE, scene, renderer));

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

    const fabric = makeFabricTexture(THREE, renderer);
    disposers.push(() => fabric.dispose());
    // Only the outside wears the design; the tee's lining keeps its blank sheet.
    const { materials, printed } = applyFabricToShells(THREE, gltf.scene, fabric);

    // The blank garment (the tee's own white sheet; the hoodie ships with none), and the design's
    // sheet; the texture is a blend of the two, redrawn only when the blend changes.
    const blank = document.createElement('canvas');
    blank.width = blank.height = SHEET;
    const original = printed.find(m => m.map?.image)?.map?.image;
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
    for (const mat of printed) {
      const old = mat.map;
      mat.map = texture;
      mat.needsUpdate = true;
      old?.dispose();
    }
    disposers.push(() => {
      texture.dispose();
      materials.forEach(m => {
        if (m.map !== texture) m.map?.dispose(); // the lining's own sheet
        m.dispose();
      });
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
