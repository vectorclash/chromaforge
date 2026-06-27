import React from 'react';

// Two-state switch from the locked foundation (.cf-toggle in components.css). Controlled:
// pass `on` + `onClick` (or `onChange`-style handler) rather than using a native checkbox,
// so it composes the same way the studio's existing toggles do.
export default function Toggle({ on = false, className = '', ...props }) {
  return (
    <button type="button" aria-pressed={on} className={`cf-toggle ${on ? 'on' : ''} ${className}`} {...props}>
      <span className="cf-toggle-thumb" />
    </button>
  );
}
