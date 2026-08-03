import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import PageContainer from '../components/ui/PageContainer';
import Button from '../components/ui/Button';
import Card from '../components/ui/Card';
import FadeImage from '../components/ui/FadeImage';
import SkeletonGrid from '../components/ui/SkeletonGrid';
import ConfirmDialog from '../components/ui/ConfirmDialog';
import GalleryModal from '../components/ui/GalleryModal';
import { useCrossfadeImage } from '../hooks/useCrossfadeImage';
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
import { usePageMeta } from '../hooks/usePageMeta';
import AuthorBadge from '../components/ui/AuthorBadge';
import { preloadImages } from '../utils/preloadImages';
import { DURATION_SLOW } from '../utils/motionTokens';

const PAGE_SIZE = 20;

// One source of truth for the grid geometry: the skeleton and the real grid are stacked on
// top of each other during the crossfade below, so any divergence between their column
// counts or gaps would show up as the placeholder sliding sideways as it fades.
const GRID_CLASS = 'grid grid-cols-2 gap-5 sm:grid-cols-3 lg:grid-cols-4';

// How many thumbnails to warm before revealing. Four columns x two rows is roughly the
// first screenful on a desktop viewport; the rest stream in under their own per-card
// placeholders, off-screen, where nobody watches them arrive.
const PRELOAD_COUNT = 8;

// The placeholder's tile count while the query is still in flight, i.e. the only moment we
// genuinely don't know how many cards are coming. Public is exact whenever the feed has a
// full page (it asks for PAGE_SIZE and gets it); `mine` is a guess for one render, and is
// replaced by the real count for every subsequent visit -- see lastCountRef.
const INITIAL_SKELETON_COUNT = { public: PAGE_SIZE, mine: 8 };

