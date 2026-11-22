// The stock-render queue for the ad builder's Flight mode (src/adBuilder/StockQueue.jsx): packs of
// VJ / stock loops rendered one after another by a headless Chromium this dev server starts, so a
// batch runs with no browser tab open, nothing else on the GPU, and none of Safari's tab rules
// (Aaron, 2026-11-22: packs of 5-100 loops for Envato VideoHive and Adobe Stock).
//
// The queue lives in .ads/stock-queue.json, so it survives a reload or a dev-server restart. The
// runner page (stock-runner.html, src/adBuilder/stockRunner.js) claims one job at a time and renders
// it with the same code the panel's "Render now" uses (stockJob.js); every master is ProRes 422 HQ,
// written into .ads/stock/<pack>/, and the outputs each job asks for (H.264 MP4, DXV) are made from
// the master by ffmpeg afterwards -- seconds of CPU, beside the next loop's GPU render.
//
//   GET  /__ads/queue                    the queue: { running, jobs, runner }
//   POST /__ads/queue/add     { jobs }   appends jobs (the browser builds them; see StockQueue)
//   POST /__ads/queue/remove  { id }     removes a job (cancels it if it is rendering)
//   POST /__ads/queue/move    { id, by } moves a job up (-1) or down (+1)
//   POST /__ads/queue/retry   { id }     a failed job back to waiting
//   POST /__ads/queue/clear   {}         removes finished jobs from the list (files stay)
//   POST /__ads/queue/start   {}         starts the runner
//   POST /__ads/queue/pause   {}         stops after the loop being rendered
//   POST /__ads/queue/preview { pack }   one video of a pack's finished loops, for a store listing
//   POST /__ads/queue/reveal  { pack }   opens the pack's folder in Finder
// The runner's own:
//   POST /__ads/queue/claim | progress | finished | failed | idle
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promises as fs, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const SLUG = /^[a-z0-9][a-z0-9-]{0,47}$/;
const STALL_MS = 4 * 60 * 1000; // a runner that reports nothing for this long is restarted
const MAX_ATTEMPTS = 2; // a job that crashes the runner twice is marked failed

// The outputs a job can ask for, made from its ProRes master. Both convert from the master's
// BT.709 limited-range YUV.
const OUTPUTS = {
  // H.264 High, 8-bit 4:2:0: what VideoHive's VJ packs ship as, and fine for Adobe Stock
  mp4: {
    ext: '.mp4',
    args: [
      '-c:v', 'libx264', '-preset', 'slow', '-crf', '14', '-pix_fmt', 'yuv420p', '-profile:v', 'high',
      '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-color_range', 'tv',
      '-movflags', '+faststart'
    ]
  },
  // Resolume's codec (DXT1 only in ffmpeg: "Normal Quality", lossy, no alpha)
  dxv: {
    ext: '-dxv.mov',
    args: ['-vf', 'scale=in_color_matrix=bt709:in_range=tv', '-c:v', 'dxv', '-format', 'dxt1', '-pix_fmt', 'rgba']
  }
};

function ffmpeg(args) {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', d => (err = (err + d).slice(-2000)));
    p.on('error', reject);
    p.on('close', code => (code === 0 ? resolve() : reject(new Error(`ffmpeg failed (${code}): ${err}`))));
  });
}

export const packSlug = name =>
  String(name || 'pack')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'pack';

/**
 * @param {{ root: string, stockDir: string, port: () => number }} o
 *   `port`: the dev server's port, read when the runner starts (it is not known at plugin setup).
 */
