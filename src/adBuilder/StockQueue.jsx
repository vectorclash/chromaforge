import React, { useCallback, useEffect, useRef, useState } from 'react';
import Button from '../components/ui/Button';
import { useStudio } from '../context/StudioContext';
import { randomSeed } from '../render/prng';
import { GEOMETRY_STYLES, resolveGeometryStyle, getGeometrySettings } from '../render/designSettings';
import { NEBULA_PIXELS_LITE } from '../render/nebula';
import { queueGet, queuePost } from './devApi';
import ExportProgress from './ExportProgress';

// The stock-render queue (2026-11-22, Aaron: VJ loop packs of 5-100 videos, for Envato VideoHive and
// Adobe Stock). Jobs are snapshots of the Flight mode as it stands when they are added -- design,
// length, ramp, objects, Flight quality and the Stock master settings -- so changing the panel
// afterwards never touches a queued loop. The dev server renders them in its own headless Chromium
// (scripts/ad-builder-queue.mjs), so a batch runs with this tab closed, and writes each pack into
// .ads/stock/<pack>/: a ProRes master per loop, plus the outputs ticked here, made from the master.

const PREFS_KEY = 'cf-ads:queue';
const DEFAULTS = { pack: 'Pack 01', mp4: true, dxv: false, count: 10, mixStyles: false };
const readPrefs = () => {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') };
  } catch {
    return DEFAULTS;
  }
};

// A design's concrete geometry style ('random' resolved from its seed, as the renderer does)
const styleOf = (seed, settings) => getGeometrySettings(resolveGeometryStyle(seed, settings)).style;

const fmtTime = s => {
  s = Math.max(0, Math.round(s));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h ? `${h}h ${String(m).padStart(2, '0')}m` : m ? `${m}m ${String(s % 60).padStart(2, '0')}s` : `${s}s`;
};
const blobToDataUrl = blob =>
  new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(fr.result);
    fr.onerror = rej;
    fr.readAsDataURL(blob);
  });

const STATUS = {
  waiting: 'Waiting',
  rendering: 'Rendering',
  converting: 'Converting',
  done: 'Done',
  failed: 'Failed'
};

/**
 * @param {{ design: any, designTitle?: string, options: { seconds: number, ramp: boolean, objects: number },
 *   width: number, height: number, stockOpts: () => any, otherProgress?: boolean, disabled?: boolean }} props
 *   `stockOpts`: the Stock master's renderer options as the panel stands (StockRender).
 *   `otherProgress`: another progress bar is showing, so this one stacks under it.
 */
