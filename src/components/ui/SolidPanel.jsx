import React from 'react';

// Solid surface from the locked foundation (.cf-solid in components.css). Use for content
// with no live art behind it -- account, checkout, mid-page modules. Same tokens as
// GlassPanel, just not frosted.
export default function SolidPanel({ as: Comp = 'div', className = '', children, ...props }) {
  return (
    <Comp className={`cf-solid ${className}`} {...props}>
      {children}
    </Comp>
  );
}
