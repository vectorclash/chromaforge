import React, { createContext, useContext, useEffect, useRef, useState, useCallback } from 'react';
import { generateArtwork } from '../render/generateArtwork';
import { randomSeed } from '../render/prng';
import renderArtwork from '../render/renderArtwork';
import { toCompactDesign } from '../render/compactDesign';
import { isSameDesign } from '../render/designSettings';
import { densityFloorSize } from '../render/scale';
import { resolvedPalette } from '../render/resolvedPalette';
import { saveDesign, uploadDesignThumbnail } from '../lib/designs';
import { readDesignPrefs, writeDesignPrefs } from '../lib/studioPrefs';
import { useAuth } from './AuthContext';
import FileName from '../components/FileNameGenerator';

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
// The render pipeline is now fully synchronous and asset-free: both star shapes are drawn
// from code (render/starSprite.js), so there is nothing to preload before a render can run.
// This used to hold a createjs LoadQueue of the two star PNGs, and a `queueReady` flag that
// every preview surface had to wait on -- all of that is gone. (createjs itself is still
// required: GeometricShape.js uses EaselJS.)

const PREVIEW_SIZE = 480;
// How long a replaced preview url stays alive before being revoked -- comfortably longer
// than useCrossfadeImage's full reveal (DURATION_FAST + DURATION_HOLD + DURATION_SLOW =
// 1.7s), which is the window in which a consumer can still be loading it.
const STALE_PREVIEW_REVOKE_MS = 5000;
// Sized to cover a gallery card on a 2x screen, which 320 did not: measured live, the cards
// occupy 259 CSS px on the gallery page and 227 on the homepage, so a retina display asks for
// 518 and 454 device pixels and a 320px JPEG was being upscaled ~1.6x. Mobile happened to land
// at 318 needed against 320 stored (101%), which is why this went unnoticed -- phones were
// always correct and only desktop was soft.
//
// It became visible rather than merely true at GENERATOR_VERSION 9: that made elements about
// a third of their previous size within a square frame (see CLAUDE.md's thumbnail note), and
// fine detail survives an upscale far worse than the large flat gradient shapes this used to
// carry.
//
// Verified rather than assumed. Scoring each encode against the 2000px render resampled to a
// real 518px card -- i.e. including the upscale the browser actually performs -- RMSE drops
// 8.22 -> 5.42, 7.27 -> 4.73 and 5.48 -> 3.67 across three seeds, about a third better in
// every case. Files go 11-26KB -> 29-66KB, so the whole designs table's thumbnails move from
// roughly 0.7MB to 1.7MB: nowhere near the scale at which the design-mockups bucket became a
// quota problem.
//
// Changing this needs `backfill-thumbnails.mjs` re-run (bare, no --generator-version filter)
// to reach existing rows; its own copy of the constant must be kept in sync.
const THUMBNAIL_SIZE = 640;

const StudioContext = createContext(null);

