import React, { useEffect, useRef, useState } from 'react';
import { gsap } from 'gsap/all';
import ArrowIcon from './buttons/ArrowIcon';
import { useStudio } from '../context/StudioContext';
import { DURATION_FAST, DURATION_SLOW } from '../utils/motionTokens';

// Small live 3D garment preview for the homepage hero panel: the current design rendered
// as the base-color texture of a t-shirt model, slowly rotating. three.js is dynamically
// imported (same lazy-chunk treatment as Animation3DPreview) so it never loads for
// visitors who bounce before the hero settles.
//
// Model: "Tshirt" (https://sketchfab.com/3d-models/tshirt-a88d6e25d67c4b0c91b9ea013e679870)
// by khalilchahi99 (https://sketchfab.com/khalilchahi99), CC-BY-4.0 -- served from
// public/models/tshirt/ (GLTFLoader fetches scene.bin + textures by URL, which Vite's
// import pipeline can't resolve from src/assets). license.txt ships alongside it.
//
// Texture spec (from the model's own baseColor atlas): a single square 2048x2048 sheet
// holding the front/back body panels, two sleeves, and hem-strip UV islands as flat
// cut-pattern shapes. A naive full-bleed square render put an arbitrary off-center CROP
// of the artwork on each panel (each island samples its own region of the sheet) -- the
// design never read as centered on the shirt. Instead, each island gets its own
// recompose-per-ratio render (same philosophy as the print pipeline: a sibling
// composition generated fresh from the seed at the island's aspect), composited into the
// island's measured rect. Rects were flood-fill measured off the model's own
// material_baseColor.jpeg (2048-space, generous bounding boxes; the curved
// neckline/hem edges just clip whatever falls outside the island -- invisible, same as
// any print overhang). Both body panels share one render (aspects within 5%), as do the
// sleeves; the tiny hem strips sample the full-bleed base layer drawn underneath.
const TEXTURE_SIZE = 1024;
const ATLAS = 2048;
const BODY_ISLANDS = [
  { x: 61, y: 440, w: 916, h: 1332 },
  { x: 1114, y: 520, w: 872, h: 1267 }
];
const SLEEVE_ISLANDS = [
  { x: 125, y: 30, w: 729, h: 385 },
  { x: 1196, y: 33, w: 729, h: 385 }
];
// Render sizes at each island family's aspect ratio (body 916/1332 ≈ 0.69 portrait,
// sleeve 729/385 ≈ 1.9 landscape), at roughly the resolution they occupy in the
// 1024 composite.
const BODY_RENDER = { w: 512, h: 744 };
const SLEEVE_RENDER = { w: 512, h: 270 };

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
      vec2 off = vec2(0.02 * uAmount, 0.0);
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
  const [failed, setFailed] = useState(false);
  const { currentDesign, renderDesignBlob, queueReady } = useStudio();

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

        const scene = new THREE.Scene();
        const camera = new THREE.PerspectiveCamera(28, 1, 0.05, 50);
        scene.add(new THREE.AmbientLight(0xffffff, 2.4));
        const key = new THREE.DirectionalLight(0xffffff, 2.2);
        key.position.set(2, 3, 4);
        scene.add(key);

        const gltf = await new GLTFLoader().loadAsync('/models/tshirt/scene.gltf');
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

        const materials = [];
        gltf.scene.traverse(obj => {
          if (obj.isMesh) materials.push(obj.material);
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
            }
          });
        };

        mount.appendChild(renderer.domElement);

        // No idle spin -- the shirt faces forward and turns slowly toward the mouse
        // (desktop) or with the phone's left/right tilt (touch devices, deviceorientation
        // gamma), capped at ±15° of yaw either way. Static under prefers-reduced-motion.
        const MAX_YAW = (15 * Math.PI) / 180;
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
        };
        const startOrientation = () => {
          window.addEventListener('deviceorientation', onOrientation);
          inputCleanups.push(() => window.removeEventListener('deviceorientation', onOrientation));
        };

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
          aberrationTween = gsap.to(aberrationPass.uniforms.uAmount, {
            value,
            duration,
            ease: value > 0 ? 'power2.out' : 'power2.inOut'
          });
        };

        let raf = 0;
        const animate = now => {
          pivot.rotation.y += (targetYaw - pivot.rotation.y) * 0.04;
          aberrationPass.uniforms.uTime.value = now * 0.001;
          composer.render();
          raf = requestAnimationFrame(animate);
        };
        raf = requestAnimationFrame(animate);

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
          cancelAnimationFrame(raf);
          inputCleanups.forEach(fn => fn());
          crossfadeTween?.kill();
          aberrationTween?.kill();
          stateRef.current.api = null;
          texture.dispose();
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

  // Re-render the texture whenever the design changes. queueReady gates the star-sprite
  // queue renderDesignBlob depends on -- same guard StudioContext's own preview effect uses.
  useEffect(() => {
    if (!queueReady || failed) return undefined;
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
        BODY_ISLANDS.forEach(r =>
          ctx.drawImage(body, r.x * sc, r.y * sc, r.w * sc, r.h * sc)
        );
        // The two sleeve islands map onto the garment in opposite orientations, so the
        // second draw is horizontally mirrored -- identical draws made one worn sleeve
        // read as flipped relative to the other (user-caught); mirroring restores
        // left/right symmetry on the shirt.
        SLEEVE_ISLANDS.forEach((r, i) => {
          if (i === 0) {
            ctx.drawImage(sleeve, r.x * sc, r.y * sc, r.w * sc, r.h * sc);
          } else {
            ctx.save();
            ctx.translate((r.x + r.w) * sc, r.y * sc);
            ctx.scale(-1, 1);
            ctx.drawImage(sleeve, 0, 0, r.w * sc, r.h * sc);
            ctx.restore();
          }
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
  }, [currentDesign, queueReady, renderDesignBlob, failed]);

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
      onClick={onShopClick}
      aria-label="Shop this design on merch"
      className="tshirt-preview-btn group relative shrink-0 cursor-pointer border-0 bg-transparent p-0 transition-transform duration-300 hover:scale-[1.04]"
      style={{ width: size, height: size }}
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
