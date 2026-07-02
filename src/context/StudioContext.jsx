import React, { createContext, useContext, useEffect, useRef, useState, useCallback } from 'react';
import { generateArtwork } from '../render/generateArtwork';
import { randomSeed } from '../render/prng';
import renderArtwork from '../render/renderArtwork';
import { toCompactDesign } from '../render/compactDesign';
import { saveDesign, uploadDesignThumbnail } from '../lib/designs';
import { useAuth } from './AuthContext';
import FileName from '../components/FileNameGenerator';
import s1 from '../assets/images/star-sprite-large.png';
import s2 from '../assets/images/star-sprite-small.png';

// Shared "studio" state: the current design, a live small preview of it, and the ability to
// render/save it -- lifted out of DisplayCanvas so commerce routes (product mockups, the
// ambient mini-generator widget, the footer art band) can all work off the same design even
// though the canvas component isn't mounted on those routes.
//
// `currentDesign` is the generateArtwork() output (same object DisplayCanvas keeps as
// this.mainConfig) -- it carries .seed and .colors, which is all renderDesignBlob needs to
// reconstruct the artwork at any size. The studio writes it via setCurrentDesign on every
// generate/load; pages read it.
//
// The star-sprite queue is the one piece renderArtwork needs that isn't pure -- it's loaded
// once here (mirroring DisplayCanvas's own load) so the render pipeline works off-canvas.

const PREVIEW_SIZE = 480;
const THUMBNAIL_SIZE = 320;

// Two designs are "the same" if they'd regenerate identical artwork -- same seed, same
// palette -- regardless of whether they're literally the same object in memory (a saved
// design is always a distinct compacted object from whatever full generateArtwork() output
// produced it). See isCurrentDesignSaved's own comment for why reference equality was wrong.
function isSameDesign(a, b) {
  if (!a || !b || a.seed !== b.seed) return false;
  const ac = a.colors || [];
  const bc = b.colors || [];
  return ac.length === bc.length && ac.every((c, i) => c === bc[i]);
}

const StudioContext = createContext(null);

