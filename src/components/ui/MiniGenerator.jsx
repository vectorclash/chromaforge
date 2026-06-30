import React, { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useStudio } from '../../context/StudioContext';
import { useAuth } from '../../context/AuthContext';
import { useCrossfadeImage } from '../../hooks/useCrossfadeImage';
import { useWidgetVisibility } from '../../hooks/useWidgetVisibility';
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

  const { shown, incoming, fadingIn } = useCrossfadeImage(previewUrl, CROSSFADE_MS);
  const pending = !!incoming;

  const [saveStatus, setSaveStatus] = useState('idle'); // idle | saving | error

  // Clear any stale error state from a previous design's failed save attempt
  useEffect(() => {
    setSaveStatus('idle');
  }, [currentDesign]);

  const onGenerate = () => generateRandom();

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

  const onOpenStudio = () => {
    const url = generateShareUrl(currentDesign);
    const query = url && url.includes('?') ? url.slice(url.indexOf('?')) : '';
    navigate('/studio' + query, { state: { from: location.pathname } });
  };

  // 1. Inline (Docked in Footer) Version: Horizontal Layout, buttons on left, image on right
  if (inline) {
    return (
      <div className="flex flex-row items-center gap-4 rounded-2xl bg-black/15 p-4 opacity-90 shadow-[0_4px_40px_rgba(0,0,0,0.4)] backdrop-blur-[4px] backdrop-brightness-[0.95]">
        {/* Buttons stacked on the left */}
        <div className="flex flex-col gap-3 w-32 shrink-0">
          <button
            type="button"
            onClick={onGenerate}
            disabled={pending}
            aria-label="Generate new design"
            title="Generate new design"
            className="flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-white/5 border border-white/10 text-text-secondary hover:text-accent hover:bg-accent/10 hover:border-accent/30 transition-all duration-200 text-xs font-bold uppercase tracking-wider disabled:cursor-not-allowed disabled:opacity-30 cursor-pointer"
          >
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
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-white/5 border border-white/10 text-text-secondary hover:text-accent hover:bg-accent/10 hover:border-accent/30 transition-all duration-200 disabled:cursor-not-allowed disabled:opacity-30 cursor-pointer"
        >
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
