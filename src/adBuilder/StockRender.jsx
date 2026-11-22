import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import saveAs from 'file-saver';
import Button from '../components/ui/Button';
import { flightSceneDesign, renderFlightFrame } from './feedPost';
import ExportProgress from './ExportProgress';
import { renderStockJob, StockCancelled, MAX_RESETS } from './stockJob';
import StockQueue from './StockQueue';

// The Flight mode's stock-video master (animation3d/stockRender.js): the same flight, rendered
// offline at stock quality and written by ffmpeg as ProRes or 10-bit HEVC into .ads/stock. Silent:
// stock footage is bought without music. "Preview frame" renders the frame under the playhead at
// these settings beside the site's own render of it, so a setting can be judged before a long render.

const PREFS_KEY = 'cf-ads:stock';
const DEFAULTS = { res: '4k', fps: 30, trail: 'sharp', samples: 16, ss: 1, format: 'prores', nebulaPasses: 4 };
const TRAIL = { sharp: 3, even: 0 };
const MAX_BLUR = 1 / 90; // scene seconds: the longest exposure any frame gets (see stockRender)

function readPrefs() {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') };
  } catch {
    return DEFAULTS;
  }
}

function Choice({ value, options, onChange, label, disabled }) {
  return (
    <div className="flex flex-wrap gap-1" role="group" aria-label={label}>
      {options.map(([v, text]) => (
        <button
          key={String(v)}
          type="button"
          disabled={disabled}
          aria-pressed={value === v}
          onClick={() => onChange(v)}
          className={`rounded-md px-2 py-1 text-sm tabular-nums disabled:opacity-40 ${
            value === v ? 'bg-white/15 text-white' : 'text-neutral-400 hover:bg-white/5 hover:text-white'
          }`}
        >
          {text}
        </button>
      ))}
    </div>
  );
}

function Row({ label, children }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-neutral-400">{label}</span>
      {children}
    </div>
  );
}

const fmtTime = s => {
  s = Math.max(0, Math.round(s));
  const m = Math.floor(s / 60);
  return m ? `${m}m ${String(s % 60).padStart(2, '0')}s` : `${s}s`;
};

/**
 * @param {{ design: any, options: { seconds: number, ramp: boolean, objects: number },
 *   aspect: { width: number, height: number }, playhead: () => number, baseName: () => string,
 *   quality: { nebula: string, stars: string, blur: number }, disabled?: boolean,
 *   onBusyChange?: (busy: boolean) => void, designTitle?: string, exporting?: boolean }} props
 *   `quality`: the ad builder's Flight quality (flightQuality.js) -- nebula, stars and blur are set
 *   there, for every export; this panel adds what only the stock master has.
 *   `onBusyChange`: told when a render or preview starts and ends, so the page can freeze its live
 *   preview -- otherwise a second flight redraws on the same GPU, every frame, for the whole render.
 *   `designTitle`, `exporting`: for the queue below (a job's name; whether the page's own export bar
 *   is up, so the queue's stacks under it).
 */
