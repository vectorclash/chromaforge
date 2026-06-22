import React from 'react';
import { useNavigate } from 'react-router-dom';
import DisplayCanvas from '../components/DisplayCanvas';
import { useStudio } from '../context/StudioContext';
import { useAuth } from '../context/AuthContext';

// The generative studio: the dark, full-bleed canvas at "/". Wraps the existing
// DisplayCanvas and feeds the current design into StudioContext so the store routes can
// render mockups of it. The canvas keeps its own immersive identity and floating controls;
// only the store/account/gallery routes get the light site chrome.
export default function StudioPage() {
  const { setCurrentDesign } = useStudio();
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
      onDesignChange={setCurrentDesign}
      onNavigate={navigate}
    />
  );
}
