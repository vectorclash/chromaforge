import React from 'react';
import { Link } from 'react-router-dom';
import { useStudio } from '../../context/StudioContext';

// Decorative band showing the current/last-generated artwork above the copyright row -- purely
// ambient (no controls), so even pages that never touch the mini-generator widget still
// bookend with the brand's actual generative art. Shares StudioContext.previewUrl with the
// widget, so regenerating there updates this band too.
export default function SiteFooter() {
  const { previewUrl } = useStudio();
  return (
    <footer className="mt-16 border-t border-neutral-200">
      {previewUrl && (
        <div className="h-32 w-full overflow-hidden">
          <img src={previewUrl} alt="" className="h-full w-full object-cover" />
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
