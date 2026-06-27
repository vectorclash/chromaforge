import React from 'react';

// Solid, lift-on-hover card from the locked foundation (.cf-card in components.css). `as`
// lets it render as a router <Link> (whole-card link, e.g. a product tile) while keeping
// hover affordances.
export default function Card({ as: Comp = 'div', className = '', children, ...props }) {
  return (
    <Comp className={`cf-card block overflow-hidden ${className}`} {...props}>
      {children}
    </Comp>
  );
}
