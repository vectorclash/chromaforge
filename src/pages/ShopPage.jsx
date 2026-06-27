import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import PageContainer from '../components/ui/PageContainer';
import Card from '../components/ui/Card';
import { listCatalogProducts, STARTER_PRODUCT_IDS } from '../lib/printful';

// The storefront: the curated, spec-verified starter products (one AOP tee, one AOP
// hoodie). Each tile links to its product page where the current design is previewed and
// mocked up.
export default function ShopPage() {
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const all = await listCatalogProducts();
        const starter = all.filter(p => STARTER_PRODUCT_IDS.includes(p.id));
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
      {loading && <p className="text-text-secondary">Loading products…</p>}
      {error && <p className="text-accent">{error}</p>}
      {!loading && !error && (
        <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {products.map(product => (
            <Card key={product.id} as={Link} to={`/shop/${product.id}`} className="group">
              <div className="aspect-square overflow-hidden bg-ink-900">
                <img
                  src={product.image}
                  alt={product.title}
                  className="h-full w-full object-cover transition group-hover:scale-[1.02]"
                />
              </div>
              <div className="p-4">
                <h2 className="font-quicksand text-sm font-bold text-text">{product.title}</h2>
                <p className="mt-1 text-sm text-text-secondary">Customize with your design →</p>
              </div>
            </Card>
          ))}
        </div>
      )}
    </PageContainer>
  );
}
