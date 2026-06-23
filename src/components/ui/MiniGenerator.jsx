import React, { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Button from './Button';
import { useStudio } from '../../context/StudioContext';
import { useAuth } from '../../context/AuthContext';
import { generateShareUrl } from '../../utils/urlConfig';

// How long the widget treats a generate as "in progress" before it lets the new design
// show, regardless of how fast the off-canvas render actually finished -- mirrors the
// deliberate ~1s beat the full studio gives onGenerateButtonClick/setImage rather than
// popping the new design in instantly.
const GENERATE_MIN_DELAY_MS = 900;
const CROSSFADE_MS = 450;

function RefreshIcon({ spinning }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={spinning ? 'animate-spin' : ''}
    >
      <path d="M3 12a9 9 0 0 1 15.3-6.4M21 12a9 9 0 0 1-15.3 6.4" />
      <path d="M21 4v5h-5M3 20v-5h5" />
    </svg>
  );
}

// Ambient presence of the generator on every light page: a small floating widget with a live
// thumbnail of the current design plus Generate/Save. Rendered once in SiteLayout. The
// thumbnail and the footer's art band both read the same StudioContext.previewUrl, so
// regenerating here updates both at once -- that shared reactivity is the point.
export default function MiniGenerator() {
  const { previewUrl, currentDesign, generateRandom, saveCurrentDesign } = useStudio();
  const { user } = useAuth();
  const navigate = useNavigate();

  const [pending, setPending] = useState(false);
  const [saveState, setSaveState] = useState('idle'); // idle | saving | saved | error

  // Crossfade state: `shown` is the fully-visible layer; `incoming` fades in over it, then
  // gets promoted to `shown` once the transition finishes. Two stacked <img> layers, not a
  // single tag's opacity, because swapping one <img>'s src can't visually cross-dissolve
  // between old and new content -- it just pops once the new image decodes.
  const [shown, setShown] = useState(null);
  const [incoming, setIncoming] = useState(null);
  const [fadingIn, setFadingIn] = useState(false);
  const minDelayRef = useRef(null);
  const generateClickedRef = useRef(false);

  // Reveal a freshly-rendered previewUrl once both the off-canvas render AND the deliberate
  // minimum delay (if this update came from a Generate click) have elapsed.
  useEffect(() => {
    if (!previewUrl || previewUrl === shown || previewUrl === incoming) return;

    const reveal = () => {
      setIncoming(previewUrl);
      setFadingIn(false);
      requestAnimationFrame(() => setFadingIn(true));
    };

    if (generateClickedRef.current) {
      generateClickedRef.current = false;
      const elapsed = Date.now() - (minDelayRef.current ?? Date.now());
      const remaining = Math.max(0, GENERATE_MIN_DELAY_MS - elapsed);
      const t = setTimeout(reveal, remaining);
      return () => clearTimeout(t);
    }
    if (!shown) {
      // First-ever appearance (no prior image to fade from) -- show it immediately.
      setShown(previewUrl);
      return;
    }
    reveal();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewUrl]);

  // Once the incoming layer has finished fading in, promote it to `shown` and drop the
  // crossfade layer + the "pending" (regenerating) state.
  useEffect(() => {
    if (!fadingIn || !incoming) return;
    const t = setTimeout(() => {
      setShown(incoming);
      setIncoming(null);
      setFadingIn(false);
      setPending(false);
    }, CROSSFADE_MS);
    return () => clearTimeout(t);
  }, [fadingIn, incoming]);

  const onGenerate = () => {
    setPending(true);
    generateClickedRef.current = true;
    minDelayRef.current = Date.now();
    generateRandom();
  };

  const onSave = async () => {
    if (!user) {
      navigate('/account');
      return;
    }
    setSaveState('saving');
    try {
      await saveCurrentDesign('image', currentDesign);
      setSaveState('saved');
      setTimeout(() => setSaveState('idle'), 2000);
    } catch {
      setSaveState('error');
      setTimeout(() => setSaveState('idle'), 2500);
    }
  };

  // Open the studio with THIS design loaded, not a fresh one -- the studio's own init()
  // already knows how to load a design from the URL (getConfigFromUrl), the same path
  // GalleryPage uses to reopen a saved design, so reuse it rather than a bare "/" link.
  const onOpenStudio = () => {
    const url = generateShareUrl(currentDesign);
    const query = url && url.includes('?') ? url.slice(url.indexOf('?')) : '';
    navigate('/' + query);
  };

  return (
    <div className="fixed bottom-6 right-6 z-30 w-44 rounded-xl border border-neutral-200 bg-white/95 p-2 shadow-lg backdrop-blur">
      <button
        type="button"
        onClick={onOpenStudio}
        aria-label="Open this design in the studio"
        className="relative block aspect-square w-full overflow-hidden rounded-lg bg-neutral-100"
      >
        {shown && (
          <img src={shown} alt="" className="absolute inset-0 h-full w-full object-cover" />
        )}
        {incoming && (
          <img
            src={incoming}
            alt=""
            className={
              'absolute inset-0 h-full w-full object-cover transition-opacity ' +
              (fadingIn ? 'opacity-100' : 'opacity-0')
            }
            style={{ transitionDuration: `${CROSSFADE_MS}ms` }}
          />
        )}
      </button>
      <div className="mt-2 flex gap-1.5">
        {/* Icon-only (matches the studio's own .button-icon language) so its fixed size
            never fights the Save label for width -- that's what made the row overflow
            the card before. */}
        <button
          type="button"
          onClick={onGenerate}
          disabled={pending}
          aria-label="Generate new design"
          title="Generate new design"
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-neutral-300 text-neutral-700 transition hover:border-neutral-900 disabled:opacity-40"
        >
          <RefreshIcon spinning={pending} />
        </button>
        <Button size="sm" variant="primary" className="min-w-0 flex-1" onClick={onSave} disabled={saveState === 'saving'}>
          {saveState === 'saving' && 'Saving'}
          {saveState === 'saved' && 'Saved'}
          {saveState === 'error' && 'Error'}
          {saveState === 'idle' && 'Save'}
        </Button>
      </div>
    </div>
  );
}
