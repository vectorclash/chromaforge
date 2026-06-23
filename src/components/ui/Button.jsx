import React from 'react';

// Light-theme button for the store/account/gallery chrome. `as` lets it render as a
// router <Link> or <a> while keeping the same styling (e.g. <Button as={Link} to="/shop">).
// Variants: primary (accent fill), secondary (outline), ghost (text only).
const VARIANTS = {
  primary: 'bg-accent text-white hover:bg-accent-strong',
  secondary: 'border border-neutral-300 text-neutral-900 hover:border-neutral-900',
  ghost: 'text-neutral-600 hover:text-neutral-900'
};

const SIZES = {
  sm: 'h-9 px-4 text-sm',
  md: 'h-11 px-6 text-sm'
};

export default function Button({
  as: Comp = 'button',
  variant = 'primary',
  size = 'md',
  className = '',
  ...props
}) {
  const base =
    'inline-flex items-center justify-center rounded-lg font-quicksand font-bold transition ' +
    'cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ' +
    'disabled:pointer-events-none disabled:opacity-40';
  return <Comp className={`${base} ${VARIANTS[variant]} ${SIZES[size]} ${className}`} {...props} />;
}
