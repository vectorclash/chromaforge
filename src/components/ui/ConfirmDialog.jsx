import React, { useEffect } from 'react';
import SolidPanel from './SolidPanel';
import Button from './Button';

// Shared modal for destructive confirmations (design delete, ...) -- replaces
// window.confirm, which uses browser chrome that can't be styled, blocks the render
// thread, and looks nothing like the rest of the app. `.cf-solid` (via SolidPanel) rather
// than glass: this sits over a dimmed backdrop, not live generative art -- see
// components.css's own note on when each surface applies.
export default function ConfirmDialog({
  open,
  title = 'Are you sure?',
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  onConfirm,
  onCancel
}) {
  useEffect(() => {
    if (!open) return;
    const onKeyDown = e => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onCancel]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex animate-fade-in items-center justify-center bg-black/60 px-6 backdrop-blur-sm"
      onClick={onCancel}
    >
      <SolidPanel
        className="w-full max-w-sm animate-pop-in p-6"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        onClick={e => e.stopPropagation()}
      >
        <h2 id="confirm-dialog-title" className="font-quicksand text-lg font-bold text-text">
          {title}
        </h2>
        {message && <p className="mt-2 text-sm text-text-secondary">{message}</p>}
        <div className="mt-6 flex gap-3">
          <Button type="button" variant="secondary" className="flex-1" onClick={onCancel}>
            {cancelLabel}
          </Button>
          <Button type="button" className="flex-1" onClick={onConfirm} autoFocus>
            {confirmLabel}
          </Button>
        </div>
      </SolidPanel>
    </div>
  );
}
