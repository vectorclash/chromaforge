import React from 'react';

// Canonical button for the dark site-wide system (.cf-btn-primary / .cf-btn-ghost /
// .cf-btn-icon in components.css). One button, reused on glass and solid surfaces alike --
// the surface changes, the button doesn't. `as` lets it render as a router <Link> or <a>
// while keeping the same styling (e.g. <Button as={Link} to="/shop">).
// `secondary` is kept as an alias for `ghost` -- pre-redesign callers used that name for
// the outline treatment, which is exactly what ghost is here.
const VARIANTS = {
  primary: 'cf-btn-primary',
  secondary: 'cf-btn-ghost',
  ghost: 'cf-btn-ghost',
  icon: 'cf-btn-icon'
};

const SIZES = {
  sm: 'cf-size-sm',
  md: ''
};

export default function Button({
  as: Comp = 'button',
  variant = 'primary',
  size = 'md',
  className = '',
  ...props
}) {
  return <Comp className={`${VARIANTS[variant]} ${SIZES[size]} ${className}`} {...props} />;
}
