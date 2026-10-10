import React from 'react';

// The Recent panel's icon, drawn on SettingsButton's 512 grid at the same weight so the two
// read as a pair. On hover the arrow rewinds and the hands spin back (components.css), the
// clock's version of the settings icon's sliding knobs.
export default function RecentButton() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" className="recent-icon" aria-hidden="true">
      <g className="recent-arc">
        {/* A circle open at the left, running clockwise from the arrowhead... */}
        <path d="M71.8 189A196 196 0 1 1 71.8 323" fill="none" stroke="white" strokeWidth="52" strokeLinecap="round" />
        {/* ...which points back the other way */}
        <path d="M47.2 256.7L14.4 159.6L134.6 203.4Z" stroke="white" strokeWidth="12" strokeLinejoin="round" />
      </g>
      <g className="recent-hands" fill="none" stroke="white" strokeWidth="48" strokeLinecap="round">
        <path d="M256 256V146" />
        <path d="M256 256L334 302" />
      </g>
    </svg>
  );
}
