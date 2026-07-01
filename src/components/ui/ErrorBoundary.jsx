import React from 'react';

// Last-resort catch for render errors anywhere in the tree -- without this, any uncaught
// error during render unmounts the whole app to a permanently blank page with nothing to
// act on. Class component because error boundaries have no hook equivalent. Deliberately
// uses no router/context/design-system components: it has to render even when those are
// what broke, so the styling is plain utility classes on plain elements.
export default class ErrorBoundary extends React.Component {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error, info) {
    console.error('Unhandled render error:', error, info.componentStack);
  }

  render() {
    if (!this.state.hasError) return this.props.children;
    return (
      <div className="flex h-screen w-full flex-col items-center justify-center gap-4 bg-ink-950 px-6 text-center">
        <h1 className="font-display text-2xl font-black text-text">Something went wrong</h1>
        <p className="max-w-sm text-sm text-text-secondary">
          An unexpected error interrupted the page. Reloading usually clears it — your saved
          designs and orders are unaffected.
        </p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="cf-btn-primary mt-2"
        >
          Reload
        </button>
      </div>
    );
  }
}
