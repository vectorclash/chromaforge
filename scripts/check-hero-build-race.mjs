// Verifies that the studio canvas can never end up showing a DIFFERENT design from every
// other surface that mirrors the active artwork.
//
//   npm i --no-save playwright@1.50.1        # both lines are one-off, ~78MB of browser
//   npx playwright install chromium
//   npm run build && npx vite preview --port 4173 &
//   node scripts/check-hero-build-race.mjs   # --url=... to point elsewhere
//
// Exit 0 = the canvas always lands on the newest design and always hands the controls back.
// Exit 1 = a stale or failed build can strand it, which is a bug customers see.
//
// Playwright is deliberately NOT a devDependency: it would pull a browser download into every
// install of a Vite app for one script. `--no-save` puts it in node_modules without touching
// package.json, so a later `npm ci` cleans it back out -- rerun the two install lines then.
//
// WHY THIS EXISTS (real incident, reported 2026-08-16 with a screenshot): the homepage hero
// showed one design while the t-shirt preview, About blob, mini generator, footer band and
// mobile nav all showed another. Aaron had seen it once before and assumed he was imagining
// it -- it is a race, so it is a coin flip in the wild and effectively unreproducible by hand.
//
// The asymmetry that makes the canvas the odd one out: every OTHER surface is guarded against
// stale async results (StudioContext's render effect has a `cancelled` flag, useCrossfadeImage
// has an epoch counter, TshirtPreview has its own `cancelled`), so they can only ever agree
// with each other. The canvas is whatever DisplayCanvas.setImage last wrote to
// .image-container, and that path had no guard at all: no generation token, no in-flight
// check, no null check on the blob. Two full-size builds could genuinely coexist, because the
// three MiniGenerator instances on the homepage (floating, footer, mobile nav) each change the
// design while the hero is mid-build -- their own Generate lock ends when the 480px preview
// lands, long before the hero's 2160px+ render and quality-0.98 JPEG encode finish.
//
// HOW IT FORCES THE RACE: it patches canvas.toBlob and HOLDS the callback, so the test decides
// when and in what order each build lands. Quality 0.98 is the canvas image path's unique
// signature -- every preview render in the app encodes at 0.85, so the filter needs no other
// discriminator.
//
// RUN IT AGAINST THE PRODUCTION BUILD. In dev, StrictMode double-mounts DisplayCanvas, so two
// builds exist at load for a reason that has nothing to do with this, and every count is
// meaningless. That wasted a debugging pass the first time.
//
// Measured when this landed -- pre-fix vs. post-fix:
//   builds in flight when a generate lands mid-build     2  ->  1
//   hero after the OLDER build is released last     build 1  ->  n/a (cannot coexist)
//   toBlob returning null            throws, stuck "Generating"  ->  recovers to "Generate"

import { chromium } from 'playwright';

const arg = name => {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};
const BASE = arg('url') || 'http://localhost:4173';

const sleep = ms => new Promise(r => setTimeout(r, ms));

const INIT = `
window.__cf = { n: 0, previews: 0, pending: [], thrown: [], urlIndex: new Map(), blobIndex: new Map() };
const origToBlob = HTMLCanvasElement.prototype.toBlob;
HTMLCanvasElement.prototype.toBlob = function (cb, type, q) {
  // StudioContext's shared 480px preview -- the signal that the ACTIVE DESIGN changed, i.e.
  // that every non-canvas surface has moved on. Used to prove a click really did something.
  if (q === 0.85 && this.width === 480) window.__cf.previews++;
  if (q !== 0.98 || this.width < 1000) return origToBlob.call(this, cb, type, q);
  const i = ++window.__cf.n;
  origToBlob.call(this, blob => { window.__cf.pending.push({ i, blob, cb }); }, type, q);
};
const origCreate = URL.createObjectURL;
URL.createObjectURL = function (blob) {
  const url = origCreate.call(URL, blob);
  if (window.__cf.blobIndex.has(blob)) window.__cf.urlIndex.set(url, window.__cf.blobIndex.get(blob));
  return url;
};
window.__cf.release = (i, asNull) => {
  const p = window.__cf.pending.find(x => x.i === i);
  if (!p) return false;
  window.__cf.blobIndex.set(p.blob, p.i);
  // A throw here belongs to the app, not the harness: toBlob callbacks run detached in a real
  // browser, so an exception inside setImage is an unhandled error that silently kills that
  // build. Record it and carry on, so the run can observe what the UI does next.
  try { p.cb(asNull ? null : p.blob); } catch (e) { window.__cf.thrown.push(String(e.message || e)); }
  return true;
};
// Which build's blob is actually painted right now.
window.__cf.heroIndex = () => {
  const el = document.querySelector('.image-container');
  const m = /url\\("?(blob:[^")]+)"?\\)/.exec((el && el.style.backgroundImage) || '');
  return m ? (window.__cf.urlIndex.get(m[1]) ?? 'unknown') : null;
};
window.__cf.generateLabel = () => {
  const b = document.querySelector('.button-large');
  return b ? b.textContent.trim() : null;
};
`;

