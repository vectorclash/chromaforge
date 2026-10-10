import React, { useEffect, useMemo, useRef, useState } from 'react';
import saveAs from 'file-saver';
import { useAuth } from '../context/AuthContext';
import { useStudio } from '../context/StudioContext';
import { listMyDesigns, getDesign, getThumbnailUrl } from '../lib/designs';
import { listCatalogProducts, STARTER_PRODUCT_IDS } from '../lib/printful';
import { toCompactDesign, withCurrentGeneratorVersion } from '../render/compactDesign';
import { isSameDesign } from '../render/designSettings';
import { encodeMp4, exportBitrate } from '../lib/videoEncode';
import Button from '../components/ui/Button';
import Toggle from '../components/ui/Toggle';
import ProductSlot, { slotPhotos } from './ProductSlot';
import InstagramOverlay from './InstagramOverlay';
import DesignThumb from './DesignThumb';
import PostCopy from './PostCopy';
import { DEFAULT_POST } from './postText';
import { createAdComposer } from './adComposer';
import { adTimeline, segmentAt, AD_WIDTH, AD_HEIGHT, AD_FPS, DEFAULT_TEMPO } from './adTimeline';
import { planFromLink, renderMusic, encodeWav, loadWav } from './orrery';
import { keepFile, listSavedAds, loadAd, saveAd, adSlug } from './devApi';

// The local ad builder: an Instagram Reel of a design flying through 3D and landing on the
// products, cut to music from Orrery. See ad-builder.html for how to open it.

const PREVIEW_W = AD_WIDTH / 2;
const PREVIEW_H = AD_HEIGHT / 2;
const FLIGHT_BARS = [1, 2, 3, 4];
const PRODUCT_BARS = [0.5, 1, 2];
const MAX_PRODUCTS = 5;
const ROOT_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const AD_FILE_VERSION = 1;

const fmt = t => `${t.toFixed(2)}s`;

// Product slots carry a stable id so each keeps its own mockup state when one is removed.
let nextSlotId = 1;
const newSlot = productId => ({ uid: nextSlotId++, productId, photos: [], fit: 'full' });

// The design a saved row prints: the row's own design for an image, a 3D animation's one design,
// or a 2D animation's first frame.
function designOfRow(row) {
  if (row.kind === 'image') return row.data;
  return row.data?.design ?? row.data?.frames?.[0] ?? null;
}

