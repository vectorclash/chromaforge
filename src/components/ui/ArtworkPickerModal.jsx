import React, { useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { Link } from 'react-router-dom';
import SolidPanel from './SolidPanel';
import Button from './Button';
import { listMyDesigns, listPublicDesigns, countDesigns, getThumbnailUrl } from '../../lib/designs';
import { useAuth } from '../../context/AuthContext';
import { authorName } from './AuthorBadge';

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
      {/* Dark ink, not white: the accent is a LIGHT colour (10.55:1 against the page), so a
          white mark on it sits at 1.58:1 -- under WCAG 1.4.11's 3:1 for a graphic that
          carries meaning, and visibly washed out. #1E1E1E is --color-ink-950, hardcoded here
          only because this is an SVG stroke attribute. */}
      <svg viewBox="0 0 24 24" width={11} height={11} fill="none" stroke="#1E1E1E" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
        <path d="M5 13l4 4L19 7" />
      </svg>
    </span>
  );
}

// Modal-local skeleton page, NOT the shared SkeletonGrid: its cells mirror this modal's
// card structure exactly (square image area + the title strip below, same border/rounding/
// padding), so a real thumbnail fading in over its skeleton lands pixel-aligned -- the
// shared grid's bare squares left row 2 sitting visibly higher than the cards replacing it.
function SkeletonPage({ count = PAGE_SIZE }) {
  return (
    <div className="grid grid-cols-4 gap-2 sm:gap-3" aria-hidden="true">
      {Array.from({ length: count }).map((_, i) => (
        <div
          key={i}
          className="animate-pulse overflow-hidden rounded-xl border-2 border-hairline bg-ink-900"
          style={{ animationDelay: `${i * 50}ms` }}
        >
          <div className="aspect-square bg-ink-800" />
          <div className="px-1.5 py-1 sm:px-2 sm:py-1.5">
            <div className="h-[15px] w-2/3 rounded bg-ink-800 sm:h-4" />
          </div>
        </div>
      ))}
    </div>
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
  // In-progress touch gesture on the grid (start point, locked axis, latest dx) for the
  // drag-follow swipe below, plus the wrapper element the drag translates imperatively --
  // per-move transforms go straight to the DOM node, never through React state, so a fast
  // drag can't queue 60 re-renders/second of an 8-card grid.
  const touchStartRef = useRef(null);
  const slideRef = useRef(null);
  // True while a released swipe is animating the track the rest of the way to the
  // neighbor -- new touches are ignored until the page commit lands.
  const animatingRef = useRef(false);
  // Which direction the last page change travelled ('next' | 'prev' | null): drives the
  // incoming page's slide-in side. null (tab switch, first load) keeps the original
  // per-card entrance stagger instead.
  const [slideDir, setSlideDir] = useState(null);

  // Fresh state every time the modal opens: a save/delete elsewhere in the app would
  // otherwise show a stale library, and a previous visit's half-made selection shouldn't
  // linger. Cheap -- the first page is 8 rows + 8 thumbnails.
  useEffect(() => {
    if (!open) return;
    fetchTokenRef.current++;
    setTab(user ? 'mine' : 'public');
    setTabState({ mine: EMPTY_TAB, public: EMPTY_TAB });
    setPending(null);
    setSlideDir(null);
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
  // Paging is optimistic: goNext advances pageIndex immediately (SkeletonGrid renders as
  // the page until this commits), so pageIndex may point one page past pages.length while
  // a load is in flight -- the effect below is what actually triggers this fetch.
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
            // Land on the new page only if the user is still waiting on it (the usual
            // case -- goNext's optimistic pageIndex already equals s.pages.length); if
            // they swiped back off the skeleton mid-load, don't yank them forward.
            pageIndex: Math.min(s.pageIndex, s.pages.length),
            total,
            loading: false
          }
        };
      });
      // Rows committing over a skeleton page (or an initial/tab load) should "load in"
      // with the per-card stagger, not replay the directional slide -- the slide already
      // happened when the skeleton page arrived.
      setSlideDir(null);
    } catch (err) {
      if (fetchTokenRef.current !== token) return;
      updateTab(which, { loading: false, error: err.message });
    }
  };

  // Fetch whenever the current page isn't loaded yet -- that's both a tab's first visit
  // (pageIndex 0, no pages) and goNext's optimistic advance onto a skeleton page. Error
  // halts refetching until Retry clears it. Signed-out My Designs shows a sign-in prompt
  // instead (see below), so don't fetch -- listMyDesigns would just throw.
  useEffect(() => {
    if (!open) return;
    if (tab === 'mine' && !user) return;
    const s = tabState[tab];
    if (s.pageIndex >= s.pages.length && !s.loading && !s.error) {
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
  const hasNext = totalPages !== null && state.pageIndex + 1 < totalPages;
  const hasPrev = state.pageIndex > 0;

  // dir is what the incoming page's entrance should be: 'prev'/'next' (chevron clicks --
  // directional slide-in keyframe) or 'swipe' (touch handoff below -- NO entrance at all,
  // because the neighbor panel was already dragged fully into place and any further
  // animation would double the motion).
  const goPrev = (dir = 'prev') => {
    if (!hasPrev) return;
    setSlideDir(dir);
    // Clearing error covers backing off a failed skeleton page -- the loaded page behind
    // it should render normally, and a later goNext gets a fresh attempt via the effect.
    updateTab(tab, { pageIndex: state.pageIndex - 1, error: null });
  };
  const goNext = (dir = 'next') => {
    if (!hasNext || state.loading) return;
    setSlideDir(dir);
    // Optimistic: advance immediately even onto a not-yet-loaded page -- SkeletonGrid
    // renders as that page (so a swipe always has something to land on) and the fetch
    // effect above picks up the missing page.
    updateTab(tab, { pageIndex: state.pageIndex + 1 });
  };

  // Touch swipe on the grid area pages the carousel, matching what the pager's shape
  // already implies on mobile. A true carousel drag: the neighboring pages (or a skeleton
  // stand-in for a not-yet-loaded next page) are rendered offscreen at +/-100% inside the
  // sliding track, so dragging shows both panels moving together -- never a blank gap.
  // Once a touch commits to the horizontal axis (first ~10px of travel decide, so a
  // vertical panel scroll is never hijacked -- the wrapper's touch-action: pan-y leaves
  // that to the browser), the track follows the finger 1:1, with 3x rubber-band
  // resistance when there's no page in that direction (first page, last page, or a
  // next-page load already in flight). Release past the threshold animates the track the
  // rest of the way to the neighbor, THEN commits the page and resets the track in the
  // same frame -- the new current page renders exactly where the neighbor just was, so
  // the handoff is invisible. Release short of the threshold springs back.
  // Sequential-only by design -- cursor pagination can't jump to an arbitrary page.
  const onGridTouchStart = e => {
    if (animatingRef.current) return;
    const t = e.touches[0];
    touchStartRef.current = { x: t.clientX, y: t.clientY, axis: null, dx: 0 };
    if (slideRef.current) slideRef.current.style.transition = '';
  };
  const onGridTouchMove = e => {
    const g = touchStartRef.current;
    if (!g) return;
    const t = e.touches[0];
    const dx = t.clientX - g.x;
    const dy = t.clientY - g.y;
    if (!g.axis) {
      if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return;
      g.axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
    }
    if (g.axis !== 'x' || !slideRef.current) return;
    g.dx = dx;
    const pageAvailable = dx < 0 ? hasNext && !state.loading : hasPrev;
    slideRef.current.style.transform = `translateX(${pageAvailable ? dx : dx / 3}px)`;
  };
  const onGridTouchEnd = () => {
    const g = touchStartRef.current;
    touchStartRef.current = null;
    const el = slideRef.current;
    if (!g || !el) return;
    const dx = g.axis === 'x' ? g.dx : 0;
    const commitNext = dx < -56 && hasNext && !state.loading;
    const commitPrev = dx > 56 && hasPrev;
    if (commitNext || commitPrev) {
      // The neighbor sits at 100% + one grid gap (see the neighbor panels' comment), so
      // the settle has to travel that same distance -- plain clientWidth would leave the
      // handoff off by the gap, a visible jump at commit. The current panel (grid or
      // skeleton) carries the gap classes, so read the real computed value off it.
      const gap =
        parseFloat(el.firstElementChild ? getComputedStyle(el.firstElementChild).columnGap : '0') || 0;
      const width = el.clientWidth + gap;
      animatingRef.current = true;
      el.style.transition = 'transform 250ms ease-out';
      el.style.transform = `translateX(${commitNext ? -width : width}px)`;
      // setTimeout over transitionend: a transform transition interrupted by e.g. the
      // modal closing never fires transitionend, which would leave animatingRef stuck.
      window.setTimeout(() => {
        animatingRef.current = false;
        if (!slideRef.current) return;
        // flushSync so the page commit and the transform reset land in the same task --
        // interleaving them with React's async render would paint one frame of the OLD
        // page snapped back to center (or of the track still offset) before the new page
        // takes the neighbor's place.
        flushSync(() => {
          if (commitNext) goNext('swipe');
          else goPrev('swipe');
        });
        slideRef.current.style.transition = '';
        slideRef.current.style.transform = '';
      }, 260);
    } else {
      el.style.transition = 'transform 200ms ease-out';
      el.style.transform = 'translateX(0)';
    }
  };

  const tabClass = active =>
    'cursor-pointer font-quicksand text-sm pb-2 border-b-2 transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-interactive ' +
    (active ? 'border-accent text-text' : 'border-transparent text-text-muted hover:text-text');

  // One page of design cards. Used for the current page AND for the offscreen neighbor
  // panels the carousel drag reveals (`ghost` -- non-interactive: they're purely visual
  // until a commit re-renders them as the real current page). Entrance for the current
  // page: a directional whole-grid slide when the change came from a chevron (slideDir
  // 'next'/'prev', continuing the motion the button implies -- the per-card stagger is
  // skipped then, since both at once read as visual noise), nothing at all after a swipe
  // handoff ('swipe' -- the drag itself was the transition), the per-card stagger
  // otherwise (tab switch, first load).
  const renderPageGrid = (pageRows, { ghost = false } = {}) => (
    <div
      className={
        'grid grid-cols-4 gap-2 sm:gap-3' +
        (!ghost && slideDir === 'next'
          ? ' animate-slide-in-right'
          : !ghost && slideDir === 'prev'
            ? ' animate-slide-in-left'
            : '')
      }
    >
      {pageRows.map((d, i) => {
        const selected = pending?.id === d.id;
        return (
          <button
            key={d.id}
            type="button"
            tabIndex={ghost ? -1 : undefined}
            onClick={ghost ? undefined : () => setPending(d)}
            aria-pressed={selected}
            style={!ghost && slideDir === null ? { animationDelay: `${i * 40}ms` } : undefined}
            className={
              'group cursor-pointer overflow-hidden rounded-xl border-2 bg-ink-900 text-left transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-interactive ' +
              // Plain staggered fade, NOT fade-slide-up: cards here often appear over a
              // skeleton grid already sitting in their exact spots (swipe-onto-unloaded-
              // page fill-in), and a vertical slide would visibly misalign with it.
              (!ghost && slideDir === null ? 'animate-fade-in ' : '') +
              (selected ? 'border-accent' : 'border-hairline hover:border-text-muted')
            }
          >
            <div className="relative aspect-square overflow-hidden bg-ink-900">
              {/* Plain <img>: loadNextPage already preloaded this exact URL before the
                  page was committed, so FadeImage's own skeleton/fade would just fight
                  the wrapper's stagger (same reasoning as the mockup filmstrip's comment
                  in ProductPage). */}
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
              {/* Byline hidden on phones: at 4 columns a ~70px cell can't show a useful
                  amount of it, and dropping the line is what keeps the 2-row page short
                  enough to never scroll. */}
              {/* Name only, no avatar, unlike the gallery surfaces: these tiles are ~70px
                  and this line is already hidden on phones, so a circle would crowd out the
                  name it's meant to caption. Shares authorName so the fallback chain stays
                  in one place. */}
              {tab === 'public' && d.profiles && (
                <span className="hidden truncate text-[11px] text-text-secondary sm:block">
                  by {authorName(d.profiles)}
                </span>
              )}
            </div>
          </button>
        );
      })}
    </div>
  );

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
            <button
              className={tabClass(tab === 'mine')}
              onClick={() => {
                setSlideDir(null);
                setTab('mine');
              }}
            >
              My designs
            </button>
          )}
          <button
            className={tabClass(tab === 'public')}
            onClick={() => {
              setSlideDir(null);
              setTab('public');
            }}
          >
            Public
          </button>
        </div>

        {/* shrink-0 on each section: the panel is a flex column capped at 92vh with its own
            scrollbar -- without this, flex shrinks the grid wrapper instead of letting the
            panel scroll, and the footer renders on top of the squeezed grid (seen live at
            375px). Same treatment as GalleryModal's artwork block. */}
        {/* overflow-hidden + touch-action: pan-y: the drag-follow transform must not leak
            outside the grid area, and pan-y keeps vertical panel scrolling native while
            leaving horizontal travel to the gesture handlers. */}
        <div
          className="mt-4 min-h-[13rem] shrink-0 overflow-hidden [touch-action:pan-y]"
          onTouchStart={onGridTouchStart}
          onTouchMove={onGridTouchMove}
          onTouchEnd={onGridTouchEnd}
          onTouchCancel={onGridTouchEnd}
        >
          {/* The sliding track: current page in flow, neighbor pages absolutely
              positioned at +/-100% so a drag reveals them moving alongside. relative for
              the neighbors' inset-0; will-change hints the per-frame transform. */}
          <div ref={slideRef} className="relative will-change-transform">
          {tab === 'mine' && !user ? (
            <p className="py-12 text-center text-sm text-text-secondary">
              <Link to="/account" className="text-accent underline">Sign in</Link> to pick from your
              own saved designs.
            </p>
          ) : (state.pageIndex >= state.pages.length && !state.error) ||
            (state.loading && rows.length === 0) ? (
            // The skeleton page is a real swipe destination (goNext's optimistic advance
            // lands here), so it slides in with the same directional motion a loaded page
            // would -- the thumbnails then stagger in over it when the fetch commits.
            // Keyed off "this page isn't loaded", NOT just state.loading: the fetch
            // effect only sets loading a beat after the optimistic advance renders, and
            // gating on loading alone flashed the empty-state message in that gap.
            <div
              className={
                slideDir === 'next'
                  ? 'animate-slide-in-right'
                  : slideDir === 'prev'
                    ? 'animate-slide-in-left'
                    : undefined
              }
            >
              <SkeletonPage />
            </div>
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
            // Keyed per tab+page so switching pages replays the entrance animation for
            // the incoming batch instead of diffing cards in place (see renderPageGrid's
            // comment for which entrance plays when). 4 columns at every width (2 short
            // rows, not 4 tall ones) so the whole page of 8 fits a phone viewport without
            // the panel needing to scroll -- smaller thumbnails were Aaron's explicit
            // preference over a scrolling modal.
            <React.Fragment key={`${tab}-${state.pageIndex}`}>
              {slideDir === null ? (
                // Staggered-fade entrance (fill-in over a skeleton page, tab switch,
                // first load): the skeleton STAYS, layered behind the cards, so each
                // thumbnail crossfades in over its still-pulsing placeholder instead of
                // the skeleton vanishing a beat before the cards reach full opacity.
                // Once the fade completes the opaque cards simply cover it. count matches
                // the rows so a partial last page doesn't leave orphan placeholders
                // pulsing in the empty slots.
                <div className="relative">
                  <div className="absolute inset-0" aria-hidden="true">
                    <SkeletonPage count={rows.length} />
                  </div>
                  <div className="relative">{renderPageGrid(rows)}</div>
                </div>
              ) : (
                // Slide/swipe entrances move the whole grid -- a static skeleton behind
                // would peek out mid-motion, so no backdrop there.
                renderPageGrid(rows)
              )}
            </React.Fragment>
          )}

          {/* Neighbor panels -- the carousel drag's destinations, sitting offscreen at
              +/-100% until the finger pulls them in. Purely visual (aria-hidden, no
              pointer events, unfocusable): on commit the same content re-renders as the
              real current page in the exact spot the drag left it. Prev is always a
              cached page; next falls back to a skeleton when it hasn't loaded yet, which
              is also what the committed page shows while its fetch runs -- so the swipe
              target and the landing page agree. Suppressed while the current "page" is an
              error/sign-in/empty state (nothing sensible to drag to). */}
          {(tab !== 'mine' || user) && !state.error && hasPrev && (
            // Offset by 100% + the grid's own gap (0.5rem, 0.75rem at sm -- keep in sync
            // with the gap-2 sm:gap-3 on renderPageGrid) so the seam between pages reads
            // as one more column gap, not two grids touching edge-to-edge.
            <div
              className="pointer-events-none absolute top-0 w-full right-[calc(100%+0.5rem)] sm:right-[calc(100%+0.75rem)]"
              aria-hidden="true"
            >
              {renderPageGrid(state.pages[state.pageIndex - 1] || [], { ghost: true })}
            </div>
          )}
          {(tab !== 'mine' || user) && !state.error && hasNext && !state.loading && (
            <div
              className="pointer-events-none absolute top-0 w-full left-[calc(100%+0.5rem)] sm:left-[calc(100%+0.75rem)]"
              aria-hidden="true"
            >
              {state.pages[state.pageIndex + 1] ? (
                renderPageGrid(state.pages[state.pageIndex + 1], { ghost: true })
              ) : (
                <SkeletonPage />
              )}
            </div>
          )}
          </div>
        </div>

        {(tab !== 'mine' || user) && totalPages !== null && totalPages > 1 && (
          // animate-expand-in: this row only mounts once the count query resolves (and
          // never for a single-page tab), so it grows open smoothly instead of snapping
          // the whole modal taller the moment the total arrives. overflow-hidden clips
          // the row while max-height is still expanding.
          <div className="flex shrink-0 animate-expand-in items-center justify-center gap-3 overflow-hidden">
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
