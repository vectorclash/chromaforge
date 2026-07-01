import React from 'react';

// Shared section heading/body rhythm for the Terms/Privacy pages -- both are long,
// section-by-section documents that need the same heading style repeated a dozen times.
export default function LegalSection({ title, children }) {
  return (
    <section className="border-t border-hairline pt-6">
      <h2 className="font-quicksand text-sm font-bold uppercase tracking-wide text-text-secondary">
        {title}
      </h2>
      <div className="mt-3 space-y-3 text-sm leading-relaxed text-text-secondary">
        {children}
      </div>
    </section>
  );
}
