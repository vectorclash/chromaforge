import React from 'react';

// Plain outline "film frame with a play triangle" icon -- marks a gallery card as an
// animation (kind === 'animation') rather than a static image, since a design's thumbnail
// alone (a single still JPEG either way, see lib/designs.js's uploadDesignThumbnail) can't
// carry that distinction on its own. Inherits color via currentColor, matching ShirtIcon's
// convention.
export default function AnimationIcon({ size = 16, className = '' }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <rect x="2.5" y="4" width="19" height="16" rx="2" />
      <path d="M10 8.5v7l6-3.5-6-3.5z" fill="currentColor" stroke="none" />
    </svg>
  );
}
