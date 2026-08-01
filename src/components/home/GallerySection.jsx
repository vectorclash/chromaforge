import React, { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import Card from '../ui/Card';
import FadeImage from '../ui/FadeImage';
import GalleryModal from '../ui/GalleryModal';
import HeartIcon from '../buttons/HeartIcon';
import AnimationIcon from '../buttons/AnimationIcon';
import { listTopLikedDesigns, listMyLikedIds, toggleLike, getThumbnailUrl } from '../../lib/designs';
import { useAuth } from '../../context/AuthContext';
import { useStudio } from '../../context/StudioContext';
import { useScrollTriggerReveal } from '../../hooks/useScrollTriggerReveal';
import AuthorBadge from '../ui/AuthorBadge';

// Homepage preview of the gallery -- the 8 most-liked public designs. Solid surface (no
// live art behind the grid as a whole; the artworks themselves are the content). Thumbnails
// are the same pre-rendered JPEGs the full Gallery page uses (uploaded at save time via
// StudioContext.saveCurrentDesign -> uploadDesignThumbnail), not a second render path.
export default function GallerySection() {
  const { user } = useAuth();
  const { setPrintQueueDesign } = useStudio();
  const navigate = useNavigate();
  const [designs, setDesigns] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [likedIds, setLikedIds] = useState(() => new Set());
  // Same pattern as GalleryPage: the id, not the object, so the modal always reflects
  // fresh data (e.g. a like-count bump) instead of a stale snapshot from when it opened.
  const [openDesignId, setOpenDesignId] = useState(null);
  const openDesign = designs.find(d => d.id === openDesignId) || null;
  // The real content this needs to stagger (the cards, or the empty/error message) only
  // exists once the fetch below resolves -- see useScrollTriggerReveal's own comment on
  // why `[loading]` has to be passed here.
  const ref = useScrollTriggerReveal([loading]);

  useEffect(() => {
    let cancelled = false;
    listTopLikedDesigns({ limit: 8 })
      .then(rows => {
        if (cancelled) return;
        setDesigns(rows);
        listMyLikedIds(rows.map(d => d.id))
          .then(ids => !cancelled && setLikedIds(new Set(ids)))
          .catch(() => {});
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

  // Load a saved design into the full studio -- same approach as GalleryPage.onOpenStudio,
  // routing to its real database id so /studio's getDesignIdFromUrl/getDesign path fetches
  // and reconstructs it on mount (see utils/urlConfig.js). Reached via the gallery modal's
  // own "Open in studio" link now, not directly from the card (see onClick below).
  const onOpenStudio = design => {
    navigate(`/studio?id=${design.id}`, { state: { from: '/' } });
  };

  // "Print this" -- same hand-off as GalleryPage.onPrint: queue the design in
  // StudioContext (a one-shot hand-off ProductPage reads on mount) and jump to the catalog.
  const onPrint = (design, e) => {
    e?.stopPropagation();
    setPrintQueueDesign(design);
    navigate('/shop');
  };

  // Same optimistic toggle as GalleryPage.onToggleLike -- see that file for the rationale on
  // why this is local-only rather than refetching (likes_count is server-authoritative via a
  // DB trigger, this just avoids a round-trip before the heart visibly flips). `e` is only
  // passed when this fires from the card's own desktop-hover pill button, to stop the click
  // from also bubbling up and opening the modal -- the modal's own Like button calls this
  // with no event at all.
  const onToggleLike = async (design, e) => {
    e?.stopPropagation();
    if (!user) {
      navigate('/account');
      return;
    }
    const wasLiked = likedIds.has(design.id);
    setLikedIds(prev => {
      const next = new Set(prev);
      wasLiked ? next.delete(design.id) : next.add(design.id);
      return next;
    });
    setDesigns(rows =>
      rows.map(d =>
        d.id === design.id ? { ...d, likes_count: (d.likes_count || 0) + (wasLiked ? -1 : 1) } : d
      )
    );
    try {
      await toggleLike(design.id);
    } catch {
      setLikedIds(prev => {
        const next = new Set(prev);
        wasLiked ? next.add(design.id) : next.delete(design.id);
        return next;
      });
      setDesigns(rows =>
        rows.map(d =>
          d.id === design.id
            ? { ...d, likes_count: (d.likes_count || 0) + (wasLiked ? 1 : -1) }
            : d
        )
      );
    }
  };

  if (!loading && (error || designs.length === 0)) {
    return (
      <section id="gallery" ref={ref} className="bg-ink-200">
        <div className="mx-auto max-w-5xl px-6 py-24 text-center">
          <p className="reveal-item font-quicksand text-xs font-bold uppercase tracking-[0.18em] text-ink-950">
            Community gallery
          </p>
          <h2 className="reveal-item mt-3 font-display text-3xl font-bold text-ink-950">Most-liked designs</h2>
          {error ? (
            <p className="reveal-item mt-4 text-accent">Couldn&rsquo;t load the gallery.</p>
          ) : (
            <p className="reveal-item mt-4 text-ink-950/70">
              No public designs yet. Be the first &mdash;{' '}
              <Link to="/studio" state={{ from: '/' }} className="text-accent underline">
                open the studio
              </Link>
              .
            </p>
          )}
        </div>
      </section>
    );
  }

  return (
    <section id="gallery" ref={ref} className="bg-ink-200">
      <div className="mx-auto max-w-5xl px-6 py-24">
        <div className="reveal-item mb-10">
          <p className="font-quicksand text-xs font-bold uppercase tracking-[0.18em] text-ink-950">
            Community gallery
          </p>
          <h2 className="mt-3 font-display text-3xl font-bold text-ink-950">Most-liked designs</h2>
        </div>

        {loading ? (
          <p className="text-ink-950/70">Loading&hellip;</p>
        ) : (
          <div className="grid grid-cols-2 gap-5 sm:grid-cols-4">
            {designs.map(design => (
              <Card
                key={design.id}
                className="reveal-item group cursor-pointer"
                onClick={() => setOpenDesignId(design.id)}
              >
                <div className="relative aspect-square overflow-hidden bg-ink-800">
                  <FadeImage
                    src={getThumbnailUrl(design.user_id, design.id)}
                    alt={design.title || 'Untitled design'}
                    onError={e => {
                      e.target.style.visibility = 'hidden';
                    }}
                    className="h-full w-full object-cover transition-transform duration-300 ease-out group-hover:scale-[1.08]"
                  />
                  {/* -inset-px, not inset-0: the overlay and the image are the same computed box, but
                      an aspect-square card resolves to a FRACTIONAL height at most widths, and on a
                      high-DPR screen the two can rasterise to different device-pixel extents --
                      leaving a hairline of undarkened image along the bottom edge, intermittently,
                      depending on how each card's width happens to round. Bleeding the overlay a
                      pixel past its box costs nothing (the card's own overflow-hidden clips it) and
                      removes the whole class of mismatch rather than the bottom edge alone. */}
                  <div className="pointer-events-none absolute -inset-px bg-[linear-gradient(to_top,rgba(0,0,0,0.85)_0%,rgba(0,0,0,0.4)_22%,rgba(0,0,0,0.1)_40%,transparent_60%)]" />
                  {/* Always visible, not hidden-until-hover -- see GalleryPage.jsx's own copy
                      of this badge for why (a thumbnail alone can't distinguish an animation
                      from a still image, and this card doesn't even show a title to fall
                      back on). */}
                  {design.kind === 'animation' && (
                    <div
                      className="pointer-events-none absolute left-2 top-2 flex items-center gap-1 rounded-full bg-black/40 px-2 py-1 text-text backdrop-blur-sm"
                      title="Animation"
                    >
                      <AnimationIcon size={12} />
                    </div>
                  )}
                  <div className="absolute inset-x-0 bottom-0 overflow-hidden p-3">
                    {/* Hidden-until-hover only on devices with a hover-capable pointer, same
                        pattern as the like button below -- on touch there's no real
                        `:hover` to reveal this, so without the media-query gate the
                        caption/CTA would be permanently invisible on mobile instead of just
                        hover-deferred on desktop. */}
                    {/* space-y-1 rather than relying on line-height alone: the byline is a flex
                        row containing a 16px avatar circle, so it is taller than the plain text
                        lines it sits between and crowded them once the avatar landed there. */}
                    <div className="space-y-1 [@media(hover:hover)]:translate-y-5 transition-transform duration-300 ease-out [@media(hover:hover)]:group-hover:translate-y-0 [@media(hover:hover)]:group-focus-within:translate-y-0">
                      <AuthorBadge profile={design.profiles} />
                      {/* Was "Open in studio" -- clicking a card now opens the gallery
                          modal (with its own explicit "Open in studio" link) instead of
                          jumping straight into the Studio. */}
                      <span className="block truncate text-xs text-accent [@media(hover:hover)]:opacity-0 transition-opacity duration-300 ease-out [@media(hover:hover)]:group-hover:opacity-100 [@media(hover:hover)]:group-focus-within:opacity-100">
                        View design &rarr;
                      </span>
                    </div>
                  </div>
                  {/* Desktop-only quick like -- `hidden` by default (touch devices rely on
                      the gallery modal instead, opened by tapping the card, for a real
                      touch-target-sized Like button), shown as a hover-capable-only flex
                      pill so it behaves exactly as it did before the modal existed on
                      devices that actually have a mouse. Same reasoning as GalleryPage's
                      own hover pill. */}
                  <button
                    onClick={e => onToggleLike(design, e)}
                    className={
                      'absolute right-2 top-2 -m-1 hidden items-center gap-1 rounded-full bg-black/40 px-3 py-2 backdrop-blur-sm transition duration-200 ease-out [@media(hover:hover)]:flex [@media(hover:hover)]:-translate-y-1 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:translate-y-0 [@media(hover:hover)]:group-hover:opacity-100 [@media(hover:hover)]:group-focus-within:translate-y-0 [@media(hover:hover)]:group-focus-within:opacity-100 ' +
                      (likedIds.has(design.id) ? 'text-accent' : 'text-text hover:text-accent')
                    }
                    aria-label={likedIds.has(design.id) ? 'Unlike this design' : 'Like this design'}
                    title={likedIds.has(design.id) ? 'Unlike' : 'Like'}
                  >
                    <HeartIcon filled={likedIds.has(design.id)} />
                    {design.likes_count > 0 && <span className="text-xs">{design.likes_count}</span>}
                  </button>
                </div>
              </Card>
            ))}
          </div>
        )}

        <div className="reveal-item mt-8 flex justify-start">
          <Link to="/gallery" className="font-quicksand text-sm text-ink-950/60 transition hover:text-ink-950">
            View full gallery &rarr;
          </Link>
        </div>
      </div>

      <GalleryModal
        design={openDesign}
        liked={!!openDesign && likedIds.has(openDesign.id)}
        canDelete={false}
        onClose={() => setOpenDesignId(null)}
        onToggleLike={onToggleLike}
        onPrint={onPrint}
        onOpenStudio={onOpenStudio}
      />
    </section>
  );
}
