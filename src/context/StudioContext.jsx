import React, { createContext, useContext, useEffect, useRef, useState, useCallback } from 'react';
import { generateArtwork } from '../render/generateArtwork';
import renderArtwork from '../render/renderArtwork';
import s1 from '../assets/images/star-sprite-large.png';
import s2 from '../assets/images/star-sprite-small.png';

// Shared "studio" state: the current design and the ability to render it to an image,
// lifted out of DisplayCanvas so commerce routes (e.g. /shop product mockups) can render
// the current design even though the canvas component isn't mounted on those routes.
//
// `currentDesign` is the generateArtwork() output (same object DisplayCanvas keeps as
// this.mainConfig) -- it carries .seed and .colors, which is all renderDesignBlob needs to
// reconstruct the artwork at any size. The studio writes it via setCurrentDesign on every
// generate/load; pages read it.
//
// The star-sprite queue is the one piece renderArtwork needs that isn't pure -- it's loaded
// once here (mirroring DisplayCanvas's own load) so the render pipeline works off-canvas.

const StudioContext = createContext(null);

export function StudioProvider({ children }) {
  const queueRef = useRef(null);
  const [queueReady, setQueueReady] = useState(false);
  const [currentDesign, setCurrentDesign] = useState(null);

  useEffect(() => {
    if (queueRef.current) return; // guard against StrictMode double-invoke
    const queue = new window.createjs.LoadQueue(true, '');
    queueRef.current = queue;
    queue.on('complete', () => setQueueReady(true));
    queue.loadManifest([
      { id: 'star-large', src: s1 },
      { id: 'star-small', src: s2 }
    ]);
  }, []);

  // Render any design config to a JPEG blob at the given size, off-canvas, using the shared
  // star-sprite queue. Generalized from DisplayCanvas.renderArtworkBlobAt -- recompose per
  // ratio (regenerate from seed/colors), not a downscaled screenshot.
  const renderDesignBlob = useCallback(async (config, width, height) => {
    if (!queueRef.current) throw new Error('Render assets are still loading.');
    const built = generateArtwork(config.seed, width, height, config.colors);
    const canvas = renderArtwork(built, queueRef.current);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.85));
    canvas.width = 0;
    canvas.height = 0;
    return blob;
  }, []);

  const value = { currentDesign, setCurrentDesign, renderDesignBlob, queueReady };
  return <StudioContext.Provider value={value}>{children}</StudioContext.Provider>;
}

export function useStudio() {
  const ctx = useContext(StudioContext);
  if (!ctx) throw new Error('useStudio must be used within a StudioProvider');
  return ctx;
}
