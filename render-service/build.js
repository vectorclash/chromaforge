// Bundles the actual generateArtwork.js/renderArtwork.js from ../src/render (and their
// Generate*/render-layer dependencies) into a single importable file. This is NOT a code
// port -- esbuild just resolves Vite-style extensionless imports (which Node's native ESM
// loader can't do) and inlines them; the executed logic is byte-for-byte the same as what
// ships to the browser. Re-run this (npm run build) before every deploy so the bundle can
// never go stale relative to ../src/render.
import { build } from 'esbuild';

await build({
  entryPoints: ['entry.js'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: 'generated/render-lib.js',
  external: ['tinycolor2'] // plain npm dep, resolved from render-service's own node_modules
});

console.log('Built generated/render-lib.js');
