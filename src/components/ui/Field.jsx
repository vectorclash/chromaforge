import React from 'react';

// Form primitives for the light chrome (account sign-in, etc.).
export function Input({ className = '', ...props }) {
  const base =
    'h-11 w-full rounded-lg border border-neutral-300 px-3 text-sm text-neutral-900 ' +
    'outline-none transition placeholder:text-neutral-400 ' +
    'focus:border-accent focus-visible:ring-2 focus-visible:ring-accent/25';
  return <input className={`${base} ${className}`} {...props} />;
}

export function Field({ label, htmlFor, children, className = '' }) {
  return (
    <label htmlFor={htmlFor} className={`block ${className}`}>
      {label && <span className="mb-1.5 block text-sm font-medium text-neutral-700">{label}</span>}
      {children}
    </label>
  );
}
