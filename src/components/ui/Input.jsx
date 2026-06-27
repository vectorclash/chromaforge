import React from 'react';

// Text input from the locked foundation (.cf-input in components.css).
export default function Input({ className = '', ...props }) {
  return <input className={`cf-input w-full ${className}`} {...props} />;
}
