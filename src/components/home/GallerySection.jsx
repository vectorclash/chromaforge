import React, { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import Card from '../ui/Card';
import FadeImage from '../ui/FadeImage';
import HeartIcon from '../buttons/HeartIcon';
import { listTopLikedDesigns, listMyLikedIds, toggleLike, getThumbnailUrl } from '../../lib/designs';
import { generateShareUrl } from '../../utils/urlConfig';
import { useAuth } from '../../context/AuthContext';
import { useScrollTriggerReveal } from '../../hooks/useScrollTriggerReveal';

// Homepage preview of the gallery -- the 8 most-liked public designs. Solid surface (no
// live art behind the grid as a whole; the artworks themselves are the content). Thumbnails
// are the same pre-rendered JPEGs the full Gallery page uses (uploaded at save time via
// StudioContext.saveCurrentDesign -> uploadDesignThumbnail), not a second render path.
export default function GallerySection() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const ref = useScrollTriggerReveal();
  const [designs, setDesigns] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [likedIds, setLikedIds] = useState(() => new Set());

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

  // Load a saved design into the full studio -- same approach as GalleryPage.onOpen,
  // routing to /studio's share-link query so getConfigFromUrl reconstructs it on mount.
  const onOpen = design => {
    const url = generateShareUrl(design.data);
    const query = url && url.includes('?') ? url.slice(url.indexOf('?')) : '';
    navigate('/studio' + query, { state: { from: '/' } });
  };

  // Same optimistic toggle as GalleryPage.onToggleLike -- see that file for the rationale on
  // why this is local-only rather than refetching (likes_count is server-authoritative via a
  // DB trigger, this just avoids a round-trip before the heart visibly flips).
  const onToggleLike = async (e, design) => {
    e.preventDefault();
    e.stopPropagation();
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
          <p className="font-quicksand text-xs font-bold uppercase tracking-[0.18em] text-ink-950">
            Community favorites
          </p>
          <h2 className="mt-3 font-display text-3xl text-ink-950">Most-liked designs</h2>
          {error ? (
            <p className="mt-4 text-accent">Couldn't load the gallery right now.</p>
          ) : (
            <p className="mt-4 text-ink-950/70">
              No public designs yet -- be the first to{' '}
              <Link to="/studio" state={{ from: '/' }} className="text-accent underline">
                save one
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
        <div className="mb-10 flex items-end justify-between gap-4">
          <div>
            <p className="font-quicksand text-xs font-bold uppercase tracking-[0.18em] text-ink-950">
              Community favorites
            </p>
            <h2 className="mt-3 font-display text-3xl text-ink-950">Most-liked designs</h2>
          </div>
          <Link to="/gallery" className="font-quicksand text-sm text-ink-950/60 transition hover:text-ink-950">
            View all &rarr;
          </Link>
        </div>

        {loading ? (
          <p className="text-ink-950/70">Loading&hellip;</p>
        ) : (
          <div className="grid grid-cols-2 gap-5 sm:grid-cols-4">
            {designs.map((design, i) => (
              <Card
                key={design.id}
                className="group cursor-pointer animate-fade-slide-up"
                style={{ animationDelay: `${i * 50}ms` }}
                onClick={() => onOpen(design)}
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
                  <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(to_top,rgba(0,0,0,0.85)_0%,rgba(0,0,0,0.4)_22%,rgba(0,0,0,0.1)_40%,transparent_60%)]" />
                  <div className="absolute inset-x-0 bottom-0 overflow-hidden p-3">
                    <div className="translate-y-5 transition-transform duration-300 ease-out group-hover:translate-y-0">
                      {design.profiles && (
                        <span className="block truncate text-xs text-text-secondary">
                          by {design.profiles.display_name || design.profiles.username || 'someone'}
                        </span>
                      )}
                      <span className="block truncate text-xs text-accent opacity-0 transition-opacity duration-300 ease-out group-hover:opacity-100">
                        Open in studio &rarr;
                      </span>
                    </div>
                  </div>
                  {/* Hidden-until-hover only on devices with a hover-capable pointer -- on
                      touch, where there's no hover to reveal it, the like button stays
                      visible exactly as before so tapping it never loses functionality. */}
                  <button
                    onClick={e => onToggleLike(e, design)}
                    className={
                      'absolute right-2 top-2 flex items-center gap-1 rounded-full bg-black/40 px-2 py-1 backdrop-blur-sm transition duration-200 ease-out [@media(hover:hover)]:-translate-y-1 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:translate-y-0 [@media(hover:hover)]:group-hover:opacity-100 [@media(hover:hover)]:group-focus-within:translate-y-0 [@media(hover:hover)]:group-focus-within:opacity-100 ' +
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
      </div>
    </section>
  );
}
