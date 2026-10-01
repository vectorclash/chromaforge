/*
 * Leak check: drives the production build through the things a visitor repeats -- Generate on
 * the homepage, home -> shop -> product -> home, Generate and Export in the studio's 3D mode --
 * and fails if anything the page holds GROWS with the repetition. Also fails on idle frame loops
 * and on an export that cannot recover from an encoder failure.
 *
 * WHY THIS EXISTS (2026-09-26 bug-class sweep). Leaks are the one class of bug with no symptom
 * of its own until a phone runs out of memory, so nothing else here would notice one. The sweep
 * found four with these exact measurements, every one invisible to the build, the route smoke
 * check and a desktop by eye:
 *   - EaselJS's Stage registers window mouseup/mousemove listeners that hold the stage, so every
 *     render with a geometry layer stayed alive for the session: +7 listeners per homepage
 *     Generate, and each mousemove ran through all of them.
 *   - The studio's 3D preview never force-lost its WebGL context: 20 Generates in 3D left 16
 *     contexts live, with Chrome evicting the oldest.
 *   - Every 3D export left its context behind the same way.
 *   - An encoder that died mid-export left the studio stuck on "Exporting..." until a reload.
 * Each assertion below was seen to FAIL on the commit before its fix before it was trusted.
 *
 * WHAT IT MEASURES, and how:
 *   - Window/document listeners, counted by wrapping add/removeEventListener. Only listeners
 *     added by the app's own scripts count: Playwright installs its own on the first click,
 *     from an anonymous script, and those are excluded by origin rather than by name.
 *   - WebGL contexts made against contexts lost (a `webglcontextlost` event per canvas). "Live"
 *     is made minus lost; a page may hold one, never a growing number.
 *   - requestAnimationFrame callbacks per second with nothing on screen moving. GSAP's
 *     ScrollTrigger keeps a 60/s loop of its own for the whole session (library code, an empty
 *     callback) and polls every 250ms, so the ceiling is set just above that.
 * The geometry layer is pinned ON through the stored studio prefs, because the EaselJS leak
 * only exists for a design that has one -- an unpinned run passes by luck one time in ten.
 *
 * Usage:  node scripts/check-leaks.mjs [--url http://localhost:4174]
 * Builds and serves dist/ itself unless --url is given. Exit 0 = nothing grows. Needs a GPU
 * (WebGL + WebCodecs), which headless Chromium has on a Mac with the flags below. No secrets.
 */
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const args = process.argv.slice(2);
const urlArg = args.includes('--url') ? args[args.indexOf('--url') + 1] : null;
const PORT = 4174;
const GENERATES = 6;
const NAV_CYCLES = 3;
const STUDIO_GENERATES = 8;
const IDLE_RAF_CEILING = 70; // ScrollTrigger's own 60/s + its 4/s poll, and a little slack

const LAUNCH = { args: ['--enable-gpu', '--use-angle=metal', '--ignore-gpu-blocklist'] };

// Runs in the page before any of its scripts.
function instrument({ origin, failEncoderAt }) {
  const S = (window.__leak = { made: 0, lost: 0, raf: 0, floatUploads: 0 });

  // Each 3D scene build uploads its plate data as two FLOAT textures, so counting those shows
  // a rebuild happened without assuming it makes a new context (it does not: the preview keeps
  // one renderer per mount, so a rebuild never blacks out the canvas).
  // three.js allocates with texStorage2D and uploads with texSubImage2D on WebGL2; both are
  // counted, keyed on the type argument (index 7 in the 9-argument forms of each).
  if (window.WebGL2RenderingContext) {
    for (const name of ['texImage2D', 'texSubImage2D']) {
      const fn = WebGL2RenderingContext.prototype[name];
      WebGL2RenderingContext.prototype[name] = function (...a) {
        if (a.length >= 9 && a[7] === 0x1406) S.floatUploads++; // type === gl.FLOAT
        return fn.apply(this, a);
      };
    }
  }

  const seen = new WeakSet();
  const getContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
    const ctx = getContext.call(this, type, ...rest);
    if (ctx && /webgl/.test(type) && !seen.has(ctx)) {
      seen.add(ctx);
      S.made++;
      this.addEventListener('webglcontextlost', () => S.lost++);
    }
    return ctx;
  };

  const raf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = cb => {
    S.raf++;
    return raf(cb);
  };

  const live = new Map();
  const add = EventTarget.prototype.addEventListener;
  const remove = EventTarget.prototype.removeEventListener;
  const key = (target, type, opts) => {
    if (target !== window && target !== document) return null;
    return `${type}|${typeof opts === 'boolean' ? opts : !!opts?.capture}`;
  };
  EventTarget.prototype.addEventListener = function (type, fn, opts) {
    const k = key(this, type, opts);
    // Only listeners added from the app's own scripts: the calling frame's URL.
    if (k && fn && ((new Error().stack || '').split('\n')[2] || '').includes(origin)) {
      if (!live.has(k)) live.set(k, new Set());
      live.get(k).add(fn);
    }
    return add.call(this, type, fn, opts);
  };
  EventTarget.prototype.removeEventListener = function (type, fn, opts) {
    const k = key(this, type, opts);
    if (k && fn) live.get(k)?.delete(fn);
    return remove.call(this, type, fn, opts);
  };
  S.listeners = () => {
    const out = {};
    for (const [k, set] of live) if (set.size) out[k] = set.size;
    return out;
  };

  if (failEncoderAt && window.VideoEncoder) {
    // What an encoder dying mid-export looks like to the code: it closes, and every later
    // encode() throws InvalidStateError.
    const encode = VideoEncoder.prototype.encode;
    let n = 0;
    VideoEncoder.prototype.encode = function (...a) {
      if (++n === failEncoderAt) this.close();
      return encode.apply(this, a);
    };
  }

  // Geometry layer always on (see the header), and the studio starting in 3D so it does not
  // spend 30s building 2D frames first. Written once per tab, so the app's own writes stand.
  if (!sessionStorage.getItem('__leakSeeded')) {
    sessionStorage.setItem('__leakSeeded', '1');
    localStorage.setItem('cf-studio:design', JSON.stringify({ v: 1, colors: [], settings: { geometry: { chance: 1 } } }));
    localStorage.setItem(
      'cf-studio:video',
      JSON.stringify({ v: 1, threeDMode: true, cycleDuration: 5, speedRamp: true, logoMark: false, frameCount: 20, starFrameCount: 10, exportAspect: '1:1', exportFps: 24, exportSize: '4k' })
    );
  }
}

