// esbuild entry point -- re-exports the actual render pipeline from ../src/render so
// build.js can bundle it (see build.js's header comment for why bundling is needed at all).
export { generateArtwork, GENERATOR_VERSION } from '../src/render/generateArtwork.js';
export { default as renderArtwork } from '../src/render/renderArtwork.js';
