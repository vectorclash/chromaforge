import React, { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import PageContainer from './PageContainer';
import { claimRouteIntro, releaseRouteIntro } from '../../utils/routeIntro';
import SkeletonGrid from './SkeletonGrid';

// Placeholders for the SiteLayout routes, shown by the Suspense boundary while a lazy page's
// chunk downloads -- and, for the product page, reused by the page itself while its catalog
// fetch is in flight, so the two phases are literally the same markup and cannot disagree.
//
// This exists because reserving space inside each page was only half the job: every route
// under SiteLayout is React.lazy, so for the few hundred ms before its chunk lands the layout
// renders a header, an EMPTY main and a footer -- and `min-h-dvh` + `flex-1` parks that footer
// at the bottom of the viewport, in plain sight, until the page mounts and shoves it off
// screen. Measured on a cold load of /shop/257 at 1280x800: the document sat at 800px for
// ~500ms, then went to 1637px in one frame.
//
// EVERYTHING HERE MUST STAY CHEAP TO IMPORT. SiteLayout imports it eagerly, so anything it
// pulls in lands in the main bundle -- which is exactly what the lazy routes exist to avoid.
// No lib/printful, no render pipeline, no Supabase: markup and constants only.

// One class for every placeholder block, so a skeleton pulses as one surface.
const SKEL = 'animate-pulse rounded-lg bg-ink-800';

// Grid geometry for the two card routes. Shared with ShopPage/GalleryPage rather than
// duplicated: their own in-page skeletons hand over to (and from) these, so a divergence in
// columns or gaps would show as the placeholder shifting sideways mid-load.
export const SHOP_GRID_CLASS = 'grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3';
export const GALLERY_GRID_CLASS = 'grid grid-cols-2 gap-5 sm:grid-cols-3 lg:grid-cols-4';

// The real heading each of these two routes will render, owned here and imported BACK by the
// pages themselves so there is exactly one copy of the words.
//
// The skeleton renders them FOR REAL rather than as grey bars, which is what removes the last
// layout shift on these routes instead of tuning it away. A placeholder bar has to guess how
// many lines the sentence takes, and a sentence wraps at a width no breakpoint knows about:
// reserving one line (what this did) cost 24px of jump at 390px and below on both routes, and
// reserving two would have made the footer RISE into view on every wider screen, which is the
// same jolt in reverse (see the note above GENERIC_BODY_MIN). Rendering the real text through
// the real PageContainer makes the geometry identical by construction, at every width, with
// nothing to re-measure when the copy changes.
//
// Only these two routes can do this: their headings are compile-time constants. The product
// page's title is the product's, which nothing knows before the fetch.
export const SHOP_HEADER = {
  title: 'Shop',
  subtitle: 'Wear the algorithm. Generated from a seed, printed to order.'
};

export const GALLERY_HEADER = {
  title: 'Gallery',
  subtitle: 'Designs saved by the community and by you.'
};

// Mirrors STARTER_PRODUCT_IDS.length. Deliberately a literal and not that array's length:
// importing it would drag lib/printful (and with it the whole render pipeline) into the main
// bundle. ShopPage imports this constant back and warns in dev if the two ever drift.
export const SHOP_TILE_COUNT = 18;

// Mirrors GalleryPage's PAGE_SIZE, for the same reason as above -- kept a literal so this
// module stays free of page imports.
export const GALLERY_TILE_COUNT = 20;

// Shown while the product's catalog fetch is in flight and, before that, while its chunk
// downloads. It deliberately MIRRORS the real page's geometry -- the same wrapper classes,
// the same aspect-square hero, the same block heights down the purchase column -- rather
// than approximating it. Measured with the fetch delayed, across five products: exactly 0px
// of shift at 1280 and -11px at 768 (the square hero in the 3fr column dominates both, so it
// is exact for every product), and +4 to +90px at 390, where the stacked purchase column
// contributes and the size-chip row's real wrap depends on a per-product size count (3 to 11)
// that nothing can know before the fetch. That residual sits ~1000px below a phone's fold.
// If you change the real layout's block heights, change them here too; there is no way to
// derive one from the other, and a divergence shows up as exactly the pop this removes.
export function ProductPageSkeleton() {
  // This route mounts this component up to THREE times on a cold load -- the Suspense
  // fallback, the page's own `loading` render once its chunk lands, and the copy inside
  // SkeletonFadeOut during the crossfade -- and a fresh mount replays `.intro-stagger`, so
  // the placeholder visibly animated in two or three times over. Claiming the route's
  // entrance as a `placeholder` means only the first of them enters; the real page claims
  // nothing of the sort and still enters in full, which is the whole point of this route not
  // sharing the shop/gallery treatment. See routeIntro.js.
  const { pathname } = useLocation();
  useEffect(() => {
    claimRouteIntro(pathname, 'placeholder');
    return () => releaseRouteIntro(pathname, 'placeholder');
  }, [pathname]);

  return (
    <PageContainer
      introKind="placeholder"
      breadcrumb={
        // Real, not a placeholder: "Shop" is a working way back out while the page loads, and
        // it is the one part of this route that is already known.
        <nav className="font-quicksand text-sm text-text-muted" aria-label="Breadcrumb">
          <Link to="/shop" className="transition hover:text-text">
            Shop
          </Link>
          <span className="px-1.5 text-text-muted/60" aria-hidden="true">
            ›
          </span>
          <span className={`${SKEL} inline-block h-3.5 w-28 align-middle`} aria-hidden="true" />
        </nav>
      }
    >
      <div aria-hidden="true">
        {/* Matches PageContainer's own header: one 40px line of text-4xl, which wraps to two
            on a phone for all but the shortest product titles. */}
        <header className="mb-10">
          <div className="flex h-10 items-center">
            <div className={`${SKEL} h-7 w-64 max-w-full`} />
          </div>
          <div className="flex h-10 items-center sm:hidden">
            <div className={`${SKEL} h-7 w-40`} />
          </div>
        </header>

        {/* 1. Choose artwork: the h2, then a row of 96px tiles each over a two-line label. */}
        <div className="mb-8">
          <div className="flex h-5 items-center">
            <div className={`${SKEL} h-3.5 w-32`} />
          </div>
          <div className="mt-3 flex flex-wrap gap-3">
            {[0, 1].map(i => (
              <div key={i} className="flex w-24 flex-col gap-1.5">
                <div
                  className={`${SKEL} h-24 w-24 rounded-xl`}
                  style={{ animationDelay: `${i * 50}ms` }}
                />
                <div className="min-h-[2.5em] text-[11px]">
                  <div className={`${SKEL} mx-auto h-2.5 w-16`} />
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* The collapsed Print options disclosure. */}
        <div className="mb-8">
          <div className="flex h-[68px] items-center justify-between gap-3 rounded-xl border border-hairline px-4">
            <div className="min-w-0 flex-1 space-y-2">
              <div className={`${SKEL} h-3.5 w-28`} />
              <div className={`${SKEL} h-3 w-48 max-w-full`} />
            </div>
            <div className={`${SKEL} h-4 w-4 shrink-0 rounded-full`} />
          </div>
        </div>

        <div className="grid grid-cols-1 gap-10 lg:grid-cols-[3fr_2fr]">
          {/* The hero. This is what makes the desktop height exact: the same aspect-square box
              the real gallery uses, in the same 3fr column. */}
          <div>
            <div className={`${SKEL} aspect-square rounded-xl border border-hairline`} />
          </div>

          {/* Purchase column: size row, size guide link, size chips, quantity, subtotal block.
              Heights measured off the real column. */}
          <div>
            <div className="flex h-5 items-center justify-between">
              <div className={`${SKEL} h-3.5 w-24`} />
              <div className={`${SKEL} h-3.5 w-12`} />
            </div>
            <div className="mt-1 flex h-4 items-center">
              <div className={`${SKEL} h-3 w-20`} />
            </div>
            {/* One row of size chips. Their WIDTH matters as much as their height: at a phone
                width a chip wider than the real ones (px-3 around one or two characters) wraps
                the row and reserves 46px too much. Sizes-per-product runs from 3 to 11, so a
                single row is the central guess, not an exact one. */}
            <div className="mt-3 flex flex-wrap gap-2">
              {[0, 1, 2, 3, 4, 5].map(i => (
                <div key={i} className={`${SKEL} h-[38px] w-11`} />
              ))}
            </div>
            <div className="mt-8">
              <div className="flex h-5 items-center">
                <div className={`${SKEL} h-3.5 w-20`} />
              </div>
              <div className={`${SKEL} mt-3 h-[46px] w-32`} />
            </div>
            <div className="mt-8 border-t border-hairline pt-6">
              <div className="flex h-8 items-baseline justify-between">
                <div className={`${SKEL} h-3.5 w-16`} />
                <div className={`${SKEL} h-6 w-24`} />
              </div>
              <div className="mt-1 flex h-4 items-center justify-end">
                <div className={`${SKEL} h-3 w-44 max-w-full`} />
              </div>
              <div className={`${SKEL} mt-4 h-14 w-full`} />
              <div className="mt-4 space-y-1.5">
                <div className={`${SKEL} h-3 w-full`} />
                <div className={`${SKEL} h-3 w-2/3`} />
              </div>
            </div>
          </div>
        </div>
      </div>
    </PageContainer>
  );
}

// Wraps a skeleton that is being replaced by real content, so it fades out ON TOP of it
// rather than being cut away -- which would leave a frame where neither is painted, since a
// page's own entrance animations start from opacity 0. Same beat and shape as the crossfade
// ShopPage and GalleryPage already run; they can express it as a class swap because their
// placeholder is already mounted and visible, whereas this one mounts at the moment of the
// swap. Hence the two frames: an element that mounts straight into opacity-0 has no previous
// painted value to transition FROM (the same reason FadeImage defers its own reveal twice).
// The caller keeps this mounted for DURATION_SLOW and then drops it.
export function SkeletonFadeOut({ children }) {
  const [out, setOut] = useState(false);
  useEffect(() => {
    let inner;
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => setOut(true));
    });
    return () => {
      cancelAnimationFrame(outer);
      if (inner) cancelAnimationFrame(inner);
    };
  }, []);
  return (
    <div
      aria-hidden="true"
      className={
        'pointer-events-none absolute inset-x-0 top-0 transition-opacity duration-500 ease-out ' +
        (out ? 'opacity-0' : 'opacity-100')
      }
    >
      {children}
    </div>
  );
}

