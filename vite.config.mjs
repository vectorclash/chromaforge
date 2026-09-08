import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
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
