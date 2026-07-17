import React, { useEffect, useState } from 'react';
import SolidPanel from './SolidPanel';
import Button from './Button';
import FadeImage from './FadeImage';
import ShirtIcon from '../buttons/ShirtIcon';
import HeartIcon from '../buttons/HeartIcon';
import ArrowIcon from '../buttons/ArrowIcon';
import AnimationIcon from '../buttons/AnimationIcon';
import { getThumbnailUrl } from '../../lib/designs';
import { useStudio } from '../../context/StudioContext';

// Rendered bigger than the 320x320 gallery thumbnail so the artwork actually looks crisp
// full-screen-ish, but well short of print resolution -- this is a preview, not a print
// file. Comfortably covers the panel's own viewport-fit cap (see PANEL_SIZE_CLASS) at up
// to ~1.5x device pixel ratio. Uses renderDesignBlob's highDensity option (see
// StudioContext.jsx) since 1400 is still under DISPLAY_RENDER_CAP -- without it this would
// generate a composition genuinely less dense than the design's own full-size render, not
// just a smaller one.
const MODAL_RENDER_SIZE = 1400;

// The whole panel scales continuously with the viewport instead of jumping between fixed
// breakpoints -- bounded by width (90vw) and by height (90vh minus a fixed budget for the
// title/gaps/padding/button row around the square artwork, ~210px) so a short-but-wide
// window and a tall-but-narrow one both get a panel that actually fits without needing to
// scroll, up to a 1000px ceiling so it doesn't balloon to fill a huge monitor. Every child
// below is a plain `w-full` (or default block fill) of *this* -- the artwork's own size is
// never computed independently, so it can't end up wider than the panel that clips it (a
// real bug from an earlier version: an image sized off 90vw directly could exceed a
// separately-capped max-w-[95vw] panel once its own padding was subtracted, and bled out
// past the panel's edge on narrow viewports).
const PANEL_SIZE_CLASS = 'w-[min(90vw,calc(90vh_-_210px),1000px)]';

const PILL =
  'flex h-11 cursor-pointer items-center gap-2 rounded-lg border px-4 font-quicksand text-sm font-semibold transition';
const PILL_IDLE = ' border-hairline bg-ink-800 text-text hover:border-accent/40 hover:text-accent';
const PILL_ACTIVE = ' border-accent/50 bg-accent/10 text-accent';

