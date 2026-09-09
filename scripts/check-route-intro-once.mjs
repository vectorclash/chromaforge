/*
 * Counts how many times the site plays an entrance animation, across every route and every
 * navigation shape, and fails if any surface enters more than once.
 *
 * WHY (2026-09-09, Aaron: on a product page's first load "I see the skeleton content animate
 * twice as it loads in... it doesn't seem to happen again when returning to the same page").
 * The product route mounts ProductPageSkeleton up to three separate times on a cold load --
 * the Suspense fallback, the page's own `loading` render, and the copy inside SkeletonFadeOut
 * -- and a fresh mount replays `.intro-stagger`. Only the first load has the fallback phase,
 * which is exactly why it stopped reproducing on a return visit.
 *
 * TWO DETECTORS, because one alone cannot see both halves of this:
 *
 *   1. CASCADE ROOTS. `.intro-stagger` is applied per container, so one container that
 *      animated is ONE entrance however many sections it staggers. Counting animationstart
 *      events instead would just measure section count, and the number would move whenever a
 *      page gained a section. This is what catches a remount: a replacement is a different
 *      node, so per-node counting is blind to it.
 *   2. PER-NODE REPEATS. The same element running the same entrance animation twice -- a
 *      persistent surface being re-triggered, which a root count cannot see because both runs
 *      share one root. This is also how the two-owners-of-opacity class of bug shows up (see
 *      ProductPage's hero note in CLAUDE.md).
 *
 * The cold-load pass has to DELAY each route's chunk: on a warm local server the Suspense
 * fallback may never paint, and the bug this was written for only exists on a load that has
 * one. The navigation pass then covers what a cold load cannot see at all -- client-side
 * route changes, back/forward, mobile, and the modals.
 *
 * Usage:  node scripts/check-route-intro-once.mjs [--url http://localhost:4173]
 *         node scripts/check-route-intro-once.mjs --signed-in --email aaron@vectorclash.com
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { chromium } from 'playwright';

const args = process.argv.slice(2);
const urlArg = args.includes('--url') ? args[args.indexOf('--url') + 1] : null;
// Off by default: it needs the service-role key, and most runs of this check are about the
// public routes. Requires --email naming an EXISTING account; see signedInPass and the guard
// in mintSession for why it must never be allowed to guess.
const signedIn = args.includes('--signed-in');
// Skip the public phases. Only for iterating on the signed-in pass itself -- a real run wants
// both, since the public routes are where most of the surfaces are.
const onlySignedIn = args.includes('--only-signed-in');
const emailArg = args.includes('--email') ? args[args.indexOf('--email') + 1] : null;
const PORT = 4176;
const CHUNK_DELAY_MS = 600;

// Every keyframe name the site uses as an ENTRANCE. Deliberately not `animate-pulse` (a
// skeleton's own infinite shimmer) or the GSAP-driven work, which sets inline styles rather
// than running CSS animations.
const ENTRANCE = [
  'resolve-in',
  'resolve-flat',
  'fade-slide-up',
  'fade-in',
  'pop-in',
  'reveal-quick',
  'iris-in',
  'bloom-in',
  'expand-in',
  'slide-in-left',
  'slide-in-right',
  'toast-in'
];

/*
 * `roots` is how many cascades one load may play.
 *
 * TWO is correct for the product route and is not a defect: its skeleton is unlabelled
 * placeholder bars, so the real page arriving IS new content and must enter. Shop and gallery
 * are ONE, because their skeleton renders the real header and the handover is invisible.
 *
 * TWO is also correct for the legal pages, for an unrelated reason: they NEST the mechanism
 * (their section list is `intro-skip intro-stagger`, so it opts out of being one item in the
 * page's cascade and becomes a container in its own right). Both roots start in the same
 * frame -- they are one motion, not two entrances.
 */
const ROUTES = [
  { path: '/', name: 'home', roots: 1 },
  { path: '/shop', name: 'shop', roots: 1 },
  { path: '/shop/257', name: 'product (t-shirt)', roots: 2 },
  { path: '/shop/693', name: 'product (mesh shorts)', roots: 2 },
  { path: '/shop/654', name: 'product (bucket hat)', roots: 2 },
  { path: '/gallery', name: 'gallery', roots: 1 },
  { path: '/account', name: 'account (signed out)', roots: 1 },
  { path: '/terms', name: 'terms (nested)', roots: 2 },
  { path: '/privacy', name: 'privacy (nested)', roots: 2 },
  { path: '/checkout/success', name: 'checkout success', roots: 1 },
  { path: '/no-such-page', name: '404', roots: 1 }
];

