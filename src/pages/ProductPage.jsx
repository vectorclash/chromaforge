import React, { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import PageContainer from '../components/ui/PageContainer';
import Button from '../components/ui/Button';
import { getCatalogProduct, getPrintfileSpecs } from '../lib/printful';
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
  const { currentDesign, renderDesignBlob, queueReady } = useStudio();
  const { user } = useAuth();
  const { status, error: mockupError, images, generate } = useMockup();

  const [detail, setDetail] = useState(null); // { product, variants }
  const [printfileSpecs, setPrintfileSpecs] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [previewUrl, setPreviewUrl] = useState(null);
  const [selectedVariantId, setSelectedVariantId] = useState(null);

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

  // Render a preview of the current design (what will be printed) off-canvas.
  useEffect(() => {
    if (!currentDesign || !queueReady) {
      setPreviewUrl(null);
      return;
    }
    let url;
    let cancelled = false;
    renderDesignBlob(currentDesign, 600, 600)
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
  }, [currentDesign, queueReady, renderDesignBlob]);

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
      <div className="grid grid-cols-1 gap-10 lg:grid-cols-2">
        {/* Product + variants */}
        <div>
          <div className="aspect-square overflow-hidden rounded-xl border border-neutral-200 bg-neutral-100">
            <img src={product.image} alt={product.title} className="h-full w-full object-cover" />
          </div>
          <div className="mt-6">
            <div className="flex items-baseline justify-between">
              <h2 className="font-quicksand text-sm font-bold uppercase tracking-wide text-neutral-500">
                Size{hasMultipleColors ? ' & color' : ''}
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

        {/* Design preview + mockup */}
        <div>
          <h2 className="font-quicksand text-sm font-bold uppercase tracking-wide text-neutral-500">
            Your design
          </h2>
          <div className="mt-2 aspect-square overflow-hidden rounded-xl border border-neutral-200 bg-neutral-100">
            {previewUrl ? (
              <img src={previewUrl} alt="Your current design" className="h-full w-full object-cover" />
            ) : (
              <div className="flex h-full items-center justify-center p-6 text-center text-sm text-neutral-500">
                {currentDesign ? 'Rendering preview…' : (
                  <span>
                    No design yet.{' '}
                    <Link to="/" className="text-accent underline">Create one in the Studio →</Link>
                  </span>
                )}
              </div>
            )}
          </div>

          <div className="mt-6">
            {!user ? (
              <p className="text-sm text-neutral-500">
                <Link to="/account" className="text-accent underline">Sign in</Link> to preview your
                design on this product.
              </p>
            ) : (
              <Button onClick={() => generate({ product, printfileSpecs, variant, design: currentDesign })} disabled={busy || !currentDesign}>
                {busy ? STATUS_LABEL[status] : 'Generate mockup'}
              </Button>
            )}
            {status === 'failed' && mockupError && (
              <p className="mt-3 text-sm text-accent">{mockupError}</p>
            )}
            {status === 'completed' && images.length > 0 && (
              <div className="mt-4 grid grid-cols-2 gap-3">
                {images.map(m => (
                  <div key={m.style_id} className="overflow-hidden rounded-lg border border-neutral-200">
                    <img src={m.mockup_url} alt={m.display_name} className="w-full" />
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