export default function GalleryPage() {
  usePageMeta({
    title: 'Gallery',
    description: 'Browse a shared gallery of generative art made in the Chromaforge studio, and print your favorites on real merch.',
    path: '/gallery'
  });
  const { user } = useAuth();
  const { setPrintQueueDesign, previewUrl } = useStudio();
  // Two stacked layers through the shared hook rather than a bare <img src={previewUrl}>:
  // MiniGenerator sits on this route, so generating from it used to crossfade the widget
  // while this empty-state thumbnail popped to the new design on the same beat.
  const emptyPreview = useCrossfadeImage(previewUrl);
  const navigate = useNavigate();
  const [tab, setTab] = useState('public');
  const [designs, setDesigns] = useState([]);
  // Data has landed AND the first screenful of thumbnails has decoded -- the moment the
  // real grid is worth showing. This deliberately replaces a plain `loading` flag tracking
  // the query alone: dropping the placeholder the instant the rows arrived, while every
  // thumbnail was still in flight, is exactly what made the page flash a phantom grid
  // (see preloadImages.js).
  const [revealed, setRevealed] = useState(false);
  // The placeholder outlives `revealed` by one transition so it can fade out UNDER the
  // incoming cards rather than being cut away, leaving a blank frame where neither is
  // painted (the real cards start at opacity 0 -- `animate-fade-slide-up` is `backwards`).
  const [skeletonMounted, setSkeletonMounted] = useState(true);
  // Remembered per tab so a return visit or a tab switch reserves the right amount of
  // space immediately, instead of guessing and then correcting.
  const lastCountRef = useRef({});
  const loadTokenRef = useRef(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState(null);
  const [likedIds, setLikedIds] = useState(() => new Set());
  const [pendingDelete, setPendingDelete] = useState(null);
  // The id, not the object -- so the modal always shows fresh data (e.g. a like-count
  // bump) from `designs` instead of a stale snapshot taken when it was opened.
  const [openDesignId, setOpenDesignId] = useState(null);
  const openDesign = designs.find(d => d.id === openDesignId) || null;

  // Signed in, the Public tab excludes your own designs -- they already have their own
  // My Designs tab, and the same design appearing under both read as a duplicate.
  const load = useCallback(
    async which => {
      // Switching tabs mid-flight must not let the outgoing request finish over the top of
      // the incoming one. Worth guarding now specifically because waiting on the thumbnails
      // widens this window from "one query" to "one query plus an image fetch".
      const token = ++loadTokenRef.current;
      const isStale = () => token !== loadTokenRef.current;

      setRevealed(false);
      setSkeletonMounted(true);
      setError(null);
      setHasMore(false);
      try {
        const rows =
          which === 'mine'
            ? await listMyDesigns()
            : await listPublicDesigns({ limit: PAGE_SIZE, excludeUserId: user?.id });
        if (isStale()) return;
        setDesigns(rows);
        lastCountRef.current[which] = rows.length;
        setHasMore(which === 'public' && rows.length === PAGE_SIZE);
        listMyLikedIds(rows.map(d => d.id))
          .then(ids => setLikedIds(new Set(ids)))
          .catch(() => {});
        // Hold the placeholder across the image fetch too, so the grid arrives complete.
        // Bounded, and never rejects, so neither a slow network nor a design with no stored
        // thumbnail can keep the page from appearing -- see preloadImages.js.
        await preloadImages(
          rows.slice(0, PRELOAD_COUNT).map(d => getThumbnailUrl(d.user_id, d.id))
        );
      } catch (err) {
        if (isStale()) return;
        setError(err.message);
      } finally {
        if (!isStale()) setRevealed(true);
      }
    },
    [user?.id]
  );

  useEffect(() => {
    load(tab);
  }, [tab, load]);

  // Drop the faded-out placeholder once its transition has run. A timer rather than
  // `transitionend`, which never fires if the element is display:none'd or the transition
  // is collapsed to ~0ms by prefers-reduced-motion -- either would strand it in the DOM.
  useEffect(() => {
    if (!revealed) return;
    const t = setTimeout(() => setSkeletonMounted(false), DURATION_SLOW * 1000);
    return () => clearTimeout(t);
  }, [revealed]);

  const onLoadMore = async () => {
    const cursor = designs[designs.length - 1]?.created_at;
    if (!cursor) return;
    setLoadingMore(true);
    try {
      const more = await listPublicDesigns({ limit: PAGE_SIZE, before: cursor, excludeUserId: user?.id });
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

  // `e` is only passed when this fires from a card's own hover-pill button (desktop only --
  // see the card markup) -- it needs stopPropagation so the click doesn't also bubble up to
  // the card's onClick and open the modal. The gallery modal's buttons call these with no
  // event at all, since there's no parent click handler to guard against there.
  const onDelete = (design, e) => {
    e?.stopPropagation();
    setPendingDelete(design);
  };

  const confirmDelete = async () => {
    const design = pendingDelete;
    setPendingDelete(null);
    // The design being deleted may be the one currently open in the modal (its Delete
    // button routes here too) -- close it, since there's nothing left to show.
    if (openDesignId === design.id) setOpenDesignId(null);
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
  const onOpenStudio = design => {
    navigate(`/studio?id=${design.id}`, { state: { from: '/gallery' } });
  };

  // "Print this" -- queue the design in StudioContext (a one-shot hand-off ProductPage
  // reads on mount) and jump to the catalog so the user picks a product for it.
  const onPrint = (design, e) => {
    e?.stopPropagation();
    setPrintQueueDesign(design);
    navigate('/shop');
  };

  // Optimistic like toggle: flips the heart + adjusts the visible count immediately, reverts
  // both if the request fails. likes_count itself is server-authoritative (a DB trigger), so
  // this local adjustment is just to avoid a refetch -- it'll be exactly right next load.
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

      {/* The placeholder and the real grid live in one relative box and overlap for the
          length of the crossfade. While waiting, the placeholder is in normal flow and is
          what gives the page its height; on reveal it flips to absolute so the real grid
          takes over the layout without the page collapsing to zero height for a frame, and
          fades out on top. Both use GRID_CLASS, so the tiles it fades out of line up with
          the cards fading in. */}
      {skeletonMounted && !error && (
        <div className="relative">
          <SkeletonGrid
            count={
              // Exact as soon as the rows are in hand -- the guess only covers the query
              // itself, so the tile count never visibly corrects underneath the reveal.
              designs.length || lastCountRef.current[tab] || INITIAL_SKELETON_COUNT[tab]
            }
            className={`${GRID_CLASS} transition-opacity duration-500 ease-out ${
              revealed ? 'pointer-events-none absolute inset-x-0 top-0 opacity-0' : 'opacity-100'
            }`}
          />
        </div>
      )}
      {error && (
        <p className="animate-pop-in text-accent">
          {error}{' '}
          <button onClick={() => load(tab)} className="cursor-pointer underline">
            Retry
          </button>
        </p>
      )}
      {revealed && !error && designs.length === 0 && (
        <div className="flex animate-fade-slide-up flex-col items-center gap-5 py-12 text-center">
          {/* The studio's own live preview, not a stock illustration -- an empty gallery
              should still look like this is a generative art tool, not a blank state from
              any other app. Same previewUrl the ambient MiniGenerator widget shows. */}
          {emptyPreview.shown && (
            <div className="relative h-36 w-36 overflow-hidden rounded-2xl border border-hairline opacity-90">
              <img
                ref={emptyPreview.shownRef}
                src={emptyPreview.shown}
                alt=""
                className="absolute inset-0 h-full w-full object-cover"
              />
              {emptyPreview.incoming && (
                <img
                  ref={emptyPreview.incomingRef}
                  src={emptyPreview.incoming}
                  alt=""
                  className="absolute inset-0 h-full w-full object-cover"
                  style={{ opacity: 0 }}
                />
              )}
            </div>
          )}
          <p className="text-text-secondary">
            {tab === 'mine'
              ? 'You haven’t saved any designs yet.'
              : user
                ? 'No public designs from other artists yet.'
                : 'No public designs yet.'}
          </p>
          {tab === 'mine' && (
            <Button as={Link} to="/studio" variant="secondary" size="sm">
              Go create one
            </Button>
          )}
        </div>
      )}

      {revealed && designs.length > 0 && (
        <div className={GRID_CLASS}>
          {designs.map((design, i) => (
            <Card
              key={design.id}
              className="group cursor-pointer animate-fade-slide-up"
              style={{ animationDelay: `${Math.min(i, 10) * 50}ms` }}
              onClick={() => setOpenDesignId(design.id)}
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
                {/* -inset-px, not inset-0: the overlay and the image are the same computed box, but
                    an aspect-square card resolves to a FRACTIONAL height at most widths, and on a
                    high-DPR screen the two can rasterise to different device-pixel extents --
                    leaving a hairline of undarkened image along the bottom edge, intermittently,
                    depending on how each card's width happens to round. Bleeding the overlay a
                    pixel past its box costs nothing (the card's own overflow-hidden clips it) and
                    removes the whole class of mismatch rather than the bottom edge alone. */}
                <div className="pointer-events-none absolute -inset-px bg-[linear-gradient(to_top,rgba(0,0,0,0.9)_0%,rgba(0,0,0,0.5)_28%,rgba(0,0,0,0.15)_50%,transparent_70%)]" />
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
                      media-query gate the title/caption (and, worse, the "View design"
                      hint) would be permanently invisible on mobile instead of just
                      hover-deferred on desktop. */}
                  {/* space-y-1 rather than relying on line-height alone: the byline is a flex
                      row containing a 16px avatar circle, so it is taller than the plain text
                      lines it sits between and crowded them once the avatar landed there. */}
                  <div className="space-y-1 [@media(hover:hover)]:translate-y-5 transition-transform duration-300 ease-out [@media(hover:hover)]:group-hover:translate-y-0 [@media(hover:hover)]:group-focus-within:translate-y-0">
                    <span className="block truncate text-sm font-bold text-text">
                      {design.title || (design.kind === 'animation' ? 'Untitled animation' : 'Untitled')}
                    </span>
                    <AuthorBadge profile={design.profiles} />
                    {/* Was "Open in studio" -- clicking a card now opens the gallery modal
                        (with its own explicit "Open in studio" link) instead of jumping
                        straight into the Studio, so the hint had to change to match. */}
                    <span className="block truncate text-xs text-accent [@media(hover:hover)]:opacity-0 transition-opacity duration-300 ease-out [@media(hover:hover)]:group-hover:opacity-100 [@media(hover:hover)]:group-focus-within:opacity-100">
                      View design &rarr;
                    </span>
                  </div>
                </div>
                {/* Desktop-only quick actions -- `hidden` by default (touch devices rely on
                    the gallery modal instead, opened by tapping the card, for these same
                    actions at a real touch-target size), shown as a hover-capable-only flex
                    pill so it behaves exactly as it did before the modal existed on devices
                    that actually have a mouse. */}
                <div
                  className="absolute right-2 top-2 hidden shrink-0 items-center gap-2 rounded-full bg-black/40 px-2 py-1 backdrop-blur-sm transition duration-200 ease-out [@media(hover:hover)]:flex [@media(hover:hover)]:-translate-y-1 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:translate-y-0 [@media(hover:hover)]:group-hover:opacity-100 [@media(hover:hover)]:group-focus-within:translate-y-0 [@media(hover:hover)]:group-focus-within:opacity-100"
                >
                  <button
                    onClick={e => onToggleLike(design, e)}
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
                      onClick={e => onPrint(design, e)}
                      className="cursor-pointer p-1 -m-1 text-text hover:text-accent"
                      aria-label="Print this design"
                      title="Print this design"
                    >
                      <ShirtIcon size={14} />
                    </button>
                  )}
                  {tab === 'mine' && (
                    <button
                      onClick={e => onDelete(design, e)}
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

      <GalleryModal
        design={openDesign}
        liked={!!openDesign && likedIds.has(openDesign.id)}
        canDelete={tab === 'mine'}
        onClose={() => setOpenDesignId(null)}
        onToggleLike={onToggleLike}
        onPrint={onPrint}
        onDelete={onDelete}
        onOpenStudio={onOpenStudio}
      />

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
