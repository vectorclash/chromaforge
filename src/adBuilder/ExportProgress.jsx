import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';
import Button from '../components/ui/Button';

// Every long render's progress, where it can be seen (2026-11-22, Aaron: the stock export "should
// probably have some sort of bar indicator that's more visible so you know what's going on"). The
// exports used to report in one line of small text in the side panel, which is usually scrolled
// somewhere else by the time a render is under way. This is pinned to the top of the preview column
// (where nothing is used during a render; the bottom holds the transport), and the tab's title
// carries the percentage, so a render can be watched from another tab. Rendered into document.body: the panel is `will-change: transform`, which makes it
// the containing block of anything `fixed` inside it.

/**
 * @param {{ label: string, progress?: number | null, detail?: string | null, onAction?: (() => void) | null,
 *   actionLabel?: string, tone?: 'busy' | 'warn' | 'done', stack?: number }} props
 *   `progress` 0..1, or null for a phase with no measure (the bar then runs a segment across).
 *   `onAction`: a button beside the percentage -- Cancel while running, Dismiss once done.
 *   `stack`: 1 sits under another bar (the queue's, under an export of this page's own).
 */
export default function ExportProgress({ label, progress = null, detail = null, onAction = null, actionLabel = 'Cancel', tone = 'busy', stack = 0 }) {
  const pct = progress == null ? null : Math.max(0, Math.min(100, Math.round(progress * 100)));
  useEffect(() => {
    const base = document.title.replace(/^\d+% · /, '');
    document.title = pct == null || tone === 'done' ? base : `${pct}% · ${base}`;
    return () => {
      document.title = document.title.replace(/^\d+% · /, '');
    };
  }, [pct, tone]);
  return createPortal(
    <div
      role="status"
      aria-live="polite"
      style={stack ? { top: `calc(1rem + ${stack} * 6.25rem)` } : undefined}
      className="export-progress fixed top-4 z-50 -translate-x-1/2 animate-resolve-in rounded-xl border border-white/10 bg-neutral-950/90 px-4 py-3 text-sm shadow-2xl backdrop-blur-md"
    >
      <div className="flex items-baseline justify-between gap-3">
        <span className={tone === 'warn' ? 'text-amber-300' : 'min-w-0 truncate text-white'}>{label}</span>
        <span className="flex items-center gap-3">
          {pct != null && <span className="font-display tabular-nums text-white">{pct}%</span>}
          {onAction && (
            <Button size="sm" variant="ghost" onClick={onAction}>
              {actionLabel}
            </Button>
          )}
        </span>
      </div>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/10">
        {pct == null ? (
          <div key="sweep" className="export-progress-indeterminate h-full w-1/3 rounded-full" />
        ) : (
          // keyed apart from the sweep, or React reuses that element and the fill grows from its width
          <div
            key="fill"
            className="export-progress-fill h-full rounded-full transition-[width] duration-300 ease-out"
            style={{ width: `${pct}%` }}
          />
        )}
      </div>
      {detail && <p className="mt-1.5 text-xs tabular-nums text-neutral-400">{detail}</p>}
    </div>,
    document.body
  );
}
