import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import Card from '../ui/Card';
import { listCatalogProducts, STARTER_PRODUCT_IDS } from '../../lib/printful';

// Homepage preview of the shop -- a horizontal scroller of the catalog (currently the two
// spec-verified starter products; built to scale as more are added, see lib/printful.js).
// Solid surface, same product data as the full Shop page.
export default function ShopCarousel() {
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    listCatalogProducts()
      .then(all => {
        if (!cancelled) setProducts(all.filter(p => STARTER_PRODUCT_IDS.includes(p.id)));
      })
      .catch(err => {
        if (!cancelled) setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Distinguish "genuinely no products" (return null -- nothing to show) from "the catalog
  // fetch failed" (show it, with the error) -- both used to look identical (silently
  // vanish), which made a real Printful outage indistinguishable from an intentionally
  // empty catalog.
  if (!loading && !error && products.length === 0) return null;

  return (
    <section id="shop" className="mx-auto max-w-5xl px-6 py-24">
      <div className="mb-10 flex items-end justify-between gap-4">
        <div>
          <p className="font-quicksand text-xs font-bold uppercase tracking-[0.18em] text-accent">
            Wear it
          </p>
          <h2 className="mt-3 font-display text-3xl text-text">Print-on-demand merch</h2>
        </div>
        <Link to="/shop" className="font-quicksand text-sm text-text-muted transition hover:text-text">
          View all &rarr;
        </Link>
      </div>

      {loading ? (
        <p className="text-text-secondary">Loading&hellip;</p>
      ) : error ? (
        <p className="text-accent">Couldn't load the shop right now.</p>
      ) : (
        <div className="no-scrollbar flex gap-5 overflow-x-auto pb-2">
          {products.map(product => (
            <Card
              key={product.id}
              as={Link}
              to={`/shop/${product.id}`}
              className="group w-64 shrink-0"
            >
              <div className="aspect-square overflow-hidden bg-ink-900">
                <img
                  src={product.image}
                  alt={product.title}
                  className="h-full w-full object-cover transition group-hover:scale-[1.02]"
                />
              </div>
              <div className="p-4">
                <h3 className="font-quicksand text-sm font-bold text-text">{product.title}</h3>
                <p className="mt-1 text-sm text-text-secondary">Customize with your design &rarr;</p>
              </div>
            </Card>
          ))}
        </div>
      )}
    </section>
  );
}
