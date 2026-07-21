import React, { useEffect } from 'react';
import SolidPanel from './SolidPanel';
import Button from './Button';

// Buy Now, centralized into one modal (Aaron's redesign, approved from a live mockup,
// 2026-07-21) -- previously a "Buy without a preview" link duplicated in the mockup image
// area, an inline paragraph + progress readout scattered around the purchase button, and
// a separate ConfirmDialog for the skip-preview case. One click straight to `preparing`
// when a mockup already exists; two clicks (through `confirm`) when it doesn't -- that's
// the only case that actually needs a "you haven't previewed this yet" heads-up.
// `preparing` is the one stage that can't be dismissed (no Cancel button, and both
// backdrop-click and Escape no-op) -- print files are already rendering/uploading and the
// Stripe session is being created, so wandering off mid-flow is the one thing worth
// blocking. A modal only stops *in-app* exits (link clicks) by simply covering them; it
// can't intercept the browser's own back/forward or a typed URL, so ProductPage's existing
// beforeunload/isMountedRef guards still cover those.
export default function BuyNowModal({
  stage, // null | 'confirm' | 'preparing' | 'error'
  onContinue,
  onCancel,
  errorMessage,
  narration,
  progress, // { done, total } | null
  elapsedSeconds
}) {
  const dismissible = stage === 'confirm' || stage === 'error';

  useEffect(() => {
    if (!dismissible) return undefined;
    const onKeyDown = e => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [dismissible, onCancel]);

  if (!stage) return null;

  // Before any real progress event, or once file rendering has finished and only session
  // creation remains (renderAndUploadPrintFiles' onProgress stops firing, see
  // ProductPage's onBuyNowClick), read as "almost there" rather than resetting to empty.
  const progressPercent = progress ? Math.min(100, (progress.done / progress.total) * 100) : 100;

  return (
    <div
      className="fixed inset-0 z-50 flex animate-fade-in items-center justify-center bg-black/60 px-6 backdrop-blur-sm"
      onClick={dismissible ? onCancel : undefined}
    >
      <SolidPanel
        className="w-full max-w-sm animate-pop-in overflow-hidden p-0"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="buy-now-modal-title"
        onClick={e => e.stopPropagation()}
      >
        <div className="cf-spectrum-line" />
        <div className="p-6">
          {stage === 'confirm' && (
            <>
              <h2 id="buy-now-modal-title" className="font-quicksand text-lg font-bold text-text">
                Buy without a preview?
              </h2>
              <p className="mt-2 text-sm text-text-secondary">
                You haven't seen a mockup of this design on the garment yet -- it still
                prints exactly as designed, you'll just skip the preview photo.
              </p>
              <div className="mt-6 flex flex-col gap-3">
                <Button type="button" className="w-full" onClick={onContinue} autoFocus>
                  Continue
                </Button>
                <Button type="button" variant="secondary" className="w-full" onClick={onCancel}>
                  Cancel
                </Button>
              </div>
            </>
          )}

          {stage === 'preparing' && (
            <>
              <h2 id="buy-now-modal-title" className="font-quicksand text-lg font-bold text-text">
                Preparing your order
              </h2>
              <div className="mt-4 flex items-center gap-3.5">
                <div
                  aria-hidden
                  className="h-8 w-8 shrink-0 animate-spin rounded-full border-[3px] border-white/15 border-t-interactive"
                />
                <div className="flex min-h-[2.4em] flex-1 items-center">{narration}</div>
              </div>
              <div className="mt-3 h-1 overflow-hidden rounded-full bg-white/10">
                <div
                  className="h-full rounded-full bg-interactive transition-[width] duration-500 ease-out"
                  style={{ width: `${progressPercent}%` }}
                />
              </div>
              <div className="mt-2 flex justify-between font-mono text-[11px] text-text-muted">
                <span>
                  {progress && progress.total > 0
                    ? `print file ${Math.min(progress.done + 1, progress.total)} of ${progress.total}`
                    : ''}
                </span>
                <span>{elapsedSeconds}s elapsed</span>
              </div>
              <p className="mt-4 text-[11.5px] text-text-muted">
                Stays open until this finishes -- please don't close the tab.
              </p>
            </>
          )}

          {stage === 'error' && (
            <>
              <h2 id="buy-now-modal-title" className="font-quicksand text-lg font-bold text-text">
                Something went wrong
              </h2>
              <p className="mt-2 text-sm text-accent">{errorMessage}</p>
              <div className="mt-6 flex flex-col gap-3">
                <Button type="button" className="w-full" onClick={onContinue} autoFocus>
                  Try again
                </Button>
                <Button type="button" variant="secondary" className="w-full" onClick={onCancel}>
                  Cancel
                </Button>
              </div>
            </>
          )}
        </div>
      </SolidPanel>
    </div>
  );
}
