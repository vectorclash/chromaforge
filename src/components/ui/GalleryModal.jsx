import React, { useEffect, useRef, useState } from 'react';
import SolidPanel from './SolidPanel';
import Button from './Button';
import FadeImage from './FadeImage';
import ShirtIcon from '../buttons/ShirtIcon';
import HeartIcon from '../buttons/HeartIcon';
import ArrowIcon from '../buttons/ArrowIcon';
import AnimationIcon from '../buttons/AnimationIcon';
import { getThumbnailUrl } from '../../lib/designs';
import { useStudio } from '../../context/StudioContext';
import AuthorBadge from './AuthorBadge';
import samplePalette from '../../utils/samplePalette';

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

// Pixel size the full render is downscaled to before sampling its palette. Big enough that
// drawImage's averaging doesn't mute a design's vivid accents into the wash behind them,
// small enough that getImageData + the scan is free.
const SAMPLE_SIZE = 200;

// How many swatches the rail shows. Five matches the largest stored palette in the gallery
// (sizes run 3-6, and a 6th dot starts crowding the seed chip beside it on a narrow panel).
const SWATCH_COUNT = 5;

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
  // Palette sampled off the full render, used only when the design has no palette of its
  // own. Most of the gallery is in that case -- a design's `colors` is the palette the user
  // explicitly picked, and an auto-palette design stores an empty array (37 of 47 rows when
  // this was built), deriving its colours from the seed inside the generators without ever
  // persisting them. Keyed off the render rather than the stored thumbnail because the
  // render is a same-origin blob: URL, so the canvas isn't tainted; the thumbnail comes from
  // Storage and getImageData on it would throw.
  const [sampledColors, setSampledColors] = useState(null);
  // This component stays mounted (GalleryPage always renders it; `design` just flips
  // between an object and null), so `fullSrc`/`fullLoaded` persist across closes. Track
  // which design they actually belong to so reopening the SAME design shows the already-
  // rendered image instantly instead of resetting to blank and re-fetching/re-fading in a
  // fresh render of identical content -- the same bug class as MobileNav's DotRipple
  // replaying on every reopen (see MobileNav.jsx).
  const renderedIdRef = useRef(null);
  const fullSrcRef = useRef(null);
  fullSrcRef.current = fullSrc;

  // Reset only when the design genuinely changes (not close->reopen of the same one) so
  // the previous design's full-res image can't linger visible under the next design's
  // still-loading one.
  useEffect(() => {
    if (!design || design.id === renderedIdRef.current) return;
    setFullSrc(null);
    setFullLoaded(false);
    setSampledColors(null);
    if (fullSrcRef.current) URL.revokeObjectURL(fullSrcRef.current);
  }, [design?.id]);

  useEffect(() => {
    // Animations don't have a single { seed, colors } config to recompose from (their
    // `data` is { animation: true, frames: [...] }) -- the thumbnail is all there is.
    if (!design || design.kind === 'animation' || !queueReady) return;
    if (design.id === renderedIdRef.current) return;
    let cancelled = false;
    renderDesignBlob(design.data, MODAL_RENDER_SIZE, MODAL_RENDER_SIZE, { highDensity: true })
      .then(blob => {
        if (cancelled) return;
        renderedIdRef.current = design.id;
        setFullSrc(URL.createObjectURL(blob));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // design is keyed by id below -- re-running this for every new object reference the
    // same design gets (e.g. a like-count bump) would refetch and re-flash the image for
    // no reason.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [design?.id, queueReady, renderDesignBlob]);

  // Blob URLs are otherwise kept alive across close/reopen (see above) -- only unmounting
  // the whole modal actually discards one.
  useEffect(() => {
    return () => {
      if (fullSrcRef.current) URL.revokeObjectURL(fullSrcRef.current);
    };
  }, []);

  useEffect(() => {
    if (!design) return;
    const onKeyDown = e => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [design, onClose]);

  if (!design) return null;

  const storedColors = Array.isArray(design.data?.colors) ? design.data.colors : [];
  const swatches = (storedColors.length ? storedColors : sampledColors || []).slice(0, SWATCH_COUNT);
  const seed = design.data?.seed;
  // Only surfaced when the design actually carries non-default settings -- compactDesign
  // omits `settings` entirely otherwise, and a "coherence 0" chip on every design that
  // never touched the sliders would be noise standing in for an answer nobody asked for.
  const coherence = design.data?.settings?.geometry?.coherence;
  const hasChips = swatches.length > 0 || seed || coherence != null;

  // Reads the palette off the render once it's on screen. Runs in the load handler rather
  // than an effect because it needs the decoded image, which is exactly what this event
  // reports. Failure is silent and non-fatal: the rail just doesn't render.
  const handleFullLoad = e => {
    setFullLoaded(true);
    if (storedColors.length || sampledColors) return;
    try {
      const canvas = document.createElement('canvas');
      canvas.width = SAMPLE_SIZE;
      canvas.height = SAMPLE_SIZE;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(e.target, 0, 0, SAMPLE_SIZE, SAMPLE_SIZE);
      setSampledColors(samplePalette(ctx.getImageData(0, 0, SAMPLE_SIZE, SAMPLE_SIZE), SWATCH_COUNT));
    } catch {
      setSampledColors([]);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex animate-fade-in items-center justify-center bg-black/70 p-4 backdrop-blur-sm sm:p-6"
      onClick={onClose}
    >
      <SolidPanel
        className={
          'relative flex max-h-[92vh] flex-col overflow-y-auto animate-iris-in p-5 sm:p-6 ' +
          PANEL_SIZE_CLASS
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

        {/* The entrance is one orchestrated beat, not three independent ones: the panel
            irises open, the artwork blooms out of blur inside it, then the title and the
            actions arrive on the existing reveal-quick stagger (same pattern/delays as
            ProductPage's mockup reveal). Delays are inline because they're per-element
            offsets within one sequence, which is what the token's own comment describes. */}
        <div className="animate-reveal-quick pr-10" style={{ animationDelay: '160ms' }}>
          <h2
            id="gallery-modal-title"
            className="truncate font-quicksand text-xl font-bold tracking-tight text-text"
          >
            {design.title || (design.kind === 'animation' ? 'Untitled animation' : 'Untitled')}
          </h2>
          <AuthorBadge profile={design.profiles} size="md" className="mt-1.5" />
        </div>

        <div className="relative mt-4 aspect-square w-full shrink-0 overflow-hidden rounded-xl bg-ink-900 ring-1 ring-white/5">
          {/* The bloom lives on this inner wrapper rather than the rounded container above
              so its blur and 1.06 overscale are clipped by that container's own
              overflow-hidden -- on the container itself, the blur would soften the panel's
              corners for the length of the animation. */}
          <div className="absolute inset-0 animate-bloom-in">
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
                onLoad={handleFullLoad}
                className={
                  'absolute inset-0 h-full w-full object-cover transition-opacity duration-500 ' +
                  (fullLoaded ? 'opacity-100' : 'opacity-0')
                }
              />
            )}
          </div>
          {design.kind === 'animation' && (
            <div
              className="pointer-events-none absolute left-3 top-3 flex items-center gap-1 rounded-full border border-white/10 bg-black/50 px-2.5 py-1.5 text-text backdrop-blur-sm"
              title="Animation"
            >
              <AnimationIcon size={14} />
            </div>
          )}
        </div>

        {/* The design's own facts, between the artwork and the things you can do to it.
            Every chip is conditional: an animation has no seed or palette, and a design that
            never touched the geometry sliders has no settings -- the row itself disappears
            rather than rendering an empty shell. Shares the actions' stagger delay so it
            arrives with them as one group, not as a fourth beat. */}
        {hasChips && (
          <div
            className="mt-4 flex animate-reveal-quick flex-wrap items-center gap-2"
            style={{ animationDelay: '280ms' }}
          >
            {swatches.length > 0 && (
              <span
                className="flex h-7 items-center rounded-full border border-hairline bg-ink-900 px-2.5"
                title={
                  storedColors.length
                    ? `Palette: ${swatches.join(', ')}`
                    : `Colors in this design: ${swatches.join(', ')}`
                }
              >
                {/* Overlapped, so five swatches read as one palette object rather than five
                    separate dots competing with the chips beside them. The ring is the chip's
                    own background, which is what makes the overlap legible. */}
                <span className="flex">
                  {swatches.map((hex, i) => (
                    <span
                      key={hex + i}
                      className="h-4 w-4 rounded-full ring-2 ring-ink-900"
                      style={{ backgroundColor: hex, marginLeft: i === 0 ? 0 : '-5px' }}
                    />
                  ))}
                </span>
              </span>
            )}

            {seed && (
              <span className="flex h-7 items-center gap-1.5 rounded-full border border-hairline bg-ink-900 px-2.5 font-quicksand text-xs font-semibold text-text-secondary">
                <span className="text-[10px] uppercase tracking-widest text-text-muted">Seed</span>
                <span className="tabular-nums">{seed}</span>
              </span>
            )}

            {coherence != null && (
              <span className="flex h-7 items-center gap-1.5 rounded-full border border-hairline bg-ink-900 px-2.5 font-quicksand text-xs font-semibold text-text-secondary">
                <span className="text-[10px] uppercase tracking-widest text-text-muted">
                  Coherence
                </span>
                <span className="tabular-nums">{coherence}</span>
              </span>
            )}
          </div>
        )}

        {/* Two rows, not one wrapping flex row -- with 3-4 pills plus a CTA, wrapping
            could strand "Open in studio" alone on its own line, still pinned to the
            right via ml-auto, which read as a stray floating button rather than a
            deliberate primary action. A dedicated full-width row below the quick actions
            reads the same (and looks intentional) at every width instead. */}
        <div
          className="mt-5 flex animate-reveal-quick flex-wrap items-center gap-3"
          style={{ animationDelay: '280ms' }}
        >
          <button
            type="button"
            onClick={() => onToggleLike(design)}
            className={PILL + (liked ? PILL_ACTIVE : PILL_IDLE)}
            aria-label={liked ? 'Unlike this design' : 'Like this design'}
          >
            <HeartIcon filled={liked} size={18} />
            <span>{liked ? 'Liked' : 'Like'}</span>
            {design.likes_count > 0 && (
              <span className="tabular-nums text-text-muted">{design.likes_count}</span>
            )}
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
          className={
            PILL +
            ' mt-3 w-full animate-reveal-quick justify-center border-accent/60 text-accent hover:bg-accent/10'
          }
          style={{ animationDelay: '340ms' }}
        >
          <span>Open in studio</span>
          <ArrowIcon size={14} />
        </button>
      </SolidPanel>
    </div>
  );
}
