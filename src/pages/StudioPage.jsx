import React from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import DisplayCanvas from '../components/DisplayCanvas';
import { useStudio } from '../context/StudioContext';
import { useAuth } from '../context/AuthContext';
import { usePageTitle } from '../hooks/usePageTitle';

// Where the full studio's "return" link sends the user back to -- keyed off the `from`
// path callers pass via navigate('/studio', { state: { from } }) (see GalleryPage,
// GallerySection, MiniGenerator, Hero/DisplayCanvas's compact "Go to studio" button).
// Falls back to home for direct navigation (no state, e.g. a bookmarked/typed /studio URL).
function getReturnTo(from) {
  if (from === '/gallery') return { path: '/gallery', label: 'Return to gallery' };
  if (from === '/account') return { path: '/account', label: 'Return to account' };
  if (from?.startsWith('/shop')) return { path: from, label: 'Return to shop' };
  return { path: '/', label: 'Back to home' };
}

// The full interactive generator -- the dark, full-bleed canvas. Wraps the existing
// DisplayCanvas and feeds the current design into StudioContext so the store routes (and
// the homepage footer/mini-widget) can all render the same active design. `compact` defaults
// on (the homepage hero, see components/home/Hero.jsx, which already has the site nav for
// wordmark/Shop, so the panel opens minimal: just Generate, Save, and a "Go to studio" link)
// -- pass `compact={false}` for the full standalone tool (the "/studio" route in App.jsx).
export default function StudioPage({ compact = true }) {
  // Compact mode is the homepage hero, where the base site title should stay -- null keeps
  // it; only the standalone /studio route gets its own title.
  usePageTitle(compact ? null : 'Studio');
  const { currentDesign, setCurrentDesign, saveCurrentDesign, isCurrentDesignSaved, savedDesignId } =
    useStudio();
  const { user } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const returnTo = getReturnTo(location.state?.from);

  let width = 3840;
  let height = 2160;
  if (/Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent)) {
    width = 2160;
    height = 2160;
  }

  return (
    <DisplayCanvas
      width={width}
      height={height}
      user={user}
      compact={compact}
      returnTo={returnTo}
      initialDesign={currentDesign}
      isDesignSaved={isCurrentDesignSaved}
      savedDesignId={savedDesignId}
      onDesignChange={setCurrentDesign}
      onNavigate={navigate}
      saveCurrentDesign={saveCurrentDesign}
    />
  );
}
