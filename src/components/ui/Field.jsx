import React from 'react';

// Re-exported so existing `{ Field, Input }` imports keep working -- Input itself now lives
// in its own file (the dark-system .cf-input primitive) since other modules need it without
// the label wrapper.
export { default as Input } from './Input';

export function Field({ label, htmlFor, children, className = '' }) {
  return (
    <label htmlFor={htmlFor} className={`block ${className}`}>
      {label && <span className="mb-1.5 block text-sm font-medium text-text-secondary">{label}</span>}
      {children}
    </label>
  );
}
