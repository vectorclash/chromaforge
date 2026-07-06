import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import PageContainer from '../components/ui/PageContainer';
import Card from '../components/ui/Card';
import FadeImage from '../components/ui/FadeImage';
import SkeletonGrid from '../components/ui/SkeletonGrid';
import { listCatalogProducts, STARTER_PRODUCT_IDS } from '../lib/printful';
import { usePageTitle } from '../hooks/usePageTitle';

// The storefront: the curated, spec-verified starter products (see STARTER_PRODUCT_IDS in
// lib/printful.js for the current list). Each tile links to its product page where the
// current design is previewed and mocked up.
export default function ShopPage() {
  usePageTitle('Shop');
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const all = await listCatalogProducts();
        const byId = new Map(all.map(p => [p.id, p]));
        const starter = STARTER_PRODUCT_IDS.map(id => byId.get(id)).filter(Boolean);
        if (!cancelled) setProducts(starter);
      } catch (err) {
        if (!cancelled) setError(err.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <PageContainer title="Shop" subtitle="Wear the algorithm. Every piece is generated, never reprinted.">
      {loading && (
        <SkeletonGrid count={6} className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3" />
      )}
      {error && <p className="animate-pop-in text-accent">{error}</p>}
      {!loading && !error && (
        <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {products.map((product, i) => (
            <Card
              key={product.id}
              as={Link}
              to={`/shop/${product.id}`}
              className="group animate-fade-slide-up"
              style={{ animationDelay: `${Math.min(i, 10) * 50}ms` }}
            >
              <div className="relative aspect-square overflow-hidden bg-ink-900">
                <FadeImage
                  src={product.image}
                  alt={product.title}
                  className="h-full w-full object-cover transition-transform duration-300 ease-out group-hover:scale-[1.08]"
                />
                <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(to_top,rgba(0,0,0,0.92)_0%,rgba(0,0,0,0.55)_30%,rgba(0,0,0,0.18)_55%,transparent_75%)]" />
                <div className="absolute inset-x-0 bottom-0 p-4">
                  {/* Hidden-until-hover only on devices with a hover-capable pointer -- on
                      touch there's no real `:hover` to reveal this, so without the
                      media-query gate the product title itself (not just the CTA line)
                      would be permanently invisible on mobile instead of just
                      hover-deferred on desktop. */}
                  <div className="[@media(hover:hover)]:translate-y-6 transition-transform duration-300 ease-out [@media(hover:hover)]:group-hover:translate-y-0 [@media(hover:hover)]:group-focus-within:translate-y-0">
                    <h2 className="font-quicksand text-sm font-bold text-text">{product.title}</h2>
                    <p className="mt-1 text-sm text-text-secondary [@media(hover:hover)]:opacity-0 transition-opacity duration-300 ease-out [@media(hover:hover)]:group-hover:opacity-100 [@media(hover:hover)]:group-focus-within:opacity-100">
                      Customize with your design →
                    </p>
                  </div>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}
    </PageContainer>
  );
}
