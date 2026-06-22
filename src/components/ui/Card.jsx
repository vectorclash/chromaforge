import React from 'react';

// Light surface card. `as` lets it render as a router <Link> (whole-card link, e.g. a
// product tile) while keeping hover affordances.
export default function Card({ as: Comp = 'div', className = '', children, ...props }) {
  const base =
    'block overflow-hidden rounded-xl border border-neutral-200 bg-white transition ' +
    'hover:border-neutral-300 hover:shadow-sm';
  return (
    <Comp className={`${base} ${className}`} {...props}>
      {children}
    </Comp>
  );
}