// A card grid behind its page header. Both card routes have the same shape at this stage --
// a title, a subtitle or a tab strip, then the grid -- so they share one component and differ
// only in geometry and tile count.
function GridRouteSkeleton({ pathname, header, gridClass, count, extra = null, after = null }) {
  // This fallback shows the page's own header, at its final size, in its final place -- so
  // the entrance it plays IS the route's entrance, and the page must not repeat it when it
  // takes over. Released on unmount so a later visit enters again. See routeIntro.js; the
  // product skeleton deliberately does not do this, because it shows placeholder bars.
  useEffect(() => {
    claimRouteIntro(pathname);
    return () => releaseRouteIntro(pathname);
  }, [pathname]);

  return (
    <PageContainer title={header.title} subtitle={header.subtitle}>
      {extra}
      <SkeletonGrid count={count} className={gridClass} />
      {after}
    </PageContainer>
  );
}

// Everything else under SiteLayout: account, the legal pages, checkout success, 404. These
// share no shape, so the only thing worth getting right is the reserved height -- and the two
// directions are NOT symmetric. Under-reserving leaves the footer on screen and then throws it
// off, which is the whole complaint; over-reserving makes the footer RISE into view once the
// real content lands, which is the same jolt in reverse. So the rule is: reserve past the fold
// wherever the real page is reliably taller than a viewport, and reserve little where it
// isn't. Measured mains at 1280x800: terms 2197, privacy 1884, account 704 signed out (more
// signed in), checkout success and 404 both exactly 403.
const GENERIC_BODY_MIN = {
  // Walls of text. Anything up to a screenful is a safe under-estimate here.
  '/terms': 1000,
  '/privacy': 1000,
  // Lands the footer exactly where the signed-OUT page puts it, which is this route's floor --
  // signed in only ever grows past it.
  '/account': 408
};

