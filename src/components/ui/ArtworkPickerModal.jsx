import React, { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import SolidPanel from './SolidPanel';
import Button from './Button';
import SkeletonGrid from './SkeletonGrid';
import { listMyDesigns, listPublicDesigns, countDesigns, getThumbnailUrl } from '../../lib/designs';
import { useAuth } from '../../context/AuthContext';

// Fixed page size for the carousel-style pager below. 8 = a clean 4x2 grid on desktop and
// 2x4 on mobile -- deliberately a fixed-size page ("carousel": prev/next + dots + "n / m"),
// NOT an appending "Load more", so the modal never grows taller as more of a library pages
// in (Aaron's explicit call in the approved mockup, see TODO.md's picker-redesign entry).
const PAGE_SIZE = 8;

// Past this many pages the dot row would get silly-wide; the "n / m" count still shows.
const MAX_DOTS = 10;

function CloseIcon() {
  return (
    <svg viewBox="0 0 24 24" width={18} height={18} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

function ChevronIcon({ dir = 1 }) {
  return (
    <svg viewBox="0 0 24 24" width={16} height={16} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      {dir === 1 ? <path d="M9 6l6 6-6 6" /> : <path d="M15 6l-6 6 6 6" />}
    </svg>
  );
}

function CheckBadge() {
  return (
    <span className="absolute bottom-1.5 right-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-accent">
      <svg viewBox="0 0 24 24" width={11} height={11} fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
        <path d="M5 13l4 4L19 7" />
      </svg>
    </span>
  );
}

const EMPTY_TAB = { pages: [], pageIndex: 0, total: null, loading: false, error: null };

// The "Browse gallery" modal ProductPage's artwork step opens: Public / My Designs tabs
// (mirroring GalleryPage's split) over a fixed-size, cursor-paginated grid, with an
// explicit "Use this artwork" confirmation footer (per the approved mockup) so closing
// without picking anything is obviously safe. Only ever lists printable designs
// (kind='image' -- the mockup pipeline can't take an animation's frames array).
// Backdrop/panel/keyboard handling mirrors GalleryModal/ConfirmDialog.
export default function ArtworkPickerModal({ open, onClose, onSelect }) {
  const { user } = useAuth();
  // My Designs is the default tab for signed-in users -- picking your own saved artwork is
  // the expected case; Public is the discovery path. Signed out, only Public has content.
  const [tab, setTab] = useState(user ? 'mine' : 'public');
  const [tabState, setTabState] = useState({ mine: EMPTY_TAB, public: EMPTY_TAB });
  const [pending, setPending] = useState(null);
  // Monotonic token so a fetch resolving after the modal was closed/reset (or after a
  // newer fetch started) can't commit stale pages into the fresh state.
  const fetchTokenRef = useRef(0);
  // Start point of an in-progress touch on the grid, for the swipe gesture below.
  const touchStartRef = useRef(null);

  // Fresh state every time the modal opens: a save/delete elsewhere in the app would
  // otherwise show a stale library, and a previous visit's half-made selection shouldn't
  // linger. Cheap -- the first page is 8 rows + 8 thumbnails.
  useEffect(() => {
    if (!open) return;
    fetchTokenRef.current++;
    setTab(user ? 'mine' : 'public');
    setTabState({ mine: EMPTY_TAB, public: EMPTY_TAB });
    setPending(null);
  }, [open, user]);

  const state = tabState[tab];
  const updateTab = (which, patch) =>
    setTabState(prev => ({ ...prev, [which]: { ...prev[which], ...patch } }));

  const fetchRows = async which => {
    const cursorPages = tabState[which].pages;
    const before = cursorPages.length
      ? cursorPages[cursorPages.length - 1][cursorPages[cursorPages.length - 1].length - 1]?.created_at
      : null;
    return which === 'mine'
      ? listMyDesigns({ limit: PAGE_SIZE, before, kind: 'image' })
      : // Signed in, "Public" means everyone else's -- your own work already has its own
        // tab, and the same design under both tabs read as a duplicate.
        listPublicDesigns({ limit: PAGE_SIZE, before, kind: 'image', excludeUserId: user?.id });
  };

  // Load the next uncached page for a tab (also the initial page-0 load). Thumbnails are
  // preloaded before the page is committed so the grid's entrance stagger is the only
  // thing driving perceived order -- same pattern as ProductPage's mockup filmstrip.
  const loadNextPage = async which => {
    const token = ++fetchTokenRef.current;
    updateTab(which, { loading: true, error: null });
    try {
      const [rows, total] = await Promise.all([
        fetchRows(which),
        tabState[which].total === null
          ? countDesigns({ mine: which === 'mine', kind: 'image', excludeUserId: user?.id })
          : Promise.resolve(tabState[which].total)
      ]);
      await Promise.all(
        rows.map(
          d =>
            new Promise(resolve => {
              const img = new Image();
              img.onload = resolve;
              img.onerror = resolve;
              img.src = getThumbnailUrl(d.user_id, d.id);
            })
        )
      );
      if (fetchTokenRef.current !== token) return;
      setTabState(prev => {
        const s = prev[which];
        return {
          ...prev,
          [which]: {
            ...s,
            pages: [...s.pages, rows],
            pageIndex: s.pages.length,
            total,
            loading: false
          }
        };
      });
    } catch (err) {
      if (fetchTokenRef.current !== token) return;
      updateTab(which, { loading: false, error: err.message });
    }
  };

  // First visit to a tab (per open) kicks off its page 0. Signed-out My Designs shows a
  // sign-in prompt instead (see below), so don't fetch -- listMyDesigns would just throw.
  useEffect(() => {
    if (!open) return;
    if (tab === 'mine' && !user) return;
    if (tabState[tab].pages.length === 0 && !tabState[tab].loading && !tabState[tab].error) {
      loadNextPage(tab);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, tab, tabState]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = e => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  const rows = state.pages[state.pageIndex] || [];
  const totalPages = state.total !== null ? Math.max(1, Math.ceil(state.total / PAGE_SIZE)) : null;
  const lastLoadedPage = state.pages.length - 1;
  const hasNext = totalPages !== null && state.pageIndex + 1 < totalPages;
  const hasPrev = state.pageIndex > 0;

  const goPrev = () => hasPrev && updateTab(tab, { pageIndex: state.pageIndex - 1 });
  const goNext = () => {
    if (!hasNext || state.loading) return;
    if (state.pageIndex < lastLoadedPage) updateTab(tab, { pageIndex: state.pageIndex + 1 });
    else loadNextPage(tab);
  };

  // Touch swipe on the grid area pages the carousel, matching what the pager's shape
  // already implies on mobile. Left/right only: the gesture must beat a real distance
  // threshold AND be clearly more horizontal than vertical, so scrolling the panel (or a
  // slightly-diagonal thumb) never accidentally changes pages. Sequential-only by design
  // -- cursor pagination can't jump to an arbitrary page, and goPrev/goNext already guard
  // the edges and in-flight loads. Deliberately no animated drag-follow: the incoming
  // page's existing entrance stagger is the transition.
  const onGridTouchStart = e => {
    const t = e.touches[0];
    touchStartRef.current = { x: t.clientX, y: t.clientY };
  };
  const onGridTouchEnd = e => {
    const start = touchStartRef.current;
    touchStartRef.current = null;
    if (!start) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - start.x;
    const dy = t.clientY - start.y;
    if (Math.abs(dx) < 48 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
    if (dx < 0) goNext();
    else goPrev();
  };

  const tabClass = active =>
    'cursor-pointer font-quicksand text-sm pb-2 border-b-2 transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-interactive ' +
    (active ? 'border-accent text-text' : 'border-transparent text-text-muted hover:text-text');

  return (
    <div
      className="fixed inset-0 z-50 flex animate-fade-in items-center justify-center bg-black/70 p-4 backdrop-blur-sm sm:p-6"
      onClick={onClose}
    >
      <SolidPanel
        className="relative flex max-h-[92vh] w-full max-w-2xl flex-col overflow-y-auto animate-pop-in p-5 sm:p-6"
        role="dialog"
        aria-modal="true"
        aria-labelledby="artwork-picker-title"
        onClick={e => e.stopPropagation()}
      >
        <Button
          type="button"
          variant="icon"
          className="absolute right-3 top-3 z-10"
          onClick={onClose}
          aria-label="Close"
        >
          <CloseIcon />
        </Button>

        <h2 id="artwork-picker-title" className="pr-10 font-quicksand text-lg font-bold text-text">
          Choose artwork
        </h2>

        <div className="mt-4 flex gap-6 border-b border-hairline">
          {user && (
            <button className={tabClass(tab === 'mine')} onClick={() => setTab('mine')}>
              My designs
            </button>
          )}
          <button className={tabClass(tab === 'public')} onClick={() => setTab('public')}>
            Public
          </button>
        </div>

        {/* shrink-0 on each section: the panel is a flex column capped at 92vh with its own
            scrollbar -- without this, flex shrinks the grid wrapper instead of letting the
            panel scroll, and the footer renders on top of the squeezed grid (seen live at
            375px). Same treatment as GalleryModal's artwork block. */}
        <div
          className="mt-4 min-h-[13rem] shrink-0"
          onTouchStart={onGridTouchStart}
          onTouchEnd={onGridTouchEnd}
        >
          {tab === 'mine' && !user ? (
            <p className="py-12 text-center text-sm text-text-secondary">
              <Link to="/account" className="text-accent underline">Sign in</Link> to pick from your
              own saved designs.
            </p>
          ) : state.loading && rows.length === 0 ? (
            <SkeletonGrid count={PAGE_SIZE} className="grid grid-cols-4 gap-2 sm:gap-3" />
          ) : state.error ? (
            <p className="animate-pop-in py-12 text-center text-sm text-accent">
              {state.error}{' '}
              <button
                onClick={() => {
                  updateTab(tab, { error: null });
                }}
                className="cursor-pointer underline"
              >
                Retry
              </button>
            </p>
          ) : rows.length === 0 ? (
            <p className="py-12 text-center text-sm text-text-secondary">
              {tab === 'mine'
                ? 'You haven’t saved any designs yet.'
                : user
                  ? 'No public designs from other artists yet.'
                  : 'No public designs yet.'}
            </p>
          ) : (
            // Keyed per tab+page so switching pages replays the entrance stagger for the
            // incoming batch instead of diffing cards in place. 4 columns at every width
            // (2 short rows, not 4 tall ones) so the whole page of 8 fits a phone
            // viewport without the panel needing to scroll -- smaller thumbnails were
            // Aaron's explicit preference over a scrolling modal.
            <div key={`${tab}-${state.pageIndex}`} className="grid grid-cols-4 gap-2 sm:gap-3">
              {rows.map((d, i) => {
                const selected = pending?.id === d.id;
                return (
                  <button
                    key={d.id}
                    type="button"
                    onClick={() => setPending(d)}
                    aria-pressed={selected}
                    style={{ animationDelay: `${i * 40}ms` }}
                    className={
                      'group cursor-pointer overflow-hidden rounded-xl border-2 bg-ink-900 text-left transition animate-fade-slide-up focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-interactive ' +
                      (selected ? 'border-accent' : 'border-hairline hover:border-text-muted')
                    }
                  >
                    <div className="relative aspect-square overflow-hidden bg-ink-900">
                      {/* Plain <img>: loadNextPage already preloaded this exact URL before
                          the page was committed, so FadeImage's own skeleton/fade would just
                          fight the wrapper's stagger (same reasoning as the mockup
                          filmstrip's comment in ProductPage). */}
                      <img
                        src={getThumbnailUrl(d.user_id, d.id)}
                        alt={d.title || 'Untitled design'}
                        onError={e => {
                          e.target.style.visibility = 'hidden';
                        }}
                        className="h-full w-full object-cover transition-transform duration-300 ease-out group-hover:scale-[1.08]"
                      />
                      {selected && <CheckBadge />}
                    </div>
                    <div className="min-w-0 px-1.5 py-1 sm:px-2 sm:py-1.5">
                      <span className="block truncate text-[10px] font-bold text-text sm:text-xs">
                        {d.title || 'Untitled'}
                      </span>
                      {/* Byline hidden on phones: at 4 columns a ~70px cell can't show a
                          useful amount of it, and dropping the line is what keeps the
                          2-row page short enough to never scroll. */}
                      {tab === 'public' && d.profiles && (
                        <span className="hidden truncate text-[11px] text-text-secondary sm:block">
                          by {d.profiles.display_name || d.profiles.username || 'someone'}
                        </span>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {(tab !== 'mine' || user) && totalPages !== null && totalPages > 1 && (
          <div className="mt-4 flex shrink-0 items-center justify-center gap-3">
            <button
              type="button"
              onClick={goPrev}
              disabled={!hasPrev}
              aria-label="Previous page"
              className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-lg border border-hairline text-text-secondary transition enabled:hover:border-text enabled:hover:text-text disabled:cursor-default disabled:opacity-30"
            >
              <ChevronIcon dir={-1} />
            </button>
            {totalPages <= MAX_DOTS && (
              <span className="flex items-center gap-1.5" aria-hidden="true">
                {Array.from({ length: totalPages }, (_, i) => (
                  <span
                    key={i}
                    className={
                      'h-1.5 w-1.5 rounded-full transition ' +
                      (i === state.pageIndex ? 'bg-accent' : 'bg-ink-700')
                    }
                  />
                ))}
              </span>
            )}
            <span className="font-quicksand text-xs text-text-muted">
              {state.pageIndex + 1} / {totalPages}
            </span>
            <button
              type="button"
              onClick={goNext}
              disabled={!hasNext || state.loading}
              aria-label="Next page"
              aria-busy={state.loading}
              className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-lg border border-hairline text-text-secondary transition enabled:hover:border-text enabled:hover:text-text disabled:cursor-default disabled:opacity-30"
            >
              <ChevronIcon dir={1} />
            </button>
          </div>
        )}

        <div className="mt-5 flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-hairline pt-4">
          <span className="min-w-0 truncate text-xs text-text-secondary">
            {pending ? (
              <>
                Selected: <strong className="text-text">{pending.title || 'Untitled'}</strong>
              </>
            ) : (
              'Pick a design above.'
            )}
          </span>
          <div className="flex gap-2">
            <Button type="button" variant="secondary" size="sm" onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={!pending}
              onClick={() => pending && onSelect(pending)}
            >
              Use this artwork
            </Button>
          </div>
        </div>
      </SolidPanel>
    </div>
  );
}
