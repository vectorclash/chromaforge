import React from 'react';

// Standard page wrapper for content routes: an optional display title/subtitle header
// over the page body. Keeps headings consistent across Shop/Gallery/Account.
export default function PageContainer({ title, subtitle, actions, children }) {
  return (
    <div>
      {(title || subtitle || actions) && (
        <header className="mb-8 flex items-end justify-between gap-4">
          <div>
            {title && (
              <h1 className="font-display text-4xl font-black tracking-tight text-neutral-900">
                {title}
              </h1>
            )}
            {subtitle && <p className="mt-2 text-neutral-500">{subtitle}</p>}
          </div>
          {actions && <div className="shrink-0">{actions}</div>}
        </header>
      )}
      {children}
    </div>
  );
}
