import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Card from '../ui/Card';
import GalleryThumbnail from '../ui/GalleryThumbnail';
import ShirtIcon from '../buttons/ShirtIcon';
import AuthorBadge from '../ui/AuthorBadge';
import { listFeaturedDesigns, listTopLikedDesigns, MAX_FEATURED } from '../../lib/designs';
import { useStudio } from '../../context/StudioContext';
import { useScrollTriggerReveal } from '../../hooks/useScrollTriggerReveal';
import { track } from '../../lib/track';

// The homepage's hand-picked designs (2026-11-18, Aaron: until people use the social features,
// "most liked" is a waste of the slot). Up to 8 designs chosen by an admin from the gallery
// modal (featured_designs, migration 0027). A card does not open the gallery modal: it makes that
// design the ACTIVE one and goes to the shop, so every product there is already wearing it --
// the same landing an ad link (`/shop?id=`) gives.
//
// Fewer than 8 picks are topped up with the most-liked public images, so the grid is always
// full (and never empty before anything has been picked). Animations are left out of the top-up,
// since they cannot be printed.
//
// GallerySection (the community module this replaced) is kept as it was, unmounted, for when the
// gallery has the engagement to carry it -- swap it back in HomePage.
//
// Keeps the section id "gallery" so HomePage's home_section event stays continuous.
export default function FeaturedSection() {
  const { activateSavedDesign } = useStudio();
  const navigate = useNavigate();
  const [designs, setDesigns] = useState([]);
  const [loading, setLoading] = useState(true);
  const ref = useScrollTriggerReveal([loading]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      let picked = [];
      try {
        picked = await listFeaturedDesigns();
      } catch (err) {
        console.warn('Featured designs could not be loaded:', err?.message || err);
      }
      let rows = picked.slice(0, MAX_FEATURED);
      if (rows.length < MAX_FEATURED) {
        try {
          // Over-fetch: animations and the picks themselves are filtered out of the top-up.
          const popular = await listTopLikedDesigns({ limit: MAX_FEATURED * 3 });
          const have = new Set(rows.map(d => d.id));
          const extra = popular.filter(d => d.kind !== 'animation' && !have.has(d.id));
          rows = rows.concat(extra.slice(0, MAX_FEATURED - rows.length));
        } catch (err) {
          console.warn('Top designs could not be loaded:', err?.message || err);
        }
      }
      if (cancelled) return;
      setDesigns(rows);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const onPick = design => {
    if (!activateSavedDesign(design)) return;
    track('shop_click', { from: 'featured' });
    navigate('/shop');
  };

  // Nothing to show (no picks and the gallery could not be read): leave the slot out rather than
  // put an error on the homepage. The shop carousel right below still sells.
  if (!loading && designs.length === 0) return null;

  return (
    <section id="gallery" ref={ref} className="bg-ink-200">
      <div className="mx-auto max-w-5xl px-6 py-24">
        <div className="reveal-item mb-10">
          <p className="font-quicksand text-xs font-bold uppercase tracking-[0.18em] text-ink-950">
            Featured artwork
          </p>
          <h2 className="mt-3 font-display text-3xl font-bold text-ink-950">Ready to wear</h2>
          <p className="mt-3 max-w-md text-ink-950/70">
            Pieces picked from the forge. Tap one to see it on everything in the shop.
          </p>
        </div>

        {loading ? (
          // Same footprint as the loaded grid, so the shop carousel below doesn't jump when the
          // cards land.
          <div className="grid grid-cols-2 gap-5 sm:grid-cols-4" aria-hidden="true">
            {Array.from({ length: MAX_FEATURED }, (_, i) => (
              <div key={i} className="aspect-square animate-pulse rounded-xl bg-ink-950/10" />
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-5 sm:grid-cols-4">
            {designs.map(design => (
              <Card
                key={design.id}
                className="reveal-item group cursor-pointer"
                onClick={() => onPick(design)}
                role="link"
                tabIndex={0}
                aria-label={`Shop products with ${design.title || 'this design'}`}
                onKeyDown={e => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onPick(design);
                  }
                }}
              >
                <div className="relative aspect-square overflow-hidden bg-ink-800">
                  <GalleryThumbnail
                    design={design}
                    className="h-full w-full object-cover transition-transform duration-300 ease-out group-hover:scale-[1.08]"
                  />
                  {/* -inset-px: see GallerySection's note on fractional card heights. */}
                  <div className="pointer-events-none absolute -inset-px bg-[linear-gradient(to_top,rgba(0,0,0,0.85)_0%,rgba(0,0,0,0.4)_22%,rgba(0,0,0,0.1)_40%,transparent_60%)]" />
                  <div className="absolute inset-x-0 bottom-0 overflow-hidden p-3">
                    {/* Same hover-only reveal as the gallery cards: on touch there is no hover,
                        so the call to action stays visible there. */}
                    <div className="space-y-1 [@media(hover:hover)]:translate-y-5 transition-transform duration-300 ease-out [@media(hover:hover)]:group-hover:translate-y-0 [@media(hover:hover)]:group-focus-within:translate-y-0 [@media(hover:hover)]:group-focus-visible:translate-y-0">
                      <AuthorBadge profile={design.profiles} />
                      <span className="flex items-center gap-1.5 truncate text-xs text-accent [@media(hover:hover)]:opacity-0 transition-opacity duration-300 ease-out [@media(hover:hover)]:group-hover:opacity-100 [@media(hover:hover)]:group-focus-visible:opacity-100">
                        <ShirtIcon size={12} />
                        Shop this design &rarr;
                      </span>
                    </div>
                  </div>
                </div>
              </Card>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
