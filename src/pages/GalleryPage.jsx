import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import PageContainer from '../components/ui/PageContainer';
import Button from '../components/ui/Button';
import Card from '../components/ui/Card';
import FadeImage from '../components/ui/FadeImage';
import SkeletonGrid from '../components/ui/SkeletonGrid';
import ConfirmDialog from '../components/ui/ConfirmDialog';
import ShirtIcon from '../components/buttons/ShirtIcon';
import HeartIcon from '../components/buttons/HeartIcon';
import AnimationIcon from '../components/buttons/AnimationIcon';
import {
  listPublicDesigns,
  listMyDesigns,
  listMyLikedIds,
  toggleLike,
  deleteDesign,
  getThumbnailUrl
} from '../lib/designs';
import { useAuth } from '../context/AuthContext';
import { useStudio } from '../context/StudioContext';
import { usePageTitle } from '../hooks/usePageTitle';

const PAGE_SIZE = 20;

export default function GalleryPage() {
  usePageTitle('Gallery');
  const { user } = useAuth();
  const { setPrintQueueDesign, previewUrl } = useStudio();
  const navigate = useNavigate();
  const [tab, setTab] = useState('public');
  const [designs, setDesigns] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState(null);
  const [likedIds, setLikedIds] = useState(() => new Set());
  const [pendingDelete, setPendingDelete] = useState(null);

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

  // Kept in a ref (rather than relying on the effect's closure) so the observer always
  // calls the latest onLoadMore -- it captures that render's `designs` for the cursor --
  // without needing to tear down and recreate the observer on every render.
  const onLoadMoreRef = useRef(onLoadMore);
  onLoadMoreRef.current = onLoadMore;

  // Infinite scroll for the public feed: keyset (cursor) pagination already avoids the
  // "page 2 shifts under you" problem a live, growing feed has with offset-based numbered
  // pages, so auto-loading near the bottom is a more natural fit than page controls. The
  // sentinel sits just past the grid; while a fetch is in flight the effect skips attaching
  // an observer at all, so a slow request can't trigger a second overlapping one.
  const sentinelRef = useRef(null);
  useEffect(() => {
    if (tab !== 'public' || !hasMore || loadingMore) return;
    const sentinel = sentinelRef.current;
    if (!sentinel) return;
    const root = sentinel.closest('.overflow-y-auto');
    const observer = new IntersectionObserver(
      entries => {
        if (entries[0].isIntersecting) onLoadMoreRef.current();
      },
      { root, rootMargin: '600px' }
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [tab, hasMore, loadingMore, designs.length]);

  const onDelete = (e, design) => {
    e.stopPropagation();
    setPendingDelete(design);
  };

  const confirmDelete = async () => {
    const design = pendingDelete;
    setPendingDelete(null);
    try {
      await deleteDesign(design.id);
      setDesigns(d => d.filter(x => x.id !== design.id));
    } catch (err) {
      setError(err.message);
    }
  };

  // Load a saved design into the full studio by routing to its real database id -- /studio's
  // getDesignIdFromUrl/getDesign path fetches and reconstructs it on mount (see
  // utils/urlConfig.js). Every design in this list already has a real, permanent id, so
  // there's nothing to encode -- no need for generateShareUrl's old data-in-URL approach.
  // (Not "/" -- the homepage hero is the compact Generate/Save view now, not the full tool;
  // see StudioPage's `compact`.)
  const onOpen = design => {
    navigate(`/studio?id=${design.id}`, { state: { from: '/gallery' } });
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
    'cursor-pointer font-quicksand text-sm pb-2 border-b-2 transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-interactive ' +
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

      {loading && (
        <SkeletonGrid count={8} className="grid grid-cols-2 gap-5 sm:grid-cols-3 lg:grid-cols-4" />
      )}
      {error && (
        <p className="animate-pop-in text-accent">
          {error}{' '}
          <button onClick={() => load(tab)} className="cursor-pointer underline">
            Retry
          </button>
        </p>
      )}
      {!loading && !error && designs.length === 0 && (
        <div className="flex animate-fade-slide-up flex-col items-center gap-5 py-12 text-center">
          {/* The studio's own live preview, not a stock illustration -- an empty gallery
              should still look like this is a generative art tool, not a blank state from
              any other app. Same previewUrl the ambient MiniGenerator widget shows. */}
          {previewUrl && (
            <img
              src={previewUrl}
              alt=""
              className="h-36 w-36 rounded-2xl border border-hairline object-cover opacity-90"
            />
          )}
          <p className="text-text-secondary">
            {tab === 'mine' ? 'You haven’t saved any designs yet.' : 'No public designs yet.'}
          </p>
          {tab === 'mine' && (
            <Button as={Link} to="/studio" variant="secondary" size="sm">
              Go create one
            </Button>
          )}
        </div>
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
                  className="h-full w-full object-cover transition-transform duration-300 ease-out group-hover:scale-[1.08]"
                />
                <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(to_top,rgba(0,0,0,0.9)_0%,rgba(0,0,0,0.5)_28%,rgba(0,0,0,0.15)_50%,transparent_70%)]" />
                {/* Always visible (not hidden-until-hover like the like/print/delete pill) --
                    a thumbnail is a single still JPEG either way (see lib/designs.js's
                    uploadDesignThumbnail), so nothing else about the image itself hints this
                    is an animation. The title-text fallback ("Untitled animation") only
                    covered untitled ones and only surfaced on hover; this covers every
                    animation, titled or not, without needing to interact with the card. */}
                {design.kind === 'animation' && (
                  <div
                    className="pointer-events-none absolute left-2 top-2 flex items-center gap-1 rounded-full bg-black/40 px-2 py-1 text-text backdrop-blur-sm"
                    title="Animation"
                  >
                    <AnimationIcon size={12} />
                  </div>
                )}
                <div className="absolute inset-x-0 bottom-0 min-w-0 overflow-hidden p-3">
                  {/* Hidden-until-hover only on devices with a hover-capable pointer, same
                      reasoning and same pattern as the like/print/delete pill below -- on
                      touch there's no real `:hover` to ever reveal this, so without the
                      media-query gate the title/caption (and, worse, the "Open in studio"
                      hint) would be permanently invisible on mobile instead of just
                      hover-deferred on desktop. */}
                  <div className="[@media(hover:hover)]:translate-y-5 transition-transform duration-300 ease-out [@media(hover:hover)]:group-hover:translate-y-0 [@media(hover:hover)]:group-focus-within:translate-y-0">
                    <span className="block truncate text-sm font-bold text-text">
                      {design.title || (design.kind === 'animation' ? 'Untitled animation' : 'Untitled')}
                    </span>
                    {design.profiles && (
                      <span className="block truncate text-xs text-text-secondary">
                        by {design.profiles.display_name || design.profiles.username || 'someone'}
                      </span>
                    )}
                    <span className="block truncate text-xs text-accent [@media(hover:hover)]:opacity-0 transition-opacity duration-300 ease-out [@media(hover:hover)]:group-hover:opacity-100 [@media(hover:hover)]:group-focus-within:opacity-100">
                      Open in studio &rarr;
                    </span>
                  </div>
                </div>
                {/* Hidden-until-hover on devices that actually have a hover-capable pointer
                    -- on touch, where there's no hover to reveal it, the pill (and the
                    like/print/delete actions inside it) stays visible exactly as before, so
                    tapping never loses functionality. */}
                <div
                  className="absolute right-2 top-2 flex shrink-0 items-center gap-2 rounded-full bg-black/40 px-2 py-1 backdrop-blur-sm transition duration-200 ease-out [@media(hover:hover)]:-translate-y-1 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:translate-y-0 [@media(hover:hover)]:group-hover:opacity-100 [@media(hover:hover)]:group-focus-within:translate-y-0 [@media(hover:hover)]:group-focus-within:opacity-100"
                >
                  {/* Each button gets a p-1 -m-1 halo: the padding grows the actual tappable
                      box (the icons alone were ~12-14px, well under a usable touch target)
                      while the matching negative margin cancels it back out visually, so the
                      pill's on-screen size/spacing is unchanged. 4px halo either side exactly
                      fills half of this row's gap-2 (8px), so adjacent buttons' hit areas meet
                      at the midpoint -- no dead zone between them, but no overlap either. */}
                  <button
                    onClick={e => onToggleLike(e, design)}
                    className={
                      'flex cursor-pointer items-center gap-1 p-1 -m-1 ' +
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
                      className="cursor-pointer p-1 -m-1 text-text hover:text-accent"
                      aria-label="Print this design"
                      title="Print this design"
                    >
                      <ShirtIcon size={14} />
                    </button>
                  )}
                  {tab === 'mine' && (
                    <button
                      onClick={e => onDelete(e, design)}
                      className="cursor-pointer p-1 -m-1 text-xs text-text hover:text-accent"
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
        <div ref={sentinelRef} className="flex justify-center py-10">
          {loadingMore && <p className="text-sm text-text-muted">Loading more…</p>}
        </div>
      )}

      <ConfirmDialog
        open={!!pendingDelete}
        title="Delete this design?"
        message="This can’t be undone."
        confirmLabel="Delete"
        onConfirm={confirmDelete}
        onCancel={() => setPendingDelete(null)}
      />
    </PageContainer>
  );
}
