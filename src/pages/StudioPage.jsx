import React, { useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import DisplayCanvas from '../components/DisplayCanvas';
import { isMobileDevice } from '../utils/device';
import { useStudio } from '../context/StudioContext';
import { useAuth } from '../context/AuthContext';
import { usePageMeta } from '../hooks/usePageMeta';

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
  // Compact mode is the homepage hero, where the base site meta should stay -- passing null
  // skips the hook entirely; only the standalone /studio route gets its own title/description.
  usePageMeta(
    compact
      ? null
      : {
          title: 'Studio',
          description:
            'Design generative art from a seed. Tweak colors and geometry, save it to your gallery, and preview it printed on real merch.',
          path: '/studio'
        }
  );
  // The one route that still locks page scrolling. Scrolling is otherwise on site-wide so
  // iOS Safari minimizes its toolbar (see tailwind.css); the standalone studio is the
  // exception because its canvas is a full-bleed immersive surface with nothing below it.
  // Compact mode is the homepage hero, which sits at the top of a page that must scroll --
  // locking there would freeze the whole homepage.
  useEffect(() => {
    if (compact) return undefined;
    document.documentElement.classList.add('no-scroll');
    return () => document.documentElement.classList.remove('no-scroll');
  }, [compact]);

  const { currentDesign, setCurrentDesign, saveCurrentDesign, isCurrentDesignSaved, savedDesignId } =
    useStudio();
  const { user } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const returnTo = getReturnTo(location.state?.from);

  let width = 3840;
  let height = 2160;
  if (isMobileDevice()) {
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
