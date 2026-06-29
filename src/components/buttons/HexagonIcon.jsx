import React from 'react';

// Plain filled hexagon -- the signed-out placeholder in SiteHeader's tiny avatar circle,
// a quiet nod to the geometric-shape piece of the avatar generator without rendering a
// real one. currentColor-based like the other small icons in this app (ShirtIcon,
// HeartIcon) so it inherits color from its wrapper.
export default function HexagonIcon({ size = 16, className = '' }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor" className={className}>
      <path d="M12 2 20.66 7 20.66 17 12 22 3.34 17 3.34 7Z" />
    </svg>
  );
}
