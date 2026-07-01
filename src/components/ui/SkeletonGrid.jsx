import React from 'react';

// Placeholder grid shown while a card grid (shop products, gallery designs) is loading --
// same cell shape/rounding as the Card tiles that replace it, so the swap reads as content
// filling in rather than a layout appearing from nothing. The stagger matches the loaded
// grid's own fade-slide-up delays (50ms/item). Callers pass the exact same grid classes
// they use for the real content so columns/gaps always agree.
export default function SkeletonGrid({ count = 8, className = '' }) {
  return (
    <div className={className} aria-hidden="true">
      {Array.from({ length: count }).map((_, i) => (
        <div
          key={i}
          className="aspect-square animate-pulse overflow-hidden rounded-xl border border-hairline bg-ink-800"
          style={{ animationDelay: `${Math.min(i, 10) * 50}ms` }}
        />
      ))}
    </div>
  );
}