export default function StockQueue({ design, designTitle, options, width, height, stockOpts, otherProgress = false, disabled = false }) {
  const { renderDesignBlob } = useStudio();
  const [prefs, setPrefs] = useState(readPrefs);
  const [q, setQ] = useState({ running: false, jobs: [], runner: null, runnerError: null });
  const [adding, setAdding] = useState(null); // null | { done, total }
  const [note, setNote] = useState(null);
  const set = patch => setPrefs(p => ({ ...p, ...patch }));
  useEffect(() => {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    } catch {
      /* fine */
    }
  }, [prefs]);

  // Polled: fast while something is under way, slowly otherwise (another tab may add jobs)
  const busy = q.running || q.jobs.some(j => j.status === 'rendering' || j.status === 'converting');
  const refresh = useCallback(() => queueGet().then(setQ).catch(() => {}), []);
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, busy ? 1000 : 5000);
    return () => clearInterval(t);
  }, [busy, refresh]);
  const act = async (action, body) => {
    try {
      const r = await queuePost(action, body);
      if (r.jobs) setQ(r);
      else refresh();
      return r;
    } catch (e) {
      setNote(e.message);
      return null;
    }
  };

  const thumbRef = useRef(renderDesignBlob);
  thumbRef.current = renderDesignBlob;
  const thumbFor = async d => {
    const tw = width >= height ? 160 : Math.round((160 * width) / height);
    const th = width >= height ? Math.round((160 * height) / width) : 160;
    try {
      const blob = await thumbRef.current(d, tw, th, { nebulaPixels: NEBULA_PIXELS_LITE });
      return blob ? await blobToDataUrl(blob) : null;
    } catch {
      return null;
    }
  };

  // A job from a design, snapshotting everything the panel says now
  const jobFor = async (d, title) => {
    const opts = stockOpts();
    // 'Every moment' is Infinity, which JSON cannot carry; any count past the samples means the same
    if (!Number.isFinite(opts.nebulaPasses)) opts.nebulaPasses = 1000;
    return {
      pack: prefs.pack.trim() || 'Pack',
      title,
      design: { seed: d.seed, colors: d.colors || [], settings: d.settings ?? null },
      options: { seconds: options.seconds, ramp: options.ramp, objects: options.objects },
      opts,
      width,
      height,
      outputs: { mp4: prefs.mp4, dxv: prefs.dxv },
      thumb: await thumbFor(d)
    };
  };

  const addThis = async () => {
    setNote(null);
    setAdding({ done: 0, total: 1 });
    await act('add', { jobs: [await jobFor(design, designTitle || design.seed)] });
    setAdding(null);
  };

  // N new designs in this one's palette and settings, each its own seed (one Generate each); with
  // "Mix styles", the geometry styles in turn starting from this design's own.
  const addVariations = async () => {
    setNote(null);
    const n = Math.max(1, Math.min(100, Math.round(prefs.count) || 1));
    const ownStyle = styleOf(design.seed, design.settings);
    const first = Math.max(0, GEOMETRY_STYLES.indexOf(ownStyle));
    const jobs = [];
    setAdding({ done: 0, total: n });
    for (let i = 0; i < n; i++) {
      const seed = randomSeed();
      let settings = design.settings ? JSON.parse(JSON.stringify(design.settings)) : null;
      if (prefs.mixStyles) {
        settings = settings ?? {};
        settings.geometry = { ...settings.geometry, style: GEOMETRY_STYLES[(first + i) % GEOMETRY_STYLES.length] };
      }
      jobs.push(await jobFor({ seed, colors: design.colors, settings }, seed));
      setAdding({ done: i + 1, total: n });
    }
    await act('add', { jobs });
    setAdding(null);
  };

  const preview = async pack => {
    setNote('Making the preview reel…');
    const r = await act('preview', { pack });
    if (r?.file) setNote(`Saved ${r.file} (${r.loops} loops)`);
  };

  // Packs in the order they first appear
  const packs = [];
  for (const j of q.jobs) {
    let p = packs.find(x => x.slug === j.packSlug);
    if (!p) packs.push((p = { slug: j.packSlug, name: j.pack, jobs: [] }));
    p.jobs.push(j);
  }

  // Progress over the whole queue, from frames: what is done, what is left, at the measured rate
  const current = q.jobs.find(j => j.status === 'rendering');
  const pending = q.jobs.filter(j => j.status === 'waiting' || j.status === 'rendering');
  const finished = q.jobs.filter(j => j.status === 'done' || j.status === 'converting');
  const rate = (() => {
    if (current?.renderStartedAt && current.frame > 1) return (Date.now() - current.renderStartedAt) / 1000 / current.frame;
    const last = [...finished].reverse().find(j => j.took);
    return last ? last.took / last.total : null;
  })();
  const framesLeft = pending.reduce((a, j) => a + (j.total - (j.status === 'rendering' ? j.frame : 0)), 0);
  const runTotal = pending.length + finished.length;
  const loopNo = finished.length + (current ? 1 : 0);
  const showBar = q.running || !!current;
  const eta = rate ? framesLeft * rate : null;

  return (
    <div className="flex flex-col gap-2.5 text-sm">
      <p className="text-xs text-neutral-500">
        Loops rendered one after another by the dev server, so this tab can close. Each loop is a ProRes master in
        .ads/stock/&lt;pack&gt;/, plus the outputs below. A loop is everything above as it stands when it is added.
      </p>
      <div className="flex items-center justify-between gap-3">
        <span className="text-neutral-400">Pack</span>
        <input
          type="text"
          value={prefs.pack}
          onChange={e => set({ pack: e.target.value })}
          className="min-w-0 flex-1 rounded-md border border-white/10 bg-white/5 px-2 py-1 text-sm text-white"
          aria-label="Pack name"
        />
      </div>
      <div className="flex items-center justify-between gap-3">
        <span className="text-neutral-400">Also make</span>
        <div className="flex gap-3">
          {[
            ['mp4', 'MP4 (H.264)'],
            ['dxv', 'DXV']
          ].map(([k, label]) => (
            <label key={k} className="flex items-center gap-1.5 text-neutral-300">
              <input type="checkbox" checked={prefs[k]} onChange={e => set({ [k]: e.target.checked })} />
              {label}
            </label>
          ))}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="ghost" disabled={disabled || !!adding} onClick={addThis}>
          Add this flight
        </Button>
        <Button size="sm" variant="ghost" disabled={disabled || !!adding} onClick={addVariations}>
          Add variations
        </Button>
        <input
          type="number"
          min="1"
          max="100"
          value={prefs.count}
          onChange={e => set({ count: Number(e.target.value) })}
          className="w-14 rounded-md border border-white/10 bg-white/5 px-2 py-1 text-sm tabular-nums text-white"
          aria-label="How many variations"
        />
        <label className="flex items-center gap-1.5 text-xs text-neutral-400" title="Each variation takes the next geometry style">
          <input type="checkbox" checked={prefs.mixStyles} onChange={e => set({ mixStyles: e.target.checked })} />
          Mix styles
        </label>
      </div>
      {adding && (
        <p className="text-xs tabular-nums text-neutral-400">
          Adding {adding.done} of {adding.total}…
        </p>
      )}

      {packs.map(p => {
        const done = p.jobs.filter(j => j.status === 'done').length;
        return (
          <div key={p.slug} className="mt-1 rounded-lg border border-white/10">
            <div className="flex items-center justify-between gap-2 border-b border-white/10 px-2.5 py-1.5">
              <span className="min-w-0 truncate text-white">{p.name}</span>
              <span className="flex shrink-0 items-center gap-1 text-xs tabular-nums text-neutral-500">
                {done}/{p.jobs.length}
                <button type="button" className="rounded px-1.5 py-0.5 hover:bg-white/10 hover:text-white disabled:opacity-40" disabled={!done} onClick={() => preview(p.slug)}>
                  Preview reel
                </button>
                <button type="button" className="rounded px-1.5 py-0.5 hover:bg-white/10 hover:text-white" onClick={() => act('reveal', { pack: p.slug })}>
                  Open folder
                </button>
              </span>
            </div>
            <ul className="max-h-80 divide-y divide-white/5 overflow-y-auto">
              {p.jobs.map(j => (
                <li key={j.id} className="flex items-center gap-2 px-2.5 py-1.5">
                  {j.thumb ? (
                    <img src={j.thumb} alt="" className="h-8 w-14 shrink-0 rounded object-cover" />
                  ) : (
                    <span className="h-8 w-14 shrink-0 rounded bg-white/5" />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-neutral-200">
                      <span className="tabular-nums text-neutral-500">{String(j.index).padStart(2, '0')}</span> {j.title}
                    </span>
                    <span className="block truncate text-xs tabular-nums text-neutral-500">
                      {styleOf(j.design.seed, j.design.settings)} · {Number(j.options.seconds.toFixed(2))}s ·{' '}
                      {j.opts.width}×{j.opts.height} {j.opts.fps}fps{j.options.ramp ? '' : ' · ramp off'}
                    </span>
                  </span>
                  <span
                    className={`shrink-0 text-xs tabular-nums ${j.status === 'failed' ? 'text-red-300' : j.status === 'done' ? 'text-neutral-300' : 'text-neutral-500'}`}
                    title={j.error || undefined}
                  >
                    {j.status === 'rendering' && j.phase === 'rendering'
                      ? `${Math.round((100 * j.frame) / j.total)}%`
                      : j.status === 'rendering' && j.phase === 'recovering'
                        ? 'GPU reset…'
                        : STATUS[j.status]}
                  </span>
                  <span className="flex shrink-0 text-neutral-500">
                    {j.status === 'failed' && (
                      <button type="button" className="rounded px-1 hover:text-white" title="Try again" onClick={() => act('retry', { id: j.id })}>
                        ↻
                      </button>
                    )}
                    {j.status === 'waiting' && (
                      <>
                        <button type="button" className="rounded px-1 hover:text-white" title="Earlier" onClick={() => act('move', { id: j.id, by: -1 })}>
                          ↑
                        </button>
                        <button type="button" className="rounded px-1 hover:text-white" title="Later" onClick={() => act('move', { id: j.id, by: 1 })}>
                          ↓
                        </button>
                      </>
                    )}
                    {j.status !== 'converting' && (
                      <button
                        type="button"
                        className="rounded px-1 hover:text-white"
                        title={j.status === 'rendering' ? 'Stop and remove' : j.status === 'done' ? 'Remove from the list (the files stay)' : 'Remove'}
                        onClick={() => act('remove', { id: j.id })}
                      >
                        ✕
                      </button>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        );
      })}

      {q.jobs.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          {q.running ? (
            <Button size="sm" variant="ghost" onClick={() => act('pause')}>
              Pause after this loop
            </Button>
          ) : (
            <Button size="sm" disabled={!q.jobs.some(j => j.status === 'waiting')} onClick={() => act('start')}>
              Start
            </Button>
          )}
          {q.jobs.some(j => j.status === 'done') && (
            <Button size="sm" variant="ghost" onClick={() => act('clear')}>
              Clear finished
            </Button>
          )}
          <span className="text-xs tabular-nums text-neutral-500">
            {pending.length} to render{eta !== null && pending.length ? ` · about ${fmtTime(eta)}` : ''}
            {!q.running && current ? ' · pausing after this loop' : ''}
          </span>
        </div>
      )}
      {(note || q.runnerError) && <p className="text-xs text-neutral-400">{q.runnerError ? `The runner could not start: ${q.runnerError}` : note}</p>}

      {showBar && (
        <ExportProgress
          stack={otherProgress ? 1 : 0}
          label={
            current
              ? `Queue · loop ${loopNo} of ${runTotal} · ${current.title}`
              : q.runner === 'starting' || !q.runner
                ? 'Queue · starting the renderer'
                : 'Queue · between loops'
          }
          tone={current?.phase === 'recovering' ? 'warn' : 'busy'}
          progress={
            current && runTotal
              ? (finished.reduce((a, j) => a + j.total, 0) + current.frame) / q.jobs.filter(j => j.status !== 'failed').reduce((a, j) => a + j.total, 0)
              : null
          }
          detail={
            current
              ? `${current.phase === 'recovering' ? 'GPU reset, redrawing · ' : ''}frame ${current.frame} of ${current.total}${
                  rate ? ` · ${rate.toFixed(2)}s a frame` : ''
                }${eta !== null ? ` · about ${fmtTime(eta)} left` : ''}${q.running ? '' : ' · pausing after this loop'}`
              : null
          }
          onAction={q.running ? () => act('pause') : null}
          actionLabel="Pause"
        />
      )}
    </div>
  );
}
