import React from 'react';

// Google's official multi-color "G" logomark -- unlike the other icons in this folder,
// this one is intentionally not currentColor: Google's brand guidelines for "Continue
// with Google" buttons require the mark's actual four-color palette, not a tinted
// monochrome version.
export default function GoogleIcon({ size = 16, className = '' }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} className={className}>
      <path
        fill="#4285F4"
        d="M23.52 12.27c0-.82-.07-1.6-.21-2.36H12v4.47h6.47a5.53 5.53 0 0 1-2.4 3.63v3.02h3.86c2.26-2.08 3.59-5.15 3.59-8.76Z"
      />
      <path
        fill="#34A853"
        d="M12 24c3.24 0 5.95-1.07 7.93-2.92l-3.86-3.02c-1.07.72-2.45 1.15-4.07 1.15-3.13 0-5.79-2.12-6.74-4.96H1.27v3.12A11.99 11.99 0 0 0 12 24Z"
      />
      <path
        fill="#FBBC05"
        d="M5.26 14.25a7.2 7.2 0 0 1 0-4.5V6.63H1.27a11.99 11.99 0 0 0 0 10.74l3.99-3.12Z"
      />
      <path
        fill="#EA4335"
        d="M12 4.78c1.76 0 3.34.61 4.58 1.79l3.43-3.43C17.94 1.18 15.24 0 12 0A11.99 11.99 0 0 0 1.27 6.63l3.99 3.12C6.21 6.9 8.87 4.78 12 4.78Z"
      />
    </svg>
  );
}
