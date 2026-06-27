import React, { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import Card from '../ui/Card';
import HeartIcon from '../buttons/HeartIcon';
import { listTopLikedDesigns, listMyLikedIds, toggleLike, getThumbnailUrl } from '../../lib/designs';
import { useAuth } from '../../context/AuthContext';

// Homepage preview of the gallery -- the 8 most-liked public designs. Solid surface (no
// live art behind the grid as a whole; the artworks themselves are the content). Thumbnails
// are the same pre-rendered JPEGs the full Gallery page uses (uploaded at save time via
// StudioContext.saveCurrentDesign -> uploadDesignThumbnail), not a second render path.
export default function GallerySection() {
  const { user } = useAuth();
  const navigate = useNavigate();
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
      <section id="gallery" className="bg-ink-900">
        <div className="mx-auto max-w-5xl px-6 py-24 text-center">
          <p className="font-quicksand text-xs font-bold uppercase tracking-[0.18em] text-accent">
            Community favorites
          </p>
          <h2 className="mt-3 font-display text-3xl text-text">Most-liked designs</h2>
          {error ? (
            <p className="mt-4 text-accent">Couldn't load the gallery right now.</p>
          ) : (
            <p className="mt-4 text-text-secondary">
              No public designs yet -- be the first to{' '}
              <Link to="/studio" className="text-accent underline">
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
    <section id="gallery" className="bg-ink-900">
      <div className="mx-auto max-w-5xl px-6 py-24">
        <div className="mb-10 flex items-end justify-between gap-4">
          <div>
            <p className="font-quicksand text-xs font-bold uppercase tracking-[0.18em] text-accent">
              Community favorites
            </p>
            <h2 className="mt-3 font-display text-3xl text-text">Most-liked designs</h2>
          </div>
          <Link to="/gallery" className="font-quicksand text-sm text-text-muted transition hover:text-text">
            View all &rarr;
          </Link>
        </div>

        {loading ? (
          <p className="text-text-secondary">Loading&hellip;</p>
        ) : (
          <div className="grid grid-cols-2 gap-5 sm:grid-cols-4">
            {designs.map(design => (
              <Card key={design.id} as={Link} to="/gallery" className="group">
                <div className="aspect-square overflow-hidden bg-ink-800">
                  <img
                    src={getThumbnailUrl(design.user_id, design.id)}
                    alt={design.title || 'Untitled design'}
                    onError={e => {
                      e.target.style.visibility = 'hidden';
                    }}
                    className="h-full w-full object-cover transition group-hover:scale-[1.02]"
                  />
                </div>
                <div className="flex items-center justify-between p-3">
                  {design.profiles ? (
                    <span className="truncate text-xs text-text-muted">
                      by {design.profiles.display_name || design.profiles.username || 'someone'}
                    </span>
                  ) : (
                    <span />
                  )}
                  <button
                    onClick={e => onToggleLike(e, design)}
                    className={
                      'flex shrink-0 cursor-pointer items-center gap-1 ' +
                      (likedIds.has(design.id) ? 'text-accent' : 'text-text-muted hover:text-accent')
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
