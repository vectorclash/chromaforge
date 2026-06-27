import React from 'react';

// Frosted surface from the locked foundation (.cf-glass in components.css). Use ONLY where
// there's live generative art behind it -- studio panel, hero, footer, mini-generator widget.
// Never over a flat background; that's what SolidPanel is for.
export default function GlassPanel({ as: Comp = 'div', className = '', children, ...props }) {
  return (
    <Comp className={`cf-glass ${className}`} {...props}>
      {children}
    </Comp>
  );
}
