import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import PageContainer from '../components/ui/PageContainer';
import Card from '../components/ui/Card';
import FadeImage from '../components/ui/FadeImage';
import SkeletonGrid from '../components/ui/SkeletonGrid';
import { SHOP_GRID_CLASS, SHOP_TILE_COUNT } from '../components/ui/RouteSkeleton';
import { listCatalogProducts, STARTER_PRODUCT_IDS } from '../lib/printful';
import { usePageMeta } from '../hooks/usePageMeta';
import { preloadImages } from '../utils/preloadImages';
import { DURATION_SLOW } from '../utils/motionTokens';

// One source of truth for the grid geometry, shared with SiteLayout's route-level fallback:
// three placeholders hand over to each other on a cold load (chunk download -> this page's
// own skeleton -> the real cards), and any divergence in columns, gaps or tile count would
// show as the placeholder sliding sideways or the page jumping as it fades.
const GRID_CLASS = SHOP_GRID_CLASS;

// The route-level fallback can't import STARTER_PRODUCT_IDS -- that would drag lib/printful
// and the whole render pipeline into the main bundle -- so it mirrors the count as a literal.
// This is the guard against the two drifting when a product is added or removed.
if (import.meta.env.DEV && SHOP_TILE_COUNT !== STARTER_PRODUCT_IDS.length) {
  console.warn(
    `SHOP_TILE_COUNT (${SHOP_TILE_COUNT}) no longer matches STARTER_PRODUCT_IDS.length ` +
      `(${STARTER_PRODUCT_IDS.length}) -- update it in components/ui/RouteSkeleton.jsx, or the ` +
      `shop's loading placeholder will reserve the wrong height.`
  );
}

// Three columns at lg, so six tiles is roughly the first screenful; the rest stream in
// under their own per-card placeholders, off-screen.
const PRELOAD_COUNT = 6;

// The storefront: the curated, spec-verified starter products (see STARTER_PRODUCT_IDS in
// lib/printful.js for the current list). Each tile links to its product page where the
// current design is previewed and mocked up.
export default function ShopPage() {
  usePageMeta({
    title: 'Shop',
    description: 'Wear the algorithm. Generative art printed on demand on shirts, hoodies, and more — every piece is generated, never reprinted.',
    path: '/shop'
  });
  const [products, setProducts] = useState([]);
  // Catalog has landed AND the first screenful of product photos has decoded -- the moment
  // the real grid is worth showing. Replaces a plain `loading` flag tracking the fetch
  // alone: dropping the placeholder the instant the JSON arrived, while every photo was
  // still in flight, left a grid of blank cards filling in afterwards (see the gallery's
  // own notes and utils/preloadImages.js).
  const [revealed, setRevealed] = useState(false);
  // The placeholder outlives `revealed` by one transition so it fades out UNDER the
  // incoming cards, rather than being cut away and leaving a frame where neither is
  // painted -- the real cards start at opacity 0, `animate-fade-slide-up` being `backwards`.
  const [skeletonMounted, setSkeletonMounted] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const all = await listCatalogProducts();
        const byId = new Map(all.map(p => [p.id, p]));
        const starter = STARTER_PRODUCT_IDS.map(id => byId.get(id)).filter(Boolean);
        if (cancelled) return;
        setProducts(starter);
        // Hold the placeholder across the image fetch too, so the grid arrives complete.
        // Bounded and never rejecting, so a slow CDN cannot keep the shop from appearing.
        await preloadImages(starter.slice(0, PRELOAD_COUNT).map(p => p.image).filter(Boolean));
      } catch (err) {
        if (!cancelled) setError(err.message);
      } finally {
        if (!cancelled) setRevealed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Drop the faded-out placeholder once its transition has run. A timer rather than
  // `transitionend`, which never fires when prefers-reduced-motion collapses the
  // transition to ~0ms -- that would strand it in the DOM.
  useEffect(() => {
    if (!revealed) return;
    const t = setTimeout(() => setSkeletonMounted(false), DURATION_SLOW * 1000);
    return () => clearTimeout(t);
  }, [revealed]);

  return (
    <PageContainer title="Shop" subtitle="Wear the algorithm. Every piece is generated, never reprinted.">
      {/* Placeholder and real grid share one relative box and overlap for the crossfade.
          While waiting the placeholder is in normal flow and gives the page its height; on
          reveal it flips to absolute so the real grid takes over layout without the page
          collapsing for a frame, and fades out on top. The tile count is EXACT from the
          first frame here -- unlike the gallery, the shop knows how many products it is
          about to show before it asks (STARTER_PRODUCT_IDS is a compile-time list), so the
          placeholder can never promise a different page height than the content delivers. */}
      {skeletonMounted && !error && (
        <div className="relative">
          <SkeletonGrid
            count={SHOP_TILE_COUNT}
            className={`${GRID_CLASS} transition-opacity duration-500 ease-out ${
              revealed ? 'pointer-events-none absolute inset-x-0 top-0 opacity-0' : 'opacity-100'
            }`}
          />
        </div>
      )}
      {error && <p className="animate-pop-in text-accent">{error}</p>}
      {revealed && !error && (
        <div className={GRID_CLASS}>
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
                {/* -inset-px, not inset-0: the overlay and the image are the same computed box, but
                    an aspect-square card resolves to a FRACTIONAL height at most widths, and on a
                    high-DPR screen the two can rasterise to different device-pixel extents --
                    leaving a hairline of undarkened image along the bottom edge, intermittently,
                    depending on how each card's width happens to round. Bleeding the overlay a
                    pixel past its box costs nothing (the card's own overflow-hidden clips it) and
                    removes the whole class of mismatch rather than the bottom edge alone. */}
                <div className="pointer-events-none absolute -inset-px bg-[linear-gradient(to_top,rgba(0,0,0,0.92)_0%,rgba(0,0,0,0.55)_30%,rgba(0,0,0,0.18)_55%,transparent_75%)]" />
                <div className="absolute inset-x-0 bottom-0 p-4">
                  {/* Hidden-until-hover only on devices with a hover-capable pointer -- on
                      touch there's no real `:hover` to reveal this, so without the
                      media-query gate the product title itself (not just the CTA line)
                      would be permanently invisible on mobile instead of just
                      hover-deferred on desktop. */}
                  <div className="[@media(hover:hover)]:translate-y-6 transition-transform duration-300 ease-out [@media(hover:hover)]:group-hover:translate-y-0 [@media(hover:hover)]:group-focus-within:translate-y-0">
                    <h2 className="font-quicksand text-sm font-bold text-text">{product.title}</h2>
                    <p className="mt-1 text-sm text-text-secondary [@media(hover:hover)]:opacity-0 transition-opacity duration-300 ease-out [@media(hover:hover)]:group-hover:opacity-100 [@media(hover:hover)]:group-focus-within:opacity-100">
                      Apply this design →
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
