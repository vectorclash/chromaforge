import React from 'react';

// Plain right-arrow for text-only links (e.g. the homepage hero's "Go to studio"). Uses
// stroke + currentColor so it inherits the surrounding link's text color/hover state
// directly, unlike the filled-path icons (ChevronIcon, SettingsButton, etc.) that lean on
// `.button-icon svg { fill: white }`.
export default function ArrowIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M5 12h14M13 6l6 6-6 6" />
    </svg>
  );
}