const results = [];
const check = (ok, name, detail = '') => {
  results.push({ ok, name, detail });
  console.log(`${ok ? ' ok ' : 'FAIL'}  ${name}${detail ? ` -- ${detail}` : ''}`);
};

const total = listeners => Object.values(listeners).reduce((a, b) => a + b, 0);
const grew = (before, after) =>
  Object.keys(after)
    .filter(k => (after[k] || 0) > (before[k] || 0))
    .map(k => `${k} ${before[k] || 0} -> ${after[k]}`)
    .join(', ');

const run = (cmd, cmdArgs) =>
  new Promise((resolve, reject) => {
    const p = spawn(cmd, cmdArgs, { stdio: 'inherit' });
    p.on('exit', code => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))));
  });

const waitFor = async url => {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error(`server never became ready at ${url}`);
};

const heroGenerateReady = page =>
  page.waitForFunction(
    () => [...document.querySelectorAll('button.button-large')].some(b => b.textContent.trim() === 'Generate' && b.classList.contains('enabled')),
    null,
    { timeout: 60000 }
  );

async function newPage(browser, base, opts = {}) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, acceptDownloads: true });
  await context.addInitScript(instrument, { origin: new URL(base).origin, failEncoderAt: opts.failEncoderAt || 0 });
  const page = await context.newPage();
  page.on('dialog', d => d.dismiss());
  return { context, page };
}

async function homepage(browser, base) {
  const { context, page } = await newPage(browser, base);
  await page.goto(base + '/', { waitUntil: 'load' });
  await heroGenerateReady(page);
  await page.waitForTimeout(3000);

  // Idle: nothing on screen is moving at the top of a settled homepage.
  const idle = await page.evaluate(async () => {
    const r0 = window.__leak.raf;
    await new Promise(r => setTimeout(r, 3000));
    return (window.__leak.raf - r0) / 3;
  });
  check(idle <= IDLE_RAF_CEILING, 'homepage idle: no app frame loop running', `${idle.toFixed(0)} rAF callbacks/s (ceiling ${IDLE_RAF_CEILING})`);

  const generate = async () => {
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.locator('button.button-large.enabled', { hasText: 'Generate' }).first().click();
    await heroGenerateReady(page);
    await page.waitForTimeout(1500);
  };
  await generate();
  const before = await page.evaluate(() => window.__leak.listeners());
  for (let i = 1; i < GENERATES; i++) await generate();
  const after = await page.evaluate(() => window.__leak.listeners());
  check(total(after) <= total(before), `homepage: listeners flat across ${GENERATES - 1} more Generates`, grew(before, after) || `${total(after)} listeners`);

  const gl = await page.evaluate(() => ({ made: window.__leak.made, lost: window.__leak.lost }));
  check(gl.made - gl.lost <= 1, 'homepage: at most one live WebGL context', `made ${gl.made}, lost ${gl.lost}`);

  // Navigation: home -> shop -> product -> home.
  const navBefore = await page.evaluate(() => window.__leak.listeners());
  for (let i = 0; i < NAV_CYCLES; i++) {
    await page.click('header nav a[href="/shop"]');
    await page.waitForSelector('a[href^="/shop/"]', { timeout: 30000 });
    await page.waitForTimeout(1500);
    await page.click('a[href^="/shop/"] >> nth=0');
    await page.waitForURL(/\/shop\/\d+/);
    await page.waitForTimeout(2500);
    await page.click('header a[href="/"]');
    await page.waitForURL(u => new URL(u).pathname === '/');
    await heroGenerateReady(page);
    await page.waitForTimeout(2500);
  }
  const navAfter = await page.evaluate(() => window.__leak.listeners());
  check(total(navAfter) <= total(navBefore), `navigation: listeners flat across ${NAV_CYCLES} home -> shop -> product -> home cycles`, grew(navBefore, navAfter) || `${total(navAfter)} listeners`);
  const navGl = await page.evaluate(() => ({ made: window.__leak.made, lost: window.__leak.lost }));
  check(navGl.made - navGl.lost <= 1, 'navigation: at most one live WebGL context', `made ${navGl.made}, lost ${navGl.lost}`);
  await context.close();
}

