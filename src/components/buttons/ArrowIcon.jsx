import React from 'react';

// Plain right-arrow for text-only links (e.g. the homepage hero's "Go to studio"). Uses
// stroke + currentColor so it inherits the surrounding link's text color/hover state
// directly, unlike the filled-path icons (ChevronIcon, SettingsButton, etc.) that lean on
// `.button-icon svg { fill: white }`. `direction="left"` mirrors it for carousel-style
// prev/next controls rather than duplicating the path. `size` defaults to the original
// inline-link footprint (14px); callers like a carousel's larger arrow buttons can bump it.
export default function ArrowIcon({ direction = 'right', size = 14 }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={direction === 'left' ? { transform: 'scaleX(-1)' } : undefined}
    >
      <path d="M5 12h14M13 6l6 6-6 6" />
    </svg>
  );
}
