import React, { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import PageContainer from '../components/ui/PageContainer';
import Button from '../components/ui/Button';
import HexagonLoader from '../components/HexagonLoader';
import { getCatalogProduct, getPrintfileSpecs } from '../lib/printful';
import { listMyDesigns, getThumbnailUrl } from '../lib/designs';
import { useStudio } from '../context/StudioContext';
import { useAuth } from '../context/AuthContext';
import { useMockup } from '../hooks/useMockup';
import { useHoverScroll } from '../hooks/useHoverScroll';

const BUSY = ['rendering', 'creating', 'polling'];
const STATUS_LABEL = {
  rendering: 'Rendering design…',
  creating: 'Sending to Printful…',
  polling: 'Generating mockup…'
};

export default function ProductPage() {
  const { productId } = useParams();
  const { currentDesign, previewUrl: studioPreviewUrl, printQueueDesign, setPrintQueueDesign } =
    useStudio();
  const { user } = useAuth();
  const { status, error: mockupError, images, generate, sync: syncMockup } = useMockup();

  const [detail, setDetail] = useState(null); // { product, variants }
  const [printfileSpecs, setPrintfileSpecs] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selectedVariantId, setSelectedVariantId] = useState(null);
  const [qty, setQty] = useState(1);
  const [activeImageIndex, setActiveImageIndex] = useState(0);
  const [checkoutNotice, setCheckoutNotice] = useState(null);

  // Step 1: which artwork to print. "current" is always the live studio design; a one-shot
  // hand-off from the Gallery's "Print this" action can also queue a specific saved design
  // (consumed once on mount, see below) alongside the user's own saved designs.
  const [myDesigns, setMyDesigns] = useState([]);
  const [queuedChoice, setQueuedChoice] = useState(null);
  const [selectedKey, setSelectedKey] = useState('current');
  const consumedQueueRef = useRef(false);
  const artworkStripRef = useHoverScroll();

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

  // A new mockup batch always starts on its first (front-facing) image.
  useEffect(() => {
    setActiveImageIndex(0);
  }, [images]);

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

  const product = detail?.product;
  const variants = detail?.variants;
  const variant = variants ? variants.find(v => v.id === selectedVariantId) || variants[0] : null;

  // Switching artwork or variant: restore an already-generated mockup for this exact combo
  // instantly (e.g. every size of a t-shirt in the same color shares one print file, so
  // there's nothing new to render -- see useMockup's cache), otherwise drop back to idle so
  // the previous selection's mockup doesn't keep showing as if it were current.
  useEffect(() => {
    if (!product || !variant || !printfileSpecs) return;
    syncMockup({ product, printfileSpecs, variant, design: selectedDesign });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedKey, selectedVariantId, product, printfileSpecs]);

  if (loading) {
    return (
      <PageContainer title="Loading…">
        <p className="text-text-secondary">Fetching product…</p>
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

  const hasMultipleColors = new Set(variants.map(v => v.color)).size > 1;
  const busy = BUSY.includes(status);
  const hasMockup = status === 'completed' && images.length > 0;
  const heroImage = hasMockup ? images[activeImageIndex].mockup_url : product.image;

  const onGenerateClick = () => generate({ product, printfileSpecs, variant, design: selectedDesign });

  // No Stripe integration yet (that's its own later phase) -- this previews the page's final
  // shape without pretending checkout works. Gated behind a real mockup existing, since
  // buying before seeing what you're printing doesn't make sense regardless of payments.
  const onBuyNowClick = () => {
    setCheckoutNotice("Checkout isn't connected yet -- coming in a later phase.");
  };

  return (
    <PageContainer
      title={product.title}
      actions={
        <Link to="/shop" className="font-quicksand text-sm text-text-muted transition hover:text-text">
          ← Shop
        </Link>
      }
    >
      {/* Step 1: artwork. Full-width, above the gallery/purchase columns -- it drives both. */}
      <div className="mb-8">
        <h2 className="font-quicksand text-sm font-bold uppercase tracking-wide text-text-secondary">
          1. Choose artwork
        </h2>
        <div ref={artworkStripRef} className="no-scrollbar mt-3 flex gap-2 overflow-x-auto px-0.5 pb-1">
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
                  'h-16 w-16 shrink-0 cursor-pointer overflow-hidden rounded-lg border-2 bg-ink-900 transition ' +
                  (selected ? 'border-accent' : 'border-hairline hover:border-text-muted')
                }
              >
                {c.thumb && <img src={c.thumb} alt={c.label} className="h-full w-full object-cover" />}
              </button>
            );
          })}
        </div>
        <p className="mt-2 truncate text-xs text-text-secondary">{selectedChoice.label}</p>
        {!user && (
          <p className="mt-1 text-xs text-text-muted">
            <Link to="/account" className="text-accent underline">Sign in</Link> to choose from your saved designs.
          </p>
        )}
      </div>

      <div className="grid grid-cols-1 gap-10 lg:grid-cols-[3fr_2fr]">
        {/* Gallery: one large hero image that upgrades in place from blank stock photo to
            the real mockup, instead of a small mockup grid competing with a separate
            "useless" blank photo elsewhere on the page. */}
        <div>
          <div className="relative aspect-square overflow-hidden rounded-xl border border-hairline bg-ink-900">
            <img src={heroImage} alt={product.title} className="h-full w-full object-cover" />
            {!hasMockup && (
              <div className="absolute inset-0 flex items-center justify-center bg-black/50 p-6">
                {!user ? (
                  <p className="max-w-xs text-center text-sm text-text">
                    <Link to="/account" className="text-accent underline">Sign in</Link> to generate a mockup of your design.
                  </p>
                ) : busy ? (
                  <div className="flex flex-col items-center gap-3 text-center text-text">
                    <HexagonLoader />
                    <p className="text-sm font-bold">{STATUS_LABEL[status]}</p>
                    <p className="text-xs text-text-secondary">This usually takes 30–90 seconds.</p>
                  </div>
                ) : status === 'failed' ? (
                  <div className="flex flex-col items-center gap-3 text-center">
                    <p className="max-w-xs text-sm text-accent">{mockupError}</p>
                    <Button onClick={onGenerateClick} disabled={!selectedDesign}>
                      Try again
                    </Button>
                  </div>
                ) : (
                  <Button onClick={onGenerateClick} disabled={!selectedDesign}>
                    Generate mockup
                  </Button>
                )}
              </div>
            )}
          </div>

          {hasMockup && images.length > 1 && (
            <div className="no-scrollbar mt-3 flex gap-2 overflow-x-auto px-0.5 pb-1">
              {images.map((m, i) => (
                <button
                  key={m.style_id}
                  type="button"
                  onClick={() => setActiveImageIndex(i)}
                  aria-pressed={i === activeImageIndex}
                  title={m.display_name}
                  className={
                    'h-16 w-16 shrink-0 cursor-pointer overflow-hidden rounded-lg border-2 transition ' +
                    (i === activeImageIndex ? 'border-accent' : 'border-hairline hover:border-text-muted')
                  }
                >
                  <img src={m.mockup_url} alt={m.display_name} className="h-full w-full object-cover" />
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Purchase panel: size/color, quantity, total, checkout. */}
        <div>
          <div className="flex items-baseline justify-between">
            <h2 className="font-quicksand text-sm font-bold uppercase tracking-wide text-text-secondary">
              2. Size{hasMultipleColors ? ' & color' : ''}
            </h2>
            <span className="font-quicksand text-sm font-bold text-text">${variant.price}</span>
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
                      : 'border-hairline text-text-secondary hover:border-text')
                  }
                >
                  {v.size}
                  {hasMultipleColors && v.color ? ` / ${v.color}` : ''}
                </button>
              );
            })}
          </div>

          <div className="mt-8">
            <h2 className="font-quicksand text-sm font-bold uppercase tracking-wide text-text-secondary">
              Quantity
            </h2>
            <div className="mt-3 inline-flex items-center gap-4 rounded-lg border border-hairline px-4 py-2">
              <button
                type="button"
                onClick={() => setQty(q => Math.max(1, q - 1))}
                aria-label="Decrease quantity"
                className="cursor-pointer font-quicksand text-lg text-text-secondary hover:text-text"
              >
                −
              </button>
              <span className="w-4 text-center font-quicksand font-bold text-text">{qty}</span>
              <button
                type="button"
                onClick={() => setQty(q => Math.min(10, q + 1))}
                aria-label="Increase quantity"
                className="cursor-pointer font-quicksand text-lg text-text-secondary hover:text-text"
              >
                +
              </button>
            </div>
          </div>

          <div className="mt-8 border-t border-hairline pt-6">
            <div className="flex items-baseline justify-between">
              <span className="font-quicksand text-sm text-text-secondary">Total</span>
              <span className="font-display text-2xl text-text">
                ${(variant.price * qty).toFixed(2)}
              </span>
            </div>

            {!user ? (
              <Button as={Link} to="/account" className="mt-4 w-full">
                Sign in to buy
              </Button>
            ) : (
              <Button className="mt-4 w-full" disabled={!hasMockup} onClick={onBuyNowClick}>
                Buy now
              </Button>
            )}
            {user && !hasMockup && (
              <p className="mt-2 text-center text-xs text-text-muted">
                Generate a mockup above before you check out.
              </p>
            )}
            {checkoutNotice && (
              <p className="mt-2 text-center text-xs text-accent">{checkoutNotice}</p>
            )}
            <p className="mt-3 text-center text-xs text-text-muted">
              Printed on demand and shipped by Printful. No returns on custom prints.
            </p>
          </div>
        </div>
      </div>
    </PageContainer>
  );
}