async function openStudio3D(browser, base, opts) {
  const { context, page } = await newPage(browser, base, opts);
  await page.goto(base + '/studio', { waitUntil: 'load' });
  await heroGenerateReady(page);
  await page.click('button.panel-tab:has-text("Animation")');
  await page.waitForTimeout(2500);
  return { context, page };
}

// Download opens the studio's Download panel (2026-10-01); its own Download button does the
// export. Opening the panel also renders a 3D preview still through its own WebGL context, so
// this covers that context's release as well.
const exportOnce = async page => {
  await page.locator('#controls-main button.button-small', { hasText: /Download MP4/ }).click();
  const panel = page.locator('#controls-download');
  await panel.waitFor({ state: 'visible' });
  await page.waitForTimeout(1500);
  const button = panel.locator('button.button-small', { hasText: /^(Download|Downloaded|Preparing\.\.\.)$/ });
  await button.click();
  let done = false;
  for (let s = 0; s < 120; s++) {
    await page.waitForTimeout(500);
    if (s > 1 && (await button.textContent()).trim() !== 'Preparing...') {
      done = true;
      break;
    }
  }
  await panel.locator('button.button-small', { hasText: 'BACK' }).click();
  return done;
};

async function studio(browser, base) {
  const { context, page } = await openStudio3D(browser, base);
  const before = await page.evaluate(() => ({ made: window.__leak.made, uploads: window.__leak.floatUploads }));
  for (let i = 0; i < STUDIO_GENERATES; i++) {
    await page.locator('button.button-large', { hasText: 'Generate' }).first().click();
    // A 3D Generate holds the new scene for one hexagon-loader cycle (2s); wait for the button to
    // come back rather than a fixed delay, so every click starts a real build
    await page.waitForFunction(() => [...document.querySelectorAll('button.button-large')].some(b => b.textContent.trim() === 'Generate'), null, { timeout: 15000 });
    await page.waitForTimeout(300);
  }
  let gl = await page.evaluate(() => ({ made: window.__leak.made, lost: window.__leak.lost }));
  const uploads = await page.evaluate(() => window.__leak.floatUploads);
  check(uploads - before.uploads >= 2 * STUDIO_GENERATES, '3D preview actually rebuilt', `${(uploads - before.uploads) / 2} scene builds`);
  check(gl.made - before.made === 0, `3D preview: one renderer across ${STUDIO_GENERATES} Generates`, `${gl.made - before.made} new contexts`);
  check(gl.made - gl.lost <= 1, `3D preview: at most one live WebGL context after ${STUDIO_GENERATES} Generates`, `made ${gl.made}, lost ${gl.lost}`);

  const exported = await exportOnce(page);
  gl = await page.evaluate(() => ({ made: window.__leak.made, lost: window.__leak.lost }));
  check(exported && gl.made - gl.lost <= 1, '3D export: finishes and releases its WebGL context', `made ${gl.made}, lost ${gl.lost}`);
  await context.close();

  const failing = await openStudio3D(browser, base, { failEncoderAt: 20 });
  const recovered = await exportOnce(failing.page);
  gl = await failing.page.evaluate(() => ({ made: window.__leak.made, lost: window.__leak.lost }));
  check(recovered, 'a failed export returns the panel to "Download"', recovered ? '' : 'still "Preparing..." after 60s');
  check(gl.made - gl.lost <= 1, 'a failed export still releases its WebGL context', `made ${gl.made}, lost ${gl.lost}`);
  await failing.context.close();
}

const main = async () => {
  let server = null;
  let base = urlArg;
  if (!base) {
    console.log('Building...');
    await run('npm', ['run', 'build']);
    server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { stdio: 'ignore' });
    base = `http://localhost:${PORT}`;
    await waitFor(base);
  }
  const browser = await chromium.launch(LAUNCH);
  try {
    await homepage(browser, base);
    await studio(browser, base);
  } finally {
    await browser.close();
    server?.kill();
  }
  const failed = results.filter(r => !r.ok);
  console.log(failed.length ? `\n${failed.length} of ${results.length} checks FAILED` : `\nAll ${results.length} checks passed.`);
  process.exit(failed.length ? 1 : 0);
};

main().catch(err => {
  console.error(err);
  process.exit(1);
});
