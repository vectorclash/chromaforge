import React, { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import PageContainer from '../components/ui/PageContainer';
import Button from '../components/ui/Button';
import { getCatalogProduct, getPrintfileSpecs } from '../lib/printful';
import { listMyDesigns, getThumbnailUrl } from '../lib/designs';
import { useStudio } from '../context/StudioContext';
import { useAuth } from '../context/AuthContext';
import { useMockup } from '../hooks/useMockup';

const BUSY = ['rendering', 'creating', 'polling'];
const STATUS_LABEL = {
  rendering: 'Rendering design…',
  creating: 'Sending to Printful…',
  polling: 'Generating mockup…'
};

export default function ProductPage() {
  const { productId } = useParams();
  const {
    currentDesign,
    previewUrl: studioPreviewUrl,
    renderDesignBlob,
    queueReady,
    printQueueDesign,
    setPrintQueueDesign
  } = useStudio();
  const { user } = useAuth();
  const { status, error: mockupError, images, generate } = useMockup();

  const [detail, setDetail] = useState(null); // { product, variants }
  const [printfileSpecs, setPrintfileSpecs] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [previewUrl, setPreviewUrl] = useState(null);
  const [selectedVariantId, setSelectedVariantId] = useState(null);

  // Step 1: which artwork to print. "current" is always the live studio design; a one-shot
  // hand-off from the Gallery's "Print this" action can also queue a specific saved design
  // (consumed once on mount, see below) alongside the user's own saved designs.
  const [myDesigns, setMyDesigns] = useState([]);
  const [queuedChoice, setQueuedChoice] = useState(null);
  const [selectedKey, setSelectedKey] = useState('current');
  const consumedQueueRef = useRef(false);

  // Fetch product detail + printfile specs.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const [d, specs] = await Promise.all([
          getCatalogProduct(productId),
          getPrintfileSpecs(productId)
        ]);
        if (!cancelled) {
          setDetail(d);
          setPrintfileSpecs(specs);
          setSelectedVariantId(d.variants[0]?.id ?? null);
        }
      } catch (err) {
        if (!cancelled) setError(err.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [productId]);

  // Consume the Gallery's queued "Print this" design exactly once -- StudioContext clears
  // it right after so it doesn't silently reapply on a later visit.
  useEffect(() => {
    if (consumedQueueRef.current || !printQueueDesign) return;
    consumedQueueRef.current = true;
    setQueuedChoice(printQueueDesign);
    setSelectedKey('queued');
    setPrintQueueDesign(null);
  }, [printQueueDesign, setPrintQueueDesign]);

  // The user's own saved (non-animation -- the mockup pipeline expects a flat
  // { seed, colors } design, not a frames array) designs, as artwork choices.
  useEffect(() => {
    if (!user) {
      setMyDesigns([]);
      return;
    }
    let cancelled = false;
    listMyDesigns()
      .then(rows => {
        if (!cancelled) setMyDesigns(rows.filter(d => d.kind !== 'animation'));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [user]);

  const choices = [
    { key: 'current', label: 'Current studio design', thumb: studioPreviewUrl, data: currentDesign },
    ...(queuedChoice
      ? [
          {
            key: 'queued',
            label: queuedChoice.title || 'Untitled',
            thumb: getThumbnailUrl(queuedChoice.user_id, queuedChoice.id),
            data: queuedChoice.data
          }
        ]
      : []),
    ...myDesigns
      .filter(d => !queuedChoice || d.id !== queuedChoice.id)
      .map(d => ({
        key: d.id,
        label: d.title || 'Untitled',
        thumb: getThumbnailUrl(d.user_id, d.id),
        data: d.data
      }))
  ];
  const selectedChoice = choices.find(c => c.key === selectedKey) || choices[0];
  const selectedDesign = selectedChoice.data;

  // Render a preview of the selected artwork (what will be printed) off-canvas.
  useEffect(() => {
    if (!selectedDesign || !queueReady) {
      setPreviewUrl(null);
      return;
    }
    let url;
    let cancelled = false;
    renderDesignBlob(selectedDesign, 600, 600)
      .then(blob => {
        if (cancelled) return;
        url = URL.createObjectURL(blob);
        setPreviewUrl(url);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [selectedDesign, queueReady, renderDesignBlob]);

  if (loading) {
    return (
      <PageContainer title="Loading…">
        <p className="text-neutral-500">Fetching product…</p>
      </PageContainer>
    );
  }
  if (error || !detail) {
    return (
      <PageContainer title="Product unavailable" subtitle={error || 'Not found.'}>
        <Button as={Link} to="/shop" variant="secondary">← Back to shop</Button>
      </PageContainer>
    );
  }

  const { product, variants } = detail;
  const variant = variants.find(v => v.id === selectedVariantId) || variants[0];
  const hasMultipleColors = new Set(variants.map(v => v.color)).size > 1;
  const busy = BUSY.includes(status);

  return (
    <PageContainer
      title={product.title}
      actions={<Button as={Link} to="/shop" variant="ghost">← Shop</Button>}
    >
      {/* Step 1: artwork. Full-width, above the size/preview columns -- it drives both. */}
      <div className="mb-8">
        <h2 className="font-quicksand text-sm font-bold uppercase tracking-wide text-neutral-500">
          1. Choose artwork
        </h2>
        <div className="mt-3 flex gap-2 overflow-x-auto pb-1">
          {choices.map(c => {
            const selected = c.key === selectedKey;
            return (
              <button
                key={c.key}
                type="button"
                onClick={() => setSelectedKey(c.key)}
                aria-pressed={selected}
                title={c.label}
                className={
                  'h-16 w-16 shrink-0 cursor-pointer overflow-hidden rounded-lg border-2 bg-neutral-100 transition ' +
                  (selected ? 'border-accent' : 'border-neutral-200 hover:border-neutral-400')
                }
              >
                {c.thumb && <img src={c.thumb} alt={c.label} className="h-full w-full object-cover" />}
              </button>
            );
          })}
        </div>
        <p className="mt-2 truncate text-xs text-neutral-500">{selectedChoice.label}</p>
        {!user && (
          <p className="mt-1 text-xs text-neutral-400">
            <Link to="/account" className="text-accent underline">Sign in</Link> to choose from your saved designs.
          </p>
        )}
      </div>

      <div className="grid grid-cols-1 gap-10 lg:grid-cols-2">
        {/* Step 2: size */}
        <div>
          <div className="aspect-square overflow-hidden rounded-xl border border-neutral-200 bg-neutral-100">
            <img src={product.image} alt={product.title} className="h-full w-full object-cover" />
          </div>
          <div className="mt-6">
            <div className="flex items-baseline justify-between">
              <h2 className="font-quicksand text-sm font-bold uppercase tracking-wide text-neutral-500">
                2. Size{hasMultipleColors ? ' & color' : ''}
              </h2>
              <span className="font-quicksand text-sm font-bold text-neutral-900">${variant.price}</span>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              {variants.map(v => {
                const selected = v.id === variant.id;
                return (
                  <button
                    key={v.id}
                    type="button"
                    onClick={() => setSelectedVariantId(v.id)}
                    aria-pressed={selected}
                    className={
                      'cursor-pointer rounded-lg border px-3 py-2 font-quicksand text-sm font-bold transition ' +
                      (selected
                        ? 'border-accent bg-accent text-white'
                        : 'border-neutral-300 text-neutral-700 hover:border-neutral-900')
                    }
                  >
                    {v.size}
                    {hasMultipleColors && v.color ? ` / ${v.color}` : ''}
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        {/* Step 3: preview + mockup */}
        <div>
          <h2 className="font-quicksand text-sm font-bold uppercase tracking-wide text-neutral-500">
            3. Preview &amp; mockup
          </h2>
          <div className="mt-2 aspect-square overflow-hidden rounded-xl border border-neutral-200 bg-neutral-100">
            {previewUrl ? (
              <img src={previewUrl} alt={selectedChoice.label} className="h-full w-full object-cover" />
            ) : (
              <div className="flex h-full items-center justify-center p-6 text-center text-sm text-neutral-500">
                Rendering preview…
              </div>
            )}
          </div>

          <div className="mt-6">
            {!user ? (
              <p className="text-sm text-neutral-500">
                <Link to="/account" className="text-accent underline">Sign in</Link> to generate a mockup of your design.
              </p>
            ) : (
              <Button
                onClick={() => generate({ product, printfileSpecs, variant, design: selectedDesign })}
                disabled={busy || !selectedDesign}
              >
                {busy && (
                  <span className="mr-2 inline-block h-3 w-3 animate-spin rounded-full border-2 border-white/40 border-t-white" />
                )}
                {busy ? STATUS_LABEL[status] : 'Generate mockup'}
              </Button>
            )}
            {busy && (
              <p className="mt-2 text-xs text-neutral-400">
                This usually takes 30–90 seconds, depending on the product.
              </p>
            )}
            {status === 'failed' && mockupError && (
              <p className="mt-3 text-sm text-accent">{mockupError}</p>
            )}
            {status === 'completed' && images.length > 0 && (
              <div className="mt-4 grid grid-cols-2 gap-3">
                {images.map(m => (
                  <div key={m.style_id}>
                    <div className="overflow-hidden rounded-lg border border-neutral-200">
                      <img src={m.mockup_url} alt={m.display_name} className="w-full" />
                    </div>
                    <p className="mt-1 text-center text-xs text-neutral-500">{m.display_name}</p>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </PageContainer>
  );
}
