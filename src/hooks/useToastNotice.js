import { useEffect, useState } from 'react';

// Local state for a floating Toast: { type: 'success'|'error', message } | null,
// auto-dismissed after a few seconds (errors linger longer than successes so there's more
// time to actually read them). Shared so every call site that wants toast-style feedback
// (auth notices, save/checkout confirmations, ...) gets the same dismiss timing without
// re-deriving it -- see components/ui/Toast.jsx for the actual rendering.
export function useToastNotice() {
  const [notice, setNotice] = useState(null);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), notice.type === 'error' ? 8000 : 5000);
    return () => clearTimeout(t);
  }, [notice]);

  return [notice, setNotice];
}