export default function StockRender({
  design,
  options,
  aspect,
  playhead,
  baseName,
  quality,
  disabled = false,
  onBusyChange = null,
  designTitle,
  exporting = false
}) {
  const [prefs, setPrefs] = useState(readPrefs);
  const [job, setJob] = useState(null); // { phase, frame, total, started, file, bytes, error }
  const [preview, setPreview] = useState(null); // { stock, site, show, t }
  const cancelRef = useRef(false);
  useEffect(() => {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    } catch {
      /* fine */
    }
  }, [prefs]);
  // The preview's object URLs, released when it closes or is replaced (and on unmount)
  const previewRef = useRef(null);
  previewRef.current = preview;
  const release = p => {
    if (p) for (const u of [p.stock, p.site]) if (u) URL.revokeObjectURL(u);
  };
  useEffect(() => () => release(previewRef.current), []);
  const closePreview = () => {
    release(previewRef.current);
    setPreview(null);
  };
  const set = patch => setPrefs(p => ({ ...p, ...patch }));

  const short = prefs.res === '4k' ? 2160 : 1080;
  const landscape = aspect.width >= aspect.height;
  const ratio = landscape ? aspect.width / aspect.height : aspect.height / aspect.width;
  const long = Math.round((short * ratio) / 2) * 2;
  const width = landscape ? long : short;
  const height = landscape ? short : long;
  const busy = !!job && ['building', 'rendering', 'recovering', 'encoding', 'preview'].includes(job.phase);
  const busyRef = useRef(onBusyChange);
  busyRef.current = onBusyChange;
  useEffect(() => busyRef.current?.(busy), [busy]);
  useEffect(() => () => busyRef.current?.(false), []);
  // Leaving the page mid-render loses it (the frames live in this tab until ffmpeg has them)
  const rendering = !!job && ['building', 'rendering', 'recovering', 'encoding'].includes(job.phase);
  useEffect(() => {
    if (!rendering) return;
    const warn = e => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [rendering]);
  const frames = Math.round(options.seconds * prefs.fps);

  const stockOpts = () => ({
    width,
    height,
    seconds: options.seconds,
    ramp: options.ramp,
    fps: prefs.fps,
    nebula: quality.nebula,
    stars: quality.stars,
    samples: prefs.samples,
    shutter: Number(quality.blur) || 0,
    trail: TRAIL[prefs.trail],
    maxBlur: MAX_BLUR,
    ss: prefs.ss,
    // 'all': every moment marches (exact); a number: that many marches per frame, shared by the
    // moments around each (stockRender's NEBULA_PASSES, ~3x faster at 4 and measured invisible)
    nebulaPasses: prefs.nebulaPasses === 'all' ? Infinity : prefs.nebulaPasses
  });
  const sceneDesign = () => flightSceneDesign(design, options.objects);

  const runPreview = async () => {
    const t = Math.min(playhead(), options.seconds);
    setJob({ phase: 'preview' });
    let r = null;
    try {
      const { createStockRenderer } = await import('../animation3d/stockRender');
      r = await createStockRenderer(sceneDesign(), stockOpts());
      const c = r.frameCanvas(t);
      const stock = URL.createObjectURL(await new Promise(res => c.toBlob(res, 'image/png')));
      r.dispose();
      r = null;
      const site = URL.createObjectURL(await renderFlightFrame(design, options, t, width, height));
      release(previewRef.current);
      setPreview({ stock, site, show: 'stock', t });
      setJob(null);
    } catch (e) {
      console.error('[stock] preview failed', e);
      setJob({ phase: 'failed', error: e.message });
    } finally {
      r?.dispose();
    }
  };

  const runRender = async () => {
    cancelRef.current = false;
    const name = `${baseName()}-stock-${width}x${height}-${prefs.fps}fps-${Number(options.seconds.toFixed(2))}s`;
    setJob({ phase: 'building', frame: 0, total: frames, resets: 0 });
    try {
      const done = await renderStockJob({
        design,
        objects: options.objects,
        opts: stockOpts(),
        name,
        format: prefs.format,
        cancelled: () => cancelRef.current,
        onProgress: p => setJob(j => ({ ...j, ...p }))
      });
      setJob({ phase: 'done', file: done.file, bytes: done.bytes, total: done.frames, took: done.took, resets: done.resets });
    } catch (e) {
      if (e instanceof StockCancelled) setJob(null);
      else {
        console.error('[stock] render failed', e);
        setJob({ phase: 'failed', error: e.message });
      }
    }
  };

  const eta =
    job?.phase === 'rendering' && job.frame > 0
      ? ((performance.now() - job.started) / job.frame) * (job.total - job.frame) / 1000
      : null;
  const progressProps = () => {
    if (!job) return null;
    const resetNote = job.resets ? ` · recovered from ${job.resets} GPU reset${job.resets > 1 ? 's' : ''}` : '';
    switch (job.phase) {
      case 'building':
        return { label: 'Stock master · building the scene', progress: null, onAction: () => (cancelRef.current = true) };
      case 'rendering':
        return {
          label: `Stock master · ${width}×${height} ${prefs.fps}fps`,
          progress: job.frame / job.total,
          detail: `Frame ${job.frame} of ${job.total} · ${(job.drawTime / job.drawn / 1000).toFixed(2)}s a frame${
            eta !== null ? ` · about ${fmtTime(eta)} left` : ''
          }${resetNote}`,
          onAction: () => (cancelRef.current = true)
        };
      case 'recovering':
        return {
          label: 'Stock master · the GPU reset, rebuilding',
          tone: 'warn',
          progress: job.total ? job.frame / job.total : null,
          detail: `Redrawing frame ${job.frame + 1}; nothing from before the reset is kept (${job.resets} of ${MAX_RESETS})`,
          onAction: () => (cancelRef.current = true)
        };
      case 'encoding':
        return { label: 'Stock master · finishing the file', progress: null };
      case 'done':
        return {
          label: `Saved ${job.file.split('/').pop()}`,
          tone: 'done',
          progress: 1,
          detail: `${(job.bytes / 1e6).toFixed(0)} MB · ${job.total} frames in ${fmtTime(job.took)}${resetNote} · in .ads/stock`,
          onAction: () => setJob(null),
          actionLabel: 'Dismiss'
        };
      default:
        return null;
    }
  };
  const progress = progressProps();

  return (
    <div className="flex flex-col gap-2.5 text-sm">
      <p className="text-xs text-neutral-500">
        The flight with the Flight quality above, at stock size and frame rate, as a 10-bit master. Silent.
        Written by ffmpeg into .ads/stock. Nebula passes: how many of a frame&rsquo;s moments march the
        nebula, the slowest part; 4 is about three times faster than every moment and looks the same.
      </p>
      <Row label="Size">
        <Choice label="Size" value={prefs.res} disabled={busy} onChange={res => set({ res })} options={[['hd', 'HD'], ['4k', '4K']]} />
      </Row>
      <Row label="Frame rate">
        <Choice label="Frame rate" value={prefs.fps} disabled={busy} onChange={fps => set({ fps })} options={[24, 25, 30, 60].map(n => [n, String(n)])} />
      </Row>
      <Row label="Shutter">
        <Choice
          label="Shutter shape"
          value={prefs.trail}
          disabled={busy || !Number(quality.blur)}
          onChange={trail => set({ trail })}
          options={[['sharp', 'Sharp + trail'], ['even', 'Even']]}
        />
      </Row>
      <Row label="Samples">
        <Choice
          label="Moments per frame"
          value={prefs.samples}
          disabled={busy || !Number(quality.blur)}
          onChange={samples => set({ samples })}
          options={[8, 16, 32].map(n => [n, String(n)])}
        />
      </Row>
      <Row label="Nebula passes">
        <Choice
          label="Nebula marches per frame"
          value={prefs.nebulaPasses}
          disabled={busy || !Number(quality.blur)}
          onChange={nebulaPasses => set({ nebulaPasses })}
          options={[[4, '4'], ['all', 'Every moment']]}
        />
      </Row>
      <Row label="Supersample">
        <Choice
          label="Supersampling"
          value={prefs.ss}
          disabled={busy}
          onChange={ss => set({ ss })}
          options={[[1, '1×'], [2, '2×']]}
        />
      </Row>
      <Row label="Format">
        <Choice
          label="File format"
          value={prefs.format}
          disabled={busy}
          onChange={format => set({ format })}
          options={[['prores', 'ProRes 422 HQ'], ['hevc', 'HEVC 10-bit'], ['dxv', 'DXV (Resolume)']]}
        />
      </Row>
      <div className="mt-1 flex flex-wrap items-center gap-2">
        <Button size="sm" variant="ghost" disabled={disabled || busy} onClick={runPreview}>
          Preview frame
        </Button>
        {job?.phase === 'rendering' || job?.phase === 'building' || job?.phase === 'recovering' ? (
          <Button size="sm" variant="ghost" onClick={() => (cancelRef.current = true)}>
            Cancel
          </Button>
        ) : (
          <Button size="sm" disabled={disabled || busy} onClick={runRender}>
            Render master
          </Button>
        )}
        <span className="text-xs tabular-nums text-neutral-500">
          {width}×{height} · {frames} frames
        </span>
      </div>
      {job && (
        <p className="text-xs tabular-nums text-neutral-400">
          {job.phase === 'preview' && 'Rendering the frame under the playhead…'}
          {job.phase === 'building' && 'Building the scene…'}
          {job.phase === 'recovering' && 'The GPU reset; rebuilding and redrawing…'}
          {job.phase === 'rendering' &&
            `Frame ${job.frame} of ${job.total}${eta !== null ? ` · about ${fmtTime(eta)} left` : ''}`}
          {job.phase === 'encoding' && 'Finishing the file…'}
          {job.phase === 'done' &&
            `Saved ${job.file} (${(job.bytes / 1e6).toFixed(0)} MB, ${job.total} frames in ${fmtTime(job.took)})`}
          {job.phase === 'failed' && `Failed: ${job.error}`}
        </p>
      )}
      {progress && <ExportProgress {...progress} />}
      <h3 className="mt-3 border-t border-white/10 pt-3 text-xs font-semibold uppercase tracking-[0.15em] text-neutral-400">Queue</h3>
      <StockQueue
        design={design}
        designTitle={designTitle}
        options={options}
        width={width}
        height={height}
        stockOpts={stockOpts}
        otherProgress={!!progress || exporting}
        disabled={disabled}
      />
      {preview &&
        createPortal(
          <div className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-3 bg-black/90 p-6" role="dialog" aria-label="Stock frame preview">
            <img
              src={preview.show === 'stock' ? preview.stock : preview.site}
              alt=""
              className="max-h-[calc(100vh-7rem)] max-w-full object-contain"
            />
            <div className="flex items-center gap-3 text-sm">
              <Choice
                label="Which render"
                value={preview.show}
                onChange={show => setPreview(p => ({ ...p, show }))}
                options={[['stock', 'Stock'], ['site', 'Site']]}
              />
              <span className="text-xs tabular-nums text-neutral-500">
                {width}×{height} at {preview.t.toFixed(2)}s
              </span>
              <Button size="sm" variant="ghost" onClick={() => saveAs(preview.show === 'stock' ? preview.stock : preview.site, `${baseName()}-${preview.show}-${preview.t.toFixed(2)}s.${preview.show === 'stock' ? 'png' : 'jpg'}`)}>
                Save
              </Button>
              <Button size="sm" onClick={closePreview}>
                Close
              </Button>
            </div>
          </div>,
          document.body
        )}
    </div>
  );
}