export function StudioProvider({ children }) {
  // StudioProvider is nested inside AuthProvider (see App.jsx), so it's safe to read auth
  // state directly here rather than threading `user` through every caller of saveCurrentDesign.
  const { user } = useAuth();

  const queueRef = useRef(null);
  const [queueReady, setQueueReady] = useState(false);
  // Seed a random default so the store always has something to preview even on a cold
  // deep-link to /shop (no Studio visit). The studio overwrites this via setCurrentDesign
  // on its first generate. Empty colors -> the seeded RNG picks a palette, deterministically.
  const [currentDesign, setCurrentDesign] = useState(() =>
    generateArtwork(randomSeed(), 1080, 1080, [])
  );
  const [previewUrl, setPreviewUrl] = useState(null);
  // Tracks the exact image-design object (by reference -- see buildConfig's onDesignChange,
  // which hands the same object to setCurrentDesign that DisplayCanvas keeps as this.mainConfig)
  // that was last saved, so "is the CURRENT design already saved" is a single shared fact
  // rather than something each caller of saveCurrentDesign tracks separately. That sharing is
  // the fix for a real bug: saving from the studio's own panel didn't used to update the
  // mini-generator widget's (locally-tracked) saved state, so visiting /shop right after a
  // studio save still showed an enabled "Save" button and produced a duplicate row.
  const [savedDesign, setSavedDesign] = useState(null);
  // One-shot hand-off for "Print this" from the Gallery: set when a gallery card's print
  // action fires, read (and cleared) by ProductPage on mount so the artwork-picker defaults
  // to this design instead of the live studio design. Deliberately separate from
  // currentDesign -- printing an old saved design shouldn't change what the ambient
  // mini-generator/footer show elsewhere, since those represent the studio's live work.
  const [printQueueDesign, setPrintQueueDesign] = useState(null);

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

  // Derived small preview of the current design -- the single render both the mini-generator
  // widget and the footer art band read, so regenerating once updates both at once instead of
  // each consumer rendering its own copy.
  useEffect(() => {
    if (!queueReady) return;
    let cancelled = false;
    let url;
    renderDesignBlob(currentDesign, PREVIEW_SIZE, PREVIEW_SIZE)
      .then(blob => {
        if (cancelled) return;
        url = URL.createObjectURL(blob);
        setPreviewUrl(prev => {
          if (prev) URL.revokeObjectURL(prev);
          return url;
        });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentDesign, queueReady, renderDesignBlob]);

  // Fresh random design, auto-palette -- the same shape used for the provider's initial seed.
  const generateRandom = useCallback(() => {
    setCurrentDesign(generateArtwork(randomSeed(), 1080, 1080, []));
  }, []);

  // Persist a design to the signed-in user's gallery. Throws (rather than silently no-op'ing)
  // so callers -- the studio's save panel, the mini-generator widget -- can each show their own
  // error state. Ported from the old DisplayCanvas.saveToGallery/uploadThumbnailFor.
  //
  // Gives every save a generated name (the same astro-themed generator already used for
  // export filenames -- src/components/FileNameGenerator.js) rather than leaving the gallery
  // row title null, which is why every card read "Untitled".
  const saveCurrentDesign = useCallback(
    async (kind, data) => {
      if (!user) throw new Error('Sign in to save designs.');
      // Compact here -- not left to each caller -- so a future save path can't repeat a
      // real bug this fixed: the mini-generator widget's Save button passed the raw,
      // uncompacted generateArtwork() output straight through (no compaction at all),
      // which let some rows balloon to multi-megabyte jsonb (a resolved starFieldConfig
      // alone can be several MB) and was the dominant driver of this project's Supabase
      // egress. toCompactDesign is idempotent, so this is a no-op for callers (DisplayCanvas's
      // own Save button) that already compact before calling this.
      const compactData =
        data.animation && data.frames
          ? { animation: true, frames: data.frames.map(toCompactDesign) }
          : toCompactDesign(data);
      const row = await saveDesign({ kind, data: compactData, title: FileName(), isPublic: true });
      if (kind === 'image') setSavedDesign(data);
      // Best-effort: a thumbnail failure shouldn't undo the save that already succeeded.
      const source = compactData.animation && compactData.frames ? compactData.frames[0] : compactData;
      if (source?.seed !== undefined) {
        renderDesignBlob(source, THUMBNAIL_SIZE, THUMBNAIL_SIZE)
          .then(blob => uploadDesignThumbnail(row.id, blob))
          .catch(err => console.error('Thumbnail upload failed:', err));
      }
      return row;
    },
    [user, renderDesignBlob]
  );

  const value = {
    currentDesign,
    setCurrentDesign,
    previewUrl,
    renderDesignBlob,
    generateRandom,
    saveCurrentDesign,
    // Real bug, found by manual testing: this used to be reference equality
    // (savedDesign === currentDesign), which only happened to hold for MiniGenerator's own
    // save (it passes currentDesign straight through, same object). DisplayCanvas's Save
    // button always builds a fresh compacted object (toCompactDesign(this.mainConfig)),
    // never === to currentDesign even though it's the exact same design -- so saving from
    // the homepage hero's studio panel, then visiting a route with MiniGenerator (e.g. the
    // gallery), showed "Save" as still available and produced a duplicate row. Compare by
    // the actual identity of a design (seed + colors) instead of by object reference.
    isCurrentDesignSaved: isSameDesign(savedDesign, currentDesign),
    queueReady,
    printQueueDesign,
    setPrintQueueDesign
  };
  return <StudioContext.Provider value={value}>{children}</StudioContext.Provider>;
}

export function useStudio() {
  const ctx = useContext(StudioContext);
  if (!ctx) throw new Error('useStudio must be used within a StudioProvider');
  return ctx;
}
