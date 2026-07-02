import React from 'react';

// Floating status banner -- pair with useToastNotice for the auto-dismiss timing. Purely
// presentational (no timer of its own) so it can sit under state owned by whichever page/
// context is showing it. Error uses the same `accent` token the rest of the store/account
// pages already use for error text (AccountPage, ShopPage, ProductPage) rather than a raw
// Tailwind red -- this used to be its own bg-red-900/bg-neutral-900 pairing in AuthContext,
// inconsistent with everywhere else errors are shown.
export default function Toast({ notice }) {
  if (!notice) return null;
  return (
    <div
      role="status"
      className={
        'fixed left-1/2 top-5 z-50 -translate-x-1/2 rounded-xl border px-5 py-3 text-center font-quicksand text-sm shadow-lg backdrop-blur-md ' +
        (notice.type === 'error'
          ? 'border-accent/30 bg-accent/10 font-bold text-accent'
          : 'border-hairline bg-ink-800/90 text-text')
      }
    >
      {notice.message}
    </div>
  );
}
