import React, { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { gsap } from 'gsap/all';
import { useStudio } from '../../context/StudioContext';
import { useAuth } from '../../context/AuthContext';
import { useCrossfadeImage } from '../../hooks/useCrossfadeImage';
import { useWidgetVisibility } from '../../hooks/useWidgetVisibility';
import GenerateGlow from './GenerateGlow';

// No more hover rotation -- it read as unrelated to anything since it fired on mouse
// position, not on actual work being done. `spinning` (MiniGenerator's `pending`, true from
// the moment Generate is clicked through the new preview actually crossfading in) drives a
// real GSAP tween instead of a CSS `animate-spin` class, which is what the old version used.
// That CSS approach had a real, confirmed bug: the icon's `transition-transform` (added so
// the *hover* rotation eased) was still present while spinning, so the instant `animate-spin`
// was removed mid-rotation, that leftover transition eased the icon from wherever it happened
// to be back to 0 over 500-700ms -- a slow, arbitrary-looking wobble that started only once
// generation had already finished, exactly the "disconnected from the process" complaint this
// replaces. GSAP owns the rotation outright now: a continuous fast linear spin for exactly as
// long as `spinning` is true, killed and snapped to rest the instant it isn't -- no transition
// left lying around to fight it.
function RefreshIcon({ spinning }) {
  const iconRef = useRef(null);

  useEffect(() => {
    const el = iconRef.current;
    if (!el) return;
    if (spinning) {
      const tween = gsap.to(el, { rotation: '+=360', duration: 0.4, ease: 'none', repeat: -1 });
      return () => tween.kill();
    }
    gsap.set(el, { rotation: 0 });
  }, [spinning]);

  return (
    <svg
      ref={iconRef}
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M3 12a9 9 0 0 1 15.3-6.4M21 12a9 9 0 0 1-15.3 6.4" />
      <path d="M21 4v5h-5M3 20v-5h5" />
    </svg>
  );
}

// A quick diagonal light sweep on hover -- the studio's own Generate button has this
// (`.button-large::before` in components.css); the mini widget's was plain, which is
// the "studio one feels more fun" gap the user pointed at.
function GenerateShine() {
  return (
    <span
      aria-hidden
      className="pointer-events-none absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-white/25 to-transparent transition-transform duration-500 ease-out group-hover:translate-x-full"
    />
  );
}

// Ambient presence of the generator: either a floating widget or docked in the footer.
// The thumbnail and the footer's art band both read the same StudioContext.previewUrl,
// so regenerating here updates both at once, fading the same way.
export default function MiniGenerator({ inline = false }) {
  const { previewUrl, currentDesign, generateRandom, saveCurrentDesign, isCurrentDesignSaved } =
    useStudio();
  const { user } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const visible = useWidgetVisibility();

  const { shown, incoming, shownRef, incomingRef, holding } = useCrossfadeImage(previewUrl);

  const [saveStatus, setSaveStatus] = useState('idle'); // idle | saving | error
  // Real work happens between clicking Generate and the new preview actually landing:
  // currentDesign updates instantly, but previewUrl (and therefore the crossfade's
  // `incoming`) only appears once StudioContext has actually re-rendered the design to an
  // image -- a genuine gap, not a fixed guess. `generating` covers that whole span so the
  // icon animates continuously from the click through to the new image fading in, instead
  // of stopping early (a fixed-duration burst) or starting late (keying off `incoming`
  // alone, which is exactly the "feels disconnected" complaint this replaces).
  const [generating, setGenerating] = useState(false);
  const pending = generating || !!incoming;

  // Clear any stale error state from a previous design's failed save attempt
  useEffect(() => {
    setSaveStatus('idle');
  }, [currentDesign]);

  // previewUrl only changes once the render StudioContext kicked off for the new design
  // actually finishes -- that's the real "done generating" signal.
  useEffect(() => {
    setGenerating(false);
  }, [previewUrl]);

  const onGenerate = () => {
    setGenerating(true);
    generateRandom();
  };

  const onSave = async () => {
    if (!user) {
      navigate('/account');
      return;
    }
    if (isCurrentDesignSaved || saveStatus === 'saving') return;
    setSaveStatus('saving');
    try {
      await saveCurrentDesign('image', currentDesign);
      setSaveStatus('idle');
    } catch {
      setSaveStatus('error');
      setTimeout(() => setSaveStatus('idle'), 2500);
    }
  };

  // Plain navigate, no ?config= URL -- StudioPage already passes StudioContext's
  // currentDesign through as DisplayCanvas's `initialDesign` prop on every /studio mount,
  // so the design carries over via React state, not the URL (same pattern as
  // DisplayCanvas's own compact "Go to studio" button). This used to build a share-style
  // URL instead (generateShareUrl(toCompactDesign(currentDesign))), which caused two real
  // bugs: an uncompacted currentDesign could blow past the URL length limit and throw on
  // navigate() (fixed once by compacting first), and -- the reason it's gone now, not just
  // patched -- DisplayCanvas.jsx's init() treats *any* design loaded via a `?config=` URL
  // as already-saved (isSaved: true), which is correct for a real share/gallery link but
  // wrong here: this design may never have been saved at all. Confirmed live: generating in
  // the mini-widget without saving, then clicking through to the studio, showed "Saved"
  // for a design that was never actually persisted. The `initialDesign` prop path
  // DisplayCanvas already has for this exact "hand off the live design" case correctly
  // sets isSaved based on StudioContext's own isCurrentDesignSaved fact (via StudioPage's
  // isDesignSaved/savedDesignId props) instead of assuming false -- otherwise a design
  // already saved from this widget showed "Save" again in the Studio and produced a
  // duplicate row on click.
  const onOpenStudio = () => {
    navigate('/studio', { state: { from: location.pathname } });
  };

  // 1. Inline (Docked in Footer) Version: Horizontal Layout, buttons on left, image on right
  if (inline) {
    return (
      <div className="inline-flex flex-row items-center gap-4 rounded-2xl bg-black/15 p-4 opacity-90 shadow-[0_4px_40px_rgba(0,0,0,0.4)] backdrop-blur-[4px] backdrop-brightness-[0.95]">
        {/* Buttons stacked on the left */}
        <div className="flex flex-col gap-3 w-32 shrink-0">
          <button
            type="button"
            onClick={onGenerate}
            disabled={pending}
            aria-label="Generate new design"
            title="Generate new design"
            className="group relative flex h-12 w-full items-center justify-center gap-2 overflow-hidden rounded-xl border border-white/10 bg-white/5 text-text-secondary transition-all duration-200 hover:scale-[1.03] hover:border-accent/30 hover:bg-accent/10 hover:text-accent active:scale-[0.96] text-xs font-bold uppercase tracking-wider disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:scale-100 cursor-pointer"
          >
            <GenerateShine />
            <RefreshIcon spinning={pending} />
            <span>Generate</span>
          </button>
          
          {isCurrentDesignSaved ? (
            <button
              type="button"
              disabled
              className="h-12 w-full rounded-xl bg-white/5 border border-white/10 text-text-muted font-quicksand font-bold text-xs uppercase tracking-wider transition-all duration-200 cursor-default"
            >
              Saved
            </button>
          ) : saveStatus === 'saving' ? (
            <button
              type="button"
              disabled
              className="h-12 w-full rounded-xl bg-white/10 border border-white/10 text-text-secondary font-quicksand font-bold text-xs uppercase tracking-wider transition-all duration-200 animate-pulse"
            >
              Saving
            </button>
          ) : saveStatus === 'error' ? (
            <button
              type="button"
              disabled
              className="h-12 w-full rounded-xl bg-red-950/20 border border-red-500/30 text-red-400 font-quicksand font-bold text-xs uppercase tracking-wider transition-all duration-200"
            >
              Error
            </button>
          ) : (
            <button
              type="button"
              onClick={onSave}
              className="h-12 w-full rounded-xl bg-accent text-ink-950 font-quicksand font-bold text-xs uppercase tracking-wider hover:bg-accent-strong hover:scale-[1.02] active:scale-[0.98] transition-all duration-200 shadow-[0_4px_12px_rgba(166,224,0,0.25)] hover:shadow-[0_6px_16px_rgba(166,224,0,0.4)] cursor-pointer"
            >
              Save
            </button>
          )}
        </div>

        {/* Thumbnail on the right */}
        <button
          type="button"
          onClick={onOpenStudio}
          aria-label="Open this design in the studio"
          className="group relative block aspect-square w-[108px] h-[108px] shrink-0 cursor-pointer overflow-hidden rounded-xl bg-ink-950 border border-white/10 transition-all duration-300 hover:scale-[1.03] hover:border-accent/40 hover:shadow-[0_0_15px_rgba(166,224,0,0.2)]"
        >
          {shown && <img ref={shownRef} src={shown} alt="" className="absolute inset-0 h-full w-full object-cover" />}
          {incoming && (
            <img
              ref={incomingRef}
              src={incoming}
              alt=""
              className="absolute inset-0 h-full w-full object-cover"
              style={{ opacity: 0 }}
            />
          )}
          <GenerateGlow active={holding} blurClass="blur-xl" />
          {/* Hover overlay */}
          <div className="absolute inset-0 bg-interactive/10 opacity-0 group-hover:opacity-100 transition-opacity duration-300 pointer-events-none" />
        </button>
      </div>
    );
  }

  // 2. Floating Version: Vertical Layout, image on top, buttons on bottom
  return (
    <div
      className={
        'fixed bottom-6 right-6 z-30 w-44 rounded-2xl bg-black/15 p-3 shadow-[0_4px_40px_rgba(0,0,0,0.4)] backdrop-blur-[4px] backdrop-brightness-[0.95] transition-all duration-300 ' +
        (visible ? 'translate-y-0 opacity-100' : 'pointer-events-none translate-y-4 opacity-0')
      }
    >
      <button
        type="button"
        onClick={onOpenStudio}
        aria-label="Open this design in the studio"
        className="group relative block aspect-square w-full cursor-pointer overflow-hidden rounded-lg bg-ink-950 border border-white/10 transition-all duration-300 hover:scale-[1.03] hover:border-interactive/40"
      >
        {shown && <img ref={shownRef} src={shown} alt="" className="absolute inset-0 h-full w-full object-cover" />}
        {incoming && (
          <img
            ref={incomingRef}
            src={incoming}
            alt=""
            className="absolute inset-0 h-full w-full object-cover"
            style={{ opacity: 0 }}
          />
        )}
        <GenerateGlow active={holding} blurClass="blur-xl" />
        {/* Hover overlay */}
        <div className="absolute inset-0 bg-interactive/10 opacity-0 group-hover:opacity-100 transition-opacity duration-300 pointer-events-none" />
      </button>

      <div className="mt-2.5 flex gap-2">
        <button
          type="button"
          onClick={onGenerate}
          disabled={pending}
          aria-label="Generate new design"
          title="Generate new design"
          className="group relative flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-white/10 bg-white/5 text-text-secondary transition-all duration-200 hover:scale-[1.08] hover:border-accent/30 hover:bg-accent/10 hover:text-accent active:scale-[0.92] disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:scale-100 cursor-pointer"
        >
          <GenerateShine />
          <RefreshIcon spinning={pending} />
        </button>
        
        {isCurrentDesignSaved ? (
          <button
            type="button"
            disabled
            className="flex-1 h-9 rounded-lg bg-white/5 border border-white/10 text-text-muted font-quicksand font-semibold text-[10px] uppercase tracking-wider transition-all duration-200 cursor-default"
          >
            Saved
          </button>
        ) : saveStatus === 'saving' ? (
          <button
            type="button"
            disabled
            className="flex-1 h-9 rounded-lg bg-white/10 border border-white/10 text-text-secondary font-quicksand font-semibold text-[10px] uppercase tracking-wider transition-all duration-200 animate-pulse"
          >
            Saving
          </button>
        ) : saveStatus === 'error' ? (
          <button
            type="button"
            disabled
            className="flex-1 h-9 rounded-lg bg-red-950/20 border border-red-500/30 text-red-400 font-quicksand font-semibold text-[10px] uppercase tracking-wider transition-all duration-200"
          >
            Error
          </button>
        ) : (
          <button
            type="button"
            onClick={onSave}
            className="flex-1 h-9 rounded-lg bg-accent text-ink-950 font-quicksand font-bold text-[10px] uppercase tracking-wider hover:bg-accent-strong hover:scale-[1.02] active:scale-[0.98] transition-all duration-200 shadow-[0_4px_12px_rgba(166,224,0,0.25)] hover:shadow-[0_6px_16px_rgba(166,224,0,0.4)] cursor-pointer"
          >
            Save
          </button>
        )}
      </div>
    </div>
  );
}
