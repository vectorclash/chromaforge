/*
 * Loads every route of the real production build in a real browser and fails on anything the
 * page itself reports as broken: an uncaught error, a console error, a failed same-origin
 * request, or the ErrorBoundary's own fallback text.
 *
 * WHY THIS EXISTS (2026-09-05, Aaron: "I'm getting the something went wrong error when viewing
 * products... maybe we need to make sure nothing is broken rather than just seeing a build go
 * through without error"). A clean `npm run build` proves the modules PARSE and resolve. It
 * cannot see anything that only happens when a component actually runs -- and the bug that
 * prompted this was exactly that class: a `useRef` added below ProductPage's `if (loading)`
 * early return, so the loading render ran fewer hooks than the loaded one and React tore the
 * tree down on the second render of EVERY product page. Zero build output, every product
 * broken. Route-level rules of the same shape (a hook after an early return, a stale prop name,
 * a null deref during a loading phase) are the recurring failure mode here, and they are all
 * visible within a second of loading the page.
 *
 * WHAT IT DOES NOT COVER, deliberately: anything behind sign-in, and anything that costs money
 * or quota -- it never generates a mockup or touches checkout. It is a "does this page stand
 * up" check, not a feature test. Product detail DOES hit the live printful-catalog edge
 * function (read-only, free), which is also why a network failure there is reported separately
 * from a code failure rather than being counted as a broken page.
 *
 * Usage:  node scripts/check-routes-smoke.mjs [--keep-server] [--url http://localhost:4173]
 * Builds and serves dist/ itself unless --url is given. Exit 0 = every route clean.
 */
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const args = process.argv.slice(2);
const urlArg = args.includes('--url') ? args[args.indexOf('--url') + 1] : null;
const PORT = 4173;

// The production build, not the dev server: dev's StrictMode double-mounts components, which
// both hides ordering bugs (a second mount can paper over the first) and invents warnings that
// have nothing to do with what a visitor sees.
const ROUTES = [
  { path: '/', name: 'home' },
  { path: '/shop', name: 'shop' },
  // Three products spanning the config shapes that make ProductPage branch: a plain t-shirt, a
  // two-leg product (leg wrap, hidden geometry row), and the reversible hat (secondary design).
  { path: '/shop/257', name: 'product (t-shirt)' },
  { path: '/shop/693', name: 'product (mesh shorts)' },
  { path: '/shop/654', name: 'product (bucket hat)' },
  { path: '/gallery', name: 'gallery' },
  { path: '/account', name: 'account (signed out)' },
  { path: '/terms', name: 'terms' },
  { path: '/privacy', name: 'privacy' },
  { path: '/no-such-page', name: '404' }
];

// React's own message for the failure this check was written after, plus the boundary text a
// visitor actually sees.
const FATAL_PAGE_TEXT = ['Something went wrong', 'Rendered more hooks', 'Rendered fewer hooks'];

/*
 * Console output from a third party that is noise by design, not a symptom. Keep this list
 * tiny and keyed on an exact shape -- a broad pattern here turns the whole check into a
 * rubber stamp, which is the one way it can be worse than useless.
 *
 * The only entry today is Cloudflare Turnstile's, on /account: its widget script logs a
 * `%c%d`-formatted line styled `font-size:0;color:transparent` (i.e. deliberately invisible in
 * a real console) whose substitutions resolve to NaN. Confirmed as theirs rather than assumed --
 * the page's only non-local hosts are challenges.cloudflare.com and hagen.challenges.
 * cloudflare.com, and the sign-in form renders complete underneath it.
 */
const IGNORED_CONSOLE = [/font-size:0;color:transparent/];

const run = (cmd, cmdArgs, opts = {}) =>
  new Promise((resolve, reject) => {
    const p = spawn(cmd, cmdArgs, { stdio: 'inherit', ...opts });
    p.on('exit', code => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))));
  });

const waitFor = async url => {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error(`server never became ready at ${url}`);
};

const main = async () => {
  let server = null;
  let base = urlArg;

  if (!base) {
    console.log('Building...');
    await run('npm', ['run', 'build']);
    server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], {
      stdio: 'ignore'
    });
    base = `http://localhost:${PORT}`;
    await waitFor(base);
  }

  const browser = await chromium.launch();
  const results = [];

  for (const route of ROUTES) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const consoleErrors = [];
    const pageErrors = [];
    const failedRequests = [];

    page.on('console', m => {
      if (m.type() !== 'error') return;
      const text = m.text();
      if (IGNORED_CONSOLE.some(re => re.test(text))) return;
      consoleErrors.push(text);
    });
    page.on('pageerror', e => pageErrors.push(String(e)));
    page.on('requestfailed', r => {
      if (r.url().startsWith(base)) failedRequests.push(`${r.url()} (${r.failure()?.errorText})`);
    });
    page.on('response', r => {
      if (r.url().startsWith(base) && r.status() >= 400 && !route.path.startsWith('/no-such')) {
        failedRequests.push(`${r.url()} -> ${r.status()}`);
      }
    });

    await page.goto(base + route.path, { waitUntil: 'networkidle' }).catch(() => {});
    // Long enough for a lazy route chunk, the catalog fetch and any settle-then-crash render.
    await page.waitForTimeout(2500);

    const body = await page.evaluate(() => document.body.innerText).catch(() => '');
    const fatalText = FATAL_PAGE_TEXT.filter(t => body.includes(t));
    // A route that renders nothing at all is broken too, whatever the console says.
    const empty = body.trim().length < 40;

    results.push({
      ...route,
      consoleErrors,
      pageErrors,
      failedRequests,
      fatalText,
      empty,
      chars: body.trim().length
    });
    await page.close();
  }

  await browser.close();
  if (server && !args.includes('--keep-server')) server.kill();

  let failures = 0;
  console.log('');
  for (const r of results) {
    const bad =
      r.pageErrors.length + r.consoleErrors.length + r.fatalText.length + (r.empty ? 1 : 0);
    const netOnly = r.failedRequests.length && !bad;
    if (bad) failures++;
    console.log(
      `${bad ? 'FAIL' : netOnly ? 'warn' : ' ok '}  ${r.path.padEnd(16)} ${r.name.padEnd(22)} ${r.chars} chars rendered`
    );
    for (const t of r.fatalText) console.log(`        error-boundary text: "${t}"`);
    if (r.empty) console.log('        rendered essentially nothing');
    for (const e of r.pageErrors) console.log(`        uncaught: ${e.split('\n')[0]}`);
    for (const e of r.consoleErrors.slice(0, 4)) console.log(`        console: ${e.split('\n')[0]}`);
    // Network trouble is reported but never fails the run: these routes call live Supabase and
    // Printful, so a flaky remote would otherwise make this check untrustworthy noise.
    for (const e of r.failedRequests.slice(0, 3)) console.log(`        request: ${e}`);
  }

  console.log(`\n${results.length - failures}/${results.length} routes clean`);
  process.exit(failures ? 1 : 0);
};

main().catch(err => {
  console.error(err);
  process.exit(1);
});
