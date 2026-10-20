// esbuild entry point -- re-exports the actual render pipeline from ../src/render so
// build.js can bundle it (see build.js's header comment for why bundling is needed at all).
export { generateArtwork, GENERATOR_VERSION } from '../src/render/generateArtwork.js';
export { default as renderArtwork } from '../src/render/renderArtwork.js';
// The hat-wrap compositor is bundled alongside them so render-service and lib/printful.js run
// the SAME implementation rather than mirroring it by hand the way drawRegion has to.
export { drawHatWrap, hatWrapSourceSize, hatWrapDiscSourceSize } from '../src/render/hatWrap.js';
// Same reasoning for the leg wrap -- one implementation, bundled, never mirrored by hand.
export { drawLegWrap, legWrapSourceSize } from '../src/render/legWrap.js';
// The nebula's CPU field and the hook that takes a field computed elsewhere, so render-service
// can split the field across threads (nebulaThreads.js) with the same code the browser runs.
export { prepareNebulaWithField } from '../src/render/nebula.js';
export { nebula2dRows } from '../src/render/nebula2dCpu.js';
