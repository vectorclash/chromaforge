import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { gsap } from 'gsap/all';
import { DURATION_FAST, DURATION_SLOW } from '../../utils/motionTokens';
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

// The panel's top edge: the site's spectrum hairline (.cf-spectrum-line, the one under the
// wordmark) but built from the ACTIVE design's own colours, so the widget carries a trace of
// the artwork it just made instead of a fixed brand stripe. The last stop repeats the first --
// the brand line does the same (it opens and closes on #4c00ff), and without it a two- or
// three-stop palette reads as a hard left-to-right ramp rather than a band of the design.
//
// Two stacked copies rather than one whose background is swapped: a CSS gradient cannot be
// transitioned between arbitrary stop lists, and even where it could, a swap would snap. The
// old palette stays put while the new one fades in over it, which is the same crossfade (not
// dip-out) the artwork itself gets.
function edgeGradient(colors) {
  if (!colors || colors.length === 0) return null;
  const stops = colors.length === 1 ? [colors[0], colors[0]] : [...colors, colors[0]];
  return `linear-gradient(90deg, ${stops.join(', ')})`;
}

function PaletteEdge({ inset, shownColors, incomingColors, incomingRef }) {
  const shownBg = edgeGradient(shownColors);
  if (!shownBg) return null;
  const incomingBg = edgeGradient(incomingColors);
  return (
    <>
      <span aria-hidden className={`mini-palette-edge ${inset}`} style={{ background: shownBg }} />
      {incomingBg && (
        <span
          ref={incomingRef}
          aria-hidden
          className={`mini-palette-edge ${inset}`}
          style={{ background: incomingBg, opacity: 0 }}
        />
      )}
    </>
  );
}

// What the Generate button dims to while a generate is in flight -- the value the
// `disabled:opacity-30` utility used to supply, kept here because GSAP now owns this
// property outright (see the tween in MiniGenerator below).
const DISABLED_OPACITY = 0.3;

