import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Button from './Button';
import { useStudio } from '../../context/StudioContext';
import { useAuth } from '../../context/AuthContext';
import { useCrossfadeImage } from '../../hooks/useCrossfadeImage';
import { generateShareUrl } from '../../utils/urlConfig';

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
// thumbnail and the footer's art band both read the same StudioContext.previewUrl through the
// same useCrossfadeImage hook, so regenerating here updates both at once, fading the same way.
export default function MiniGenerator() {
  const { previewUrl, currentDesign, generateRandom, saveCurrentDesign } = useStudio();
  const { user } = useAuth();
  const navigate = useNavigate();

  const { shown, incoming, fadingIn } = useCrossfadeImage(previewUrl, CROSSFADE_MS);
  // "Generating" lasts exactly as long as the crossfade -- no artificial extra wait.
  const pending = !!incoming;

  // Tracks the design object that was last successfully saved, so the button can show
  // "Saved" (and stop inviting another save) until a new design replaces it.
  const [savedDesign, setSavedDesign] = useState(null);
  const [saveStatus, setSaveStatus] = useState('idle'); // idle | saving | error
  const isSaved = savedDesign === currentDesign;

  // A fresh design (Generate) always needs its own save -- clear any stale error state from
  // a previous design's failed save attempt.
  useEffect(() => {
    setSaveStatus('idle');
  }, [currentDesign]);

  const onGenerate = () => generateRandom();

  const onSave = async () => {
    if (!user) {
      navigate('/account');
      return;
    }
    if (isSaved || saveStatus === 'saving') return;
    setSaveStatus('saving');
    try {
      await saveCurrentDesign('image', currentDesign);
      setSavedDesign(currentDesign);
      setSaveStatus('idle');
    } catch {
      setSaveStatus('error');
      setTimeout(() => setSaveStatus('idle'), 2500);
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
        className="relative block aspect-square w-full cursor-pointer overflow-hidden rounded-lg bg-neutral-100"
      >
        {shown && <img src={shown} alt="" className="absolute inset-0 h-full w-full object-cover" />}
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
            never fights the Save label for width. */}
        <button
          type="button"
          onClick={onGenerate}
          disabled={pending}
          aria-label="Generate new design"
          title="Generate new design"
          className="flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-lg border border-neutral-300 text-neutral-700 transition hover:border-neutral-900 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <RefreshIcon spinning={pending} />
        </button>
        <Button
          size="sm"
          variant={isSaved ? 'secondary' : 'primary'}
          className="min-w-0 flex-1"
          onClick={onSave}
          disabled={saveStatus === 'saving' || isSaved}
        >
          {saveStatus === 'saving' && 'Saving'}
          {saveStatus === 'error' && 'Error'}
          {saveStatus === 'idle' && (isSaved ? 'Saved' : 'Save')}
        </Button>
      </div>
    </div>
  );
}