function Section({ title, children, aside = null }) {
  return (
    <section className="border-b border-white/10 px-5 py-5">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h2 className="text-xs font-bold uppercase tracking-[0.2em] text-neutral-400">{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

function Segmented({ value, options, onChange, label }) {
  return (
    <div className="flex gap-1" role="group" aria-label={label}>
      {options.map(([v, text]) => (
        <button
          key={String(v)}
          type="button"
          aria-pressed={value === v}
          onClick={() => onChange(v)}
          className={`rounded-md px-2.5 py-1 text-sm ${
            value === v
              ? 'bg-white/15 text-white'
              : 'text-neutral-400 hover:bg-white/5 hover:text-white'
          }`}
        >
          {text}
        </button>
      ))}
    </div>
  );
}

export default function AdBuilder() {
  const { user, authResolved } = useAuth();
  const { currentDesign } = useStudio();

  // ── What the ad is made of ──────────────────────────────────────────────────
  const [design, setDesign] = useState(null); // { title, id, data: compact design }
  const [slots, setSlots] = useState(() => [newSlot(STARTER_PRODUCT_IDS[0])]);
  const [music, setMusic] = useState({ link: '', plan: null, audioUrl: null, duration: null });
  const [musicBuffer, setMusicBuffer] = useState(null);
  const [timing, setTiming] = useState({ flightBars: 1, productBars: 1 });
  const [overlay, setOverlay] = useState({ show: true, text: 'chromaforge.app', position: 'bottom' });
  const [name, setName] = useState('');
  const [post, setPost] = useState(DEFAULT_POST);

  // ── Supporting data and UI state ────────────────────────────────────────────
  const [catalog, setCatalog] = useState(
    STARTER_PRODUCT_IDS.map(id => ({ id, title: `Product ${id}` }))
  );
  const [myDesigns, setMyDesigns] = useState(null);
  const [linkInput, setLinkInput] = useState('');
  const [designError, setDesignError] = useState(null);
  const [musicBusy, setMusicBusy] = useState(null); // null | 'loading' | progress 0..1
  const [musicError, setMusicError] = useState(null);
  const [savedAds, setSavedAds] = useState([]);
  const [notice, setNotice] = useState(null);
  const [showIg, setShowIg] = useState(true);
  const [previewState, setPreviewState] = useState('empty'); // empty | building | ready | error
  const [previewError, setPreviewError] = useState(null);
  const [playing, setPlaying] = useState(false);
  const [exportState, setExportState] = useState(null); // null | { label, progress }

  const flightDesign = useMemo(
    () =>
      design
        ? {
            seed: design.data.seed,
            colors: design.data.colors || [],
            settings: design.data.settings ?? null
          }
        : null,
    [design]
  );
  const mockupDesign = useMemo(
    () => (design ? withCurrentGeneratorVersion(design.data) : null),
    [design]
  );
  const photos = useMemo(
    // Every chosen photo is its own beat: slot by slot, in each slot's own order.
    () =>
      slots.flatMap(s =>
        slotPhotos(s)
          .filter(p => p.url)
          .map(p => ({ url: p.url, fit: s.fit || 'cutout', productId: s.productId }))
      ),
    [slots]
  );
  const tempo = music.plan?.state?.tempo || DEFAULT_TEMPO;
  const timeline = useMemo(
    () =>
      adTimeline({
        tempo,
        flightBars: timing.flightBars,
        productBars: timing.productBars,
        productCount: photos.length
      }),
    [tempo, timing, photos.length]
  );
  const musicStale = !!musicBuffer && Math.abs((music.duration ?? 0) - timeline.total) > 0.001;

  useEffect(() => {
    listCatalogProducts()
      .then(all => {
        const byId = new Map(all.map(p => [p.id, p]));
        setCatalog(
          STARTER_PRODUCT_IDS.map(id => ({ id, title: byId.get(id)?.title ?? `Product ${id}` }))
        );
      })
      .catch(() => {});
    listSavedAds()
      .then(setSavedAds)
      .catch(() => {});
  }, []);

  const userId = user?.id ?? null;
  useEffect(() => {
    if (!userId) {
      setMyDesigns(null);
      return;
    }
    listMyDesigns({ kind: 'image' })
      .then(setMyDesigns)
      .catch(e => setDesignError(e.message));
  }, [userId]);

  // ── Preview ─────────────────────────────────────────────────────────────────
  const canvasRef = useRef(null);
  const flightHostRef = useRef(null);
  const lockupHostRef = useRef(null);
  const composerRef = useRef(null);
  const scrubRef = useRef(null);
  const timeRef = useRef(null);
  const drawState = useRef({ timeline, overlay });
  drawState.current = { timeline, overlay };
  // Products are placed clear of the lockup, so where the text sits is part of their layout.
  const photoLayout = { position: overlay.position, showText: overlay.show };
  const photosKey = JSON.stringify([photos, photoLayout]);
  const photosRef = useRef({ photos, photoLayout, key: photosKey });
  photosRef.current = { photos, photoLayout, key: photosKey };
  const musicRef = useRef(musicBuffer);
  musicRef.current = musicBuffer;
  const play = useRef({
    playing: false,
    t: 0,
    raf: 0,
    audio: null,
    source: null,
    audioStart: 0,
    wallStart: 0
  });

  const showTime = t => {
    if (scrubRef.current) scrubRef.current.value = String(t);
    if (timeRef.current)
      timeRef.current.textContent = `${fmt(t)} / ${fmt(drawState.current.timeline.total)}`;
  };

  // `readout: false` is for playback, which updates the time and scrubber on its own schedule.
  const drawAt = (t, { readout = true } = {}) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (composerRef.current) composerRef.current.draw(ctx, t, drawState.current);
    else {
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    if (readout) showTime(t);
  };

  const flightKey = flightDesign ? JSON.stringify(flightDesign) : '';
  useEffect(() => {
    if (!flightDesign) return;
    let cancelled = false;
    let built = null;
    setPreviewState('building');
    setPreviewError(null);
    // Layered: the flight shows on its own canvas under the frame canvas -- see createAdComposer.
    createAdComposer({
      design: flightDesign,
      width: PREVIEW_W,
      height: PREVIEW_H,
      exact: false,
      layered: true
    })
      .then(async c => {
        built = c;
        if (cancelled) return c.dispose();
        // Until composerRef is set, the photos effect below has no composer to tell, so a change
        // that lands while these decode is picked up here instead of being lost.
        let placed;
        do {
          placed = photosRef.current;
          await c.setPhotos(placed.photos, placed.photoLayout);
          if (cancelled) return;
        } while (placed.key !== photosRef.current.key);
        flightHostRef.current?.appendChild(c.flightCanvas);
        lockupHostRef.current?.appendChild(c.lockupCanvas);
        composerRef.current = c;
        setPreviewState('ready');
        drawAt(play.current.t);
      })
      .catch(e => {
        if (cancelled) return;
        setPreviewState('error');
        setPreviewError(e.message);
      });
    return () => {
      cancelled = true;
      if (composerRef.current === built) composerRef.current = null;
      built?.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flightKey]);

  useEffect(() => {
    const c = composerRef.current;
    if (!c) return;
    c.setPhotos(photos, photoLayout)
      .then(() => composerRef.current === c && drawAt(play.current.t))
      .catch(e => setNotice(`A photo failed to load: ${e.message}`));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [photosKey]);

  // Timing, text or tempo changed while paused: redraw where the playhead is.
  const drawKey = JSON.stringify([timeline.total, timing, overlay]);
  useEffect(() => {
    if (play.current.t > timeline.total) play.current.t = 0;
    if (!play.current.playing) drawAt(play.current.t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drawKey]);

  // ── Playback: the music's clock when there is music, the wall clock otherwise ──
  const stopSource = () => {
    const p = play.current;
    try {
      p.source?.stop();
    } catch {
      /* not started */
    }
    p.source = null;
  };

  const startClock = t0 => {
    const p = play.current;
    stopSource();
    const buffer = musicRef.current;
    if (buffer) {
      p.audio = p.audio || new AudioContext();
      p.audio.resume();
      const src = p.audio.createBufferSource();
      src.buffer = buffer;
      src.connect(p.audio.destination);
      src.start(0, Math.min(t0, buffer.duration));
      p.source = src;
      p.audioStart = p.audio.currentTime - t0;
    } else {
      p.wallStart = performance.now() - t0 * 1000;
    }
  };
  const clockNow = () => {
    const p = play.current;
    return p.source ? p.audio.currentTime - p.audioStart : (performance.now() - p.wallStart) / 1000;
  };

  const pause = () => {
    const p = play.current;
    p.playing = false;
    cancelAnimationFrame(p.raf);
    stopSource();
    setPlaying(false);
  };

  // Frame timing while playing: each frame's interval and what drawing it cost on the main
  // thread, for the readout under the preview (and window.__adPerf, for profiling).
  const perf = useRef({ frames: [], last: 0 });
  const fpsRef = useRef(null);
  if (typeof window !== 'undefined') window.__adPerf = perf.current;
  const recordFrame = (t, now, cost) => {
    const f = perf.current;
    if (f.last) f.frames.push({ t, interval: now - f.last, cost });
    if (f.frames.length > 240) f.frames.shift();
    f.last = now;
    if (fpsRef.current && f.frames.length && f.frames.length % 15 === 0) {
      const recent = f.frames.slice(-60);
      const median = key => recent.map(x => x[key]).sort((a, b) => a - b)[recent.length >> 1];
      fpsRef.current.textContent = `${Math.round(1000 / median('interval'))} fps · ${median('cost').toFixed(1)}ms`;
    }
  };

  const start = () => {
    const p = play.current;
    if (p.playing) return;
    p.playing = true;
    perf.current.last = 0;
    if (p.t >= drawState.current.timeline.total - 0.02) p.t = 0;
    // The audio context is made and unlocked HERE, inside the click, even with no take yet.
    // A take that lands mid-play starts its source from an effect; a context first created
    // there is outside any user gesture, and Safari keeps it suspended -- a silent preview
    // until the next pause and play.
    p.audio = p.audio || new AudioContext();
    p.audio.resume();
    startClock(p.t);
    const tick = now => {
      if (!p.playing) return;
      let t = clockNow();
      // Loops like a Reel does.
      if (t >= drawState.current.timeline.total) {
        t = 0;
        startClock(0);
      }
      p.t = t;
      const before = performance.now();
      drawAt(t, { readout: false });
      recordFrame(t, now, performance.now() - before);
      // The time and scrubber about ten times a second, not every frame: every DOM change is a
      // style, layout and paint pass, and Safari was repainting far more than the change.
      if (now - (p.readoutAt || 0) > 100) {
        p.readoutAt = now;
        showTime(t);
      }
      p.raf = requestAnimationFrame(tick);
    };
    p.raf = requestAnimationFrame(tick);
    setPlaying(true);
  };

  // A new take (or none) while playing restarts the clock on it.
  useEffect(() => {
    if (play.current.playing) startClock(play.current.t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [musicBuffer]);

  useEffect(
    () => () => {
      const p = play.current;
      p.playing = false;
      cancelAnimationFrame(p.raf);
      stopSource();
      p.audio?.close();
    },
    []
  );

  // ── Design ──────────────────────────────────────────────────────────────────
  // A mockup photo is a photo OF the design it was made from, so a different design takes every
  // one out of the ad -- left in, they kept playing the old artwork on the products. Your own
  // photos belong to no design and stay. Compared by the whole design, not the seed: the Studio
  // button can bring back the same seed in a new palette. Opening a saved ad sets its design
  // directly and keeps its photos, which were made of it.
  const chooseDesign = d => {
    if (!isSameDesign(design?.data, d.data)) {
      setSlots(s =>
        s.map(slot => ({
          ...slot,
          photo: undefined,
          photos: slotPhotos(slot).filter(p => p.source.startsWith('own:'))
        }))
      );
    }
    setDesign(d);
    setDesignError(null);
  };

  const useLink = async () => {
    setDesignError(null);
    const id = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.exec(linkInput)?.[0];
    if (!id) return setDesignError('Paste a share link or a design id.');
    try {
      const row = await getDesign(id);
      const data = designOfRow(row);
      if (!data?.seed) throw new Error('That design has no artwork to use.');
      chooseDesign({ id: row.id, title: row.title || 'Shared design', data });
    } catch (e) {
      setDesignError(e.message);
    }
  };

  // ── Music ───────────────────────────────────────────────────────────────────
  const loadMusicLink = async () => {
    setMusicError(null);
    setMusicBusy('loading');
    try {
      const plan = await planFromLink(music.link);
      if (!plan)
        throw new Error('That is not an Orrery share link. Use SHARE in Orrery’s Manual mode.');
      setMusic(m => ({ ...m, plan, audioUrl: null, duration: null }));
      setMusicBuffer(null);
    } catch (e) {
      setMusicError(e.message);
    } finally {
      setMusicBusy(null);
    }
  };

  // A take is a single render of the plan at exactly the ad's length. Only the latest request
  // counts: the length can change again while one is rendering, and an older take landing last
  // would be the wrong length.
  const renderToken = useRef(0);
  const renderTake = async (plan, duration) => {
    const token = ++renderToken.current;
    const current = () => token === renderToken.current;
    setMusicError(null);
    setMusicBusy(0);
    try {
      // Progress in 5% steps. Orrery reports after every 60ms of audio, and each report re-rendered
      // the whole builder -- ~190 renders for an 11s take, on the same main thread the render and
      // the preview share. Measured at 4x CPU, that is what made a re-roll stutter the preview.
      let shown = -1;
      const buffer = await renderMusic(plan, duration, f => {
        const step = Math.floor(f * 20) / 20;
        if (step !== shown && current()) {
          shown = step;
          setMusicBusy(step);
        }
      });
      if (!current()) return;
      const audioUrl = await keepFile(encodeWav(buffer));
      if (!current()) return;
      setMusic(m => ({ ...m, audioUrl, duration }));
      setMusicBuffer(buffer);
    } catch (e) {
      if (current()) setMusicError(e.message);
    } finally {
      if (current()) setMusicBusy(null);
    }
  };

  // Always have a take that fits the ad: one renders as soon as a link is loaded, and again
  // whenever the ad's length changes (a product added, the timing changed) -- otherwise the music
  // ran out partway through the loop until someone pressed Render. A short debounce, so a run of
  // edits renders once. A failed render is not retried until something changes.
  const needsTake =
    !!music.plan && (!musicBuffer || Math.abs((music.duration ?? 0) - timeline.total) > 0.001);
  useEffect(() => {
    if (!needsTake) return;
    const id = setTimeout(() => renderTake(music.plan, timeline.total), 400);
    return () => clearTimeout(id);
  }, [needsTake, music.plan, timeline.total]);

  const clearMusic = () => {
    renderToken.current++;
    setMusicBusy(null);
    setMusic({ link: '', plan: null, audioUrl: null, duration: null });
    setMusicBuffer(null);
  };

  // ── Save, load, export ──────────────────────────────────────────────────────
  const fileBase = () => adSlug(name || design?.title || design?.data?.seed);

  const saveCurrent = async () => {
    const slug = fileBase();
    try {
      await saveAd(slug, {
        version: AD_FILE_VERSION,
        name: name || slug,
        design,
        slots,
        music,
        timing,
        overlay,
        post
      });
      setName(name || slug);
      setSavedAds(await listSavedAds());
      setNotice(`Saved as ${slug}.`);
    } catch (e) {
      setNotice(`Save failed: ${e.message}`);
    }
  };

  const openSaved = async slug => {
    if (!slug) return;
    try {
      pause();
      const ad = await loadAd(slug);
      const savedTake = ad.music?.audioUrl ? await loadWav(ad.music.audioUrl) : null;
      setName(ad.name || slug);
      setDesign(ad.design);
      setSlots(
        ad.slots.map(slot => ({
          ...slot,
          photo: undefined,
          photos: slotPhotos(slot),
          uid: nextSlotId++
        }))
      );
      // The saved take is decoded BEFORE any of the ad is applied, so the take arrives in the same
      // render as the plan -- otherwise the automatic render above would see a plan with no take
      // and replace the one that was saved.
      renderToken.current++;
      setTiming(ad.timing);
      setOverlay(ad.overlay);
      setPost(ad.post ?? DEFAULT_POST);
      setMusic(ad.music);
      setMusicBuffer(savedTake);
      play.current.t = 0;
      setNotice(`Opened ${slug}.`);
    } catch (e) {
      setNotice(`Couldn’t open ${slug}: ${e.message}`);
    }
  };

  const exportVideo = async () => {
    pause();
    const releases = [];
    setExportState({ label: 'Building the scene', progress: 0 });
    try {
      const comp = await createAdComposer({
        design: flightDesign,
        width: AD_WIDTH,
        height: AD_HEIGHT,
        exact: true
      });
      releases.push(() => comp.dispose());
      await comp.setPhotos(photos, photoLayout);
      const canvas = document.createElement('canvas');
      canvas.width = AD_WIDTH;
      canvas.height = AD_HEIGHT;
      releases.push(() => {
        canvas.width = 0;
        canvas.height = 0;
      });
      const ctx = canvas.getContext('2d');
      const state = { timeline, overlay };
      const totalFrames = Math.round(timeline.total * AD_FPS);
      const blob = await encodeMp4({
        width: AD_WIDTH,
        height: AD_HEIGHT,
        fps: AD_FPS,
        totalFrames,
        bitrate: exportBitrate({
          width: AD_WIDTH,
          height: AD_HEIGHT,
          fps: AD_FPS,
          durationSec: timeline.total
        }),
        releases,
        audio: musicBuffer,
        renderFrame: f => {
          comp.draw(ctx, f / AD_FPS, state);
          return canvas;
        },
        onFrame: f => setExportState({ label: 'Rendering frames', progress: f / totalFrames }),
        beforeFlush: () => {
          comp.dispose();
          setExportState({ label: 'Finishing the file', progress: 1 });
        }
      });
      saveAs(blob, `${fileBase()}-${AD_WIDTH}x${AD_HEIGHT}.mp4`);
    } catch (e) {
      console.error('[ad builder] export failed', e);
      setNotice(`Export failed: ${e.message}`);
    } finally {
      for (const release of releases.reverse()) {
        try {
          release();
        } catch {
          /* already released */
        }
      }
      setExportState(null);
    }
  };

  const exportCover = async () => {
    pause();
    setExportState({ label: 'Rendering the cover', progress: 0 });
    let comp = null;
    try {
      comp = await createAdComposer({
        design: flightDesign,
        width: AD_WIDTH,
        height: AD_HEIGHT,
        exact: true
      });
      await comp.setPhotos(photos, photoLayout);
      const canvas = document.createElement('canvas');
      canvas.width = AD_WIDTH;
      canvas.height = AD_HEIGHT;
      comp.draw(canvas.getContext('2d'), play.current.t, { timeline, overlay });
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.95));
      if (!blob) throw new Error('The frame could not be encoded.');
      saveAs(blob, `${fileBase()}-cover.jpg`);
    } catch (e) {
      setNotice(`Cover failed: ${e.message}`);
    } finally {
      comp?.dispose();
      setExportState(null);
    }
  };

  const busy = !!exportState;
  const canExport =
    // Never while a take is missing or the wrong length: that would export the old take, or none.
    !!flightDesign && previewState === 'ready' && !busy && !needsTake && musicBusy === null;
  const seg = segmentAt(timeline, play.current.t);

  // ── Layout ──────────────────────────────────────────────────────────────────
  return (
    <div className="flex min-h-dvh bg-[#0c0b12] text-neutral-200">
      <aside
        // Its own compositing layer, as are the thumbnail grid and the preview: in Safari the
        // preview animating repainted this whole panel every frame -- 20fps with the thumbnails in
        // view, 60 with them scrolled away -- and separate layers keep each one's repaints its own.
        className="ad-scroll w-[440px] shrink-0 overflow-y-auto border-r border-white/10 will-change-transform"
        style={{ maxHeight: '100dvh' }}
      >
        <header className="flex items-center justify-between border-b border-white/10 px-5 py-4">
          <h1 className="font-[Exo] text-lg font-bold tracking-wide text-white">Ad builder</h1>
          <span className="text-xs text-neutral-500">
            Instagram Reels · 1080×1920 · {AD_FPS}fps
          </span>
        </header>

        <Section title="1 · Design">
          {authResolved && !user && (
            <p className="mb-3 text-sm text-neutral-400">
              <a
                href="/account"
                target="_blank"
                rel="noreferrer"
                className="text-[#d1ff1a] underline"
              >
                Sign in on this server
              </a>{' '}
              to use your saved designs and generate mockups, then reload.
            </p>
          )}
          {design && (
            <p className="mb-3 truncate text-sm">
              <span className="text-neutral-500">Using</span> {design.title}{' '}
              <span className="text-neutral-500">· seed {design.data.seed}</span>
            </p>
          )}
          {myDesigns && (
            <p className="mb-1.5 text-xs text-neutral-500">
              {myDesigns.length} saved design{myDesigns.length === 1 ? '' : 's'}
            </p>
          )}
          {myDesigns && (
            // The scroller wraps the grid rather than being it: a height-capped grid shrinks its rows
            // to fit, and every square thumbnail then spills over the rows below it.
            <div className="ad-scroll max-h-56 overflow-y-auto p-0.5 pr-2 will-change-transform">
              <div className="grid grid-cols-5 gap-1.5">
                {myDesigns.map(row => (
                  <button
                    key={row.id}
                    type="button"
                    onClick={() =>
                      chooseDesign({ id: row.id, title: row.title || 'Untitled', data: row.data })
                    }
                    className={`aspect-square overflow-hidden rounded ring-2 ${
                      design?.id === row.id
                        ? 'ring-[#d1ff1a]'
                        : 'ring-transparent hover:ring-white/30'
                    }`}
                    title={row.title || ''}
                  >
                    <DesignThumb src={getThumbnailUrl(row.user_id, row.id)} size={73} />
                  </button>
                ))}
              </div>
            </div>
          )}
          <div className="mt-3 flex gap-2">
            <input
              value={linkInput}
              onChange={e => setLinkInput(e.target.value)}
              placeholder="Share link or design id"
              className="min-w-0 flex-1 rounded-md border border-white/15 bg-neutral-900 px-2 py-1.5 text-sm"
            />
            <Button size="sm" variant="ghost" onClick={useLink}>
              Use
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={!currentDesign}
              onClick={() =>
                chooseDesign({
                  id: null,
                  title: 'Studio design',
                  data: toCompactDesign(currentDesign)
                })
              }
              title="The design the studio last showed in this browser"
            >
              Studio
            </Button>
          </div>
          {designError && <p className="mt-2 text-xs text-red-300">{designError}</p>}
        </Section>

        <Section
          title="2 · Products"
          aside={
            <Button
              size="sm"
              variant="ghost"
              disabled={slots.length >= MAX_PRODUCTS}
              onClick={() =>
                setSlots(s => [
                  ...s,
                  newSlot(STARTER_PRODUCT_IDS[(s.length * 3) % STARTER_PRODUCT_IDS.length])
                ])
              }
            >
              Add
            </Button>
          }
        >
          <div className="flex flex-col gap-2">
            {slots.map((slot, i) => (
              <ProductSlot
                key={slot.uid}
                index={i}
                slot={slot}
                design={mockupDesign}
                catalog={catalog}
                signedIn={!!user}
                onChange={update => setSlots(s => s.map(x => (x.uid === slot.uid ? update(x) : x)))}
                onRemove={() => setSlots(s => s.filter(x => x.uid !== slot.uid))}
              />
            ))}
          </div>
          {!design && (
            <p className="mt-2 text-xs text-neutral-500">
              Choose a design first: mockups are made of it.
            </p>
          )}
        </Section>

        <Section
          title="3 · Music"
          aside={
            music.plan && (
              <button
                type="button"
                className="text-xs text-neutral-500 hover:text-white"
                onClick={clearMusic}
              >
                Remove
              </button>
            )
          }
        >
          <div className="flex gap-2">
            <input
              value={music.link}
              onChange={e => setMusic(m => ({ ...m, link: e.target.value }))}
              placeholder="Orrery share link (SHARE in Manual mode)"
              className="min-w-0 flex-1 rounded-md border border-white/15 bg-neutral-900 px-2 py-1.5 text-sm"
            />
            <Button
              size="sm"
              variant="ghost"
              disabled={!music.link || musicBusy !== null}
              onClick={loadMusicLink}
            >
              Load
            </Button>
          </div>
          {music.plan && (
            <div className="mt-3 text-sm">
              <p>
                {Math.round(music.plan.state.tempo)} bpm ·{' '}
                {ROOT_NAMES[music.plan.state.rootMidi % 12]} ·{' '}
                <span className="text-neutral-400">
                  {music.plan.voices.join(', ') || 'no voices'}
                </span>
                {music.plan.bassStyle && (
                  <span className="text-neutral-400">, bass ({music.plan.bassStyle})</span>
                )}
              </p>
              <div className="mt-2 flex items-center gap-3">
                <Button
                  size="sm"
                  disabled={musicBusy !== null}
                  onClick={() => renderTake(music.plan, timeline.total)}
                  title="Orrery plays it differently every time"
                >
                  Re-roll
                </Button>
                <span className="text-xs text-neutral-400">
                  {typeof musicBusy === 'number'
                    ? `Rendering ${Math.round(musicBusy * 100)}%`
                    : musicBuffer && !musicStale
                      ? `${fmt(music.duration)} take, playing with the preview.`
                      : 'Rendering…'}
                </span>
              </div>
            </div>
          )}
          {musicBusy === 'loading' && (
            <p className="mt-2 text-xs text-neutral-400">Reading the link…</p>
          )}
          {musicError && <p className="mt-2 text-xs text-red-300">{musicError}</p>}
        </Section>

        <Section
          title="4 · Timing"
          aside={
            <span className="text-xs text-neutral-500">
              {fmt(timeline.total)} · {Math.round(tempo)} bpm
            </span>
          }
        >
          <div className="flex items-center justify-between gap-3 text-sm">
            <span className="text-neutral-400">Flight</span>
            <Segmented
              label="Flight length"
              value={timing.flightBars}
              options={FLIGHT_BARS.map(b => [b, `${b} bar${b > 1 ? 's' : ''}`])}
              onChange={v => setTiming(t => ({ ...t, flightBars: v }))}
            />
          </div>
          <div className="mt-2 flex items-center justify-between gap-3 text-sm">
            <span className="text-neutral-400">Each product</span>
            <Segmented
              label="Bars per product"
              value={timing.productBars}
              options={PRODUCT_BARS.map(b => [
                b,
                b === 0.5 ? '½ bar' : `${b} bar${b > 1 ? 's' : ''}`
              ])}
              onChange={v => setTiming(t => ({ ...t, productBars: v }))}
            />
          </div>
        </Section>

        <Section
          title="5 · Brand"
          aside={
            <Toggle
              on={overlay.show}
              onClick={() => setOverlay(o => ({ ...o, show: !o.show }))}
              aria-label="Show the brand lockup"
            />
          }
        >
          <div className="flex items-center gap-3">
            <input
              value={overlay.text}
              onChange={e => setOverlay(o => ({ ...o, text: e.target.value }))}
              className="min-w-0 flex-1 rounded-md border border-white/15 bg-neutral-900 px-2 py-1.5 text-sm"
            />
            <Segmented
              label="Text position"
              value={overlay.position}
              options={[
                ['top', 'Top'],
                ['bottom', 'Bottom']
              ]}
              onChange={v => setOverlay(o => ({ ...o, position: v }))}
            />
          </div>
          <p className="mt-2 text-xs text-neutral-500">
            The Chromaforge wordmark, with this line under it, arrives a beat after the first
            product. CHROMA&rsquo;s color wave marks new products, at most once every 2 bars.
            Products are placed clear of it.
          </p>
        </Section>

        <Section title="6 · Save and export">
          <div className="flex gap-2">
            <input
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="Name"
              className="min-w-0 flex-1 rounded-md border border-white/15 bg-neutral-900 px-2 py-1.5 text-sm"
            />
            <Button size="sm" variant="ghost" disabled={!design} onClick={saveCurrent}>
              Save
            </Button>
            <select
              className="w-28 rounded-md border border-white/15 bg-neutral-900 px-2 py-1.5 text-sm"
              value=""
              onChange={e => openSaved(e.target.value)}
              aria-label="Open a saved ad"
            >
              <option value="">Open…</option>
              {savedAds.map(a => (
                <option key={a.name} value={a.name}>
                  {a.name}
                </option>
              ))}
            </select>
          </div>
          <div className="mt-3 flex items-center gap-2">
            <Button disabled={!canExport} onClick={exportVideo}>
              Export MP4
            </Button>
            <Button
              variant="ghost"
              disabled={!canExport}
              onClick={exportCover}
              title="The frame under the playhead, as a 1080×1920 JPG"
            >
              Cover
            </Button>
          </div>
          {exportState && (
            <p className="mt-2 text-xs text-neutral-400">
              {exportState.label}{' '}
              {exportState.progress > 0 && `${Math.round(exportState.progress * 100)}%`}
            </p>
          )}
          {!music.plan && design && (
            <p className="mt-2 text-xs text-neutral-500">No music: the file will be silent.</p>
          )}
          {notice && <p className="mt-2 text-xs text-neutral-300">{notice}</p>}
        </Section>

        <Section title="7 · Post">
          <PostCopy
            design={design}
            productNames={photos.map(p =>
              catalog.find(c => c.id === p.productId)?.title?.replace(/^All-Over Print\s*/, '')
            )}
            post={post}
            onChange={setPost}
          />
        </Section>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col items-center justify-center gap-4 p-6">
        <div
          className="relative isolate overflow-hidden rounded-xl bg-black shadow-2xl will-change-transform"
          style={{ height: 'min(80dvh, 960px)', aspectRatio: '9 / 16' }}
        >
          <div ref={flightHostRef} className="absolute inset-0" />
          <canvas
            ref={canvasRef}
            width={PREVIEW_W}
            height={PREVIEW_H}
            className="absolute inset-0 h-full w-full"
          />
          <div ref={lockupHostRef} className="pointer-events-none absolute inset-0" />
          {showIg && <InstagramOverlay />}
          {!flightDesign && (
            <p className="absolute inset-0 flex items-center justify-center p-8 text-center text-sm text-neutral-400">
              Choose a design to start.
            </p>
          )}
          {previewState === 'building' && (
            <p className="absolute left-3 top-3 rounded bg-black/60 px-2 py-1 text-xs text-neutral-300">
              Building the flight…
            </p>
          )}
          {previewState === 'error' && (
            <p className="absolute inset-0 flex items-center justify-center p-8 text-center text-sm text-red-300">
              {previewError}
            </p>
          )}
        </div>

        <div className="flex w-full max-w-[540px] items-center gap-3">
          <Button
            size="sm"
            disabled={previewState !== 'ready' || busy}
            onClick={playing ? pause : start}
          >
            {playing ? 'Pause' : 'Play'}
          </Button>
          <div className="relative flex-1">
            <div className="pointer-events-none absolute inset-x-0 -top-5 flex text-[10px] text-neutral-500">
              <span
                style={{ width: `${(timeline.flight / timeline.total) * 100}%` }}
                className="truncate"
              >
                Flight
              </span>
              {timeline.products.map((p, i) => (
                <span
                  key={i}
                  style={{ width: `${((p.end - p.start) / timeline.total) * 100}%` }}
                  className={`truncate border-l border-white/20 pl-1 ${seg === i ? 'text-white' : ''}`}
                >
                  {catalog
                    .find(c => c.id === photos[i]?.productId)
                    ?.title?.replace(/^All-Over Print\s*/, '') ?? i + 1}
                </span>
              ))}
            </div>
            <input
              ref={scrubRef}
              type="range"
              min="0"
              max={timeline.total}
              step="0.01"
              defaultValue="0"
              className="w-full"
              aria-label="Playhead"
              onChange={e => {
                pause();
                play.current.t = Number(e.target.value);
                drawAt(play.current.t);
              }}
            />
          </div>
          <span ref={timeRef} className="w-28 text-right text-xs tabular-nums text-neutral-400" />
          <span
            ref={fpsRef}
            className="w-24 text-right text-xs tabular-nums text-neutral-500"
            title="Preview frame rate, and what drawing a frame costs"
          />
          <label className="flex items-center gap-2 text-xs text-neutral-400">
            <Toggle
              on={showIg}
              onClick={() => setShowIg(v => !v)}
              aria-label="Show Instagram's UI"
            />
            IG UI
          </label>
        </div>
      </main>
    </div>
  );
}