export function createStockQueue({ root, stockDir, port }) {
  const file = path.join(root, '.ads', 'stock-queue.json');
  /** @type {{ running: boolean, jobs: any[] }} */
  let state = { running: false, jobs: [] };
  try {
    state = { running: false, ...JSON.parse(readFileSync(file, 'utf8')) };
  } catch {
    /* no queue yet */
  }
  // A restart interrupted whatever was under way: those renders start again from the beginning.
  for (const j of state.jobs) {
    if (j.status === 'rendering' || j.status === 'converting') Object.assign(j, { status: 'waiting', frame: 0, phase: null });
  }
  state.running = false;

  let saving = null;
  const save = () => {
    saving ??= new Promise(res =>
      setTimeout(async () => {
        saving = null;
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, JSON.stringify(state, null, 1));
        res();
      }, 200)
    );
    return saving;
  };
  const find = id => state.jobs.find(j => j.id === id);

  // ─── the runner: a headless Chromium on this machine's GPU ─────────────────────────────────
  let runner = null; // { browser, page, lastSeen }
  let launching = null;
  let runnerError = null;

  async function launch() {
    if (runner || launching) return launching;
    launching = (async () => {
      const { chromium } = await import('playwright');
      // ANGLE on Metal is what gives headless Chromium the real GPU on a Mac (the repo's timing checks
      // launch it the same way); elsewhere Chromium's own default.
      const args = ['--enable-gpu', ...(process.platform === 'darwin' ? ['--use-angle=metal'] : [])];
      const browser = await chromium.launch({ args });
      const page = await browser.newPage();
      const r = { browser, page, lastSeen: Date.now() };
      page.on('console', m => {
        const t = m.text();
        if (m.type() === 'error' || m.type() === 'warning' || t.startsWith('[stock')) console.log(`[stock runner] ${t}`);
      });
      page.on('pageerror', e => console.log(`[stock runner] ${e.message}`));
      page.on('crash', () => crashed('the render page crashed'));
      browser.on('disconnected', () => {
        if (runner !== r) return; // closed on purpose (stopRunner)
        runner = null;
        console.log('[stock queue] the render browser closed unexpectedly');
        requeueCurrent('the render browser closed');
        if (state.running) setTimeout(() => state.running && launch(), 2000);
      });
      runner = r;
      runnerError = null;
      await page.goto(`http://localhost:${port()}/stock-runner.html`);
    })();
    try {
      await launching;
    } catch (e) {
      runnerError = e.message;
      state.running = false;
      save();
      console.log(`[stock queue] could not start the runner: ${e.message}`);
      await runner?.browser.close().catch(() => {});
      runner = null;
    } finally {
      launching = null;
    }
  }

  async function stopRunner() {
    const r = runner;
    runner = null;
    await r?.browser.close().catch(() => {});
  }

  // The job being rendered goes back to waiting (or to failed after MAX_ATTEMPTS).
  function requeueCurrent(why) {
    const j = state.jobs.find(x => x.status === 'rendering');
    if (!j) return;
    j.attempts = (j.attempts || 0) + 1;
    if (j.attempts >= MAX_ATTEMPTS) Object.assign(j, { status: 'failed', error: why, phase: null });
    else Object.assign(j, { status: 'waiting', frame: 0, phase: null });
    save();
  }

  async function crashed(why) {
    console.log(`[stock queue] ${why}`);
    requeueCurrent(why);
    await stopRunner();
    if (state.running) setTimeout(() => state.running && launch(), 2000);
  }

  const watchdog = setInterval(() => {
    if (runner && state.jobs.some(j => j.status === 'rendering') && Date.now() - runner.lastSeen > STALL_MS) {
      crashed('the render stopped reporting progress');
    }
  }, 30 * 1000).unref();

  // ─── conversions from the master, one at a time ────────────────────────────────────────────
  let converting = Promise.resolve();
  function convert(j) {
    converting = converting.then(async () => {
      if (!find(j.id)) return; // removed meanwhile
      try {
        const master = path.join(root, j.files.master);
        const base = master.replace(/\.mov$/, '');
        for (const key of Object.keys(OUTPUTS)) {
          if (!j.outputs?.[key]) continue;
          const out = base + OUTPUTS[key].ext;
          await ffmpeg(['-i', master, ...OUTPUTS[key].args, out]);
          j.files[key] = path.relative(root, out);
        }
        Object.assign(j, { status: 'done', phase: null });
      } catch (e) {
        Object.assign(j, { status: 'failed', error: e.message, phase: null });
      }
      save();
    });
  }

  // ─── the API ───────────────────────────────────────────────────────────────────────────────
  const view = () => ({
    running: state.running,
    runner: runner ? 'up' : launching ? 'starting' : null,
    runnerError,
    jobs: state.jobs
  });

  return {
    view,

    add({ jobs }) {
      if (!Array.isArray(jobs) || !jobs.length || jobs.length > 500) throw new Error('No jobs');
      for (const raw of jobs) {
        const pack = String(raw.pack || 'Pack').slice(0, 80);
        const slug = packSlug(pack);
        const index = 1 + Math.max(0, ...state.jobs.filter(j => j.packSlug === slug).map(j => j.index));
        const w = Math.round(raw.width), h = Math.round(raw.height);
        if (!(w >= 16 && w <= 8192 && h >= 16 && h <= 8192)) throw new Error('Bad size');
        if (!raw.design?.seed) throw new Error('A job needs a design');
        state.jobs.push({
          id: randomBytes(6).toString('hex'),
          pack,
          packSlug: slug,
          index,
          title: String(raw.title || raw.design.seed).slice(0, 80),
          design: raw.design,
          options: raw.options,
          opts: { ...raw.opts, width: w, height: h },
          outputs: { mp4: !!raw.outputs?.mp4, dxv: !!raw.outputs?.dxv },
          thumb: typeof raw.thumb === 'string' && raw.thumb.startsWith('data:image/') && raw.thumb.length < 60000 ? raw.thumb : null,
          status: 'waiting',
          frame: 0,
          total: Math.round(raw.opts.seconds * raw.opts.fps),
          addedAt: Date.now()
        });
      }
      save();
      return view();
    },

    remove({ id }) {
      state.jobs = state.jobs.filter(j => j.id !== id); // a rendering job learns at its next progress report
      save();
      return view();
    },

    move({ id, by }) {
      const i = state.jobs.findIndex(j => j.id === id);
      const k = i + Math.sign(by);
      if (i >= 0 && k >= 0 && k < state.jobs.length) [state.jobs[i], state.jobs[k]] = [state.jobs[k], state.jobs[i]];
      save();
      return view();
    },

    retry({ id }) {
      const j = find(id);
      if (j && j.status === 'failed') Object.assign(j, { status: 'waiting', error: null, attempts: 0, frame: 0 });
      save();
      return view();
    },

    clear() {
      state.jobs = state.jobs.filter(j => j.status !== 'done');
      save();
      return view();
    },

    async start() {
      state.running = true;
      runnerError = null;
      save();
      if (!runner) launch(); // not awaited: the page polls
      return view();
    },

    pause() {
      state.running = false; // the runner finishes its loop, finds nothing to claim, and idles
      save();
      return view();
    },

    async preview({ pack }) {
      const done = state.jobs.filter(j => j.packSlug === pack && j.status === 'done').sort((a, b) => a.index - b.index);
      if (!done.length) throw new Error('No finished loops in this pack yet');
      const dir = path.join(stockDir, pack);
      const list = path.join(dir, '.preview-list.txt');
      await fs.writeFile(list, done.map(j => `file '${path.join(root, j.files.master).replace(/'/g, "'\\''")}'`).join('\n'));
      const out = path.join(dir, `${pack}-preview.mp4`);
      // every loop once, in order, at 1080p: a store listing's preview, not a deliverable
      await ffmpeg([
        '-f', 'concat', '-safe', '0', '-i', list,
        '-vf', 'scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2',
        '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
        out
      ]);
      await fs.rm(list, { force: true });
      return { file: path.relative(root, out), loops: done.length };
    },

    async reveal({ pack }) {
      if (!SLUG.test(String(pack))) throw new Error('Bad pack');
      const dir = path.join(stockDir, pack);
      if (!existsSync(dir)) throw new Error('Nothing rendered for this pack yet');
      spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [dir], { stdio: 'ignore', detached: true }).unref();
      return { ok: true };
    },

    // ─── runner side ─────────────────────────────────────────────────────────────────────────
    claim() {
      if (runner) runner.lastSeen = Date.now();
      if (!state.running) return { job: null };
      const j = state.jobs.find(x => x.status === 'waiting');
      if (!j) {
        state.running = false; // the queue is finished
        save();
        return { job: null };
      }
      Object.assign(j, { status: 'rendering', phase: 'building', frame: 0, startedAt: Date.now(), error: null });
      save();
      return {
        job: {
          id: j.id,
          design: j.design,
          objects: j.options.objects,
          opts: j.opts,
          name: `${j.packSlug}-${String(j.index).padStart(2, '0')}`,
          dir: j.packSlug,
          format: 'prores'
        }
      };
    },

    progress({ id, phase, frame, total, resets }) {
      if (runner) runner.lastSeen = Date.now();
      const j = find(id);
      if (!j || j.status !== 'rendering') return { cancel: true };
      Object.assign(j, { phase, frame, total, resets });
      if (phase === 'rendering' && frame === 1) j.renderStartedAt = Date.now();
      return { cancel: false };
    },

    finished({ id, file: master, took, resets }) {
      const j = find(id);
      if (!j) return { ok: true };
      Object.assign(j, { status: 'converting', phase: null, frame: j.total, took, resets, files: { master } });
      save();
      convert(j);
      return { ok: true };
    },

    failed({ id, error }) {
      const j = find(id);
      if (j && j.status === 'rendering') {
        if (error === 'cancelled') Object.assign(j, { status: 'waiting', frame: 0, phase: null });
        else Object.assign(j, { status: 'failed', error: String(error).slice(0, 500), phase: null });
        save();
      }
      return { ok: true };
    },

    async idle() {
      await stopRunner();
      return { ok: true };
    },

    // The dev server is closing (or Vite is restarting it): take the runner's browser down with it
    async shutdown() {
      clearInterval(watchdog);
      await stopRunner();
    }
  };
}
