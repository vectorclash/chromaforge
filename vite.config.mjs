import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import adBuilderDev from './scripts/ad-builder-dev.mjs';
import { readFileSync } from 'node:fs';

// Publishes the build's GENERATOR_VERSION as /version.json. create-checkout-session reads it to
// refuse a Buy Now from a tab loaded before a generator bump -- that tab's designs were made by
// code render-service no longer runs, so the order could only be held after payment (see
// process-order). Read from the source with a regex rather than imported: generateArtwork.js pulls
// in the canvas/createjs graph, which does not load in Node.
function generatorVersionFile() {
  return {
    name: 'generator-version-file',
    apply: 'build',
    generateBundle() {
      const src = readFileSync(new URL('./src/render/generateArtwork.js', import.meta.url), 'utf8');
      const match = src.match(/export const GENERATOR_VERSION = (\d+);/);
      if (!match) this.error('GENERATOR_VERSION not found in src/render/generateArtwork.js');
      this.emitFile({
        type: 'asset',
        fileName: 'version.json',
        source: JSON.stringify({ generatorVersion: Number(match[1]) })
      });
    }
  };
}

export default defineConfig({
  // adBuilderDev is serve-only: the local ad builder (ad-builder.html) and its routes never reach
  // a production build, which bundles index.html alone.
  plugins: [react(), tailwindcss(), adBuilderDev(), generatorVersionFile()],
  server: {
    // `npm start` opens a browser, as it always has. CF_NO_OPEN=1 starts the server without
    // one -- for anything that only needs the port (an agent, a script, a second server
    // alongside one already running), so a dev server being restarted does not keep throwing
    // a new tab on top of whatever you were doing.
    open: !process.env.CF_NO_OPEN,
  },
  preview: {
    // Explicitly false, and it has to be said out loud: `preview.open` DEFAULTS TO
    // `server.open`, so leaving it unset made every `vite preview` inherit the dev server's
    // open:true and spawn a tab. That is how the repo's own checks behave too -- both
    // check-routes-smoke.mjs and check-hero-build-race.mjs spawn a preview server and drive
    // it with Playwright, so a full verification pass opened a browser tab per run for a
    // page nobody was going to look at. Nothing that previews a build wants a window.
    open: false,
  },
  css: {
    preprocessorOptions: {
      scss: {
        api: 'modern-compiler',
      },
    },
  },
});