// Installed before any of the app's own script runs, so the Suspense fallback's own entrance
// is caught -- it is over within a few hundred ms of the first paint.
const recorder = names => {
  window.__rec = [];
  window.__n = 0;
  addEventListener(
    'animationstart',
    e => {
      if (!names.includes(e.animationName)) return;
      const el = e.target;
      if (!el.dataset.introId) el.dataset.introId = String(++window.__n);
      const root = el.closest('.intro-stagger');
      if (root && !root.dataset.introRoot) root.dataset.introRoot = 'R' + ++window.__n;
      window.__rec.push({
        name: e.animationName,
        id: el.dataset.introId,
        root: root ? root.dataset.introRoot : null,
        at: Math.round(performance.now()),
        txt: (el.textContent || '').trim().slice(0, 30).replace(/\s+/g, ' ')
      });
    },
    true
  );
  window.__take = () => {
    const rec = window.__rec;
    window.__rec = [];
    const seen = new Map();
    for (const r of rec) {
      const k = r.name + '#' + r.id;
      seen.set(k, (seen.get(k) || 0) + 1);
    }
    const repeats = [];
    for (const [k, n] of seen) {
      if (n < 2) continue;
      const first = rec.find(r => r.name + '#' + r.id === k);
      repeats.push(`${first.name} x${n} "${first.txt}"`);
    }
    return {
      starts: rec.length,
      roots: new Set(rec.filter(r => r.root).map(r => r.root)).size,
      repeats
    };
  };
};

const run = (cmd, cmdArgs, opts = {}) =>
  new Promise((resolve, reject) => {
    const p = spawn(cmd, cmdArgs, { stdio: 'inherit', ...opts });
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

const failures = [];

/*
 * `min` guards against a VACUOUS PASS. Every one of these routes animates something, so zero
 * starts means the page never rendered -- and without this the whole check reported 11/11 ok
 * against a server that was refusing connections. A checker that passes when nothing loads is
 * worse than no checker. Only cold route loads set it: an overlay close or an idle window is
 * legitimately zero.
 */
const report = (label, got, maxRoots, min = 0) => {
  const bad = [];
  if (maxRoots !== null && got.roots > maxRoots) bad.push(`${got.roots} cascades, max ${maxRoots}`);
  if (got.repeats.length) bad.push(`repeated: ${got.repeats.join('; ')}`);
  if (got.starts < min)
    bad.push(`${got.starts} starts, expected at least ${min} -- did the page render?`);
  const rootText = maxRoots === null ? `${got.roots}` : `${got.roots}/${maxRoots}`;
  console.log(
    `  ${bad.length ? 'FAIL' : 'ok  '}  ${label.padEnd(30)} ${String(got.starts).padStart(3)} starts, ${rootText} cascade(s)` +
      (bad.length ? `  <- ${bad.join(' | ')}` : '')
  );
  if (bad.length) failures.push(`${label}: ${bad.join(' | ')}`);
};

/*
 * THE SIGNED-IN SURFACES, which the pass above cannot reach at all (`--signed-in`).
 *
 * Worth covering because the one bug of this exact class already found by hand lives here:
 * AccountPage's banners appear BETWEEN cascade items, and changing `animation-delay` --
 * which comes from `:nth-child` -- RESTARTS an animation, so submitting the sign-in form
 * replayed the entrance of everything below the banner. The signed-in account page is also
 * the densest late-arriving content in the app: three `introStyle` cards, two OrderLists with
 * staggered rows and their settle-then-allow-scroll logic, and an avatar that uploads after
 * mount. Late state is exactly what retriggers a cascade.
 *
 * HOW IT AUTHENTICATES, and why not with a password: Turnstile is enforced on every
 * password-based auth call (sign-in included), so a scripted sign-in cannot pass. Instead the
 * service-role key mints a magic-link OTP admin-side and the browser redeems it through the
 * app's OWN redirect path -- tokens in the URL hash, consumed by supabase-js exactly as a real
 * emailed link would be. No password, no CAPTCHA, and no credential stored in the repo.
 *
 * NOTE `email_otp`, not `hashed_token`: GoTrue's /verify rejects the hashed token from
 * generate_link with `otp_expired` immediately, while the OTP from the same response works.
 *
 * IT IS STRICTLY READ-ONLY, deliberately, because it runs against a REAL account with real
 * orders: it loads pages, switches tabs and opens overlays, and touches no control that
 * saves, deletes, signs out or buys. Loading /account is only read-only for a profile that
 * already HAS an avatar -- AccountPage generates and uploads one for any profile with none.
 *
 * TWO PATHS IT CANNOT REACH, and the reason is DATA rather than code: an account with no
 * saved designs shows My designs' empty state instead of a card grid, and an account with no
 * orders shows "No orders in progress" instead of OrderList's staggered rows. Both were empty
 * on the account this was first run against, so neither the grid append nor the row stagger
 * has been exercised here. Re-run with `--email` against an account that has one of each if
 * either is ever touched -- and note a low `starts` number on those two lines means the
 * fixture is empty, not that the surface is silent.
 */
const readEnvLocal = () =>
  Object.fromEntries(
    fs
      .readFileSync('.env.local', 'utf8')
      .split('\n')
      .filter(l => l.includes('=') && !l.trim().startsWith('#'))
      .map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()])
  );

