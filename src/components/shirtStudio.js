import { makeRng } from '../render/prng';

// The t-shirt's lighting and fabric, shared by the homepage hero (TshirtPreview) and the ad
// builder's explainer (adBuilder/explainShirt), so the two are always the same garment.
//
// Built for the explainer first (2026-10-26, Aaron: the hero's lighting read "very flat with
// texture and lighting" at video size), then adopted by the hero (2026-10-27, Aaron: "the shirt
// just looks so good in the video it would be nice to match that lighting and texture"). That
// REPLACES the hero's old calibration, which solved for every texel showing the colour it has on
// the wall behind it -- nearly all ambient, a weak key, no tone mapping. The trade is deliberate:
// folds now model and the lit side carries more contrast, so the garment no longer matches the
// flat background colour for colour. Tone mapping stays off, so nothing desaturates in a curve's
// shoulder (the reason the old calibration existed in the first place).

// A studio setup: a key from the upper left, a dim fill from the right, two rims from behind to
// pull the silhouette off the background, and little ambient, so the folds model. A surface
// facing the key lands near the print's own colour (ambient + env + key ~ 0.9 of pi); one turned
// away from it drops to about a third.
const AMBIENT = 0.6;
const ENV_IRRADIANCE = 0.15;
const LIGHTS = [
  [2.4, -2.4, 3.6, 4],
  [0.35, 3, 0.5, 3],
  [1.5, 3.5, 1.8, -4],
  [1.2, -3.5, 1.2, -4]
];

/**
 * Adds the lights and a sky/floor gradient environment to `scene`.
 * @returns {() => void} disposes the environment map (a PMREM target no material owns)
 */
export function addStudioLighting(THREE, scene, renderer) {
  renderer.toneMapping = THREE.NoToneMapping;
  scene.add(new THREE.AmbientLight(0xffffff, AMBIENT));
  for (const [intensity, x, y, z] of LIGHTS) {
    const light = new THREE.DirectionalLight(0xffffff, intensity);
    light.position.set(x, y, z);
    scene.add(light);
  }
  // Equirect gradient, built here rather than loaded: bright sky above, dark floor below. Rows
  // are weighted by sin(theta), their real solid angle, when normalising, so the mean radiance a
  // surface sees lands on ENV_IRRADIANCE.
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
  scene.environment = envMap; // lights the garment; never scene.background (transparent)
  return () => envMap.dispose();
}

// A tileable fabric bump as a tangent-space normal map: JERSEY KNIT, what the garments are made
// of -- columns (wales) of small V-shaped stitches. The first version was isotropic value noise,
// and noise the same in every direction reads as a wall, not cloth (Aaron, 2026-10-26: "like wall
// plaster"). A stitch is STITCH texels square; at FABRIC_REPEAT over the atlas that is ~170
// stitches across the hoodie's front, a little coarser than real jersey, so the grain survives as
// a fine directional texture once mipmapped to display size rather than resolving into a visible
// pattern. Both atlases are close to one texel density throughout, and pieces are laid upright,
// so the wales run down the garment everywhere.
const FABRIC_SIZE = 512;
const FABRIC_REPEAT = 8;
const STITCH = 8;
let fabricData = null; // the same for every shirt, so worked out once per visit
function fabricNormals() {
  if (fabricData) return fabricData;
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
  fabricData = data;
  return data;
}

/**
 * The knit normal map, for `applyFabric`. The caller disposes it.
 */
export function makeFabricTexture(THREE, renderer) {
  const fabric = new THREE.DataTexture(fabricNormals(), FABRIC_SIZE, FABRIC_SIZE);
  fabric.wrapS = fabric.wrapT = THREE.RepeatWrapping;
  fabric.repeat.set(FABRIC_REPEAT, FABRIC_REPEAT);
  fabric.generateMipmaps = true;
  fabric.minFilter = THREE.LinearMipmapLinearFilter;
  fabric.magFilter = THREE.LinearFilter;
  fabric.anisotropy = renderer.capabilities.getMaxAnisotropy();
  fabric.needsUpdate = true;
  return fabric;
}

// The tee model is TWO shells about 1/500 of its size apart, sharing one UV atlas: `material` is
// the outside, `material_1` the lining (measured: a ray off the outside escapes into open air, a
// ray off the lining crosses the body cavity). An all-over print is on the outside only, so the
// lining keeps the model's own blank sheet and never takes the design -- what shows through the
// collar, the sleeves and up the hem is plain white fabric, as on the real garment.
const isLining = mesh => mesh.material.name === 'material_1';

/**
 * Applies the fabric to every mesh under `root` and returns `{ materials, printed }`: all of the
 * live materials (for disposal), and the ones that wear the design.
 * A lined model also draws each shell from its FRONT only (the outside faces out, the lining
 * faces in). Simplifying the homepage tee pushed the two shells through each other, so the
 * lining poked out in white patches all over the print; front-only, the outside is all you see
 * from outside and the lining all you see through an opening. No holes: against the
 * double-sided render only silhouette pixels change, from six angles, on both tee builds.
 * The hoodie is one mesh holding both layers, so none of this applies to it: its inside shells
 * are unprinted in the model file itself (scripts/hoodie-model/unprint-inside.mjs).
 */
export function applyFabricToShells(THREE, root, fabric) {
  const meshes = [];
  root.traverse(obj => obj.isMesh && meshes.push(obj));
  const lined = meshes.some(isLining);
  const materials = [];
  const printed = [];
  for (const mesh of meshes) {
    const lining = isLining(mesh);
    const mat = applyFabric(THREE, mesh, fabric);
    if (lined) mat.side = THREE.FrontSide;
    materials.push(mat);
    if (!lining) printed.push(mat);
  }
  return { materials, printed };
}

/**
 * Makes a mesh's material cotton jersey: sheen at the silhouette, matte, with the knit grain.
 * Promotes a MeshStandardMaterial to MeshPhysicalMaterial (sheen exists only there) by borrowing
 * MeshStandardMaterial's OWN copy: MeshPhysicalMaterial.copy reads physical-only fields off its
 * source and would throw on a Standard one. Returns the live material.
 */
export function applyFabric(THREE, mesh, fabric) {
  let mat = mesh.material;
  if (!mat.isMeshPhysicalMaterial) {
    const physical = new THREE.MeshPhysicalMaterial();
    THREE.MeshStandardMaterial.prototype.copy.call(physical, mat);
    mat.dispose();
    mesh.material = physical;
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
  return mat;
}
