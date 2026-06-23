import React from 'react';
import { Link } from 'react-router-dom';
import { useStudio } from '../../context/StudioContext';
import { useCrossfadeImage } from '../../hooks/useCrossfadeImage';

const CROSSFADE_MS = 450;

// Decorative band showing the current/last-generated artwork above the copyright row -- purely
// ambient (no controls), so even pages that never touch the mini-generator widget still
// bookend with the brand's actual generative art. Shares StudioContext.previewUrl with the
// widget through the same useCrossfadeImage hook, so regenerating there fades this band the
// same way at the same time, instead of one popping while the other fades.
export default function SiteFooter() {
  const { previewUrl } = useStudio();
  const { shown, incoming, fadingIn } = useCrossfadeImage(previewUrl, CROSSFADE_MS);

  return (
    <footer className="mt-16 border-t border-neutral-200">
      {shown && (
        <div className="relative h-32 w-full overflow-hidden">
          <img src={shown} alt="" className="absolute inset-0 h-full w-full object-cover" />
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
        </div>
      )}
      <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-8 text-sm text-neutral-400">
        <span>© {new Date().getFullYear()} ChromaForge</span>
        <Link to="/" className="font-quicksand transition hover:text-neutral-700">
          ← Back to studio
        </Link>
      </div>
    </footer>
  );
}
