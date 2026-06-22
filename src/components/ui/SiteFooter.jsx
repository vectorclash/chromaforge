import React from 'react';
import { Link } from 'react-router-dom';

export default function SiteFooter() {
  return (
    <footer className="mt-16 border-t border-neutral-200">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-8 text-sm text-neutral-400">
        <span>© {new Date().getFullYear()} ChromaForge</span>
        <Link to="/" className="font-quicksand transition hover:text-neutral-700">
          ← Back to studio
        </Link>
      </div>
    </footer>
  );
}
