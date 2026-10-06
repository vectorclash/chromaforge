import React, { useEffect, useRef, useState } from 'react';
import { getCatalogProduct, getPrintfileSpecs } from '../lib/printful';
import { useMockup, BUSY_STATUSES } from '../hooks/useMockup';
import { defaultMockupOptions } from './mockupDefaults';
import { keepPrintfulImage, keepFile } from './devApi';
import Button from '../components/ui/Button';
import ScrollStrip from '../components/ui/ScrollStrip';

const STATUS_TEXT = {
  rendering: 'Rendering the print files',
  creating: 'Sending to Printful',
  polling: 'Printful is making the mockup'
};

// The same thumbnail sizing the product page's filmstrip uses.
const THUMB_SIZE = { max: 80, min: 64 };

// A slot's chosen photos. Ads saved before a slot could hold several have a single `photo`.
export function slotPhotos(slot) {
  const list = slot.photos ?? (slot.photo ? [slot.photo] : []);
  return list.map(p => (p.source ? p : { ...p, source: p.url }));
}

// One product in the ad, and the photos of it the ad shows -- each photo is its own beat, in the
// order chosen, so one product can carry a whole ad (flat front, flat back, on model...). Photos
// are views from a real Printful mockup of the ad's design -- generated through the product
// page's own pipeline (useMockup, with the product page's default print options), so they are the
// photos the shop would show -- or photos of your own. Either way they are copied into .ads/media.
//
// Every mockup task adds a file to the Printful library for good and counts against the
// store-wide 10-a-minute limit customers share, so a mockup is only ever made on a click. One
// made in this browser in the last 12 hours comes straight back from useMockup's cache.
export default function ProductSlot({ index, slot, design, catalog, signedIn, onChange, onRemove }) {
  const { status, error, images, elapsedSeconds, retryWaitSeconds, generate, sync } = useMockup();
  const [detail, setDetail] = useState(null); // { product, variants } + printfileSpecs
  const [loadError, setLoadError] = useState(null);
  const [keeping, setKeeping] = useState(() => new Set());
  const fileRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    setDetail(null);
    setLoadError(null);
    Promise.all([getCatalogProduct(slot.productId), getPrintfileSpecs(slot.productId)])
      .then(([d, specs]) => !cancelled && setDetail({ ...d, printfileSpecs: specs }))
      .catch(e => !cancelled && setLoadError(e.message));
    return () => {
      cancelled = true;
    };
  }, [slot.productId]);

  // Transparent 2000px PNGs: Printful cuts the product (and the model) out itself, which is what
  // the Cutout framing places. Cached separately from the shop's JPGs.
  const mockupArgs = () => ({
    product: detail.product,
    printfileSpecs: detail.printfileSpecs,
    variant: detail.variants[0],
    design,
    ...defaultMockupOptions(slot.productId),
    format: 'png',
    width: 2000
  });

  // Shows a mockup already made for this product and design, without spending a task.
  const designKey = design ? JSON.stringify(design) : '';
  useEffect(() => {
    if (detail && design) sync(mockupArgs());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail, designKey]);

  const photos = slotPhotos(slot);

  // A photo takes its place in the order the moment it is chosen, and gets its url once its file
  // is in .ads/media -- downloads finish in any order, and the ad must play in the order picked.
  // Updates go through a function of the slot as it is THEN, for the same reason.
  const keep = async (source, store) => {
    const seed = source.startsWith('own:') ? null : design?.seed ?? null;
    setKeeping(k => new Set(k).add(source));
    onChange(s => ({ ...s, photo: undefined, photos: [...slotPhotos(s), { url: null, seed, source }] }));
    try {
      const url = await store();
      onChange(s => ({ ...s, photos: slotPhotos(s).map(p => (p.source === source && !p.url ? { ...p, url } : p)) }));
    } catch (e) {
      setLoadError(e.message);
      onChange(s => ({ ...s, photos: slotPhotos(s).filter(p => p.source !== source || p.url) }));
    } finally {
      setKeeping(k => {
        const next = new Set(k);
        next.delete(source);
        return next;
      });
    }
  };
  const removeAt = i => onChange(s => ({ ...s, photo: undefined, photos: slotPhotos(s).filter((_, k) => k !== i) }));
  const move = (i, by) =>
    onChange(s => {
      const list = [...slotPhotos(s)];
      const j = i + by;
      if (j < 0 || j >= list.length) return s;
      [list[i], list[j]] = [list[j], list[i]];
      return { ...s, photo: undefined, photos: list };
    });
  const toggleView = view => {
    const at = photos.findIndex(p => p.source === view.mockup_url);
    if (at >= 0) removeAt(at);
    else if (!keeping.has(view.mockup_url)) keep(view.mockup_url, () => keepPrintfulImage(view.mockup_url));
  };

  const busy = BUSY_STATUSES.includes(status);
  const staleSeed = design && photos.some(p => p.seed && p.seed !== design.seed);
  const fit = slot.fit || 'cutout';

  return (
    <div className="rounded-lg border border-white/10 bg-white/[0.03] p-3">
      <div className="flex items-center gap-2">
        <span className="w-5 shrink-0 text-xs text-neutral-500">{index + 1}</span>
        <select
          className="min-w-0 flex-1 rounded-md border border-white/15 bg-neutral-900 px-2 py-1.5 text-sm"
          value={slot.productId}
          onChange={e => onChange(s => ({ ...s, productId: Number(e.target.value), photo: undefined, photos: [] }))}
        >
          {catalog.map(p => (
            <option key={p.id} value={p.id}>
              {p.title}
            </option>
          ))}
        </select>
        <button type="button" className="px-2 text-neutral-500 hover:text-white" onClick={onRemove} aria-label="Remove product">
          ✕
        </button>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-neutral-400">
        <Button
          size="sm"
          disabled={!detail || !design || !signedIn || busy}
          onClick={() => generate(mockupArgs())}
          title={signedIn ? '' : 'Sign in to generate mockups'}
        >
          {status === 'completed' ? 'Mockup ready' : busy ? 'Working…' : 'Generate mockup'}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => fileRef.current?.click()}>
          Own photo
        </Button>
        <input
          ref={fileRef}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          multiple
          className="hidden"
          onChange={e => {
            const files = [...(e.target.files || [])];
            e.target.value = '';
            files.forEach((file, n) => keep(`own:${Date.now()}:${n}:${file.name}`, () => keepFile(file)));
          }}
        />
        <div className="ml-auto flex gap-1" role="group" aria-label="Framing">
          {[
            ['cutout', 'Cutout'],
            ['card', 'Card'],
            ['full', 'Full frame']
          ].map(([value, label]) => (
            <button
              key={value}
              type="button"
              aria-pressed={fit === value}
              onClick={() => onChange(s => ({ ...s, fit: value }))}
              className={`rounded px-2 py-0.5 ${fit === value ? 'bg-white/15 text-white' : 'text-neutral-400 hover:text-white'}`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {busy && (
        <p className="mt-2 text-xs text-neutral-400">
          {status === 'queued'
            ? `Printful is busy, retrying in ${retryWaitSeconds ?? '…'}s`
            : `${STATUS_TEXT[status]} · ${elapsedSeconds}s`}
        </p>
      )}
      {(error || loadError) && <p className="mt-2 text-xs text-red-300">{error || loadError}</p>}

      {status === 'completed' && images.length > 0 && (
        <>
          <p className="mt-3 text-xs text-neutral-500">Click views to add them, in the order they should play.</p>
          <ScrollStrip className="mt-1.5" railClassName="px-0.5 py-0.5" itemSize={THUMB_SIZE} dragToScroll>
            {images.map(view => {
              const order = photos.findIndex(p => p.source === view.mockup_url);
              const saving = keeping.has(view.mockup_url);
              return (
                <button
                  key={view.mockup_url}
                  type="button"
                  onClick={() => toggleView(view)}
                  aria-pressed={order >= 0}
                  className="relative text-left"
                  style={{ width: 'var(--strip-item, 80px)' }}
                  title={view.display_name}
                >
                  <img
                    src={view.mockup_url}
                    alt=""
                    draggable={false}
                    className={`aspect-square w-full rounded bg-neutral-800 object-contain ring-2 ${
                      order >= 0 ? 'ring-[#d1ff1a]' : 'ring-transparent hover:ring-white/30'
                    } ${saving ? 'opacity-50' : ''}`}
                  />
                  {order >= 0 && (
                    <span className="absolute right-1 top-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-[#d1ff1a] px-1 text-[11px] font-bold text-black">
                      {order + 1}
                    </span>
                  )}
                  <span className="mt-1 block truncate text-[10px] text-neutral-400">
                    {saving ? 'Saving…' : view.display_name}
                  </span>
                </button>
              );
            })}
          </ScrollStrip>
        </>
      )}

      <div className="mt-3">
        {photos.length ? (
          <>
            <p className="mb-1.5 text-xs text-neutral-500">
              In the ad, in order{staleSeed && <span className="text-amber-300"> · some show a different design</span>}
            </p>
            <div className="flex flex-wrap gap-2">
              {photos.map((p, i) => (
                <div key={p.source} className="group relative">
                  {p.url ? (
                    <img
                      src={p.url}
                      alt=""
                      className={`h-16 w-16 rounded bg-neutral-800 object-contain ${p.seed && design && p.seed !== design.seed ? 'opacity-50' : ''}`}
                    />
                  ) : (
                    <div className="flex h-16 w-16 items-center justify-center rounded bg-neutral-800 text-[10px] text-neutral-400">Saving…</div>
                  )}
                  <span className="absolute left-1 top-1 rounded bg-black/70 px-1 text-[10px] text-white">{i + 1}</span>
                  <div className="absolute inset-x-0 bottom-0 hidden justify-between bg-black/70 text-[11px] group-hover:flex">
                    <button type="button" className="px-1.5 hover:text-[#d1ff1a]" onClick={() => move(i, -1)} aria-label="Earlier">
                      ‹
                    </button>
                    <button type="button" className="px-1.5 hover:text-red-300" onClick={() => removeAt(i)} aria-label="Remove">
                      ✕
                    </button>
                    <button type="button" className="px-1.5 hover:text-[#d1ff1a]" onClick={() => move(i, 1)} aria-label="Later">
                      ›
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </>
        ) : (
          <p className="text-xs text-neutral-500">No photos yet.</p>
        )}
      </div>
    </div>
  );
}
