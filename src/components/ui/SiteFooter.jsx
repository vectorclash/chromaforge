import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useStudio } from '../../context/StudioContext';
import { useCrossfadeImage } from '../../hooks/useCrossfadeImage';
import MiniGenerator from './MiniGenerator';
import Wordmark from './Wordmark';

const RENDER_WIDTH = 1600;
const RENDER_HEIGHT = 500;

export default function SiteFooter() {
  const { currentDesign, renderDesignBlob, queueReady } = useStudio();
  const [bgUrl, setBgUrl] = useState(null);

  useEffect(() => {
    if (!queueReady) return;
    let cancelled = false;
    renderDesignBlob(currentDesign, RENDER_WIDTH, RENDER_HEIGHT)
      .then(blob => {
        if (cancelled) return;
        const url = URL.createObjectURL(blob);
        setBgUrl(prev => {
          if (prev) URL.revokeObjectURL(prev);
          return url;
        });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [currentDesign, queueReady, renderDesignBlob]);

  const { shown, incoming, shownRef, incomingRef } = useCrossfadeImage(bgUrl);

  return (
    <footer className="relative bg-ink-700 pt-16 pb-8 text-sm text-text-muted overflow-hidden shrink-0">
      {/* Active artwork as the footer's background at 50% opacity */}
      {shown && (
        <div className="absolute inset-0 opacity-75 z-0 pointer-events-none">
          <img ref={shownRef} src={shown} alt="" className="absolute inset-0 h-full w-full object-cover" />
          {incoming && (
            <img
              ref={incomingRef}
              src={incoming}
              alt=""
              className="absolute inset-0 h-full w-full object-cover"
              style={{ opacity: 0 }}
            />
          )}
          {/* Subtle dark gradient overlay to ensure text contrast */}
          <div className="absolute inset-0 bg-gradient-to-t from-ink-950 via-ink-950/80 to-ink-950/40"></div>
        </div>
      )}

      <div className="relative z-10 mx-auto max-w-6xl px-6">
        <div className="grid grid-cols-1 gap-10 sm:grid-cols-2">
          
          {/* Column 1: Brand & Socials */}
          <div className="flex flex-col gap-4">
            <Wordmark className="text-base sm:text-lg" />
            <p className="max-w-[240px] text-xs leading-relaxed">
              An interactive, generative art playground and custom apparel workshop. Craft, save, and wear your unique algorithms.
            </p>
            {/* p-2 -m-2 on each link: grows the actual tappable box (the raw 18px svg icons
                were well under a usable touch target) while the matching negative margin
                cancels the padding back out, so the row's visual size/spacing is unchanged. */}
            <div className="mt-2 flex items-center gap-4 text-text-muted">
              <a href="https://bsky.app/profile/vectorclash.bsky.social" target="_blank" rel="noopener noreferrer" className="-m-2 p-2 transition hover:text-interactive" aria-label="Bluesky">
                <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
                  <path d="M5.202 2.857C7.954 4.922 10.913 9.11 12 11.358c1.087-2.247 4.046-6.436 6.798-8.501C20.783 1.366 24 .213 24 3.883c0 .732-.42 6.156-.667 7.037-.856 3.061-3.978 3.842-6.755 3.37 4.854.826 6.089 3.562 3.422 6.299-5.065 5.196-7.28-1.304-7.847-2.97-.104-.305-.152-.448-.153-.327 0-.121-.05.022-.153.327-.568 1.666-2.782 8.166-7.847 2.97-2.667-2.737-1.432-5.473 3.422-6.3-2.777.473-5.899-.308-6.755-3.369C.42 10.04 0 4.615 0 3.883c0-3.67 3.217-2.517 5.202-1.026"/>
                </svg>
              </a>
              <a href="https://github.com/vectorclash" target="_blank" rel="noopener noreferrer" className="-m-2 p-2 transition hover:text-interactive" aria-label="GitHub">
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22"/>
                </svg>
              </a>
            </div>
          </div>

          {/* Column 2: Docked Mini Generator */}
          <div className="flex justify-start sm:justify-end">
            <MiniGenerator inline={true} />
          </div>

        </div>

        {/* Bottom Bar */}
        <div className="mt-12 border-t border-hairline pt-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between text-xs text-text-muted">
          <span>
            © {new Date().getFullYear()}{' '}
            <a
              className="font-bold text-text-muted no-underline hover:text-text"
              href="https://www.vectorclash.com"
              target="_blank"
              rel="noopener noreferrer"
            >
              Aaron Ezra Sterczewski
            </a>
          </span>
          <div className="flex gap-4">
            <Link to="/privacy" className="hover:text-text transition">Privacy</Link>
            <span>•</span>
            <Link to="/terms" className="hover:text-text transition">Terms</Link>
          </div>
        </div>
      </div>
    </footer>
  );
}
