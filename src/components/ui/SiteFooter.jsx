import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useStudio } from '../../context/StudioContext';
import { useCrossfadeImage } from '../../hooks/useCrossfadeImage';
import MiniGenerator from './MiniGenerator';

const CROSSFADE_MS = 450;
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

  const { shown, incoming, fadingIn } = useCrossfadeImage(bgUrl, CROSSFADE_MS);

  return (
    <footer className="relative bg-ink-950 border-t border-hairline pt-16 pb-8 text-sm text-text-muted overflow-hidden shrink-0">
      {/* Active artwork as the footer's background at 50% opacity */}
      {shown && (
        <div className="absolute inset-0 opacity-50 z-0 pointer-events-none">
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
          {/* Subtle dark gradient overlay to ensure text contrast */}
          <div className="absolute inset-0 bg-gradient-to-t from-ink-950 via-ink-950/80 to-ink-950/40"></div>
        </div>
      )}

      <div className="relative z-10 mx-auto max-w-6xl px-6">
        <div className="grid grid-cols-1 gap-10 sm:grid-cols-2">
          
          {/* Column 1: Brand & Socials */}
          <div className="flex flex-col gap-4">
            <Link to="/" className="font-display text-base tracking-tight text-text sm:text-lg">
              CHROMA<b className="font-black text-accent-soft">FORGE</b>
            </Link>
            <p className="max-w-[240px] text-xs leading-relaxed">
              An interactive, generative art playground and custom apparel workshop. Craft, save, and wear your unique algorithms.
            </p>
            <div className="mt-2 flex items-center gap-4 text-text-muted">
              <a href="https://twitter.com" target="_blank" rel="noopener noreferrer" className="transition hover:text-interactive" aria-label="Twitter / X">
                <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
                  <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/>
                </svg>
              </a>
              <a href="https://instagram.com" target="_blank" rel="noopener noreferrer" className="transition hover:text-interactive" aria-label="Instagram">
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="2" y="2" width="20" height="20" rx="5" ry="5"/>
                  <path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z"/>
                  <line x1="17.5" y1="6.5" x2="17.51" y2="6.5"/>
                </svg>
              </a>
              <a href="https://discord.com" target="_blank" rel="noopener noreferrer" className="transition hover:text-interactive" aria-label="Discord">
                <svg viewBox="0 0 127.14 96.36" width="18" height="18" fill="currentColor">
                  <path d="M107.7,8.07A105.15,105.15,0,0,0,77.26,0a77.19,77.19,0,0,0-3.3,6.83A96.67,96.67,0,0,0,53.22,6.83,77.19,77.19,0,0,0,49.88,0,105.15,105.15,0,0,0,19.44,8.07C3.66,31.58-1.86,54.65,1,77.53A105.73,105.73,0,0,0,32,96.36a77.7,77.7,0,0,0,6.63-10.85,68.43,68.43,0,0,1-10.5-5c.83-.62,1.63-1.27,2.4-2a75.41,75.41,0,0,0,73.3,0c.77.69,1.57,1.34,2.4,2a68.43,68.43,0,0,1-10.5,5,77.7,77.7,0,0,0,6.63,10.85,105.73,105.73,0,0,0,31.58-18.83C129.07,50.12,123.16,27.27,107.7,8.07ZM42.45,65.69C36.18,65.69,31,60,31,53S36.18,40.36,42.45,40.36,53.83,46,53.83,53,48.72,65.69,42.45,65.69Zm42.24,0C78.41,65.69,73.24,60,73.24,53S78.41,40.36,84.69,40.36,96.07,46,96.07,53,91,65.69,84.69,65.69Z"/>
                </svg>
              </a>
              <a href="https://github.com" target="_blank" rel="noopener noreferrer" className="transition hover:text-interactive" aria-label="GitHub">
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
          <span>© {new Date().getFullYear()} ChromaForge. All rights reserved.</span>
          <div className="flex gap-4">
            <a href="#privacy" className="hover:text-text transition">Privacy</a>
            <span>•</span>
            <a href="#terms" className="hover:text-text transition">Terms</a>
          </div>
        </div>
      </div>
    </footer>
  );
}