const failures = [];
const check = (ok, label, detail) => {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail === undefined ? '' : ` -- ${detail}`}`);
  if (!ok) failures.push(label);
};

async function open(browser) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await ctx.addInitScript(INIT);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e.message || e)));
  await page.goto(`${BASE}/`, { waitUntil: 'load' });
  await page.waitForFunction('window.__cf && window.__cf.pending.length >= 1', null, { timeout: 30000 });
  return { ctx, page, errors };
}

// Release build `i` once its encode has actually finished. `__cf.n` counts a build when toBlob
// is CALLED, but it only becomes releasable when the encode completes -- and since interactive
// renders now run in steps (render/renderQueue.js) that can land a beat after the count does.
// Releasing on the count alone found nothing to release and left the canvas on the older build.
// A build that never becomes ready still fails the check that follows, since nothing is released.
async function releaseWhenReady(page, i, asNull = false) {
  await page
    .waitForFunction(n => window.__cf.pending.some(x => x.i === n), i, { timeout: 10000 })
    .catch(() => {});
  return page.evaluate(([n, nul]) => window.__cf.release(n, nul), [i, asNull]);
}

// Wait (bounded) for build `i` to be the one on the canvas. A Generate's builds reveal on a
// shared cycle (utils/generationCycle.js) -- with every other surface showing the design, once
// ALL of them have rendered -- so how long after its own decode the hero paints depends on the
// rest of the page. Measured 0.7-2.0s after release here, which a fixed 2.5s sleep only just
// covered. A build that never paints still fails the check that follows.
async function waitForHero(page, i) {
  await page.waitForFunction(n => window.__cf.heroIndex() === n, i, { timeout: 10000 }).catch(() => {});
}

// Generate from an ambient surface, NOT the canvas's own button -- that one is disabled while
// a build runs, which is precisely why it is the ambient ones that can land mid-build.
async function generateFromWidget(page) {
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  // Long enough for the mini generator to finish docking into the footer (a 0.8s morph):
  // mid-morph, the floating row's Generate is still "visible" when found and hidden by the time
  // it is clicked, which timed this check out.
  await sleep(1200);
  const before = await page.evaluate(() => window.__cf.previews);
  const buttons = page.locator('button[aria-label="Generate new design"]');
  const n = await buttons.count();
  for (let i = 0; i < n; i++) {
    const b = buttons.nth(i);
    if ((await b.isVisible()) && (await b.isEnabled())) {
      // A direct DOM click, not Playwright's: its scroll-into-view moves the page, and the
      // docked mini generator's position is scroll-linked (MiniGenerator's useDockMorph), so the
      // button could keep moving out from under the pointer until the click timed out. This
      // check is about builds racing, not about click mechanics.
      await b.evaluate(el => el.click());
      break;
    }
  }
  await sleep(800);
  const after = await page.evaluate(() => window.__cf.previews);
  return after > before;
}

async function main() {
  const browser = await chromium.launch();

  // 1. A generate landing mid-build must not open a second full-size build, and the design it
  //    asked for must still get built once the in-flight one lands.
  {
    const { ctx, page, errors } = await open(browser);
    const changed = await generateFromWidget(page);
    check(changed, 'a widget generate actually changed the active design');

    const inFlight = await page.evaluate(() => window.__cf.n);
    check(inFlight === 1, 'only one full-size build in flight at a time', `builds=${inFlight}`);

    if (inFlight >= 2) {
      // Unfixed: land the NEWER build first, then the OLDER one, and see who wins.
      await releaseWhenReady(page, 2);
      await sleep(1200);
      await releaseWhenReady(page, 1);
      await sleep(2000);
      const hero = await page.evaluate(() => window.__cf.heroIndex());
      check(hero === 2, 'a stale build cannot paint over a newer one', `canvas shows build ${hero}`);
    } else {
      await releaseWhenReady(page, 1);
      // "Eventually", not "within 2.5s": the deferred build waits out the landed build's hold and
      // fade-in, a 350ms retry, and then renders in steps across frames (render/renderQueue.js).
      await page.waitForFunction(() => window.__cf.n >= 2, null, { timeout: 10000 }).catch(() => {});
      const after = await page.evaluate(() => window.__cf.n);
      check(after === 2, 'the deferred design builds once the canvas is free', `builds=${after}`);
      await releaseWhenReady(page, 2);
      await waitForHero(page, 2);
      const hero = await page.evaluate(() => window.__cf.heroIndex());
      check(hero === 2, 'the canvas ends on the newest design', `canvas shows build ${hero}`);
    }
    check(errors.length === 0, 'no page errors', errors.join(' | '));
    await ctx.close();
  }

  // 2. The encoder giving up (a real WebKit behaviour at these canvas sizes) must not strand
  //    the UI. Pre-fix this threw out of the toBlob callback and left "Generating" forever.
  {
    const { ctx, page, errors } = await open(browser);
    await releaseWhenReady(page, 1, true);
    await sleep(2500);
    const thrown = await page.evaluate(() => window.__cf.thrown);
    const label = await page.evaluate(() => window.__cf.generateLabel());
    check(thrown.length === 0, 'a null blob does not throw out of setImage', thrown.join(' | '));
    check(label === 'Generate', 'the controls come back after a failed build', `button reads "${label}"`);
    check(errors.length === 0, 'no page errors', errors.join(' | '));
    await ctx.close();
  }

  // 3. The ordinary path still works, from an idle canvas.
  {
    const { ctx, page, errors } = await open(browser);
    await releaseWhenReady(page, 1);
    await sleep(2500);
    const first = await page.evaluate(() => window.__cf.heroIndex());
    check(first === 1, 'first build paints', `canvas shows build ${first}`);
    await generateFromWidget(page);
    // Generate now puts its active state on screen before starting any work
    // (utils/afterFeedback), so this build begins a beat after the click -- releaseWhenReady
    // waits for it rather than assuming a fixed sleep covers it.
    await releaseWhenReady(page, 2);
    await waitForHero(page, 2);
    const second = await page.evaluate(() => window.__cf.heroIndex());
    check(second === 2, 'a generate from an idle canvas repaints', `canvas shows build ${second}`);
    check(errors.length === 0, 'no page errors', errors.join(' | '));
    await ctx.close();
  }

  await browser.close();

  if (failures.length) {
    console.log(`\n${failures.length} check(s) failed.`);
    process.exit(1);
  }
  console.log('\nAll checks passed.');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