function GenericRouteSkeleton({ bodyMin = 0 }) {
  return (
    <div aria-hidden="true">
      <header className="mb-10">
        <div className="flex h-10 items-center">
          <div className={`${SKEL} h-7 w-56`} />
        </div>
        <div className="mt-2 flex h-6 items-center">
          <div className={`${SKEL} h-3.5 w-80 max-w-full`} />
        </div>
      </header>
      {/* Bare, the body is one small card: the default has to suit the SHORT routes, since
          those are the ones where a too-tall reservation would visibly lift the footer. The
          text lines only appear for the routes that asked for real height. */}
      <div className="space-y-4" style={bodyMin ? { minHeight: `${bodyMin}px` } : undefined}>
        <div className={`${SKEL} h-24 w-full rounded-xl`} />
        {bodyMin > 0 && (
          <>
            <div className={`${SKEL} h-3.5 w-full`} />
            <div className={`${SKEL} h-3.5 w-11/12`} />
            <div className={`${SKEL} h-3.5 w-3/4`} />
          </>
        )}
      </div>
    </div>
  );
}

export default function RouteSkeleton({ pathname }) {
  // Matched on the path rather than passed down per route, because the Suspense boundary sits
  // above the router's route matching -- by the time a <Route> element could choose its own
  // fallback, its chunk has already loaded and there is nothing left to show.
  if (/^\/shop\/[^/]+/.test(pathname)) return <ProductPageSkeleton />;
  if (pathname === '/shop') {
    return (
      <GridRouteSkeleton
        pathname={pathname}
        header={SHOP_HEADER}
        gridClass={SHOP_GRID_CLASS}
        count={SHOP_TILE_COUNT}
      />
    );
  }
  if (pathname === '/gallery') {
    return (
      <GridRouteSkeleton
        pathname={pathname}
        header={GALLERY_HEADER}
        gridClass={GALLERY_GRID_CLASS}
        count={GALLERY_TILE_COUNT}
        // The Public/My Designs tab strip above the grid, and below it the infinite-scroll
        // sentinel's own 80px -- a full page of tiles is exactly the evidence `hasMore` is set
        // from, and GalleryPage's own skeleton reserves the same row for the same reason.
        extra={<div className="mb-6 h-[31px] border-b border-hairline" aria-hidden="true" />}
        after={<div className="py-10" aria-hidden="true" />}
      />
    );
  }
  return <GenericRouteSkeleton bodyMin={GENERIC_BODY_MIN[pathname] || 0} />;
}