// Ambient presence of the generator: either a floating widget or docked in the footer.
// The thumbnail and the footer's art band both read the same StudioContext.previewUrl,
// so regenerating here updates both at once, fading the same way.
//
// `style`/`className` exist for ONE reason and it is load-bearing, not convenience: an entrance
// animation for this widget has to be applied to the glass surface ITSELF, never to a wrapper
// around it. Any ancestor with opacity < 1 (or a transform/filter) becomes a *backdrop root*,
// and a backdrop-filter can only sample what is painted inside its own backdrop root -- so a
// wrapper that contains nothing behind the panel leaves the filter with an empty backdrop and
// the glass renders inert: the artwork behind shows through sharp and unblurred, then snaps to
// frosted the instant the animation ends. That was a real bug in MobileNav, which used to put
// `fade-slide-up` on the padding div around this (Aaron: "doesn't show the artwork correctly
// behind it at first but then it settles"). Verified in Chromium: an ancestor's opacity kills
// the blur, the element's OWN opacity does not -- which is why moving the animation down one
// level is the whole fix, and why the floating variant below can animate its own opacity freely.
export default function MiniGenerator({ inline = false, className = '', style }) {
  const {
    previewUrl,
    previewPalette,
    currentDesign,
    generateRandom,
    saveCurrentDesign,
    isCurrentDesignSaved
  } = useStudio();
  const { user } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const visible = useWidgetVisibility();

  const { shown, incoming, shownRef, incomingRef, holding } = useCrossfadeImage(previewUrl);

  // The top edge's colours, kept on the artwork's own beat rather than the design's. The whole
  // point is that they change WITH the thumbnail, and the two facts arrive at different times:
  // previewPalette lands with the new preview url, at the START of the reveal (the fade-out),
  // while `incoming` is set at the instant the fade-in begins. So the palette is held in a ref
  // and only committed when `incoming` appears -- the same trigger, the same DURATION_SLOW, the
  // same power2.inOut the hook fades the image with, which is what makes the two read as one
  // event instead of two things that happen to be near each other. Keying off previewPalette
  // directly would recolour the edge a full second before the image it belongs to (the artwork
  // is still fading the PREVIOUS design out at that point), which is the same mistake as
  // watching currentDesign instead of previewUrl -- see the site-wide rule in CLAUDE.md.
  const [edgeColors, setEdgeColors] = useState(null);
  const [edgeIncomingColors, setEdgeIncomingColors] = useState(null);
  const edgeIncomingRef = useRef(null);
  const latestPaletteRef = useRef(null);
  latestPaletteRef.current = previewPalette;

  const [saveStatus, setSaveStatus] = useState('idle'); // idle | saving | error
  // Real work happens between clicking Generate and the new preview actually landing:
  // currentDesign updates instantly, but previewUrl (and therefore the crossfade's
  // `incoming`) only appears once StudioContext has actually re-rendered the design to an
  // image -- a genuine gap, not a fixed guess. `generating` covers that whole span so the
  // icon animates continuously from the click through to the new image fading in, instead
  // of stopping early (a fixed-duration burst) or starting late (keying off `incoming`
  // alone, which is exactly the "feels disconnected" complaint this replaces).
  const [generating, setGenerating] = useState(false);
  // `holding` is load-bearing here, not belt-and-braces: useCrossfadeImage's reveal is
  // fade-out -> DURATION_HOLD blank beat -> fade-in, and `incoming` is only set at the
  // START of the fade-in. `generating` ends the moment previewUrl lands, i.e. at the start
  // of the fade-out -- so without `holding` there is a ~1.2s dead gap covering the whole
  // fade-out + hold, in which the icon snaps to rest and then starts spinning again. That
  // is a real, measured regression from the crossfade rework (dd61219, which added the
  // hold): sampled rotation went 0deg at the click, ~33deg by 74ms, back to 0 from 77ms to
  // 1294ms, then spinning again to 1786ms -- exactly the "almost starts, then nothing, then
  // starts a moment too late" symptom.
  //
  // It deliberately ends AT the fade-in rather than after it, so the icon settling and the
  // button coming back live are the same beat as the new artwork appearing, instead of the
  // reveal finishing and the button waking up a half-second later. That's the same instant
  // GenerateGlow's own fade-out is timed to (it rides `holding` too, see useCrossfadeImage's
  // comment) -- so every "working" signal in the widget resolves together, on the artwork.
  // Hence `incoming` is intentionally NOT part of this.
  const pending = generating || holding;

  // The button's dimmed/live state is the same motion as the artwork's, not a lookalike:
  // GSAP drives its opacity with the exact durations and ease useCrossfadeImage uses on the
  // images themselves -- dim over DURATION_FAST alongside the old preview's fade-out,
  // restore over DURATION_SLOW alongside the new one's fade-in, both power2.inOut. Matching
  // them in CSS was tried and abandoned: a hand-picked cubic-bezier tracks a JS ease only
  // approximately (measured drift of ~7 opacity points mid-curve even with the durations
  // equal), and the two engines can't be reconciled by tuning -- so the same engine runs
  // both, and .mini-generate-btn deliberately leaves opacity out of its CSS transition.
  // useLayoutEffect, not useEffect, so the dim is committed in the same frame as the click
  // rather than a paint later, and so it pairs with the hook's own layout effect.
  const generateBtnRef = useRef(null);
  useLayoutEffect(() => {
    const el = generateBtnRef.current;
    if (!el) return;
    const tween = gsap.to(el, {
      opacity: pending ? DISABLED_OPACITY : 1,
      duration: pending ? DURATION_FAST : DURATION_SLOW,
      ease: 'power2.inOut'
    });
    return () => tween.kill();
  }, [pending]);

  // First appearance only -- the hook shows the very first preview with no fade at all (there
  // is nothing to fade from), so the edge has to arrive the same way rather than waiting for an
  // `incoming` that will never come for that first design.
  useEffect(() => {
    if (!previewPalette) return;
    setEdgeColors(prev => prev ?? previewPalette);
  }, [previewPalette]);

  // A reveal has reached its fade-in: start the edge's own crossfade on the same frame.
  // useLayoutEffect, not useEffect: a passive effect commits this a render later, so the edge's
  // tween started roughly a frame and a half behind the image's and the two curves visibly
  // separated (measured mid-fade: edge 0.747 against image 0.837). A layout effect's state
  // update is flushed before paint, so both tweens begin in the same frame.
  // The palette is snapshotted here rather than read live, so a second generate landing during
  // this fade-in can't swap the colours mid-crossfade.
  useLayoutEffect(() => {
    if (!incoming) return;
    setEdgeIncomingColors(latestPaletteRef.current);
  }, [incoming]);

  // Layout effect for the same reason the hook uses one on its incoming image: the new layer
  // must be at opacity 0 before the browser paints it, or it flashes at full strength for a
  // frame ahead of the tween.
  useLayoutEffect(() => {
    if (!edgeIncomingColors || !edgeIncomingRef.current) return;
    const el = edgeIncomingRef.current;
    gsap.set(el, { opacity: 0 });
    const tween = gsap.to(el, {
      opacity: 1,
      duration: DURATION_SLOW,
      ease: 'power2.inOut',
      onComplete: () => {
        // Promote the incoming palette to the resting layer and drop the second one, so the
        // next reveal starts from a single opaque edge again.
        setEdgeColors(edgeIncomingColors);
        setEdgeIncomingColors(null);
      }
    });
    return () => tween.kill();
  }, [edgeIncomingColors]);

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
      <div
        className={`relative inline-flex flex-row items-center gap-4 rounded-2xl border border-white/10 bg-black/15 p-4 opacity-90 shadow-[0_4px_40px_rgba(0,0,0,0.4),inset_0_1px_0_rgba(255,255,255,0.14)] backdrop-blur-[4px] backdrop-brightness-[0.95] ${className}`}
        style={style}
      >
        <PaletteEdge
          inset="left-4 right-4"
          shownColors={edgeColors}
          incomingColors={edgeIncomingColors}
          incomingRef={edgeIncomingRef}
        />
        {/* Buttons stacked on the left */}
        <div className="flex flex-col gap-3 w-32 shrink-0">
          <button
            type="button"
            ref={generateBtnRef}
            onClick={onGenerate}
            disabled={pending}
            aria-label="Generate new design"
            title="Generate new design"
            className="mini-generate-btn group relative flex h-12 w-full items-center justify-center gap-2 overflow-hidden rounded-xl border border-white/10 bg-white/5 text-text-secondary hover:scale-[1.03] hover:border-accent/30 hover:bg-accent/10 hover:text-accent active:scale-[0.96] text-xs font-bold uppercase tracking-wider disabled:cursor-not-allowed disabled:hover:scale-100 cursor-pointer"
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
        'fixed bottom-6 right-6 z-30 w-44 rounded-2xl border border-white/10 bg-black/15 p-3 shadow-[0_4px_40px_rgba(0,0,0,0.4),inset_0_1px_0_rgba(255,255,255,0.14)] backdrop-blur-[4px] backdrop-brightness-[0.95] transition-all duration-300 ' +
        (visible ? 'translate-y-0 opacity-100' : 'pointer-events-none translate-y-4 opacity-0') +
        (className ? ' ' + className : '')
      }
      style={style}
    >
      <PaletteEdge
        inset="left-3 right-3"
        shownColors={edgeColors}
        incomingColors={edgeIncomingColors}
        incomingRef={edgeIncomingRef}
      />
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
          ref={generateBtnRef}
          onClick={onGenerate}
          disabled={pending}
          aria-label="Generate new design"
          title="Generate new design"
          className="mini-generate-btn group relative flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-white/10 bg-white/5 text-text-secondary hover:scale-[1.08] hover:border-accent/30 hover:bg-accent/10 hover:text-accent active:scale-[0.92] disabled:cursor-not-allowed disabled:hover:scale-100 cursor-pointer"
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
