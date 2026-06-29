import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import PageContainer from '../components/ui/PageContainer';
import Button from '../components/ui/Button';
import Card from '../components/ui/Card';
import FadeImage from '../components/ui/FadeImage';
import ShirtIcon from '../components/buttons/ShirtIcon';
import HeartIcon from '../components/buttons/HeartIcon';
import {
  listPublicDesigns,
  listMyDesigns,
  listMyLikedIds,
  toggleLike,
  deleteDesign,
  getThumbnailUrl
} from '../lib/designs';
import { generateShareUrl } from '../utils/urlConfig';
import { useAuth } from '../context/AuthContext';
import { useStudio } from '../context/StudioContext';

const PAGE_SIZE = 20;

export default function GalleryPage() {
  const { user } = useAuth();
  const { setPrintQueueDesign } = useStudio();
  const navigate = useNavigate();
  const [tab, setTab] = useState('public');
  const [designs, setDesigns] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState(null);
  const [likedIds, setLikedIds] = useState(() => new Set());

  const load = useCallback(async which => {
    setLoading(true);
    setError(null);
    setHasMore(false);
    try {
      const rows =
        which === 'mine' ? await listMyDesigns() : await listPublicDesigns({ limit: PAGE_SIZE });
      setDesigns(rows);
      setHasMore(which === 'public' && rows.length === PAGE_SIZE);
      listMyLikedIds(rows.map(d => d.id))
        .then(ids => setLikedIds(new Set(ids)))
        .catch(() => {});
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(tab);
  }, [tab, load]);

  const onLoadMore = async () => {
    const cursor = designs[designs.length - 1]?.created_at;
    if (!cursor) return;
    setLoadingMore(true);
    try {
      const more = await listPublicDesigns({ limit: PAGE_SIZE, before: cursor });
      setDesigns(d => [...d, ...more]);
      setHasMore(more.length === PAGE_SIZE);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoadingMore(false);
    }
  };

  const onDelete = async (e, design) => {
    e.stopPropagation();
    if (!window.confirm('Delete this design? This can’t be undone.')) return;
    try {
      await deleteDesign(design.id);
      setDesigns(d => d.filter(x => x.id !== design.id));
    } catch (err) {
      setError(err.message);
    }
  };

  // Load a saved design into the full studio by routing to its share URL -- /studio's
  // existing getConfigFromUrl path reconstructs it on mount. (Not "/" -- the homepage hero
  // is the compact Generate/Save view now, not the full tool; see StudioPage's `compact`.)
  const onOpen = design => {
    const url = generateShareUrl(design.data);
    const query = url && url.includes('?') ? url.slice(url.indexOf('?')) : '';
    navigate('/studio' + query);
  };

  // "Print this" -- queue the design in StudioContext (a one-shot hand-off ProductPage
  // reads on mount) and jump to the catalog so the user picks a product for it.
  const onPrint = (e, design) => {
    e.stopPropagation();
    setPrintQueueDesign(design);
    navigate('/shop');
  };

  // Optimistic like toggle: flips the heart + adjusts the visible count immediately, reverts
  // both if the request fails. likes_count itself is server-authoritative (a DB trigger), so
  // this local adjustment is just to avoid a refetch -- it'll be exactly right next load.
  const onToggleLike = async (e, design) => {
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

  const tabClass = active =>
    'cursor-pointer font-quicksand text-sm pb-2 border-b-2 transition ' +
    (active ? 'border-accent text-text' : 'border-transparent text-text-muted hover:text-text');

  return (
    <PageContainer title="Gallery" subtitle="Designs saved by the community and by you.">
      <div className="mb-6 flex gap-6 border-b border-hairline">
        <button className={tabClass(tab === 'public')} onClick={() => setTab('public')}>
          Public
        </button>
        {user && (
          <button className={tabClass(tab === 'mine')} onClick={() => setTab('mine')}>
            My designs
          </button>
        )}
      </div>

      {loading && <p className="text-text-secondary">Loading…</p>}
      {error && (
        <p className="text-accent">
          {error}{' '}
          <button onClick={() => load(tab)} className="cursor-pointer underline">
            Retry
          </button>
        </p>
      )}
      {!loading && !error && designs.length === 0 && (
        <p className="text-text-secondary">
          {tab === 'mine' ? 'You haven’t saved any designs yet.' : 'No public designs yet.'}
        </p>
      )}

      {!loading && designs.length > 0 && (
        <div className="grid grid-cols-2 gap-5 sm:grid-cols-3 lg:grid-cols-4">
          {designs.map((design, i) => (
            <Card
              key={design.id}
              className="group cursor-pointer animate-fade-slide-up"
              style={{ animationDelay: `${Math.min(i, 10) * 50}ms` }}
              onClick={() => onOpen(design)}
            >
              <div className="relative aspect-square overflow-hidden bg-ink-900">
                <FadeImage
                  src={getThumbnailUrl(design.user_id, design.id)}
                  alt={design.title || 'Untitled design'}
                  onError={e => {
                    e.target.style.visibility = 'hidden';
                  }}
                  className="h-full w-full object-cover transition group-hover:scale-[1.02]"
                />
                <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(to_top,rgba(0,0,0,0.9)_0%,rgba(0,0,0,0.5)_28%,rgba(0,0,0,0.15)_50%,transparent_70%)]" />
                <div className="absolute inset-x-0 bottom-0 min-w-0 p-3">
                  <span className="block truncate text-sm font-bold text-text">
                    {design.title || (design.kind === 'animation' ? 'Untitled animation' : 'Untitled')}
                  </span>
                  {design.profiles && (
                    <span className="block truncate text-xs text-text-secondary">
                      by {design.profiles.display_name || design.profiles.username || 'someone'}
                    </span>
                  )}
                </div>
                <div className="absolute right-2 top-2 flex shrink-0 items-center gap-2 rounded-full bg-black/40 px-2 py-1 backdrop-blur-sm">
                  <button
                    onClick={e => onToggleLike(e, design)}
                    className={
                      'flex cursor-pointer items-center gap-1 ' +
                      (likedIds.has(design.id) ? 'text-accent' : 'text-text hover:text-accent')
                    }
                    aria-label={likedIds.has(design.id) ? 'Unlike this design' : 'Like this design'}
                    title={likedIds.has(design.id) ? 'Unlike' : 'Like'}
                  >
                    <HeartIcon filled={likedIds.has(design.id)} />
                    {design.likes_count > 0 && <span className="text-xs">{design.likes_count}</span>}
                  </button>
                  {/* Animations aren't printable -- the mockup pipeline expects a flat
                      { seed, colors } design, not a frames array. */}
                  {design.kind !== 'animation' && (
                    <button
                      onClick={e => onPrint(e, design)}
                      className="cursor-pointer text-text hover:text-accent"
                      aria-label="Print this design"
                      title="Print this design"
                    >
                      <ShirtIcon size={14} />
                    </button>
                  )}
                  {tab === 'mine' && (
                    <button
                      onClick={e => onDelete(e, design)}
                      className="cursor-pointer text-xs text-text hover:text-accent"
                      aria-label="Delete design"
                    >
                      Delete
                    </button>
                  )}
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      {tab === 'public' && hasMore && (
        <div className="mt-8 text-center">
          <Button variant="secondary" onClick={onLoadMore} disabled={loadingMore}>
            {loadingMore ? 'Loading…' : 'Load more'}
          </Button>
        </div>
      )}
    </PageContainer>
  );
}
