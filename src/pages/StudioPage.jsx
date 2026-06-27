import React from 'react';
import { useNavigate } from 'react-router-dom';
import DisplayCanvas from '../components/DisplayCanvas';
import { useStudio } from '../context/StudioContext';
import { useAuth } from '../context/AuthContext';

// The full interactive generator -- the dark, full-bleed canvas. Wraps the existing
// DisplayCanvas and feeds the current design into StudioContext so the store routes (and
// the homepage footer/mini-widget) can all render the same active design. `compact` defaults
// on (the homepage hero, see components/home/Hero.jsx, which already has the site nav for
// wordmark/Shop, so the panel opens minimal: just Generate, Save, and a "Go to studio" link)
// -- pass `compact={false}` for the full standalone tool (the "/studio" route in App.jsx).
export default function StudioPage({ compact = true }) {
  const { currentDesign, setCurrentDesign, saveCurrentDesign } = useStudio();
  const { user } = useAuth();
  const navigate = useNavigate();

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
      initialDesign={currentDesign}
      onDesignChange={setCurrentDesign}
      onNavigate={navigate}
      saveCurrentDesign={saveCurrentDesign}
    />
  );
}