const mintSession = async email => {
  const env = readEnvLocal();
  const {
    VITE_SUPABASE_URL: url,
    SUPABASE_SERVICE_ROLE_KEY: sr,
    VITE_SUPABASE_ANON_KEY: anon
  } = env;
  if (!url || !sr || !anon)
    throw new Error(
      '.env.local needs VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY'
    );

  /*
   * REFUSE TO RUN AGAINST AN EMAIL THAT DOES NOT ALREADY EXIST. This is not a convenience
   * check -- `generate_link` with type `magiclink` SILENTLY CREATES the user if the address is
   * unknown, and the signup trigger then makes it a profile, and AccountPage generates and
   * uploads an avatar for it. That is exactly what happened the first time this ran
   * (2026-09-09): it was pointed at an address that looked like the owner's but was not the
   * app account, conjured an empty account, and reported "0 saved designs, no orders" as a
   * coverage limitation rather than as the contradiction it was. The phantom account and its
   * avatar had to be deleted afterwards.
   *
   * The tell to trust next time: an account that renders EMPTY EVERYWHERE is far more likely
   * to be the wrong account than a real fixture gap.
   */
  const list = await fetch(`${url}/auth/v1/admin/users?per_page=200`, {
    headers: { apikey: sr, Authorization: `Bearer ${sr}` }
  });
  const known = ((await list.json()).users || []).map(u => u.email);
  if (!known.includes(email)) {
    throw new Error(
      `refusing to sign in as "${email}": no such account, and generate_link would CREATE one.\n` +
        `  existing accounts: ${known.join(', ')}`
    );
  }

  const gen = await fetch(`${url}/auth/v1/admin/generate_link`, {
    method: 'POST',
    headers: { apikey: sr, Authorization: `Bearer ${sr}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'magiclink', email })
  });
  const link = await gen.json();
  const otp = link.email_otp || link.properties?.email_otp;
  if (!otp) throw new Error(`generate_link failed: ${JSON.stringify(link).slice(0, 200)}`);
  const ver = await fetch(`${url}/auth/v1/verify`, {
    method: 'POST',
    headers: { apikey: anon, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'magiclink', email, token: otp })
  });
  const session = await ver.json();
  if (!session.access_token)
    throw new Error(`verify failed: ${JSON.stringify(session).slice(0, 200)}`);
  return session;
};

const signedInPass = async (browser, base) => {
  // No default: the account has to be named. Guessing it is how this created a phantom user
  // the first time -- see mintSession's guard.
  const email = emailArg;
  if (!email) throw new Error('--signed-in needs --email <address of an EXISTING account>');
  console.log(`\nSigned in as ${email} (read-only)`);
  const session = await mintSession(email);

  // ONE context, so the session in localStorage is shared by every page below. Playwright's
  // browser.newPage() makes a fresh context each time, which would sign us out per page.
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.addInitScript(recorder, ENTRANCE);
  await ctx.route('**/assets/*.js', async r => {
    if (/Page|Shop|Gallery|Account|Terms|Privacy|Checkout|NotFound/.test(r.request().url())) {
      await new Promise(res => setTimeout(res, CHUNK_DELAY_MS));
    }
    await r.continue();
  });

  // Redeem through the app's own redirect path rather than writing supabase-js's storage key
  // by hand -- the on-disk format is the library's business and has changed between versions.
  const hash =
    `#access_token=${session.access_token}&refresh_token=${session.refresh_token}` +
    `&expires_in=${session.expires_in}&token_type=bearer&type=magiclink`;
  let page = await ctx.newPage();
  await page.goto(base + '/' + hash, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);
  const who = await page.evaluate(() =>
    [...document.querySelectorAll('header a, header button')]
      .map(e => e.textContent.trim())
      .join('|')
  );
  if (!/Account/i.test(who)) throw new Error(`session did not take; header reads "${who}"`);
  await page.close();

  const load = async (path, label, roots, settle = 5000) => {
    const p = await ctx.newPage();
    await p.goto(base + path, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await p.waitForTimeout(settle);
    report(label, await p.evaluate(() => window.__take()), roots, 1);
    return p;
  };

  // The account page's own cold load, then a SECOND window with nothing happening: the orders
  // and the avatar arrive after mount, and a late arrival that shifts :nth-child would replay
  // the cascade in that window rather than the first one.
  const acct = await load('/account', 'account (cold)', 1);
  await acct.waitForTimeout(3000);
  report('account (settling, 3s idle)', await acct.evaluate(() => window.__take()), 0);
  /*
   * OrderList's ROW STAGGER, which the Active tab usually cannot show -- an account with
   * nothing in production renders "No orders in progress" instead. The rows are also the one
   * place with settle-then-allow-scroll logic reading `getAnimations()`, so they get their own
   * idle window: a re-trigger there would land after the stagger, not during it.
   */
  await acct.evaluate(() => (window.__rec = []));
  const hist = acct.locator('button', { hasText: /Order history/i }).first();
  if (await hist.count()) {
    await hist.click();
    await acct.waitForTimeout(3500);
    report('account -> Order history', await acct.evaluate(() => window.__take()), 1, 1);
    await acct.waitForTimeout(2500);
    report('order rows (settling, 2.5s idle)', await acct.evaluate(() => window.__take()), 0);
  } else {
    console.log('  --    account -> Order history      no such tab (skipped)');
  }
  await acct.close();

  const gal = await load('/gallery', 'gallery (cold)', 1);
  const tab = re => async () => {
    const b = gal.locator('button', { hasText: re }).first();
    if (await b.count()) await b.click();
    else throw new Error('tab not found: ' + re);
  };
  await gal.evaluate(() => (window.__rec = []));
  await tab(/My designs/i)();
  await gal.waitForTimeout(3000);
  report('gallery -> My designs', await gal.evaluate(() => window.__take()), 1);
  await gal.evaluate(() => (window.__rec = []));
  await tab(/^Public/i)();
  await gal.waitForTimeout(3000);
  report('gallery -> Public', await gal.evaluate(() => window.__take()), 1);
  await gal.close();

  const prod = await load('/shop/257', 'product (cold, signed in)', 2);
  await prod.evaluate(() => (window.__rec = []));
  const pick = prod.locator('button', { hasText: /Choose|Browse|Pick/i }).first();
  if (await pick.count()) await pick.click();
  await prod.waitForTimeout(3000);
  report('artwork picker (saved designs)', await prod.evaluate(() => window.__take()), null);
  await prod.close();

  await ctx.close();
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
  const newPage = async (opts = {}) => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, ...opts });
    await page.addInitScript(recorder, ENTRANCE);
    // Force the Suspense fallback to actually paint. Without this a warm local server hands
    // the chunk over in a few ms and the phase the bug lives in never happens.
    await page.route('**/assets/*.js', async r => {
      if (/Page|Shop|Gallery|Account|Terms|Privacy|Checkout|NotFound/.test(r.request().url())) {
        await new Promise(res => setTimeout(res, CHUNK_DELAY_MS));
      }
      await r.continue();
    });
    return page;
  };
  const phase = async (page, label, fn, opts = {}) => {
    await page.evaluate(() => (window.__rec = []));
    await fn();
    await page.waitForTimeout(opts.wait ?? 2500);
    report(label, await page.evaluate(() => window.__take()), opts.roots ?? null);
  };

  if (!onlySignedIn) {
    console.log('\nCold loads (route chunk delayed, so the Suspense fallback really paints)');
    for (const route of ROUTES) {
      const page = await newPage();
      await page.goto(base + route.path, { waitUntil: 'domcontentloaded' }).catch(() => {});
      await page.waitForTimeout(4500);
      report(route.name, await page.evaluate(() => window.__take()), route.roots, 1);
      await page.close();
    }

    console.log('\nClient-side navigation (no reload -- a different mount path from the above)');
    {
      const page = await newPage();
      await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(4000);
      await phase(page, 'home -> shop', () => page.click('a[href="/shop"]'), { roots: 1 });
      await phase(page, 'shop -> product', () => page.click('main a[href^="/shop/"]'), {
        roots: 2,
        wait: 3500
      });
      // Back into an already-downloaded chunk: no fallback phase at all, which is the case that
      // masked the original bug.
      await phase(page, 'back -> shop (warm)', () => page.goBack(), { roots: 1 });
      await phase(page, 'shop -> product (warm)', () => page.click('main a[href^="/shop/"]'), {
        roots: 1,
        wait: 3500
      });
      await phase(page, 'product -> gallery', () => page.click('a[href="/gallery"]'), {
        roots: 1,
        wait: 3500
      });
      await phase(page, 'gallery -> terms', () => page.click('a[href="/terms"]'), { roots: 2 });
      await phase(page, 'terms -> account', () => page.click('a[href="/account"]'), { roots: 1 });
      await page.close();
    }

    console.log('\nOverlays and appended content (no cascade of their own -- repeats only)');
    {
      const page = await newPage();
      await page.goto(base + '/shop/257', { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(5000);
      const click = async re => {
        const b = page.locator('button', { hasText: re }).first();
        if (await b.count()) await b.click();
      };
      await phase(page, 'open size guide', () => click(/Size guide/i), { wait: 3000 });
      await phase(page, 'close size guide', () => page.keyboard.press('Escape'));
      await phase(page, 'expand print options', () => click(/Print options/i));
      await phase(page, 'open artwork picker', () => click(/Choose|Browse|Pick/i), { wait: 3000 });
      await phase(page, 'close artwork picker', () => page.keyboard.press('Escape'));
      await page.goto(base + '/gallery', { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(5000);
      await phase(
        page,
        'gallery card -> modal',
        () => page.locator('main .cf-card').first().click(),
        {
          wait: 3000
        }
      );
      await phase(page, 'close modal', () => page.keyboard.press('Escape'));
      await phase(
        page,
        'infinite scroll append',
        () => page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)),
        { wait: 4000 }
      );
      await page.close();
    }

    console.log('\nMobile 390x844');
    {
      const page = await newPage({
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true
      });
      await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(4500);
      await phase(page, 'open mobile nav', () => page.locator('header button').last().click());
      await phase(
        page,
        'mobile nav -> shop',
        () => page.locator('a[href="/shop"]').last().click(),
        {
          roots: 1
        }
      );
      await phase(
        page,
        'mobile shop -> product',
        () => page.locator('main a[href^="/shop/"]').first().click(),
        { roots: 2, wait: 3500 }
      );
      await page.close();
    }

    /*
     * A reduced-motion visitor must not be handed the same thing twice either. Note the counts
     * here are the SAME as above, not zero: tailwind.css collapses `animation-duration` to
     * 0.01ms rather than removing the animation, so every entrance still fires -- it just
     * finishes within a frame. Expecting zero here is wrong, and a first version of this check
     * asserted it and failed.
     */
    console.log('\nprefers-reduced-motion (same counts, 0.01ms durations)');
    {
      const page = await browser.newPage({
        viewport: { width: 1280, height: 900 },
        reducedMotion: 'reduce'
      });
      await page.addInitScript(recorder, ENTRANCE);
      for (const path of ['/', '/shop', '/shop/257', '/gallery']) {
        const expected = ROUTES.find(r => r.path === path).roots;
        await page.goto(base + path, { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(3500);
        report(`reduced motion ${path}`, await page.evaluate(() => window.__take()), expected, 1);
      }
      await page.close();
    }
  }

  if (signedIn) await signedInPass(browser, base);

  await browser.close();
  if (server) server.kill();

  if (failures.length) {
    console.error(`\n${failures.length} surface(s) entered more than once:`);
    failures.forEach(f => console.error('  - ' + f));
    process.exit(1);
  }
  console.log('\nEvery route, navigation and overlay entered exactly once.');
};

main().catch(e => {
  console.error(e);
  process.exit(1);
});