function CloseIcon() {
  return (
    <svg viewBox="0 0 24 24" width={18} height={18} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

// Replaces the old "tap the thumbnail to jump into the Studio" behavior -- editing was
// never really the point of browsing the gallery, and the like/print/delete pill on each
// card was too small to comfortably tap on mobile. This shows the design bigger, with
// full-size actions, and makes "Open in studio" an explicit choice instead of the only
// thing tapping a card could do. Backdrop/panel/keyboard handling mirrors ConfirmDialog
// (the one other modal in the app) -- flat fade on the backdrop, bouncy pop-in reserved
// for the panel itself (see tailwind.css's animate-fade-in comment).
export default function GalleryModal({ design, liked, canDelete, onClose, onToggleLike, onPrint, onDelete, onOpenStudio }) {
  const { renderDesignBlob, queueReady } = useStudio();
  const [fullSrc, setFullSrc] = useState(null);
  const [fullLoaded, setFullLoaded] = useState(false);

  // Reset immediately on design change so the previous design's full-res image can't
  // linger visible (at full opacity) underneath the next design's still-loading one.
  useEffect(() => {
    setFullSrc(null);
    setFullLoaded(false);
  }, [design?.id]);

  useEffect(() => {
    // Animations don't have a single { seed, colors } config to recompose from (their
    // `data` is { animation: true, frames: [...] }) -- the thumbnail is all there is.
    if (!design || design.kind === 'animation' || !queueReady) return;
    let cancelled = false;
    let url;
    renderDesignBlob(design.data, MODAL_RENDER_SIZE, MODAL_RENDER_SIZE, { highDensity: true })
      .then(blob => {
        if (cancelled) return;
        url = URL.createObjectURL(blob);
        setFullSrc(url);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
    // design is keyed by id below -- re-running this for every new object reference the
    // same design gets (e.g. a like-count bump) would refetch and re-flash the image for
    // no reason.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [design?.id, queueReady, renderDesignBlob]);

  useEffect(() => {
    if (!design) return;
    const onKeyDown = e => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [design, onClose]);

  if (!design) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex animate-fade-in items-center justify-center bg-black/70 p-4 backdrop-blur-sm sm:p-6"
      onClick={onClose}
    >
      <SolidPanel
        className={
          'relative flex max-h-[92vh] flex-col overflow-y-auto animate-pop-in p-5 sm:p-6 ' + PANEL_SIZE_CLASS
        }
        role="dialog"
        aria-modal="true"
        aria-labelledby="gallery-modal-title"
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

        <div className="pr-10">
          <h2 id="gallery-modal-title" className="truncate font-quicksand text-lg font-bold text-text">
            {design.title || (design.kind === 'animation' ? 'Untitled animation' : 'Untitled')}
          </h2>
          {design.profiles && (
            <p className="truncate text-sm text-text-secondary">
              by {design.profiles.display_name || design.profiles.username || 'someone'}
            </p>
          )}
        </div>

        <div className="relative mt-4 aspect-square w-full shrink-0 overflow-hidden rounded-xl bg-ink-900">
          <FadeImage
            key={design.id}
            src={getThumbnailUrl(design.user_id, design.id)}
            alt=""
            onError={e => {
              e.target.style.visibility = 'hidden';
            }}
            className="absolute inset-0 h-full w-full object-cover"
          />
          {fullSrc && (
            <img
              key={fullSrc}
              src={fullSrc}
              alt={design.title || 'Untitled design'}
              onLoad={() => setFullLoaded(true)}
              className={
                'absolute inset-0 h-full w-full object-cover transition-opacity duration-500 ' +
                (fullLoaded ? 'opacity-100' : 'opacity-0')
              }
            />
          )}
          {design.kind === 'animation' && (
            <div
              className="pointer-events-none absolute left-3 top-3 flex items-center gap-1 rounded-full bg-black/40 px-2.5 py-1.5 text-text backdrop-blur-sm"
              title="Animation"
            >
              <AnimationIcon size={14} />
            </div>
          )}
        </div>

        {/* Two rows, not one wrapping flex row -- with 3-4 pills plus a CTA, wrapping
            could strand "Open in studio" alone on its own line, still pinned to the
            right via ml-auto, which read as a stray floating button rather than a
            deliberate primary action. A dedicated full-width row below the quick actions
            reads the same (and looks intentional) at every width instead. */}
        <div className="mt-5 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => onToggleLike(design)}
            className={PILL + (liked ? PILL_ACTIVE : PILL_IDLE)}
            aria-label={liked ? 'Unlike this design' : 'Like this design'}
          >
            <HeartIcon filled={liked} size={18} />
            <span>{liked ? 'Liked' : 'Like'}</span>
            {design.likes_count > 0 && <span className="text-text-muted">{design.likes_count}</span>}
          </button>

          {design.kind !== 'animation' && (
            <button
              type="button"
              onClick={() => onPrint(design)}
              className={PILL + PILL_IDLE}
              aria-label="Print this design"
            >
              <ShirtIcon size={18} />
              <span>Print</span>
            </button>
          )}

          {canDelete && (
            <button
              type="button"
              onClick={() => onDelete(design)}
              className={PILL + PILL_IDLE}
              aria-label="Delete design"
            >
              <span>Delete</span>
            </button>
          )}
        </div>

        <button
          type="button"
          onClick={() => onOpenStudio(design)}
          className={PILL + ' mt-3 w-full justify-center border-accent/60 text-accent hover:bg-accent/10'}
        >
          <span>Open in studio</span>
          <ArrowIcon size={14} />
        </button>
      </SolidPanel>
    </div>
  );
}