export function StudioProvider({ children }) {
  // StudioProvider is nested inside AuthProvider (see App.jsx), so it's safe to read auth
  // state directly here rather than threading `user` through every caller of saveCurrentDesign.
  const { user } = useAuth();

  // Seed a random default so the store always has something to preview even on a cold
  // deep-link to /shop (no Studio visit). The studio overwrites this via setCurrentDesign
  // on its first generate; empty colors -> the seeded RNG picks a palette, deterministically.
  //
  // The palette + geometry sliders the user last worked in, restored from localStorage (see
  // lib/studioPrefs.js). Read once, synchronously, so the very first design of the session
  // is already in their settings -- there is no "generate the default, then correct it"
  // flash, and every surface that derives from currentDesign (the hero, the three
  // MiniGenerators, the footer band, the About blob, product mockups) starts out agreeing.
  //
  // The SEED is deliberately not restored: a visit still opens on artwork nobody has seen,
  // it just arrives in the style they chose. Only the settings persist, not the design.
  const [currentDesign, setCurrentDesign] = useState(() => {
    const prefs = readDesignPrefs();
    return generateArtwork(randomSeed(), 1080, 1080, prefs?.colors ?? [], prefs?.settings ?? null);
  });
  const [previewUrl, setPreviewUrl] = useState(null);
  // The palette the CURRENT PREVIEW is painted with -- deliberately updated alongside
  // previewUrl rather than derived from currentDesign by consumers. currentDesign changes the
  // instant Generate is clicked, while previewUrl only appears once that design has actually
  // rendered, so anything reading the design directly gets the new palette a full render ahead
  // of the image it belongs to. Pairing them here is what lets a surface tint itself with the
  // artwork it is showing rather than the one it is about to show.
  const [previewPalette, setPreviewPalette] = useState(null);
  // Mirrors previewUrl so the render effect can revoke the url it is replacing without
  // doing that (a side effect) inside a setState updater, which StrictMode invokes twice.
  const previewUrlRef = useRef(null);
  // Last value written by the persistence effect below, so an unchanged design (an animation
  // frame build, a re-render) costs no localStorage write.
  const lastPersistedRef = useRef(null);
  // Tracks the exact image-design object (by reference -- see buildConfig's onDesignChange,
  // which hands the same object to setCurrentDesign that DisplayCanvas keeps as this.mainConfig)
  // that was last saved, so "is the CURRENT design already saved" is a single shared fact
  // rather than something each caller of saveCurrentDesign tracks separately. That sharing is
  // the fix for a real bug: saving from the studio's own panel didn't used to update the
  // mini-generator widget's (locally-tracked) saved state, so visiting /shop right after a
  // studio save still showed an enabled "Save" button and produced a duplicate row.
  const [savedDesign, setSavedDesign] = useState(null);
  // The saved row's id alongside the design object above -- DisplayCanvas needs this to
  // rebuild a working share link when a design that was already saved (e.g. via the
  // mini-generator widget) is handed off into the Studio via initialDesign, rather than
  // loaded via a share/gallery URL (the only other path that used to set a share link).
  const [savedDesignId, setSavedDesignId] = useState(null);
  // One-shot hand-off for "Print this" from the Gallery: set when a gallery card's print
  // action fires, read (and cleared) by ProductPage on mount so the artwork-picker defaults
  // to this design instead of the live studio design. Deliberately separate from
  // currentDesign -- printing an old saved design shouldn't change what the ambient
  // mini-generator/footer show elsewhere, since those represent the studio's live work.
  const [printQueueDesign, setPrintQueueDesign] = useState(null);

  // Render any design config to a JPEG blob at the given size, off-canvas. Generalized from
  // DisplayCanvas.renderArtworkBlobAt -- recompose per ratio (regenerate from seed/colors),
  // not a downscaled screenshot. `includeGeometry`
  // (default true) and `geometryLayout` (default null) are render context, not part of the
  // design -- only merch placement rendering (lib/printful.js's capRenderStrategy) ever
  // passes these, driven by ProductPage.jsx's per-placement geometry checkboxes and
  // two-leg-canvas layout toggle respectively.
  //
  // `highDensity` (default false): when the output size is small display real estate (a
  // gallery thumbnail, a modal preview) rather than a size someone chose for a specific
  // reason (a merch placement's own printfile-matched size, or a live-preview size where
  // regenerating a much bigger canvas on every keystroke/generate would add real input lag),
  // generate at a denser canvas (render/scale.js's densityFloorSize) and downscale into the
  // requested output -- otherwise getCountScale's own area-based falloff makes a small
  // direct render genuinely sparser than "the same design at a size someone would call the
  // real image," not just smaller (see densityFloorSize's comment; caught the same way
  // TshirtPreview's identical issue was). Opt-in, not the default, specifically so this
  // doesn't add render cost to the hot paths that already call this on every design change
  // (the mini-generator/footer/mobile-nav previews) -- only callers that render once per
  // save or on-demand (thumbnails, the gallery modal) opt in.
  const renderDesignBlob = useCallback(
    async (
      config,
      width,
      height,
      { includeGeometry = true, geometryLayout = null, mirrorX = false, highDensity = false, sizeFrame = null, legSymmetry = false } = {}
    ) => {
      const { width: genWidth, height: genHeight } = highDensity
        ? densityFloorSize(width, height)
        : { width, height };
      const built = generateArtwork(config.seed, genWidth, genHeight, config.colors, config.settings, {
        includeGeometry,
        geometryLayout,
        mirrorX,
        sizeFrame,
        legSymmetry
      });
      const canvas = renderArtwork(built);
      let outputCanvas = canvas;
      if (genWidth !== width || genHeight !== height) {
        outputCanvas = document.createElement('canvas');
        outputCanvas.width = width;
        outputCanvas.height = height;
        // genWidth/genHeight share width/height's exact aspect (densityFloorSize scales
        // uniformly) -- a plain scaled draw is a true downsample, no cropping needed.
        outputCanvas.getContext('2d').drawImage(canvas, 0, 0, width, height);
        canvas.width = 0;
        canvas.height = 0;
      }
      const blob = await new Promise(resolve => outputCanvas.toBlob(resolve, 'image/jpeg', 0.85));
      outputCanvas.width = 0;
      outputCanvas.height = 0;
      return blob;
    },
    []
  );

  // Mirror the active design's palette + settings back to localStorage. This is the single
  // write point on purpose: every path that can change either of them -- the studio's own
  // Generate, the debounced geometry-slider regeneration, a colour edit, a share-link or
  // gallery load (both of which sync the panel to the loaded design via
  // DisplayCanvas.adoptDesignColors/adoptDesignSettings), the mini-generator widget --
  // finishes by handing the rebuilt design to setCurrentDesign. Persisting here rather than
  // at each of those means a future path cannot forget to.
  //
  // Skipped when the value is unchanged, which is what keeps a 2D animation build cheap:
  // it calls buildConfig once per frame (up to 60), and every one of those frames shares the
  // palette and settings this is watching.
  useEffect(() => {
    const value = {
      colors: currentDesign.colors ?? [],
      settings: currentDesign.settings ?? null
    };
    const serialized = JSON.stringify(value);
    if (serialized === lastPersistedRef.current) return;
    lastPersistedRef.current = serialized;
    writeDesignPrefs(value);
  }, [currentDesign]);

  // Derived small preview of the current design -- the single render both the mini-generator
  // widget and the footer art band read, so regenerating once updates both at once instead of
  // each consumer rendering its own copy.
  useEffect(() => {
    let cancelled = false;
    renderDesignBlob(currentDesign, PREVIEW_SIZE, PREVIEW_SIZE)
      .then(blob => {
        if (cancelled) return;
        const url = URL.createObjectURL(blob);
        const dead = previewUrlRef.current;
        previewUrlRef.current = url;
        setPreviewUrl(url);
        // `currentDesign` here is the closure's -- the design this blob was rendered FROM,
        // not whatever happens to be current by the time it resolves.
        setPreviewPalette(resolvedPalette(currentDesign));
        // The old url is revoked on a DELAY, not immediately. Every consumer of previewUrl
        // reveals it through useCrossfadeImage, which spends ~1.7s fading the old image out,
        // holding, and fading the new one in -- and it preloads mid-reveal. Revoking on the
        // spot pulled the url out from under a reveal that was still using it whenever two
        // previews landed close together, which is a load error, not a blank frame.
        if (dead) setTimeout(() => URL.revokeObjectURL(dead), STALE_PREVIEW_REVOKE_MS);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentDesign, renderDesignBlob]);

  // Fresh seed, but keeps the CURRENT palette/geometry settings -- what "Generate" means
  // everywhere else in the app (DisplayCanvas.onGenerateButtonClick's buildConfig() defaults
  // to the live state.colors/geometrySettings the same way). This was the real bug behind
  // "the mini generator resets everything": it used to always regenerate with an empty
  // palette and default settings regardless of what was actually live, so clicking Generate
  // on the ambient widget silently discarded any colors/geometry chosen in the Studio, while
  // the Studio's own Generate button (a different code path) preserved them. Falls back to
  // an auto-palette only for the provider's very first (pre-Studio-visit) design, same as
  // before.
  const generateRandom = useCallback(() => {
    setCurrentDesign(prev =>
      generateArtwork(randomSeed(), 1080, 1080, prev.colors ?? [], prev.settings ?? null)
    );
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
      if (kind === 'image') {
        setSavedDesign(data);
        setSavedDesignId(row.id);
      }
      // Best-effort: a thumbnail failure shouldn't undo the save that already succeeded.
      const source = compactData.animation && compactData.frames ? compactData.frames[0] : compactData;
      if (source?.seed !== undefined) {
        renderDesignBlob(source, THUMBNAIL_SIZE, THUMBNAIL_SIZE, { highDensity: true })
          .then(blob => uploadDesignThumbnail(row.id, blob))
          .catch(err => console.error('Thumbnail upload failed:', err));
      }
      return row;
    },
    [user, renderDesignBlob]
  );

  // Record an EXISTING gallery row as the saved design, for the load-by-id path (a gallery
  // "Open in studio", or a share link). saveCurrentDesign is the only other thing that sets
  // this, so before this existed a loaded design left savedDesign at null and every
  // MiniGenerator widget offered "Save" for a design already sitting in the gallery --
  // clicking it inserted a duplicate row. The studio panel's own button was right, because
  // DisplayCanvas.loadImageFromUrl sets its local isSaved: true; it was only the shared fact
  // that never learned. Same shape as the isSameDesign bug below, different cause, which is
  // why fixing that one didn't cover this.
  //
  // Takes the design the canvas actually built (not the raw row), so it is the very object
  // handed to setCurrentDesign and isSameDesign cannot disagree about a normalised `settings`
  // or an auto-palette's empty `colors`.
  const markDesignSaved = useCallback((design, id) => {
    if (!design || !id) return;
    setSavedDesign(design);
    setSavedDesignId(id);
  }, []);

  const value = {
    currentDesign,
    setCurrentDesign,
    previewUrl,
    previewPalette,
    renderDesignBlob,
    generateRandom,
    saveCurrentDesign,
    markDesignSaved,
    // Real bug, found by manual testing: this used to be reference equality
    // (savedDesign === currentDesign), which only happened to hold for MiniGenerator's own
    // save (it passes currentDesign straight through, same object). DisplayCanvas's Save
    // button always builds a fresh compacted object (toCompactDesign(this.mainConfig)),
    // never === to currentDesign even though it's the exact same design -- so saving from
    // the homepage hero's studio panel, then visiting a route with MiniGenerator (e.g. the
    // gallery), showed "Save" as still available and produced a duplicate row. Compare by
    // the actual identity of a design (seed + colors) instead of by object reference.
    isCurrentDesignSaved: isSameDesign(savedDesign, currentDesign),
    savedDesignId,
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
