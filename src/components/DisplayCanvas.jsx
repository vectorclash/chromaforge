import React from 'react';
import { gsap, TextPlugin } from 'gsap/all';
import tinycolor from 'tinycolor2';
import saveAs from 'file-saver';
import { Muxer, ArrayBufferTarget } from 'mp4-muxer';

import { generateAudioBuffer } from '../audio/generateAudioBuffer';
import { getDesignIdFromUrl, getShareUrlPrefix, buildShareUrl } from '../utils/urlConfig';
import { getDesign } from '../lib/designs';
import { randomSeed, meanLuminance, makeRng } from '../render/prng';
import { resolvedPalette } from '../render/resolvedPalette';
// Palette resolution only -- deliberately NOT tunnelScene itself, which statically imports
// three.js and must stay in its own lazy chunk.
import { resolveScenePalette } from '../animation3d/scenePalette';
import { generateArtwork } from '../render/generateArtwork';
import renderArtwork from '../render/renderArtwork';
import { toCompactDesign } from '../render/compactDesign';
import { DEFAULT_GEOMETRY_SETTINGS, getGeometrySettings } from '../render/designSettings';
import { DURATION_FAST, DURATION_BASE, DURATION_SLOW, DURATION_HOLD } from '../utils/motionTokens';
import { rampTime, rampRush, RAMP_FLOOR_2D, RAMP_FLOOR_3D } from '../utils/speedRamp';
import { logoState, LOGO_SCREEN_FRACTION } from '../utils/logoIntro';
import { generateLogoMark } from '../render/generateLogoMark';
import { drawLogoMark } from '../render/renderLogoMark';
import { isMobileDevice } from '../utils/device';
import { subscribeScrollLock } from '../hooks/useScrollLock';

import Copyright from './Copyright';
import HexagonLoader from './HexagonLoader';
import DotRipple from './DotRipple';
import AnimationPreview from './AnimationPreview';
import Animation3DPreview from './Animation3DPreview';
import TshirtPreview from './TshirtPreview';
import CloseButton from './buttons/CloseButton';
import GenerateStarField from './Canvas/GenerateStarField';
import StarField from './Canvas/StarField';
import FileName from './FileNameGenerator';
import SettingsButton from './buttons/SettingsButton';
import PlayPauseButton from './buttons/PlayPauseButton';
import AddColorButton from './buttons/AddColorButton';
import ShirtIcon from './buttons/ShirtIcon';
import ArrowIcon from './buttons/ArrowIcon';
import ColorField from './ColorField';

import s1 from '../assets/images/star-sprite-large.png';
import s2 from '../assets/images/star-sprite-small.png';
import { StudioWordmark } from './ui/Wordmark';

gsap.registerPlugin(TextPlugin);

// AAC-LC AudioSpecificConfig (the esds "description" bytes): 5 bits object type (2 =
// AAC-LC), 4 bits sampling-frequency index, 4 bits channel config. mp4-muxer requires
// this to write a playable AAC track. Chrome's AudioEncoder always supplies it in the
// output meta; WebKit's (iOS/macOS Safari) has been observed to omit it — mp4-muxer then
// produces a file whose audio track is broken/ignored by players with NO error thrown
// (export "succeeds", music is silently missing — the iOS symptom). Synthesizing it
// ourselves is byte-identical to what Chrome sends, so it's safe to apply everywhere.
const AAC_SAMPLE_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
function aacAudioSpecificConfig(sampleRate, numberOfChannels) {
  const freqIndex = AAC_SAMPLE_RATES.indexOf(sampleRate);
  if (freqIndex === -1) return null;
  return new Uint8Array([
    (2 << 3) | (freqIndex >> 1),
    ((freqIndex & 1) << 7) | (numberOfChannels << 3),
  ]);
}

async function encodeAudioTrack(audioBuffer, muxer, audioCodec, onProgress) {
  const left        = audioBuffer.getChannelData(0);
  const right       = audioBuffer.numberOfChannels > 1 ? audioBuffer.getChannelData(1) : left;
  const sampleRate  = audioBuffer.sampleRate;
  const totalFrames = audioBuffer.length;
  const isAac       = audioCodec !== 'opus';
  const CHUNK_FRAMES = 4096;
  // Estimate output chunks: AAC uses 1024-sample frames, Opus uses 960 or 480.
  const frameSize = audioCodec === 'opus' ? 960 : 1024;
  const totalOutputChunks = Math.ceil(totalFrames / frameSize);
  let outputCount = 0;

  await new Promise((resolve, reject) => {
    const encoder = new AudioEncoder({
      output: (chunk, meta) => {
        // Backfill the AAC decoderConfig description if the encoder omitted it (WebKit —
        // see aacAudioSpecificConfig above). Without it the muxed audio track is silently
        // unplayable; with a synthesized one it's exactly what Chrome would have sent.
        if (isAac && !meta?.decoderConfig?.description) {
          const description = aacAudioSpecificConfig(sampleRate, 2);
          if (description) {
            meta = {
              ...meta,
              decoderConfig: {
                codec: audioCodec,
                sampleRate,
                numberOfChannels: 2,
                ...meta?.decoderConfig,
                description,
              },
            };
          }
        }
        muxer.addAudioChunk(chunk, meta);
        outputCount++;
        onProgress?.(Math.min(outputCount / totalOutputChunks, 1));
      },
      error: reject,
    });

    try {
      encoder.configure({ codec: audioCodec, numberOfChannels: 2, sampleRate, bitrate: 128_000 });

      for (let offset = 0; offset < totalFrames; offset += CHUNK_FRAMES) {
        const frameCount = Math.min(CHUNK_FRAMES, totalFrames - offset);
        const timestamp  = Math.round((offset / sampleRate) * 1_000_000);
        const planar     = new Float32Array(frameCount * 2);
        planar.set(left.subarray(offset, offset + frameCount), 0);
        planar.set(right.subarray(offset, offset + frameCount), frameCount);

        const audioData = new AudioData({
          format: 'f32-planar',
          sampleRate,
          numberOfFrames: frameCount,
          numberOfChannels: 2,
          timestamp,
          data: planar,
        });
        encoder.encode(audioData);
        audioData.close();
      }

      encoder.flush().then(resolve).catch(reject);
    } catch (e) {
      reject(e);
    }
  });
}

// Shape-matches a real Supabase row id (a UUID) so the share-link box's id slot always has
// *something* the right size/shape to show the instant a save starts, rather than looking
// like a chunk of the URL is simply missing. Also gives the "fill in" animation a consistent
// state to animate FROM every single time (see saveToGallery's GSAP TextPlugin call) --
// previously it animated from whatever this.shareDesignId happened to still hold from a
// prior save, which was empty on a true first save (no visible animation at all) and a
// stale real id on any save after a Generate click that hadn't cleared it (see
// onGenerateButtonClick's own fix for that).
const SHARE_LINK_ID_PLACEHOLDER = 'XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX';

// ─── Animation memory budget ─────────────────────────────────────────────────────────
// Phones were crashing and reloading the tab when the Video settings were pushed up
// (Aaron, 2026-07-28). It is an out-of-memory kill, and 2D and 3D fail for completely
// different reasons — measured, not assumed:
//
//   2D: every frame AND star frame is an <img> living in the DOM, and AnimationPreview
//       decodes all of them up front on purpose (decoding lazily made frames paint black).
//       So they are all resident as RGBA bitmaps at once. At the mobile studio size
//       (2160x2160) that is 17.8MB EACH — the default 20+10 already holds 534MB, and the
//       old 60+60 ceiling would have asked for 2.1GB. The encoded blobs are irrelevant
//       (17MB total) and so is the JS heap (40MB); it is entirely decoded pixels.
//   3D: bounded by construction. Scene geometry measures 5.6MB at ANY duration >= 10s,
//       because content length is capped at MAX_CONTENT_LENGTH and the camera laps it.
//       Nothing there grows with the sliders.
//
// So the caps that matter are 2D's frame counts, plus — for both modes — Duration and
// frame rate, which size the export: mp4-muxer holds the ENTIRE file in memory
// (ArrayBufferTarget + fastStart: 'in-memory'), which at the mobile 25Mbps bitrate is
// 89MB at 30s and 179MB at 60s, on top of everything above.
const ANIM_LIMITS = {
  desktop: { frames: 60, duration: 60, fps: [24, 30, 60] },
  mobile: { frames: 30, duration: 30, fps: [24, 30] }
};

// Star frames cost exactly what main frames cost (same size, same resident bitmap), so
// they are capped at HALF the frame count rather than by a flat number of their own
// (Aaron's call). Three reasons it's the right shape: it is already the relationship the
// rest of the code assumes -- getAnimTiming falls back to ceil(fc / 2), and the 20/10
// default IS frames/2; it scales with the frame count instead of staying wrong at the
// low end (10 frames used to allow 10 star frames, doubling that animation's memory for
// a star layer churning as fast as the artwork); and it bounds total resident bitmaps at
// 1.5x frames, which is what makes the per-device frame cap alone sufficient to reason
// about. Worst cases: mobile 30+15 = 356MB, desktop 60+30 = 2.85GB (was 3.8GB).
const maxStarFrames = frameCount => Math.max(1, Math.floor(frameCount / 2));
// Resolved once: the UA cannot change mid-session.
const ANIM_LIMIT = ANIM_LIMITS[isMobileDevice() ? 'mobile' : 'desktop'];

// Mobile 2D frames are RASTERIZED at this long edge instead of the studio's 2160. This is
// the fix that actually buys the headroom — capping counts alone would have meant a mobile
// ceiling BELOW today's default, making the setting decorative. The frame is still
// GENERATED at full studio size, so composition/density is untouched (element counts scale
// with canvas area — see render/scale.js); only the stored raster is smaller, which cuts
// each resident bitmap from 17.8MB to 8.3MB. 1440 rather than 1080 because mobile exports
// at up to 1080 on the short edge, and a 1080 source would then UPSCALE on the 9:16 crop.
const MOBILE_ANIM_RASTER = 1440;

// Homepage-hero parallax overscale. This single number sets how far the artwork can drift:
// the offset is capped at the (scale - 1) / 2 of container height the overscale hides on
// each side, so an edge can never slide into view no matter how the hero is sized. At 1.3
// that is 15% of the hero's height, spent evenly across the whole time the hero is leaving
// the viewport. See componentDidMount for the progress mapping.
const HERO_PARALLAX_SCALE = 1.3;

// MP4 export framing. Sizes are the desktop targets; mobile halves them (see
// exportAnimationVideo) because full 4K encoding needs ~500MB+ of GPU/RAM that iOS
// WebViews refuse. '16:9' is the historical export size, so leaving it selected keeps the
// old behaviour exactly.
//
// 3D renders natively at whichever ratio is picked — the scene is built at export size and
// the camera aspect follows, so portrait/square is a genuine recompose, not a crop. 2D
// CANNOT do that: its frames are pre-rendered stills baked at the studio's own resolution
// during Generate (a 30s+ build), so re-rendering 20-60 of them per export is not something
// a Download click can pay for. Those get a centered cover-crop instead — no distortion,
// but a 9:16 export off a 16:9 build keeps only the middle 31.6% of the width (measured).
const EXPORT_ASPECTS = {
  '16:9': [3840, 2160],
  '9:16': [2160, 3840],
  '1:1': [2160, 2160]
};

// Downscales a rendered animation frame to MOBILE_ANIM_RASTER on phones, preserving
// aspect. Returns the canvas itself on desktop, so that path is untouched.
function rasterizeAnimationFrame(canvas) {
  const longEdge = Math.max(canvas.width, canvas.height);
  if (!isMobileDevice() || longEdge <= MOBILE_ANIM_RASTER) return canvas;
  const scale = MOBILE_ANIM_RASTER / longEdge;
  const small = document.createElement('canvas');
  small.width = Math.round(canvas.width * scale);
  small.height = Math.round(canvas.height * scale);
  const ctx = small.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(canvas, 0, 0, small.width, small.height);
  return small;
}

// Centered source rect matching the destination's aspect, so a frame is cropped rather
// than stretched into a different shape. Returns the whole source when the aspects already
// match, which is what keeps the default 16:9 export byte-identical to before.
export function coverSourceRect(srcWidth, srcHeight, dstWidth, dstHeight) {
  const srcAspect = srcWidth / srcHeight;
  const dstAspect = dstWidth / dstHeight;
  if (Math.abs(srcAspect - dstAspect) < 1e-6) {
    return { sx: 0, sy: 0, sw: srcWidth, sh: srcHeight };
  }
  if (srcAspect > dstAspect) {
    const w = srcHeight * dstAspect;
    return { sx: (srcWidth - w) / 2, sy: 0, sw: w, sh: srcHeight };
  }
  const h = srcWidth / dstAspect;
  return { sx: 0, sy: (srcHeight - h) / 2, sw: srcWidth, sh: h };
}

export default class DisplayCanvas extends React.Component {
  constructor(props) {
    super(props);
    this.state = {
      generateDisabled: false,
      isLoading: false,
      isSaving: false,
      isSaved: false,
      controlsAreOpen: true,
      controlsBlurred: false,
      saveVisible: false,
      colors: [],
      linkCopied: false,
      linkCopyFailed: false,
      animationMode: false,
      animationFrames: [],
      animationStarFrames: [],
      animationProgress: 0,
      isExporting: false,
      exportProgress: 0,
      musicEnabled: false,
      audioExportSupported: true,
      frameCount: 20,
      // 5s, the stepper's own minimum (Aaron, 2026-08-12: it's what he reaches for). Nothing
      // downstream assumed 10 -- 3D still builds one lap of unique content (FLIGHT_SPEED x 5
      // is under MAX_CONTENT_LENGTH), the logo mark's two half-second windows still fit, and
      // a 5s export never reaches the bitrate cap, so it always encodes at full quality.
      cycleDuration: 5,
      starFrameCount: 10,
      // MP4 export framing/frame rate. Export-only (never part of a design, never saved),
      // and applied at export time, so changing either is instant and needs no rebuild.
      exportAspect: '16:9',
      exportFps: 24,
      // Speed ramp: playback-time warp (see utils/speedRamp) -- each loop accelerates
      // through its whole first half and decelerates through its whole second half, still
      // looping seamlessly. 3D nearly stops at the seam and peaks at 2.16x; 2D keeps a
      // 0.25x cruise and peaks at 1.9x (a still-frame crossfade reads as frozen, not slow,
      // at near-zero speed). Pure playback timing (frame content is untouched), so it
      // applies live in both modes with no frame rebuild / settingsDirty -- which is also
      // why defaulting it ON costs nothing: toggling it off is instant, no regeneration.
      speedRamp: true,
      // 3D animation mode: instead of crossfading pre-rendered 2D frames, fly a camera
      // through a real-time three.js star tunnel (src/animation3d/tunnelScene.js).
      // threeDDesign is the compact { seed, colors, settings } identity of the current 3D
      // scene -- deliberately the same shape as a 2D design, so save/load support can be
      // added later without a format change (saving is disabled in 3D mode for now).
      threeDMode: false,
      threeDDesign: null,
      // Admin-only (profiles.is_admin): stamp the design's own vectorclash mark onto the
      // animation's loop seam -- see utils/logoIntro.js for the motion. Like speedRamp this
      // is playback/export state, never part of the design: it changes no frame content, so
      // no settingsDirty, and it is not persisted on save.
      logoMark: false,
      animationPaused: false,
      settingsTab: 'color',
      animTiming: null,
      settingsDirty: false,
      geometrySettings: { ...DEFAULT_GEOMETRY_SETTINGS },
      // Which points-slider thumb was most recently grabbed -- the two thumbs are separate
      // native range inputs stacked on one track, so when their values sit close together
      // they visually overlap and only the higher-z-index one is hit-testable. Tracking the
      // last successful grab (set on pointerdown, before any drag) keeps repeated nearby
      // touches landing on the thumb the user is actually working with, instead of a fixed
      // rule that can leave one thumb permanently unreachable once they're close.
      pointsActiveThumb: null,
      galleryStatus: null,
      galleryError: null,
      // One-time notice: the first time a *loaded* design (isSaved was true) diverges via a
      // geometry setting change, tell the user editing branches a new design rather than
      // touching the one they opened -- see onGeometrySettingChange.
      showBranchNotice: false,
    };
    this.nextColorId = 0;
  }

  componentDidMount() {
    let queueItems = [
      { id: 'star-large', src: s1 },
      { id: 'star-small', src: s2 }
    ];

    this.queue = new window.createjs.LoadQueue(true, '');
    this.queue.on('complete', this.init, this);
    this.queue.loadManifest(queueItems);

    this.checkAudioExportSupport();

    // Compact (homepage hero) only: the artwork renders oversized (HERO_PARALLAX_SCALE)
    // and drifts downward as the hero scrolls up -- a parallax against the rest of the
    // homepage scrolling past. Transform only -- every GSAP tween on .image-container
    // animates alpha, so nothing fights this. rAF-throttled; skipped under
    // prefers-reduced-motion.
    //
    // The offset is driven by the hero's own EXIT PROGRESS rather than by a fixed fraction
    // of scrollTop, so the artwork keeps moving for the entire time any part of it is on
    // screen and lands on its full travel exactly as the section clears the viewport --
    // the earlier `min(scrollTop * 0.15, 6%)` form hit its ceiling less than half a
    // viewport in and then sat frozen for the rest of the scroll, which on a phone (where
    // the hero is most of what you see) read as the effect switching off. Total travel is
    // whatever the overscale can cover ((scale - 1) / 2 of the height per direction), so
    // an edge still never slides into view: raising the scale is what buys more movement.
    //
    // Progress is measured off this component's own root, NOT off .image-container -- the
    // latter is the element being translated, so reading its rect would feed the offset
    // back into its own input. (The root is `position: fixed` but Hero.jsx's
    // `contain: layout` makes the hero section its containing block, so it scrolls with
    // the section and its rect tracks the page normally.)
    if (this.props.compact && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      // Listens on the window: the document is the scroller site-wide (see tailwind.css).
      // This used to walk up to a `.overflow-y-auto` ancestor because HomePage kept its own
      // scroll viewport, which left window.scrollY pinned at 0 -- that is no longer true,
      // and the old lookup would now find nothing and silently attach no listener at all.
      //
      // Progress is driven by `window.scrollY` against geometry measured ONCE (and re-measured
      // on resize), not by re-reading the host's rect every frame. Two reasons, both real:
      // scrollY is exactly the value the user's finger controls, so it cannot disagree with
      // what the page is doing, whereas a rect measured mid-scroll can (that disagreement is
      // what made this jerk on iOS Safari); and a rect read inside a rAF forces a synchronous
      // layout on every scrolled frame, which is worth not doing on a phone.
      let raf = 0;
      let heroTop = 0;
      let heroHeight = 0;
      let maxTravel = 0;
      // Both heights are viewport-derived (`h-screen`, i.e. the LARGE viewport), so they do
      // not change as iOS Safari's toolbar retracts -- only on a real resize/rotation.
      //
      // Every measurement here has to be a REAL one, not merely non-zero -- and the whole
      // cache has to stay correctable, because ONE bad snapshot used to be permanent. Both
      // guards below were added 2026-08-11 after measuring the mount in WebKit: it runs
      // while layout is still settling, where the host already reports a height (534 of its
      // eventual 900) but the artwork layer inside it is still 0 tall. The old
      // `if (!rect.height) return false` accepted exactly that frame, cached `maxTravel: 0`
      // and a `heroTop` measured against a mid-layout position, and returned true -- so the
      // one retry below never fired and the parallax stayed inert, or wrongly anchored, for
      // the entire session. Chromium settles before the mount and never showed it, which is
      // why this reads as intermittent rather than broken.
      const measure = () => {
        const host = this.mount;
        const el = host && host.querySelector('.image-container');
        if (!el) return false;
        const rect = host.getBoundingClientRect();
        if (!rect.height || !el.clientHeight) return false;
        art = el;
        heroTop = rect.top + window.scrollY;
        heroHeight = rect.height;
        maxTravel = (el.clientHeight * (HERO_PARALLAX_SCALE - 1)) / 2;
        return true;
      };
      let art = null;
      // A full-screen overlay's scroll lock pins the body with `position: fixed`, which
      // makes the document report scroll 0 and shifts the hero's own rect by the saved
      // offset (see useScrollLock). Acting on either would slide the artwork by up to the
      // full travel and then slide it back on close -- visible through any overlay that
      // isn't fully opaque -- or cache a `heroTop` measured against the displaced body.
      // Both are suppressed for the duration, and the resume re-measures.
      let locked = false;
      const apply = () => {
        raf = 0;
        const el = art;
        if (!el || !heroHeight || locked) return;
        // 0 while the hero sits at the top of the viewport, 1 once its bottom edge has
        // passed the top of the viewport (i.e. it has fully left the screen).
        const progress = Math.max(0, Math.min(1, (window.scrollY - heroTop) / heroHeight));
        // Positive (downward) offset: the section scrolls up past the viewport while the
        // artwork inside it lags behind, i.e. the background moves slower than the page.
        el.style.transform = `translateY(${progress * maxTravel}px) scale(${HERO_PARALLAX_SCALE})`;
      };
      this.onHeroParallaxScroll = () => {
        if (!raf) raf = requestAnimationFrame(apply);
      };
      // The travel distance is a fraction of the hero's height, which is viewport-derived
      // (h-screen) -- so a rotation changes it with no scroll event to recompute it against.
      // Re-measuring is always followed by re-applying, so a correction lands immediately
      // rather than waiting for the user's next scroll to reveal it.
      this.onHeroParallaxResize = () => {
        if (locked) return;
        measure();
        this.onHeroParallaxScroll();
      };
      this.unsubscribeHeroParallaxLock = subscribeScrollLock(isLocked => {
        locked = isLocked;
        if (!isLocked) this.onHeroParallaxResize();
      });
      window.addEventListener('scroll', this.onHeroParallaxScroll, { passive: true });
      window.addEventListener('resize', this.onHeroParallaxResize, { passive: true });
      // A ResizeObserver rather than a single mount-time snapshot plus one rAF retry: it
      // fires an initial observation immediately (covering the normal case), fires again
      // whenever the layout that these numbers are derived from actually changes (covering
      // the settling case above, however many frames it takes), and needs no guess about
      // when "settled" is. Both boxes are observed because they can arrive at their real
      // size on different frames -- the WebKit mount measured the host at a partial height
      // while the artwork layer was still 0 tall, so watching either one alone can miss the
      // frame that makes the other correct.
      this.heroParallaxObserver = new ResizeObserver(this.onHeroParallaxResize);
      this.heroParallaxObserver.observe(this.mount);
      const artLayer = this.mount && this.mount.querySelector('.image-container');
      if (artLayer) this.heroParallaxObserver.observe(artLayer);
      this.onHeroParallaxResize();
    }
  }

  componentWillUnmount() {
    if (this.boundOnKeyUp) window.removeEventListener('keyup', this.boundOnKeyUp);
    if (this.onHeroParallaxScroll) {
      window.removeEventListener('scroll', this.onHeroParallaxScroll);
      window.removeEventListener('resize', this.onHeroParallaxResize);
      this.heroParallaxObserver?.disconnect();
      this.unsubscribeHeroParallaxLock?.();
    }
    clearTimeout(this.geometryRegenTimer);
    clearTimeout(this.threeDColorTimer);
  }

  componentDidUpdate(prevProps) {
    if (
      this.props.initialDesign &&
      this.props.initialDesign !== prevProps.initialDesign &&
      this.props.initialDesign !== this.mainConfig
    ) {
      // The design being handed off may already be saved (e.g. saved once via the
      // mini-generator widget, then opened into the Studio from its thumbnail) -- StudioPage
      // passes StudioContext's own isCurrentDesignSaved/savedDesignId fact down as
      // isDesignSaved/savedDesignId so this continuity path doesn't have to guess "false"
      // and produce a duplicate save. See init()'s initialDesign branch below for the same
      // logic and the bug this fixes.
      const alreadySaved = !!this.props.isDesignSaved;
      this.shareUrl = alreadySaved && this.props.savedDesignId ? buildShareUrl(this.props.savedDesignId) : null;
      this.shareDesignId = alreadySaved && this.props.savedDesignId ? this.props.savedDesignId : null;
      // Unlike init()'s own initialDesign branch (first mount -- nothing on screen yet to
      // fade), this path replaces an image that's already showing at full opacity. Without
      // this fade-out (which onGenerateButtonClick's own Generate click already does), the
      // hexagon loader spun over the OLD, still fully-opaque artwork, and the swap to the
      // new one at the end was a hard pop -- there was nothing for setImage's later
      // gsap.to(alpha: 1) to visibly fade FROM, since alpha never left 1. This is why
      // generating from the mini-generator widget while the hero was still on screen never
      // looked like it animated, even though the hero's data (seed/colors) genuinely updated.
      gsap.to('.image-container', { duration: DURATION_FAST, alpha: 0, ease: 'power2.inOut' });
      this.setState({ isLoading: true, generateDisabled: true, isSaved: alreadySaved, showBranchNotice: false });
      this.adoptDesignSettings(this.props.initialDesign.settings);
      this.adoptDesignColors(this.props.initialDesign.colors);
      const built = this.buildConfig(
        this.props.initialDesign.seed,
        this.props.width,
        this.props.height,
        this.props.initialDesign.colors,
        this.props.initialDesign.settings ?? null
      );
      this.buildImage(built);
    }
  }

  async checkAudioExportSupport() {
    // No user-agent gating: Safari 26+ (iOS 26, fall 2025) ships WebCodecs AudioEncoder,
    // so a hard iOS block would turn away capable devices. Pure feature detection —
    // older iOS simply has no AudioEncoder and falls through to unsupported.
    if (typeof AudioEncoder === 'undefined' || typeof AudioData === 'undefined') {
      this.setState({ audioExportSupported: false });
      return;
    }
    const candidates = [
      { codec: 'mp4a.40.2', sampleRate: 44100 },
      { codec: 'opus',       sampleRate: 48000 },
    ];
    for (const c of candidates) {
      const { supported } = await AudioEncoder.isConfigSupported({
        codec: c.codec, numberOfChannels: 2, sampleRate: c.sampleRate, bitrate: 128_000,
      }).catch(() => ({ supported: false }));
      if (supported) return;
    }
    this.setState({ audioExportSupported: false, musicEnabled: false });
  }

  init() {
    // Compact mode doesn't render .controls-open (the legacy reopen icon) at all.
    if (!this.props.compact) {
      gsap.to('.controls-open', { opacity: 1, duration: DURATION_BASE, delay: 0.2 });
    }

    const designId = getDesignIdFromUrl();
    if (designId) {
      this.setState({ isLoading: true, generateDisabled: true });
      getDesign(designId)
        .then(row => {
          this.shareUrl = buildShareUrl(designId);
          this.shareDesignId = designId;
          const config = row.data;
          if (config.animation && config.frames) {
            this.setState({
              animationMode: true,
              isSaved: true,
              generateDisabled: true,
              animationProgress: 0
            });
            // All frames of one animation share their generation settings and palette
            // (they're built in a single session with the sliders/colors in one position),
            // so the first frame's are the animation's.
            this.adoptDesignSettings(config.frames[0]?.settings);
            this.adoptDesignColors(config.frames[0]?.colors);
            this.loadAnimationFromConfigs(config.frames);
          } else {
            this.loadImageFromUrl(config);
          }
        })
        .catch(err => {
          // A dead link (deleted design, mistyped id) shouldn't strand the user on a
          // permanent loading state -- fall back to a fresh random design, same as
          // visiting /studio with no query param at all. onGenerateButtonClick no-ops
          // unless generateDisabled is currently false (it assumes it's firing from an
          // idle state, e.g. a real click), so the generateDisabled: true set above --
          // needed to show a loading state while the fetch was in flight -- has to be
          // cleared first or this fallback silently does nothing and leaves the loading
          // state stuck forever. Confirmed live: without this reset, a dead id hung on
          // "Generating" indefinitely.
          console.error('Failed to load shared design:', err);
          this.setState({ generateDisabled: false }, () => this.onGenerateButtonClick());
        });
    } else if (this.props.initialDesign) {
      // Continuity with whatever's already "active" (e.g. the homepage hero's showcase,
      // via StudioContext.currentDesign) -- render that exact design instead of a fresh
      // random one, so expanding into the full tool doesn't swap the artwork out from
      // under the user. Same seed + colors is a pure function (generateArtwork), so this
      // reproduces it pixel-for-pixel rather than approximating it.
      // Same already-saved check as componentDidUpdate's initialDesign branch above -- this
      // is the path taken on a fresh /studio mount (e.g. navigating in from the
      // mini-generator's thumbnail), whereas componentDidUpdate handles it changing while
      // already mounted. Real bug this fixes: hardcoding isSaved: false here meant a design
      // already saved via the mini-generator showed "Save" (not "Saved") once opened into
      // the Studio, and clicking it inserted a duplicate row.
      const alreadySaved = !!this.props.isDesignSaved;
      this.shareUrl = alreadySaved && this.props.savedDesignId ? buildShareUrl(this.props.savedDesignId) : null;
      this.shareDesignId = alreadySaved && this.props.savedDesignId ? this.props.savedDesignId : null;
      this.setState({ isLoading: true, generateDisabled: true, isSaved: alreadySaved, showBranchNotice: false });
      this.adoptDesignSettings(this.props.initialDesign.settings);
      this.adoptDesignColors(this.props.initialDesign.colors);
      const built = this.buildConfig(
        this.props.initialDesign.seed,
        this.props.width,
        this.props.height,
        this.props.initialDesign.colors,
        this.props.initialDesign.settings ?? null
      );
      this.buildImage(built);
    } else {
      this.onGenerateButtonClick();
    }

    this.boundOnKeyUp = this.onKeyUp.bind(this);
    window.addEventListener('keyup', this.boundOnKeyUp);
  }

  // Derives all animation timing constants from the two top-level settings.
  // starCount is always ceil(frameCount/2) so both layers share the same period.
  // Spacing ratios are preserved from the original design at any frameCount/duration.
  getAnimTiming(frameCount = null) {
    const { cycleDuration, starFrameCount } = this.state;
    const fc = frameCount ?? this.state.frameCount;
    const starCount = starFrameCount ?? Math.max(1, Math.ceil(fc / 2));
    const spacing = cycleDuration / fc;
    const fade = spacing * (5.0 / 3.5);
    const starSpacing = cycleDuration / starCount;
    const starFade = starSpacing * (8.0 / 7.0);
    return { frameCount: fc, starCount, spacing, fade, starSpacing, starFade, cycleDuration };
  }

  // The admin logo mark, re-gated at the point of use rather than trusted from state alone:
  // the toggle lives behind an isAdmin-only tab, but the state outlives a sign-out, so this
  // is what actually keeps it out of a non-admin's preview and export.
  logoMarkConfig() {
    if (!this.props.isAdmin || !this.state.logoMark) return null;
    // Which seed is "this generation" differs per mode. 3D has one scene and one seed. A 2D
    // animation is N independently seeded frames, so it takes the FIRST frame's -- the same
    // rule the rest of the project already uses for an animation's identity (see
    // backfill-thumbnails.mjs, which reads an animation row's generatorVersion off frame 1).
    const design = this.state.threeDMode
      ? this.state.threeDDesign
      : this.animationConfigs?.[0] ?? this.mainConfig;
    if (!design?.seed) return null;
    // The palette the mark's accent spins from has to be the one the animation ACTUALLY
    // renders with, and `design.colors` is not that -- it's the stored identity, empty for
    // every auto-palette design, which sent the accent to generateLabelMark's fallback
    // (#ccff00) and made the mark come out yellow-green on most designs. 3D resolves it the
    // way the scene itself does (a fresh `-3d` stream lands on the same palette without
    // touching the scene's); 2D reads the artwork's own resolved gradient stops.
    const palette = this.state.threeDMode
      ? resolveScenePalette(makeRng(`${design.seed}-3d`), design.colors || [])
      : resolvedPalette(design);
    // Memoized because render() calls this every pass and the result is a prop: a fresh object
    // each time would retrigger AnimationPreview's effect (and rebuild its whole GSAP
    // timeline) on every unrelated state change. Keyed on the palette too, not the seed alone
    // -- 3D applies palette edits live against an unchanged seed.
    const key = `${design.seed}|${palette.join(',')}`;
    if (this._logoMarkSeed !== key) {
      this._logoMarkSeed = key;
      this._logoMark = generateLogoMark(design, { palette });
    }
    return this._logoMark;
  }

  // Whether the picked export ratio differs from the one the 2D frames were baked at (the
  // studio canvas: 16:9 on desktop, 1:1 on mobile) — i.e. whether exporting will crop them.
  // 3D is never cropped; it re-renders at the export size.
  exportWillCrop() {
    const [w, h] = EXPORT_ASPECTS[this.state.exportAspect] ?? EXPORT_ASPECTS['16:9'];
    return Math.abs(w / h - this.props.width / this.props.height) > 1e-6;
  }

  // The compact identity of a fresh 3D scene: seed + the current palette + the current
  // geometry sliders. Building the actual three.js scene from this is Animation3DPreview's
  // job (and exportAnimationVideo's, at export resolution) -- this is cheap and synchronous,
  // unlike the 30s+ 2D frame build.
  buildThreeDDesign(seed = randomSeed()) {
    return {
      seed,
      colors: this.state.colors.map(c => c.value || c),
      settings: { geometry: this.state.geometrySettings }
    };
  }

  // The 3D toggle in the Video settings tab. Turning it on swaps the preview to a 3D
  // scene immediately (generating one is instant -- no frame build); the 2D frames stay
  // in state untouched, so turning it back off restores them as-is. If 3D was on when
  // animation mode was first entered (so no frames were ever built), toggling it off
  // kicks off the normal 2D frame build.
  onThreeDToggle() {
    const { threeDMode, animationMode, threeDDesign, animationFrames, isExporting } = this.state;
    if (isExporting) return;
    if (!threeDMode) {
      this.setState({
        threeDMode: true,
        threeDDesign: animationMode && !threeDDesign ? this.buildThreeDDesign() : threeDDesign,
        isSaved: false,
        animationPaused: false
      });
    } else {
      this.setState({ threeDMode: false }, () => {
        if (animationMode && animationFrames.length === 0 && !this.state.generateDisabled) {
          this.onGenerateButtonClick();
        }
      });
    }
  }

  // Thin wrapper over the pure generateArtwork() orchestrator. Defaults to a fresh seed
  // at the live on-screen size with the current UI palette + geometry sliders; pass
  // explicit args to regenerate a stored design at any size (e.g. portrait print)
  // deterministically. `settings` distinguishes "not given" (undefined -> use the live
  // slider state) from "this design has none" (null -> generator defaults) -- load paths
  // pass the stored design's own settings so a loaded design never picks up whatever the
  // sliders happen to be set to.
  buildConfig(
    seed = randomSeed(),
    width = this.props.width,
    height = this.props.height,
    colorValues = null,
    settings = undefined
  ) {
    if (!colorValues) {
      colorValues = this.state.colors.map(c => c.value || c);
    }
    if (settings === undefined) {
      settings = { geometry: this.state.geometrySettings };
    }
    const config = generateArtwork(seed, width, height, colorValues, settings);
    this.mainConfig = config;
    // Mirror the current design into StudioContext (via StudioPage) so store routes can
    // render mockups of it without the canvas being mounted. No-op when rendered outside
    // the router (defensive).
    this.props.onDesignChange?.(config);
    return config;
  }

  buildImage(config) {
    this.setState({
      generateDisabled: true,
      linkCopied: false
    });

    // change buttons to match backgroundImage
    this.changeGradient(config.gradientBackgroundConfig.colors);

    const canvas = renderArtwork(config, this.queue);
    canvas.toBlob(this.setImage.bind(this), 'image/jpeg', 0.98);
    this.clearElement(canvas);
  }

  clearElement(element) {
    element.width = 0;
    element.height = 0;
    element = null;
  }

  async buildImageAsBlob(config) {
    // Yield once before the synchronous composite so the loader stays responsive
    // between animation frames (the per-frame breathe() in the callers spaces them out).
    await new Promise(r => setTimeout(r, 0));

    const canvas = renderArtwork(config, this.queue);
    // Generated at full studio size (density depends on canvas area), stored smaller on
    // phones — see MOBILE_ANIM_RASTER. `out === canvas` on desktop.
    const out = rasterizeAnimationFrame(canvas);

    return new Promise(resolve => {
      out.toBlob(blob => {
        if (out !== canvas) this.clearElement(out);
        this.clearElement(canvas);
        resolve(URL.createObjectURL(blob));
      }, 'image/jpeg', 0.98);
    });
  }

  // Builds a star-only frame as a transparent PNG — stars composite naturally
  // over whatever gradient frame is showing without any blend mode tricks.
  buildStarOnlyBlob(starFieldConfig) {
    return new Promise(resolve => {
      let canvas = document.createElement('canvas');
      let context = canvas.getContext('2d');
      canvas.width = this.props.width;
      canvas.height = this.props.height;

      let starField = StarField(starFieldConfig, this.queue);
      context.drawImage(starField, 0, 0);

      // Same treatment as the main frames: full-size generation, phone-sized raster.
      const out = rasterizeAnimationFrame(canvas);

      out.toBlob(blob => {
        if (out !== canvas) this.clearElement(out);
        this.clearElement(canvas);
        resolve(URL.createObjectURL(blob));
      }, 'image/png');
    });
  }

  async buildAnimationFrames() {
    const { frameCount, starCount } = this.getAnimTiming();
    const frames = [];
    const starFrames = [];
    this.animationConfigs = [];

    const breathe = () => new Promise(r => setTimeout(r, 100));

    // Initial pause so the loader animation has time to settle before heavy work starts
    await breathe();

    for (let i = 0; i < frameCount; i++) {
      const config = this.buildConfig();
      this.animationConfigs.push(config);
      const blobUrl = await this.buildImageAsBlob(config);
      frames.push(blobUrl);
      this.setState({ animationProgress: i + 1 });
      if (i < frameCount - 1) await breathe();
    }

    this.changeGradient(this.mainConfig.gradientBackgroundConfig.colors);

    // Generate star-only overlay frames using the animation's colour palette.
    // Each one gets a freshly randomised star layout for variety.
    const colorValues = this.mainConfig.gradientBackgroundConfig.colors.slice();
    for (let i = 0; i < starCount; i++) {
      await breathe();
      // backgroundHue/sizeFrame stay at their defaults here (these overlay frames aren't
      // tied to a placement, and the hue bias only applies to an empty palette anyway), but
      // the background lightness is passed for real -- it's what decides whether the stars
      // are driven light or dark to contrast, so leaving it at the 0.5 default would give
      // these frames a different star treatment than the main frames they overlay.
      const starConfig = new GenerateStarField(
        this.props.width,
        this.props.height,
        colorValues.slice(),
        Math.random,
        null,
        null,
        meanLuminance(colorValues)
      );
      const blobUrl = await this.buildStarOnlyBlob(starConfig);
      starFrames.push(blobUrl);
    }

    this.setState({
      animationFrames: frames,
      animationStarFrames: starFrames,
      generateDisabled: false,
      isLoading: false,
      animTiming: this.getAnimTiming(),
      settingsDirty: false,
    });
  }

  async loadAnimationFromConfigs(configs) {
    // `configs` from a share link / gallery row are each the compact { seed, colors } form --
    // regenerate every frame's full composition before rendering, same as loadImageFromUrl.
    // this.animationConfigs holds fully-resolved configs everywhere else (buildAnimationFrames,
    // onModeToggle's snapshot/restore), so resolving here keeps that invariant.
    const resolvedConfigs = configs.map(c =>
      generateArtwork(c.seed, this.props.width, this.props.height, c.colors, c.settings ?? null)
    );
    this.animationConfigs = resolvedConfigs;
    const frames = [];
    const starFrames = [];

    const breathe = () => new Promise(r => setTimeout(r, 700));

    await breathe();

    for (let i = 0; i < resolvedConfigs.length; i++) {
      const blobUrl = await this.buildImageAsBlob(resolvedConfigs[i]);
      frames.push(blobUrl);
      this.setState({ animationProgress: i + 1 });
      if (i < resolvedConfigs.length - 1) await breathe();
    }

    this.changeGradient(resolvedConfigs[resolvedConfigs.length - 1].gradientBackgroundConfig.colors);

    const { starCount } = this.getAnimTiming(resolvedConfigs.length);
    const colorValues = resolvedConfigs[0].gradientBackgroundConfig.colors.slice();
    for (let i = 0; i < starCount; i++) {
      await breathe();
      // backgroundHue/sizeFrame stay at their defaults here (these overlay frames aren't
      // tied to a placement, and the hue bias only applies to an empty palette anyway), but
      // the background lightness is passed for real -- it's what decides whether the stars
      // are driven light or dark to contrast, so leaving it at the 0.5 default would give
      // these frames a different star treatment than the main frames they overlay.
      const starConfig = new GenerateStarField(
        this.props.width,
        this.props.height,
        colorValues.slice(),
        Math.random,
        null,
        null,
        meanLuminance(colorValues)
      );
      const blobUrl = await this.buildStarOnlyBlob(starConfig);
      starFrames.push(blobUrl);
    }

    this.setState({
      animationFrames: frames,
      animationStarFrames: starFrames,
      generateDisabled: false,
      isLoading: false,
      animTiming: this.getAnimTiming(resolvedConfigs.length),
      settingsDirty: false,
    });
  }

  changeGradient(colors) {
    let buttonGradient =
      'linear-gradient(42deg, ' + colors[0] + ', ' + colors[colors.length - 1] + ')';
    let buttonColor;

    if (tinycolor(colors[0]).isLight() && tinycolor(colors[colors.length - 1]).isLight()) {
      buttonColor = '#333333';
    } else {
      buttonColor = '#FAFAFA';
    }

    gsap.set('.button-large, .text-container', {
      backgroundImage: buttonGradient,
      color: buttonColor
    });

    let borderColor = colors[Math.floor(Math.random() * colors.length)];

    gsap.set('.button-small, .button-medium,  input', {
      borderColor: borderColor
    });
  }

  // Persist the design to the signed-in user's gallery -- the primary save action. Silently
  // no-ops when signed out -- there's no longer a share link available for an unsaved design
  // at all (see utils/urlConfig.js), only Download. Delegates the actual save + thumbnail
  // upload to StudioContext.saveCurrentDesign (passed down by StudioPage), shared with the
  // mini-generator widget's Save button.
  async saveToGallery(kind, data) {
    if (!this.props.user) return;

    this.setState({ galleryStatus: 'saving', galleryError: null });
    try {
      const row = await this.props.saveCurrentDesign(kind, data);
      // isSaved/shareUrl flip together, only once the real row (and therefore a real,
      // permanent id to link to) exists -- see onSaveButtonClick's own comment.
      this.shareUrl = buildShareUrl(row.id);
      this.shareDesignId = row.id;
      this.setState({ galleryStatus: 'saved', isSaved: true });
      // Pulse the confirmation in, and type the id onto the share-link box's already-visible
      // prefix, once React has actually rendered both -- same "delayedCall after setState"
      // pattern used elsewhere in this file for exactly this (querying a class name
      // immediately after setState can run before the DOM update it targets exists, since
      // setState doesn't re-render synchronously). The confirmation element itself has a
      // static opacity-0 class in the JSX below so it's already invisible the instant React
      // mounts it -- without that, this 50ms delay meant the confirmation was fully visible
      // first, then this fromTo yanked it to invisible before animating back in (a real,
      // visible flash/flicker, confirmed by sampling computed opacity frame-by-frame).
      // No panel-height animation needed alongside this -- the JSX below always reserves
      // the confirmation block's full height from the very first 'saving' frame (see its
      // own comment), so the panel never needs to resize across this transition at all;
      // an earlier version tried to smooth that resize instead of avoiding it and never
      // quite lost a residual pop no matter how its timing/easing was tuned.
      //
      // The confirmation itself now transitions via GSAP's TextPlugin (same mechanism as
      // ProductPage.jsx's mockup status narration and the share-link box below) rather than
      // a crossfade between two blocks: the title + subtitle "type" from their 'saving'
      // copy to their 'saved' copy in place, and the check draws + pops in after the title
      // lands. The animated spans render their 'saving' text statically in the JSX so
      // React never overwrites what these tweens type on. The id likewise types onto the
      // .share-link-id span (rendered with no text child, so its empty-while-saving
      // textContent is what that tween types from).
      const savedSubline = this.state.animationMode
        ? 'Your animation is in your gallery — view it any time.'
        : 'Your design is in your gallery — view it any time or put it on a product.';
      gsap.delayedCall(0.05, () => {
        gsap.to('.gallery-status-title', {
          duration: 0.5,
          ease: 'none',
          text: 'Saved to your gallery'
        });
        gsap.to('.gallery-status-sub', {
          duration: 0.6,
          ease: 'none',
          text: savedSubline
        });
        // Check: draw its stroke + pop its scale in, landing just as the title finishes
        // typing. autoAlpha/scale/rotate is GSAP's; the JSX starts it at opacity 0.
        const check = this.mount?.querySelector?.('.gallery-saved-check');
        const checkPath = check?.querySelector('path');
        if (check) {
          gsap.fromTo(
            check,
            { autoAlpha: 0, scale: 0, rotate: -25 },
            { autoAlpha: 1, scale: 1, rotate: 0, duration: 0.4, ease: 'back.out(2.5)', delay: 0.4 }
          );
        }
        if (checkPath) {
          const len = checkPath.getTotalLength();
          gsap.fromTo(
            checkPath,
            { strokeDasharray: len, strokeDashoffset: len },
            { strokeDashoffset: 0, duration: 0.32, ease: 'power2.out', delay: 0.46 }
          );
        }
        gsap.to('.share-link-id', { duration: 1, ease: 'none', text: this.shareDesignId });
      });
    } catch (err) {
      this.setState({ galleryStatus: null, galleryError: err.message });
    }
  }

  loadImageFromUrl(config) {
    this.setState({
      isLoading: true,
      isSaved: true
    });

    gsap.to('.image-container', {
      duration: DURATION_FAST,
      alpha: 0,
      ease: 'power2.inOut'
    });

    // `config` from a share link / gallery row is the compact { seed, colors, settings? }
    // form -- buildConfig regenerates the full composition (and sets this.mainConfig)
    // before we render it, same as the `initialDesign` continuity path in init().
    this.adoptDesignSettings(config.settings);
    this.adoptDesignColors(config.colors);
    const built = this.buildConfig(
      config.seed,
      this.props.width,
      this.props.height,
      config.colors,
      config.settings ?? null
    );
    this.buildImage(built);
  }

  // Sync the geometry sliders to a loaded design's stored settings (or back to defaults
  // when it has none), so a Generate right after loading produces work in the same style
  // the user is looking at -- without this, loading a coherent-geometry design would show
  // it correctly (buildConfig gets the stored settings explicitly) but leave the sliders,
  // and therefore the next Generate, wherever they last were.
  adoptDesignSettings(settings) {
    this.setState({ geometrySettings: getGeometrySettings(settings) });
  }

  // Sync the color swatch panel to a loaded design's actual palette (or clear it, for an
  // auto-palette design) -- the missing color counterpart to adoptDesignSettings above.
  // Without this, buildConfig still renders the artwork with the right colors (it's given
  // them explicitly), but state.colors -- what the swatch panel actually reads -- stays
  // whatever this fresh mount's constructor defaulted it to ([]), so the panel looked
  // "reset" on every load path (a share/gallery link, or navigating home and back to the
  // Studio) even though the artwork itself never changed.
  adoptDesignColors(colors) {
    this.setState({
      colors: (colors || []).map(value => ({ id: this.nextColorId++, value }))
    });
  }

  setImage(blob) {
    this.blob = blob;
    let url = URL.createObjectURL(blob);
    this.imageBlobUrl = url;
    let imageLoader = document.createElement('img');
    imageLoader.src = url;

    imageLoader.addEventListener('load', () => {
      gsap.delayedCall(DURATION_HOLD, () => {
        let imageContainer = document.querySelector('.image-container');
        // This delayed call isn't cancelled on unmount, so it can still fire after the
        // route has changed away from whatever page mounted this DisplayCanvas (e.g. a
        // password-recovery link redirecting straight to /account) -- guard the same way
        // '#controls-main' already is a few lines below.
        if (!imageContainer) return;
        imageContainer.style.backgroundImage = 'url(' + url + ')';

        // Animate backdrop-filter from 0 alongside the image fade. Because GSAP updates
        // the inline value every frame, iOS re-composites each frame rather than caching
        // a stale snapshot — so we can run both animations in parallel safely.
        // Compact (homepage hero) has no glass panel at all (.controls-compact) -- animating
        // an inline backdrop-filter onto it painted a visible blur/brightness rectangle
        // over the artwork for the duration of the tween, a ghost of the removed glass.
        const panel = this.props.compact ? null : document.querySelector('#controls-main');
        if (panel) {
          const { blur: cssBlur, brightness: cssBrightness } = this.readBackdropValues(panel);
          panel.style.backdropFilter = 'none';
          const f = { blur: 0, brightness: 1 };
          gsap.to(f, {
            blur: cssBlur, brightness: cssBrightness,
            duration: DURATION_SLOW,
            ease: 'power2.inOut',
            onUpdate: () => { panel.style.backdropFilter = `blur(${f.blur}px) brightness(${f.brightness})`; },
            onComplete: () => { panel.style.backdropFilter = ''; }
          });
        }

        // The compact Save button (.controls-compact .button-small) carries its own
        // permanent backdrop-filter (components.css) -- unlike the panel above, which has
        // none in compact mode, so this one has no "ghost of removed glass" risk. Same iOS
        // staleness bug as the panel though: it needs a per-frame inline write to force a
        // recomposite once the artwork behind it changes, or it stays dark until the next
        // scroll. Only the panel is skipped for compact; this button still needs the nudge.
        const saveBtn = this.props.compact ? document.querySelector('.controls-compact .button-small') : null;
        if (saveBtn) {
          saveBtn.style.backdropFilter = 'none';
          const b = { blur: 0 };
          gsap.to(b, {
            blur: 4,
            duration: DURATION_SLOW,
            ease: 'power2.inOut',
            onUpdate: () => { saveBtn.style.backdropFilter = `blur(${b.blur}px)`; },
            onComplete: () => { saveBtn.style.backdropFilter = ''; }
          });
        }

        gsap.to('.image-container', {
          duration: DURATION_SLOW,
          alpha: 1,
          ease: 'power2.inOut'
        });

        this.setState({
          generateDisabled: false,
          isLoading: false,
        });
      });
    });
  }

  animateSettingsTab() {
    gsap.set('#controls-settings .color-container', { opacity: 1 });
    const els = '#controls-settings .settings-field, #controls-settings .row';
    // The entrance starts every row 20px low, and a transform still counts toward a scroll
    // container's scrollable overflow -- so .settings-scroll briefly gains 20px it doesn't
    // have at rest and flashes a scrollbar on every tab switch, at ANY viewport size, not
    // just the short ones that genuinely scroll. Locking overflow for the duration costs
    // nothing: a list that is still flying in isn't scrollable in any useful sense. Set on
    // entry as well as cleared onComplete, so a tween interrupted by a fast second tab
    // switch can't strand the scroller hidden.
    const scroller = this.mount?.querySelector('#controls-settings .settings-scroll');
    if (scroller) scroller.style.overflowY = 'hidden';
    gsap.set(els, { alpha: 0, y: 20 });
    gsap.to(els, {
      duration: DURATION_BASE,
      alpha: 1,
      y: 0,
      stagger: 0.06,
      ease: 'back.out(1.7)',
      onComplete: () => {
        if (scroller) scroller.style.overflowY = '';
      }
    });
  }

  animateColors() {
    if (this.state.colors.length > 0) {
      gsap.fromTo(
        '.color-container',
        {
          y: -10,
          alpha: 0
        },
        {
          duration: DURATION_FAST,
          y: 0,
          alpha: 1,
          stagger: 0.02,
          ease: 'back.out(1.7)'
        }
      );
    }
  }

  updateColors() {
    let colorFields = document.querySelectorAll('.color');
    let colors = this.state.colors.map((colorObj, index) => ({
      ...colorObj,
      value: colorFields[index] ? colorFields[index].value : colorObj.value
    }));

    this.setState({
      colors: colors
    });
  }

  openSavePanel() {
    gsap.to('#controls-main', {
      duration: DURATION_FAST,
      alpha: 0.5,
      scale: 0.9,
      filter: 'blur(3px)',
      ease: 'back.out(1.7)'
    });

    gsap.from('#controls-save', {
      duration: DURATION_FAST,
      alpha: 0,
      scale: 1.2,
      ease: 'back.out(1.7)'
    });

    this.setState({
      saveVisible: true
    });
  }

  wiggleLoadField() {
    gsap.to('input', {
      duration: 0.1,
      scaleX: 1.2,
      scaleY: 1.4,
      rotation: -0.5 + Math.random() * 1,
      skewY: -5 + Math.random() * 10,
      ease: 'bounce.out'
    });

    gsap.to('input', {
      duration: 0.1,
      scale: 1,
      rotation: 0,
      skewY: 0,
      ease: 'bounce.out',
      delay: 0.1
    });
  }

  // event handlers

  onLoadButtonClick(e) {
    // This function is no longer used since we load from URL automatically
    // Keeping it for potential future use
  }

  onSaveButtonClick(e) {
    const { isSaving, isSaved, animationMode } = this.state;

    // 3D animations can't be saved yet (deferred -- the { seed, colors, settings } design
    // is save-shaped, but the gallery/share load paths don't know how to replay it).
    if (animationMode && this.state.threeDMode) return;

    if (isSaved) {
      // isSaved is only ever set true alongside this.shareUrl -- once by init()'s
      // getDesign() load, once by saveToGallery()'s own success handler below -- so there's
      // no "isSaved but no shareUrl yet" case left to patch over here.
      this.openSavePanel();
      return;
    }

    const kind = animationMode ? 'animation' : 'image';
    const data = animationMode
      ? { animation: true, frames: this.animationConfigs.map(toCompactDesign) }
      : toCompactDesign(this.mainConfig);
    const ready = animationMode
      ? this.animationConfigs && this.animationConfigs.length > 0
      : !!this.mainConfig;
    if (!ready || isSaving) return;

    // The gallery (DB) save is now the only source of a share link -- unlike the old
    // generateShareUrl approach, there's no data to eagerly encode client-side anymore, so
    // isSaved/shareUrl can't flip true until saveToGallery's real row comes back. The panel
    // still opens immediately (openSavePanel, below) showing its own "Saving…" state
    // (galleryStatus) in the meantime -- see the share-link box's isSaved gate in the JSX,
    // which naturally covers this in-flight moment the same way it covers signed-out users.
    this.setState({ showBranchNotice: false });
    this.openSavePanel();
    this.saveToGallery(kind, data); // no-ops when signed out
  }

  onDownloadButtonClick(e) {
    const { animationMode, animationFrames, isExporting, threeDMode, threeDDesign } = this.state;

    if (animationMode) {
      const ready = threeDMode ? !!threeDDesign : animationFrames.length > 0;
      if (ready && !isExporting) {
        this.exportAnimationVideo();
      }
    } else if (this.blob) {
      const filename = FileName();
      saveAs(this.blob, filename + '.jpg');
    }
  }

  async exportAnimationVideo() {
    // WebCodecs (VideoEncoder / VideoFrame) is required for MP4 export.
    // It is unavailable in all iOS browsers on iOS < 17.4, and in Firefox on iOS
    // (which is WebKit-based and shares Safari's feature set).
    if (typeof VideoEncoder === 'undefined' || typeof VideoFrame === 'undefined') {
      alert('MP4 export requires WebCodecs, which is not supported in this browser.\n\nTry Chrome or Edge on a desktop/laptop to export MP4.');
      return;
    }

    const { animationFrames, animationStarFrames, threeDMode, threeDDesign, speedRamp } = this.state;
    const is3D = threeDMode && !!threeDDesign;
    this.setState({ isExporting: true, exportProgress: 0 });

    const loadImg = src => new Promise(resolve => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.src = src;
    });

    // 3D mode has no pre-rendered frames -- the scene renders live per exported frame.
    const [images, starImages] = is3D
      ? [[], []]
      : await Promise.all([
          Promise.all(animationFrames.map(loadImg)),
          Promise.all(animationStarFrames.map(loadImg)),
        ]);

    const isMobile = isMobileDevice();

    // Export framing comes from the picker, not from the studio canvas, so the same
    // design exports identically from any screen. Mobile halves it to stay within iOS
    // memory limits (full 4K encoding needs ~500MB+ of GPU/RAM which iOS WebViews don't
    // allow) — halving rather than the old flat 1080x1080 so the CHOSEN ratio survives.
    const [aspectWidth, aspectHeight] = EXPORT_ASPECTS[this.state.exportAspect] ?? EXPORT_ASPECTS['16:9'];
    const width = isMobile ? aspectWidth / 2 : aspectWidth;
    const height = isMobile ? aspectHeight / 2 : aspectHeight;

    const { spacing: SPACING, fade: FADE, starSpacing: STAR_SPACING, starFade: STAR_FADE, cycleDuration: CYCLE_DURATION } =
      this.getAnimTiming(is3D ? this.state.frameCount : images.length);
    const SCALE_END = 1.45;
    const TOTAL_VISIBLE = 2 * FADE;
    const STAR_SCALE_END = 1.15;
    const STAR_TOTAL_VISIBLE = 2 * STAR_FADE;
    const PERIOD = CYCLE_DURATION;
    // Export exactly one cycle, starting one period in so start and end states are identical
    const OFFSET = PERIOD;
    // Validated against the DEVICE's list, not the full one: a phone must not encode 60fps
    // just because the value survived from somewhere else.
    const FPS = ANIM_LIMIT.fps.includes(this.state.exportFps) ? this.state.exportFps : ANIM_LIMIT.fps[0];
    const TOTAL_FRAMES = Math.ceil(CYCLE_DURATION * FPS);
    const FRAME_DURATION_US = Math.round(1_000_000 / FPS);

    const { musicEnabled } = this.state;
    const totalDurationSec = TOTAL_FRAMES / FPS;

    // Pre-validate codec support and generate the audio buffer BEFORE creating the muxer.
    // An audio track declared in the muxer but left empty makes the MP4 unplayable.
    let audioBuffer = null;
    // Resolve which audio codec to use. AAC (mp4a.40.2) is preferred for broad
    // player compatibility, but requires a platform codec — not available on Linux.
    // Opus is a universal fallback supported by all WebCodecs implementations.
    let audioCodec = null;
    let audioSampleRate = 44100;
    // Why music was dropped, if it was. Both drop paths below used to be console-only —
    // on iOS (no visible console) that read as "picked music, export worked, file is
    // silent, no explanation", so a requested-but-missing track is now alerted after the
    // export finishes (the video itself is still worth keeping).
    let audioSkipReason = null;
    if (musicEnabled && typeof AudioEncoder !== 'undefined' && typeof AudioData !== 'undefined') {
      const candidates = [
        { encoderCodec: 'mp4a.40.2', muxerCodec: 'aac',  sampleRate: 44100 },
        { encoderCodec: 'opus',       muxerCodec: 'opus', sampleRate: 48000 },
      ];
      for (const c of candidates) {
        const { supported } = await AudioEncoder.isConfigSupported({
          codec: c.encoderCodec, numberOfChannels: 2, sampleRate: c.sampleRate, bitrate: 128_000,
        }).catch(() => ({ supported: false }));
        if (supported) {
          audioCodec = c.encoderCodec;
          audioSampleRate = c.sampleRate;
          break;
        }
      }
      if (!audioCodec) audioSkipReason = 'no supported audio codec (AAC/Opus) in this browser';
    }

    if (audioCodec) {
      audioBuffer = await generateAudioBuffer(totalDurationSec, audioSampleRate).catch(e => {
        console.warn('[Chromaforge audio] generateAudioBuffer failed:', e);
        audioSkipReason = 'music generation failed';
        return null;
      });
    }

    const includeAudio = audioBuffer !== null;
    const muxerAudioCodec = audioCodec === 'mp4a.40.2' ? 'aac' : 'opus';

    // Frame source: a 2D canvas compositing the pre-rendered frames, or (3D mode) a WebGL
    // canvas the tunnel scene renders into per frame. Either way, `drawAt(elapsed, rush,
    // logo)` paints the exact frame for that timeline moment and `canvas` is what VideoFrame
    // captures -- the encode loop below is fully shared.
    //
    // `logo` is the admin logo mark's state for this frame (null when off or mid-cycle),
    // computed once in the loop so both modes are driven by the same curve even though they
    // draw it completely differently: 2D composites it onto the finished frame, 3D hands it
    // to the scene, which carries a real textured plane in the tunnel.
    const logoCfg = this.logoMarkConfig();
    let drawAt;
    let canvas;
    let cleanup3D = null;

    if (is3D) {
      const [{ WebGLRenderer }, { createTunnelScene }] = await Promise.all([
        import('three'),
        import('../animation3d/tunnelScene')
      ]);
      const renderer = new WebGLRenderer({ antialias: true });
      renderer.setPixelRatio(1);
      renderer.setSize(width, height);
      const world = createTunnelScene({
        seed: threeDDesign.seed,
        colors: threeDDesign.colors || [],
        settings: threeDDesign.settings ?? null,
        duration: CYCLE_DURATION,
        width,
        height,
        logoMark: logoCfg
      });
      canvas = renderer.domElement;
      // Star sprite textures decode async -- without this, the first ~second of encoded
      // frames renders starless and the stars visibly pop in.
      await world.ready;
      // setTime is periodic in CYCLE_DURATION, and the VideoFrame is constructed in the
      // same task as the render (no await in between), so no preserveDrawingBuffer needed.
      drawAt = (elapsed, rush = 0, logo = null) => {
        world.setTime(elapsed, rush, logo);
        renderer.render(world.scene, world.camera);
      };
      cleanup3D = () => {
        world.dispose();
        renderer.dispose();
      };
    } else {
      canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');

    const easeInOut = t => (t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t);

    // Measured off a loaded frame, NOT from this.props — on phones the stored raster is
    // smaller than the studio canvas (MOBILE_ANIM_RASTER), and a source rect larger than
    // the image silently draws a clipped, partly-empty frame.
    const srcWidth  = images[0]?.naturalWidth || this.props.width;
    const srcHeight = images[0]?.naturalHeight || this.props.height;
    // Cover-crop the pre-rendered frames into the chosen export ratio instead of
    // stretching them into it (see EXPORT_ASPECTS). A no-op when the ratios match.
    const { sx: SRC_X, sy: SRC_Y, sw: SRC_W, sh: SRC_H } = coverSourceRect(
      srcWidth, srcHeight, width, height
    );

    drawAt = (elapsed, rush = 0, logo = null) => {
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, width, height);
      images.forEach((img, i) => {
        // Each frame repeats every PERIOD seconds. Find how far into its current
        // cycle window this frame is, using modular arithmetic so the animation
        // is perfectly periodic — start and end frames are identical for seamless looping.
        const rawElapsed = elapsed - i * SPACING;
        const k = Math.floor(rawElapsed / PERIOD);
        const localElapsed = rawElapsed - k * PERIOD;

        if (localElapsed < 0 || localElapsed >= TOTAL_VISIBLE) return;

        const opacity = localElapsed < FADE
          ? easeInOut(localElapsed / FADE)
          : easeInOut(1 - (localElapsed - FADE) / FADE);

        const scale = 1 + (SCALE_END - 1) * Math.min(1, localElapsed / TOTAL_VISIBLE);

        ctx.save();
        ctx.globalAlpha = Math.max(0, Math.min(1, opacity));
        ctx.translate(width / 2, height / 2);
        ctx.scale(scale, scale);
        // Draw source image scaled to the export canvas size
        ctx.drawImage(img, SRC_X, SRC_Y, SRC_W, SRC_H, -width / 2, -height / 2, width, height);
        ctx.restore();
      });

      // Star overlay — composited with screen blend so the near-black background
      // disappears and the coloured stars add light on top of the gradients.
      if (starImages.length > 0) {
        const starPeriod = starImages.length * STAR_SPACING;
        ctx.globalCompositeOperation = 'screen';
        starImages.forEach((img, i) => {
          const rawElapsed = elapsed - i * STAR_SPACING;
          const k = Math.floor(rawElapsed / starPeriod);
          const localElapsed = rawElapsed - k * starPeriod;

          if (localElapsed < 0 || localElapsed >= STAR_TOTAL_VISIBLE) return;

          const opacity = (localElapsed < STAR_FADE
            ? easeInOut(localElapsed / STAR_FADE)
            : easeInOut(1 - (localElapsed - STAR_FADE) / STAR_FADE)) * 0.75;

          const scale = 1 + (STAR_SCALE_END - 1) * Math.min(1, localElapsed / STAR_TOTAL_VISIBLE);

          ctx.save();
          ctx.globalAlpha = Math.max(0, Math.min(1, opacity));
          ctx.translate(width / 2, height / 2);
          ctx.scale(scale, scale);
          ctx.drawImage(img, SRC_X, SRC_Y, SRC_W, SRC_H, -width / 2, -height / 2, width, height);
          ctx.restore();
        });
        ctx.globalCompositeOperation = 'source-over';
      }

      // The mark goes on last, over the finished frame. Sized off the short edge like the
      // preview's overlay, so the same LOGO_BASE_FRACTION lands identically at any export
      // ratio or resolution -- the preview and this must agree, or the thing you approved
      // on screen is not the thing in the file.
      if (logo && logoCfg) {
        drawLogoMark(ctx, logoCfg, {
          cx: width / 2,
          cy: height / 2,
          size: Math.min(width, height) * LOGO_SCREEN_FRACTION * logo.scale,
          draw: logo.draw,
          alpha: logo.alpha
        });
      }
      };
    }

    // mp4-muxer + WebCodecs VideoEncoder — guarantees real H.264 MP4
    const target = new ArrayBufferTarget();
    const muxer = new Muxer({
      target,
      video: { codec: 'avc', width, height, frameRate: FPS },
      ...(includeAudio ? { audio: { codec: muxerAudioCodec, numberOfChannels: 2, sampleRate: audioSampleRate } } : {}),
      fastStart: 'in-memory'
    });

    // Resolve a supported H.264 codec string. We prefer Constrained Baseline
    // (profile 66 — `avc1.42xxxx`) because it CANNOT contain B-frames. The
    // Windows hardware encoder otherwise emits B-frames and delivers chunks in
    // decode order, so their presentation timestamps arrive non-monotonically;
    // mp4-muxer then rejects every out-of-order chunk and drops ~half the
    // frames, which is what collapsed 24fps exports to ~13fps on Windows. With
    // no B-frames, decode order == presentation order and nothing is dropped.
    // High Profile is kept as a fallback (it works fine on macOS/VideoToolbox).
    // 25Mbps mobile (was 15): the fast parts of the animation — the 3D flythrough,
    // and especially the speed ramp's mid-cycle peak — starve the encoder at 15 and
    // came out visibly blocky/pixelated on real phone exports.
    //
    // Desktop bitrate is DERIVED from the export's own size and frame rate (2026-08-12,
    // Aaron: 3D exports go blurry through the fast mid-cycle stretch). It used to be a flat
    // 40Mbps, which is the actual fault — a 3840x2160 60fps export was handed the same
    // budget as a 2160x2160 24fps one. Measured at the ramp's peak on a real 3D scene,
    // encoded and decoded back through WebCodecs: 4K24 scored 29.5dB mean / 27.3dB worst
    // PSNR at 40Mbps, 33.5/30.7 at 80, 35.7/34.0 at 120, and was still climbing at 160.
    //
    // The exponent is measured, not assumed: the same quality needed 40Mbps at 1080p24 and
    // 80Mbps at 4K24 — four times the pixels for twice the bitrate — so the target scales
    // with the SQUARE ROOT of area, and linearly with frame rate. K is set so 4K24 lands on
    // ~120Mbps, near the knee of that curve.
    //
    // Then capped by memory, because mp4-muxer holds the entire file in RAM
    // (ArrayBufferTarget + fastStart: 'in-memory'), so bitrate x duration IS the allocation.
    // Without the cap a 60s 4K60 export would ask for ~2.2GB. Long exports trade quality for
    // completing at all, which is the right way round.
    //
    // Mobile is deliberately left on its flat 25Mbps: phones already OOM-kill on this path
    // (see ANIM_LIMITS) and Aaron's ask was specifically desktop.
    const VIDEO_QUALITY_K = 1736; // bits per (sqrt-pixel x frame)
    const MAX_EXPORT_BYTES = 600 * 1024 * 1024;
    const bitrate = isMobile
      ? 25_000_000
      : Math.min(
          Math.round(VIDEO_QUALITY_K * Math.sqrt(width * height) * FPS),
          Math.floor((MAX_EXPORT_BYTES * 8) / CYCLE_DURATION)
        );
    // latencyMode: 'quality' gives the encoder real rate control and motion estimation
    // headroom; 'realtime' (used previously) trades that away for encode speed, which is
    // the other half of the fast-motion blockiness. The reordering concern that motivated
    // 'realtime' doesn't apply to Constrained Baseline — that profile structurally cannot
    // contain B-frames — so only the High Profile fallback (which CAN reorder) keeps the
    // 'realtime' hint.
    const latencyFor = codec => (codec.startsWith('avc1.42') ? 'quality' : 'realtime');
    const codecCandidates = [
      'avc1.42E034', // Constrained Baseline, Level 5.2 — no B-frames
      'avc1.42E028', // Constrained Baseline, Level 4.0 — no B-frames (lower-res fallback)
      'avc1.640034', // High Profile, Level 5.2 — may emit B-frames
    ];
    let videoCodec = null;
    for (const c of codecCandidates) {
      const cfg = { codec: c, width, height, bitrate, framerate: FPS, latencyMode: latencyFor(c) };
      const ok = await VideoEncoder.isConfigSupported(cfg)
        .then(r => r.supported)
        .catch(() => false);
      if (ok) { videoCodec = c; break; }
    }
    if (!videoCodec) videoCodec = 'avc1.640034';

    let encoder;
    try {
      encoder = new VideoEncoder({
        output: (chunk, meta) => {
          const data = new Uint8Array(chunk.byteLength);
          chunk.copyTo(data);
          muxer.addVideoChunkRaw(data, chunk.type, chunk.timestamp, FRAME_DURATION_US, meta);
        },
        error: e => console.error('VideoEncoder error:', e)
      });

      encoder.configure({
        codec: videoCodec,
        width,
        height,
        bitrate,
        framerate: FPS,
        latencyMode: latencyFor(videoCodec)
      });
    } catch (e) {
      console.error('VideoEncoder configure failed:', e);
      cleanup3D?.();
      this.setState({ isExporting: false, exportProgress: 0 });
      alert('MP4 export is not supported in this browser. Try Chrome or Edge on a desktop.');
      return;
    }

    // Encode frame by frame at a fixed timestep (no rAF timing jitter).
    // Back-pressure: if the encoder queue grows too deep, yield until it drains —
    // this prevents unbounded memory buildup that kills iOS tabs.
    for (let f = 0; f < TOTAL_FRAMES; f++) {
      // Speed ramp: warp the linear frame time through the same rampTime the live
      // previews use, so the exported motion matches them exactly. rampTime maps
      // [0, PERIOD] onto itself monotonically with equal velocity at both
      // ends, so the export still covers exactly one seamless loop. The floor is
      // per-mode (3D nearly stops at the seam, 2D keeps a cruise) and MUST match what
      // the corresponding preview passes -- Animation3DPreview for 3D, AnimationPreview's
      // ticker driver (which uses the default) for 2D.
      const linear = f / FPS;
      const elapsed =
        OFFSET + (speedRamp ? rampTime(linear, PERIOD, is3D ? RAMP_FLOOR_3D : RAMP_FLOOR_2D) : linear);
      // rush only means anything to the 3D drawAt (FOV/warp speed enhancement); the 2D
      // compositor ignores it.
      //
      // The logo mark takes the LINEAR clock, not `elapsed`: logoIntro applies its own warp
      // with its own floor (3D's 0.03 would leave the mark hanging at the seam for seconds
      // of wall time). Note the mark is NOT offset by OFFSET -- OFFSET exists to start the
      // frame crossfades one period in, and the mark's whole job is to sit exactly on the
      // seam, which `linear` already puts it on at f = 0 and f = TOTAL_FRAMES.
      const logo = logoCfg ? logoState(linear, PERIOD, speedRamp) : null;
      drawAt(elapsed, speedRamp ? rampRush(linear, PERIOD) : 0, logo);

      const frame = new VideoFrame(canvas, { timestamp: f * FRAME_DURATION_US });
      // Keyframe every 2s (was every 1s): forced keyframes are the most expensive frames
      // in the stream, and at fast-motion moments the bitrate they consume comes straight
      // out of the inter frames' budget — visibly blocky at the speed ramp's peak.
      encoder.encode(frame, { keyFrame: f % (FPS * 2) === 0 });
      frame.close();

      // Drain the encoder queue before it grows too large
      while (encoder.encodeQueueSize > 5) {
        await new Promise(r => setTimeout(r, 0));
      }

      // Yield to browser every 10 frames — scale render phase to 0–90%
      if (f % 10 === 0) {
        this.setState({ exportProgress: Math.round((f / TOTAL_FRAMES) * 90) });
        await new Promise(r => setTimeout(r, 0));
      }
    }

    if (cleanup3D) {
      cleanup3D();
    } else {
      canvas.width = 0;
      canvas.height = 0;
    }

    // encoder.flush() has no progress callbacks — animate the bar while we wait.
    // With audio, leave room at 93–99 for the audio encoding phase.
    const crawlTarget = includeAudio ? 93 : 99;
    let fakeProgress = 90;
    const crawl = setInterval(() => {
      fakeProgress += (crawlTarget - fakeProgress) * 0.15;
      this.setState({ exportProgress: Math.round(fakeProgress) });
    }, 200);

    await encoder.flush();
    clearInterval(crawl);

    if (includeAudio) {
      this.setState({ exportProgress: 94 });
      try {
        await encodeAudioTrack(audioBuffer, muxer, audioCodec, p => {
          this.setState({ exportProgress: Math.round(94 + p * 5) });
        });
      } catch (e) {
        console.warn('[Chromaforge] Audio encoding failed:', e);
        this.setState({ isExporting: false, exportProgress: 0 });
        alert('Export failed: audio encoding error. Try disabling music in settings.');
        return;
      }
    }

    try {
      muxer.finalize();
      this.setState({ exportProgress: 100 });
      const blob = new Blob([target.buffer], { type: 'video/mp4' });
      saveAs(blob, `${FileName()}.mp4`);
      if (musicEnabled && !includeAudio && audioSkipReason) {
        alert(`Note: the video was exported WITHOUT music (${audioSkipReason}).`);
      }
    } catch (e) {
      console.error('[Chromaforge] Export finalize failed:', e);
      alert('Export failed. Please try again.');
    } finally {
      this.setState({ isExporting: false, exportProgress: 0 });
    }
  }

  // Geometry slider moved. Update the state immediately (the value readout tracks the
  // thumb live), then regenerate the CURRENT seed with the new settings after a short
  // debounce -- so dragging a slider visibly reshapes the artwork on screen rather than
  // only affecting the next Generate. Settings are part of a design's identity (see
  // StudioContext.isSameDesign), so the result counts as unsaved. In animation mode a
  // regenerate means rebuilding every frame (a 30s+ job), so there it only marks settings
  // dirty -- the same "regenerate to apply" notice the video settings already use.
  //
  // isSaved flips false here immediately (not just later inside regenerateCurrentSeed) so
  // a burst of slider ticks within one debounce window only ever sees the "was this saved"
  // transition once -- wasSaved, captured before the flip, is what gates showBranchNotice.
  // Because it's derived from a real state transition rather than a separate remembered
  // flag, it naturally fires exactly once per saved-design edit: the same design's next
  // slider tick already has isSaved === false, and a freshly loaded/saved design starts
  // this cycle over again.
  onGeometrySettingChange(patch) {
    const wasSaved = this.state.isSaved;
    this.setState(
      s => ({
        geometrySettings: { ...s.geometrySettings, ...patch },
        isSaved: false,
        showBranchNotice: s.showBranchNotice || wasSaved
      }),
      () => {
        if (this.state.animationMode) {
          // 3D scenes rebuild instantly, so sliders apply live (same debounce as image
          // mode) -- same seed, new settings, the "same" scene reshaped. 2D animation
          // frames are a 30s+ rebuild, so there it stays regenerate-to-apply.
          if (this.state.threeDMode && this.state.threeDDesign) {
            clearTimeout(this.geometryRegenTimer);
            this.geometryRegenTimer = setTimeout(() => {
              this.setState(s => ({
                threeDDesign: s.threeDDesign && {
                  ...s.threeDDesign,
                  settings: { geometry: s.geometrySettings }
                }
              }));
            }, 350);
            return;
          }
          this.setState({ settingsDirty: true });
          return;
        }
        clearTimeout(this.geometryRegenTimer);
        this.geometryRegenTimer = setTimeout(() => this.regenerateCurrentSeed(), 350);
      }
    );
  }

  // 3D scenes rebuild instantly, so palette changes apply live too (same 350ms debounce
  // as the geometry sliders) -- without this, color edits only reached the 3D scene on
  // the next Generate, which read as colors doing nothing. Reads values from the DOM the
  // same way updateColors() does, since jscolor edits live in the uncontrolled inputs.
  syncThreeDColors() {
    if (!this.state.threeDMode || !this.state.threeDDesign) return;
    clearTimeout(this.threeDColorTimer);
    this.threeDColorTimer = setTimeout(() => {
      const colorFields = document.querySelectorAll('.color');
      const colors = this.state.colors.map((colorObj, index) =>
        colorFields[index] ? colorFields[index].value : colorObj.value || colorObj
      );
      this.setState(s => ({
        threeDDesign: s.threeDDesign && { ...s.threeDDesign, colors },
        isSaved: false
      }));
    }, 350);
  }

  // Queues a live 2D regenerate for a color-LIST edit that's already reflected in
  // state.colors (add/remove/clear/rainbow/reorder all update state synchronously before
  // calling this) -- same 350ms-debounced, shared-timer treatment onGeometrySettingChange
  // gives the geometry sliders, so a burst of edits across colors and geometry within one
  // window collapses into a single regenerate instead of racing. Previously colors had no
  // live-2D counterpart to syncThreeDColors, so an edit only reached mainConfig/
  // StudioContext on the next Generate click -- meaning navigating away from the Studio and
  // back silently dropped an unsaved palette edit while a geometry-slider edit survived.
  queueColorRegen() {
    if (this.state.animationMode || this.state.isExporting) return;
    const wasSaved = this.state.isSaved;
    this.setState(s => ({
      isSaved: false,
      showBranchNotice: s.showBranchNotice || wasSaved
    }));
    clearTimeout(this.geometryRegenTimer);
    this.geometryRegenTimer = setTimeout(() => this.regenerateCurrentSeed(), 350);
  }

  // Color-list edit (add/remove/clear/rainbow/reorder) -- syncs the 3D scene (unchanged)
  // and queues the 2D live regenerate above.
  onColorsChanged() {
    this.syncThreeDColors();
    this.queueColorRegen();
  }

  // A swatch's own VALUE changed (jscolor drag/typed edit, via ColorField's onEdit).
  // jscolor edits live in the swatch's uncontrolled input (see updateColors), so
  // state.colors lags the DOM until this runs -- read it only once, inside the debounced
  // callback, the same way syncThreeDColors already does, so frequent input events during
  // a drag don't each trigger a read/setState/regenerate.
  onColorSwatchEdit() {
    this.syncThreeDColors();
    if (this.state.animationMode || this.state.isExporting) return;
    const wasSaved = this.state.isSaved;
    clearTimeout(this.geometryRegenTimer);
    this.geometryRegenTimer = setTimeout(() => {
      const colorFields = document.querySelectorAll('.color');
      const colors = this.state.colors.map((colorObj, index) => ({
        ...colorObj,
        value: colorFields[index] ? colorFields[index].value : colorObj.value
      }));
      this.setState(s => ({
        colors,
        isSaved: false,
        showBranchNotice: s.showBranchNotice || wasSaved
      }), () => this.regenerateCurrentSeed());
    }, 350);
  }

  onDismissBranchNotice() {
    this.setState({ showBranchNotice: false });
  }

  regenerateCurrentSeed() {
    if (!this.mainConfig || this.state.animationMode || this.state.isExporting) return;
    if (this.state.generateDisabled) {
      // A build is already in flight (e.g. the previous slider tick's regen) -- try again
      // shortly instead of dropping the newest slider position on the floor.
      this.geometryRegenTimer = setTimeout(() => this.regenerateCurrentSeed(), 350);
      return;
    }
    this.setState({ isLoading: true, generateDisabled: true, isSaved: false });
    // Same seed, live palette + settings (buildConfig reads the live slider state) -- the
    // "same" piece, reshaped. Colors come from state.colors, not mainConfig.colors, so a
    // pending color edit (see onColorsChanged/onColorSwatchEdit) is picked up here too,
    // not just a pending geometry-slider edit -- the two previously had separate sources
    // of truth and could regenerate against stale palettes.
    const config = this.buildConfig(
      this.mainConfig.seed,
      this.props.width,
      this.props.height,
      this.state.colors.map(c => c.value || c)
    );
    this.buildImage(config);
  }

  onGenerateButtonClick(e) {
    const { generateDisabled, animationMode, animationFrames } = this.state;

    if (!generateDisabled) {
      // Clear URL when generating new image
      window.history.pushState({}, '', window.location.pathname);
      // isSaved (React state, below) isn't enough on its own -- this.shareUrl/shareDesignId
      // are plain instance fields, so without this they'd keep pointing at whatever design
      // was last saved/loaded, surviving straight through a brand new, never-saved
      // generation. Confirmed live: this let the share-link box's ref callback (meant only
      // for a design that arrived already-saved via ?id=) fire on stale data the instant the
      // panel reopened, skipping the GSAP fill-in animation entirely -- and made the *next*
      // save's animation look like it was transitioning from a real previous id, when it was
      // actually transitioning from this leftover one.
      this.shareUrl = null;
      this.shareDesignId = null;

      if (animationMode && this.state.threeDMode) {
        // 3D mode: a new scene is just a new seed -- built synchronously by the preview
        // component, no frame rendering. Nothing 2D is touched (frames stay snapshotted
        // in state for when 3D is toggled back off).
        this.setState({
          threeDDesign: this.buildThreeDDesign(),
          isSaved: false,
          showBranchNotice: false,
          animationPaused: false,
          settingsDirty: false
        });
      } else if (animationMode) {
        // Revoke existing blob URLs to free memory
        const { animationStarFrames } = this.state;
        animationFrames.forEach(url => URL.revokeObjectURL(url));
        animationStarFrames.forEach(url => URL.revokeObjectURL(url));
        // Clear any previously saved animation state — new generation replaces it
        if (this.animationModeState) {
          this.animationModeState.frames.forEach(url => URL.revokeObjectURL(url));
          this.animationModeState.starFrames.forEach(url => URL.revokeObjectURL(url));
          this.animationModeState = null;
        }

        gsap.to('.image-container', {
          duration: DURATION_FAST,
          alpha: 0,
          ease: 'power2.inOut'
        });

        this.setState({
          generateDisabled: true,
          isLoading: true,
          isSaved: false,
          showBranchNotice: false,
          animationFrames: [],
          animationStarFrames: [],
          animationProgress: 0,
          animationPaused: false
        });

        this.buildAnimationFrames();
      } else {
        gsap.to('.image-container', {
          duration: DURATION_FAST,
          alpha: 0,
          ease: 'power2.inOut'
        });

        this.setState({
          isLoading: true,
          generateDisabled: true,
          isSaved: false,
          showBranchNotice: false
        });

        const config = this.buildConfig();
        this.buildImage(config);
      }
    }
  }

  onModeToggle(mode) {
    const { animationMode, animationFrames, animationStarFrames, isSaved } = this.state;

    if (mode === animationMode) return;

    if (mode) {
      // Switching TO animation — snapshot image mode state
      this.imageModeState = {
        blob: this.blob,
        blobUrl: this.imageBlobUrl,
        config: this.mainConfig,
        isSaved,
        shareUrl: this.shareUrl,
        shareDesignId: this.shareDesignId
      };

      // 3D mode: entering animation mode needs no frame build -- just make sure a 3D
      // design exists for the preview to mount. Any snapshotted 2D animation state stays
      // put for when 3D is toggled off.
      if (this.state.threeDMode) {
        this.shareUrl = null;
        this.shareDesignId = null;
        gsap.to('.image-container', { duration: DURATION_FAST, alpha: 0, ease: 'power2.inOut' });
        this.setState({
          animationMode: true,
          isSaved: false,
          animationPaused: false,
          threeDDesign: this.state.threeDDesign || this.buildThreeDDesign()
        });
      } else if (this.animationModeState) {
        // Restore previous animation state if available
        const { frames, starFrames, configs, isSaved: wasSaved, shareUrl, shareDesignId } =
          this.animationModeState;
        this.animationModeState = null;
        this.animationConfigs = configs;
        this.shareUrl = shareUrl || null;
        this.shareDesignId = shareDesignId || null;
        this.changeGradient(configs[configs.length - 1].gradientBackgroundConfig.colors);
        this.setState({
          animationMode: true,
          animationFrames: frames,
          animationStarFrames: starFrames,
          animationProgress: frames.length,
          isSaved: wasSaved || false,
          generateDisabled: false,
          isLoading: false,
        });
      } else {
        this.animationConfigs = null;
        this.shareUrl = null;
        this.shareDesignId = null;
        gsap.to('.image-container', { duration: DURATION_FAST, alpha: 0, ease: 'power2.inOut' });
        this.setState({
          animationMode: true,
          animationFrames: [],
          animationStarFrames: [],
          animationProgress: 0,
          isSaved: false,
          generateDisabled: true,
          isLoading: true
        }, () => {
          this.buildAnimationFrames();
        });
      }
    } else {
      // Switching TO image — snapshot animation mode state (don't revoke URLs)
      if (animationFrames.length > 0) {
        this.animationModeState = {
          frames: animationFrames,
          starFrames: animationStarFrames,
          configs: this.animationConfigs,
          isSaved,
          shareUrl: this.shareUrl,
          shareDesignId: this.shareDesignId
        };
      }
      this.animationConfigs = null;

      // Restore previous image state if available
      if (this.imageModeState && this.imageModeState.blobUrl) {
        const { blob, blobUrl, config, isSaved: wasSaved, shareUrl, shareDesignId } =
          this.imageModeState;
        this.imageModeState = null;
        this.blob = blob;
        this.imageBlobUrl = blobUrl;
        this.mainConfig = config;
        this.shareUrl = shareUrl || null;
        this.shareDesignId = shareDesignId || null;
        this.changeGradient(config.gradientBackgroundConfig.colors);

        const imageContainer = document.querySelector('.image-container');
        if (imageContainer) {
          imageContainer.style.backgroundImage = `url(${blobUrl})`;
          gsap.set('.image-container', { alpha: 1 });
        }

        this.setState({
          animationMode: false,
          animationFrames: [],
          animationStarFrames: [],
          animationProgress: 0,
          isSaved: wasSaved || false,
          generateDisabled: false,
          isLoading: false,
        });
      } else {
        this.shareUrl = null;
        this.shareDesignId = null;
        this.setState({
          animationMode: false,
          animationFrames: [],
          animationStarFrames: [],
          animationProgress: 0,
          isSaved: false
        });
      }
    }

    // Pulse the newly active button after React re-renders
    gsap.delayedCall(0.05, () => {
      gsap.fromTo('.panel-tab.active',
        { opacity: 0.3, scale: 0.94 },
        { duration: DURATION_BASE, opacity: 1, scale: 1, ease: 'back.out(1.7)' }
      );
    });
  }

  readBackdropValues(el) {
    const raw = getComputedStyle(el).backdropFilter || getComputedStyle(el).webkitBackdropFilter || '';
    const blur = parseFloat((raw.match(/blur\(([\d.]+)px\)/) || [])[1]) || 6;
    const brightness = parseFloat((raw.match(/brightness\(([\d.]+)\)/) || [])[1]) || 0.95;
    return { blur, brightness };
  }

  onCloseButtonClick(e) {
    // Compact mode (the homepage hero) has its own minimal/expanded toggle below -- this
    // legacy "hide the whole panel, click anywhere to bring it back" interaction would
    // otherwise still fire on background clicks with no visible way to undo it once the
    // compact-mode reopen icon is hidden.
    //
    // Dismissing an OPEN save panel is the one half of this that does belong in compact, and
    // is what the full studio's background click already does first. It carries none of the
    // objection above -- the panel's own Save button reopens it, so there is an obvious way
    // back -- and without it the hero's save panel is the only dismissable surface on the
    // site that a background click does nothing to.
    if (this.props.compact) {
      if (this.state.saveVisible) this.onSettingsCloseButtonClick();
      return;
    }

    const { controlsAreOpen } = this.state;
    this.onSettingsCloseButtonClick();

    if (e.target.tagName !== 'BUTTON' && e.target.tagName !== 'INPUT') {
      if (controlsAreOpen) {
        this.setState({ controlsAreOpen: false });

        gsap.to('#copyright', { duration: DURATION_BASE, alpha: 0.2, scale: 0.9, ease: 'power2.inOut' });
        gsap.to('.row, .logo, .panel-tabs, .go-to-studio-btn', { duration: DURATION_FAST, alpha: 0, ease: 'power2.inOut' });

        const el = document.querySelector('.controls-inner');
        const { blur: cssBlur, brightness: cssBrightness } = this.readBackdropValues(el);
        const panelOut = { blur: cssBlur, brightness: cssBrightness, bgAlpha: 0.15, shadow: 40, shadowAlpha: 0.4 };
        gsap.to(panelOut, {
          blur: 0, brightness: 1, bgAlpha: 0, shadow: 0, shadowAlpha: 0,
          duration: DURATION_FAST,
          ease: 'power2.inOut',
          onUpdate: () => {
            el.style.backdropFilter = `blur(${panelOut.blur}px) brightness(${panelOut.brightness})`;
            el.style.background = `rgba(0, 0, 0, ${panelOut.bgAlpha})`;
            el.style.boxShadow = `0 4px ${panelOut.shadow}px rgba(0, 0, 0, ${panelOut.shadowAlpha})`;
          },
          onComplete: () => {
            gsap.set('.controls-container', { display: 'none' });
            el.style.backdropFilter = '';
            el.style.background = '';
            el.style.boxShadow = '';
            el.style.removeProperty('--border-opacity');
          }
        });

        // Border exits faster so it doesn't linger after the rest of the panel fades
        const borderOut = { v: 0.75 };
        gsap.to(borderOut, {
          v: 0, duration: 0.1, ease: 'power2.inOut',
          onUpdate: () => { el.style.setProperty('--border-opacity', borderOut.v); }
        });
      } else {
        this.setState({ controlsAreOpen: true });

        gsap.to('#copyright', { duration: 1, alpha: 0.5, scale: 1, ease: 'back.out(1.7)' });
        gsap.set('.controls-container', { display: 'flex' });

        const elIn = document.querySelector('.controls-inner');
        const { blur: cssBlurIn, brightness: cssBrightnessIn } = this.readBackdropValues(elIn);
        const panelIn = { blur: 0, brightness: 1, bgAlpha: 0, shadow: 0, shadowAlpha: 0, borderOpacity: 0 };
        gsap.to(panelIn, {
          blur: cssBlurIn, brightness: cssBrightnessIn, bgAlpha: 0.15, shadow: 40, shadowAlpha: 0.4, borderOpacity: 0.75,
          duration: DURATION_BASE,
          ease: 'power2.inOut',
          onUpdate: () => {
            elIn.style.backdropFilter = `blur(${panelIn.blur}px) brightness(${panelIn.brightness})`;
            elIn.style.background = `rgba(0, 0, 0, ${panelIn.bgAlpha})`;
            elIn.style.boxShadow = `0 4px ${panelIn.shadow}px rgba(0, 0, 0, ${panelIn.shadowAlpha})`;
            elIn.style.setProperty('--border-opacity', panelIn.borderOpacity);
          },
          onComplete: () => {
            elIn.style.backdropFilter = '';
            elIn.style.background = '';
            elIn.style.boxShadow = '';
            elIn.style.removeProperty('--border-opacity');
          }
        });

        // .go-to-studio-btn is rendered FIRST in the DOM (see its own comment, above, in
        // the non-compact JSX -- needed so .row:last-child's CSS margin still targets the
        // real last row), which meant a plain combined selector (staggering in DOM order)
        // animated it first, not last. A two-tween timeline fixed the ordering but queued
        // the button a full DURATION_SLOW after the group finished -- the group's own last
        // element doesn't land until (count-1)*stagger into ITS tween, so the button's tween
        // only starting then reads as a separate, delayed second animation instead of one
        // continuous cascade. Passing one explicit element array (button last) to a single
        // fromTo keeps it all one stagger, one duration, same as before this ever needed a
        // fix -- the button just lands in the correct position within it now.
        gsap.fromTo(
          [...gsap.utils.toArray('.row, .logo, .panel-tabs'), ...gsap.utils.toArray('.go-to-studio-btn')],
          { alpha: 0, y: 42 },
          { duration: DURATION_SLOW, alpha: 1, y: 0, stagger: 0.05, ease: 'back.out(1.7)' }
        );
      }
    }
  }

  onSettingsButtonClick(e) {
    gsap.to('#controls-main', {
      duration: DURATION_FAST,
      alpha: 0.5,
      scale: 0.9,
      filter: 'blur(3px)',
      ease: 'back.out(1.7)'
    });

    gsap.from('#controls-settings', {
      duration: DURATION_FAST,
      alpha: 0,
      scale: 1.2,
      ease: 'back.out(1.7)'
    });

    this.setState({ controlsBlurred: true }, () => this.animateSettingsTab());
  }

  onSettingsCloseButtonClick(e) {
    gsap.to('#controls-main', {
      duration: DURATION_FAST,
      alpha: 0.9,
      scale: 1,
      filter: 'blur(0px)',
      ease: 'back.out(1.7)',
      onComplete: () => {
        this.updateColors();
      }
    });

    this.setState({
      controlsBlurred: false,
      saveVisible: false,
      linkCopied: false,
      linkCopyFailed: false,
      galleryStatus: null,
      galleryError: null
    });
  }

  onClearColors() {
    this.setState({ colors: [] }, () => this.onColorsChanged());
    this.nextColorId = 0;
  }

  onRainbowColors() {
    // Replace the palette with the full rainbow set. Use fresh ids (continuing from
    // nextColorId) so the keys never collide with existing colors — otherwise React
    // reuses those ColorField instances and their uncontrolled inputs keep their old
    // values, so only the non-colliding slots would actually show rainbow colors.
    const base = this.nextColorId;
    this.setState({
      colors: [
        { id: base, value: '#ff0059' },
        { id: base + 1, value: '#ffbb00' },
        { id: base + 2, value: '#eaff00' },
        { id: base + 3, value: '#00e5ff' },
        { id: base + 4, value: '#4c00ff' }
      ]
    }, () => this.onColorsChanged());
    this.nextColorId = base + 5;
    gsap.delayedCall(0.05, () => this.animateColors());
  }

  onAddColorButtonClick(e) {
    let colors = [...this.state.colors];
    colors.push({
      id: this.nextColorId++,
      value: new tinycolor.random().toHexString()
    });
    this.setState({ colors: colors }, () => this.onColorsChanged());

    gsap.delayedCall(0.05, () => {
      this.animateColors();
    });
  }

  onRemoveColorbuttonClick(colorId) {
    // Update all color values from DOM first
    let colorFields = document.querySelectorAll('.color');
    let colors = this.state.colors.map((colorObj, index) => ({
      ...colorObj,
      value: colorFields[index] ? colorFields[index].value : colorObj.value
    }));

    // Filter out the color to remove by ID
    colors = colors.filter(colorObj => colorObj.id !== colorId);

    this.setState({ colors: colors }, () => this.onColorsChanged());
  }

  onReorderColors(draggedColorId, targetColorId) {
    // Update all color values from DOM first by matching data-color-id
    let colors = this.state.colors.map(colorObj => {
      const colorField = document.querySelector(
        `.color-container[data-color-id="${colorObj.id}"] .color`
      );
      return {
        ...colorObj,
        value: colorField ? colorField.value : colorObj.value
      };
    });

    // Find indices
    const draggedIndex = colors.findIndex(c => c.id === draggedColorId);
    const targetIndex = colors.findIndex(c => c.id === targetColorId);

    if (draggedIndex === -1 || targetIndex === -1 || draggedIndex === targetIndex) return;

    // Swap the dragged and target colors so dropping onto a swatch always takes its
    // exact slot. The previous remove-then-insert-before approach always left the
    // target at its own original index when dragging forward (earlier -> later) onto
    // it, which made the LAST swatch look stuck -- there's nothing after it to absorb
    // the displacement, so it could never be "replaced".
    [colors[draggedIndex], colors[targetIndex]] = [colors[targetIndex], colors[draggedIndex]];

    this.setState({ colors: colors }, () => this.onColorsChanged());
  }

  onKeyUp(e) {
    if (e.key === 'Enter' && !this.state.controlsAreOpen) {
      this.onGenerateButtonClick();
    }
  }

  onDirectLinkClick(e) {
    const { isSaved } = this.state;
    if (!isSaved || !this.shareUrl) return;
    this.copyToClipboard(this.shareUrl);
  }

  onCopySuccess() {
    this.setState({ linkCopied: true, linkCopyFailed: false });
    // This was already here, but with no matching .alert element in the JSX below (a
    // rename drifted at some point) -- gsap.fromTo on a selector with zero matches is a
    // silent no-op, so "Copied to clipboard" was just popping in with no animation at all.
    // Also needed the same "wait a tick for React to render" delayedCall already used
    // elsewhere in this file -- querying a class immediately after setState can run before
    // the DOM update it targets actually exists. The span itself has a static opacity-0
    // class below so it's already invisible from React's very first render of it --
    // without that, this 50ms gap meant the text was fully visible first, then this
    // fromTo snapped it to invisible before animating back in (confirmed by sampling
    // computed opacity frame-by-frame: opacity:1 for ~40ms, then a hard cut to 0).
    gsap.delayedCall(0.05, () => {
      gsap.fromTo('.alert', { alpha: 0, y: 10 }, { alpha: 1, y: 0, duration: DURATION_BASE, ease: 'bounce.out' });
    });
  }

  // Neither copy mechanism can succeed without browser/OS cooperation (e.g. the document
  // must be focused) -- when that happens, surface it instead of swallowing it silently, so
  // the user knows to fall back to manually selecting the link text shown right above.
  onCopyFailure() {
    this.setState({ linkCopyFailed: true });
  }

  // navigator.clipboard.writeText silently rejects in some real-world contexts (no document
  // focus, an embedding iframe without clipboard-write permission delegated, non-secure
  // context) -- it was failing "most of the time" with no fallback, just a swallowed
  // console.log. Fall back to the legacy execCommand technique, which copies synchronously
  // via a real text selection rather than the async permission-gated Clipboard API.
  copyToClipboard(text) {
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(
        () => this.onCopySuccess(),
        () => this.copyViaExecCommand(text)
      );
    } else {
      this.copyViaExecCommand(text);
    }
  }

  copyViaExecCommand(text) {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.left = '-9999px';
    document.body.appendChild(textarea);
    textarea.select();
    textarea.setSelectionRange(0, text.length);
    try {
      if (document.execCommand('copy')) this.onCopySuccess();
      else this.onCopyFailure();
    } catch (err) {
      this.onCopyFailure();
    }
    document.body.removeChild(textarea);
  }

  //

  render() {
    const {
      isLoading,
      isSaving,
      isSaved,
      controlsAreOpen,
      generateDisabled,
      controlsBlurred,
      colors,
      saveVisible,
      linkCopied,
      linkCopyFailed,
      animationMode,
      animationFrames,
      animationStarFrames,
      animationProgress,
      isExporting,
      exportProgress,
      frameCount,
      cycleDuration,
      starFrameCount,
      animationPaused,
      threeDMode,
      threeDDesign,
      musicEnabled,
      audioExportSupported,
      speedRamp,
      logoMark,
      exportAspect,
      exportFps,
      settingsTab,
      animTiming,
      settingsDirty,
      geometrySettings,
      galleryStatus,
      galleryError,
      showBranchNotice,
    } = this.state;

    // `user` now comes from the auth provider via props (StudioPage), not local state.
    const user = this.props.user;
    const isAdmin = !!this.props.isAdmin;
    const { spacing, fade, starSpacing, starFade } = animTiming ?? this.getAnimTiming();
    const compact = !!this.props.compact;
    const returnTo = this.props.returnTo ?? { path: '/', label: 'Back to home' };

    return (
      <div
        // bg-ink-900 (not the page's neutral bg-ink-950) so the loading/generating state
        // (before the canvas paints over it) reads as its own distinct surface -- both here
        // (the compact homepage hero, nested inside Hero.jsx's section) and standalone at
        // /studio (StudioPage renders this with no wrapping section of its own to carry a
        // background), so it belongs on this root rather than duplicated per-wrapper.
        // `absolute` when compact, `fixed` only standalone. Both fill the same box -- the
        // hero section is `relative`, so absolute positioning fills it directly, while
        // /studio has no wrapping section and needs the viewport. Compact used to be fixed
        // too, reaching this section via Hero.jsx's `contain: layout` (an ancestor with
        // layout containment becomes the containing block for fixed descendants). That is a
        // real behaviour, but it made the hero a compositor-managed fixed layer during
        // DOCUMENT scrolling, which iOS Safari does not keep in lockstep with the visual
        // scroll -- the hero's contents visibly jerked up and down as you scrolled (reported
        // 2026-08-11, right after scrolling moved to the document; it did not happen while
        // HomePage scrolled its own div, where that fast path never applied). Absolute
        // positioning is a plain in-flow-relative box with no such path. Don't put `fixed`
        // back on the compact branch.
        className={`display-canvas ${compact ? 'absolute' : 'fixed'} left-0 top-0 flex h-full w-full items-center justify-center overflow-hidden bg-ink-900`}
        ref={mount => {
          this.mount = mount;
        }}
      >
        {/* Compact (homepage hero) swaps the centered hexagon for the dot-grid ripple
            (mounted inside the panel below) -- on mobile the stacked shirt+buttons panel
            covered most of the hexagon. */}
        {isLoading && !compact ? <HexagonLoader /> : ''}
        {!compact && (
          <div
            className="controls-open absolute right-[25px] top-[25px] z-10 flex h-[3.5em] w-[3.5em] cursor-pointer items-center justify-center opacity-0 mix-blend-hard-light transition-all duration-[var(--duration-base)] ease-[ease] [-webkit-tap-highlight-color:transparent]"
            onClick={this.onCloseButtonClick.bind(this)}
          >
            <CloseButton isOpen={controlsAreOpen} />
          </div>
        )}
        <div
          className="image-container absolute left-0 top-0 z-0 h-full w-full bg-cover bg-center bg-no-repeat opacity-0"
          onClick={this.onCloseButtonClick.bind(this)}
        ></div>
        {animationFrames.length > 0 && !(animationMode && threeDMode) && (
          <AnimationPreview
            frames={animationFrames}
            starFrames={animationStarFrames}
            onClick={this.onCloseButtonClick.bind(this)}
            fade={fade}
            spacing={spacing}
            starFade={starFade}
            starSpacing={starSpacing}
            paused={animationPaused || isExporting}
            speedRamp={speedRamp}
            logoMark={this.logoMarkConfig()}
          />
        )}
        {/* Both previews freeze while encoding (paused || isExporting) — a second live
            scene (a whole WebGL scene in 3D mode) competing with the exporter for GPU/CPU
            is wasted work; the user's own pause state is untouched and playback resumes
            when the export ends. */}
        {animationMode && threeDMode && threeDDesign && (
          <Animation3DPreview
            design={threeDDesign}
            cycleDuration={cycleDuration}
            onClick={this.onCloseButtonClick.bind(this)}
            paused={animationPaused || isExporting}
            speedRamp={speedRamp}
            logoMark={this.logoMarkConfig()}
            onInitError={() => {
              alert('3D mode needs WebGL, which is unavailable in this browser. Switching back to 2D.');
              this.onThreeDToggle();
            }}
          />
        )}
        {(animationFrames.length > 0 || (animationMode && threeDMode && threeDDesign)) && (
          <button
            className="animation-pause absolute left-[25px] top-[25px] z-10 flex h-[3.5em] w-[3.5em] cursor-pointer items-center justify-center border-none bg-transparent p-0 mix-blend-hard-light transition-all duration-[var(--duration-base)] ease-[ease] [-webkit-tap-highlight-color:transparent]"
            onClick={e => { e.stopPropagation(); this.setState({ animationPaused: !animationPaused }); }}
            aria-label={animationPaused ? 'Play' : 'Pause'}
          >
            <PlayPauseButton paused={animationPaused} />
          </button>
        )}
        <div className="controls-container absolute left-0 top-0 z-[5] flex h-full w-full items-center justify-center bg-transparent">
          {controlsAreOpen ? (
            <div
              className="controls-background-click absolute left-0 top-0 z-0 h-full w-full"
              onClick={this.onCloseButtonClick.bind(this)}
            ></div>
          ) : (
            ''
          )}
          {compact ? (
            // Homepage hero: a fixed, minimal state -- no glass backing at all (see
            // .controls-compact in components.css): a live 3D shirt preview of the design
            // on the left, the (smaller) Generate/Save stack on the right, all floating
            // directly over the artwork. Image/Animation, Download, and Settings only
            // exist on the full standalone studio (compact=false, see the other branch /
            // pages/StudioPage.jsx's `compact` prop).
            <div
              id="controls-main"
              className={
                'controls-inner controls-compact absolute z-[1] flex flex-col items-center' +
                (controlsBlurred ? ' controls-blurred' : '')
              }
            >
              <div className="dot-grid" aria-hidden />
              {isLoading && <DotRipple />}
              <div className="hero-compact-row flex flex-row items-center gap-4">
                <TshirtPreview
                  size={190}
                  waiting={isLoading}
                  onShopClick={() => this.props.onNavigate?.('/shop')}
                />
                <div className="flex w-[220px] flex-col gap-2.5">
                  <div className="row">
                    <button
                      onClick={this.onGenerateButtonClick.bind(this)}
                      className={'button-large' + (generateDisabled ? ' disabled' : ' enabled')}
                    >
                      {generateDisabled ? 'Generating' : 'Generate'}
                    </button>
                  </div>
                  <div className="row">
                    <button
                      onClick={this.onSaveButtonClick.bind(this)}
                      className="button-small"
                      style={{ width: '100%' }}
                    >
                      {isSaving ? 'Saving' : [isSaved ? 'Saved' : 'Save']}
                    </button>
                  </div>
                  <button
                    onClick={() => this.props.onNavigate?.('/studio', { state: { from: '/' } })}
                    className="go-to-studio-btn"
                  >
                    Go to studio <ArrowIcon />
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <div
              id="controls-main"
              className={
                'controls-inner absolute z-[1] flex min-w-[400px] flex-col justify-center rounded-2xl bg-black/15 p-8 opacity-90 shadow-[0_4px_40px_rgba(0,0,0,0.4)]' +
                (controlsBlurred ? ' controls-blurred' : '')
              }
            >
              {/* Rendered first (not after the last row) so that row stays .row:last-child
                  for the CSS-driven top-margin gap -- this button is position: absolute and
                  out of flow, so its DOM position doesn't affect visible layout. */}
              <button
                onClick={() => this.props.onNavigate?.(returnTo.path)}
                className="go-to-studio-btn"
              >
                <ArrowIcon direction="left" /> {returnTo.label}
              </button>
              <div className="panel-tabs">
                <button
                  className={'panel-tab' + (!animationMode ? ' active' : '')}
                  onClick={() => this.onModeToggle(false)}
                >
                  Image
                </button>
                <button
                  className={'panel-tab' + (animationMode ? ' active' : '')}
                  onClick={() => this.onModeToggle(true)}
                >
                  Animation
                </button>
                <span
                  className="panel-tabs-indicator"
                  style={{ transform: animationMode ? 'translateX(100%)' : 'translateX(0%)' }}
                />
              </div>
              <div className="row">
                <button
                  onClick={this.onGenerateButtonClick.bind(this)}
                  className={'button-large' + (generateDisabled ? ' disabled' : ' enabled')}
                >
                  {generateDisabled
                    ? animationMode
                      ? `Generating ${animationProgress} / ${frameCount}`
                      : 'Generating'
                    : 'Generate'}
                </button>
              </div>
              {animationMode && (generateDisabled || isExporting) && (
                <div className="animation-progress">
                  <div
                    className="animation-progress-bar"
                    style={{
                      width: isExporting
                        ? `${exportProgress}%`
                        : `${(animationProgress / frameCount) * 100}%`
                    }}
                  />
                </div>
              )}
              {animationMode && !threeDMode && settingsDirty && animationFrames.length > 0 && !generateDisabled && (
                <div className="settings-dirty-notice animate-reveal-quick">
                  Regenerate to apply new settings
                </div>
              )}
              {showBranchNotice && (
                <div className="branch-notice animate-reveal-quick">
                  <span>Editing creates a new design — your saved version is unchanged.</span>
                  <button
                    onClick={this.onDismissBranchNotice.bind(this)}
                    aria-label="Dismiss"
                    className="branch-notice-dismiss"
                  >
                    ×
                  </button>
                </div>
              )}
              <div className="row">
                <button
                  onClick={this.onSaveButtonClick.bind(this)}
                  className="button-small"
                  disabled={animationMode && threeDMode}
                  title={animationMode && threeDMode ? '3D animations can’t be saved yet' : undefined}
                  style={animationMode && threeDMode ? { opacity: 0.4, cursor: 'not-allowed' } : {}}
                >
                  {isSaving ? 'Saving' : [isSaved ? 'Saved' : 'Save']}
                </button>
                <button
                  onClick={this.onDownloadButtonClick.bind(this)}
                  className="button-small"
                  disabled={
                    isExporting ||
                    (animationMode && (threeDMode ? !threeDDesign : animationFrames.length === 0))
                  }
                  style={
                    isExporting ||
                    (animationMode && (threeDMode ? !threeDDesign : animationFrames.length === 0))
                      ? { opacity: 0.4, cursor: 'not-allowed' }
                      : {}
                  }
                >
                  {isExporting ? 'Exporting...' : animationMode ? 'Export MP4' : 'Download'}
                </button>
              </div>
              <div className="row">
                {/* Plain clickable h1, not a <button> -- .controls-inner .row button has its
                    own hover treatment (uppercase, fixed height, glow shadow, lift) meant for
                    Generate/Save/Settings, which looked wrong applied to the wordmark. */}
                <StudioWordmark onNavigate={this.props.onNavigate} />
                <button onClick={this.onSettingsButtonClick.bind(this)} className="button-icon">
                  <SettingsButton />
                </button>
              </div>
            </div>
          )}

          <div
            id="controls-settings"
            className={
              'controls-inner controls-settings absolute z-[1] flex min-w-[400px] flex-col justify-center rounded-2xl bg-black/15 p-8 opacity-90 shadow-[0_4px_40px_rgba(0,0,0,0.4)]' +
              (controlsBlurred ? ' controls-visible' : '')
            }
          >
            <div className="settings-tabs">
              <button
                className={'settings-tab-btn' + (settingsTab === 'color' ? ' active' : '')}
                onClick={() => this.setState({ settingsTab: 'color' }, () => this.animateSettingsTab())}
              >
                Color
              </button>
              <button
                className={'settings-tab-btn' + (settingsTab === 'geometry' ? ' active' : '')}
                onClick={() => this.setState({ settingsTab: 'geometry' }, () => this.animateSettingsTab())}
              >
                Geometry
              </button>
              <button
                className={'settings-tab-btn' + (settingsTab === 'video' ? ' active' : '')}
                onClick={() => this.setState({ settingsTab: 'video' }, () => this.animateSettingsTab())}
              >
                Video
              </button>
              {/* profiles.is_admin. `profiles` is world-readable, so this conceals the tab
                  rather than protecting anything -- fine, because nothing behind it is
                  privileged: it only changes what a local export draws. Every consumer of
                  the settings below re-checks isAdmin at the point of use, so a state left
                  on by an admin can't survive into another account's session. */}
              {isAdmin && (
                <button
                  className={'settings-tab-btn' + (settingsTab === 'admin' ? ' active' : '')}
                  onClick={() => this.setState({ settingsTab: 'admin' }, () => this.animateSettingsTab())}
                >
                  Admin
                </button>
              )}
            </div>

            {/* Only the tab BODY scrolls. The tab strip above and the BACK row below stay put
                as fixed rails, which is the whole point: the panel is centred, so before this
                every pixel the screen lost took one off the tabs AND one off BACK at the same
                time -- and nothing in the chain could scroll (the panel was overflow: visible,
                .display-canvas is overflow: hidden, the document has no scroll height), so
                anything past the edge was unreachable rather than merely off-screen. Measured
                at 375x451 the tab strip cleared the top edge completely, stranding you on
                whichever tab you happened to open.

                A wrapper rather than `overflow` on the panel itself, because the panel is
                `justify-center`: a centred flex container that overflows pushes content past
                BOTH edges and scrollTop cannot go negative, so the top would have stayed
                unreachable even with a scrollbar. */}
            <div className="settings-scroll">
            {settingsTab === 'color' && (
              <>
                <div className="row colors">
                  {colors.map(colorObj => (
                    <ColorField
                      color={colorObj.value || colorObj}
                      key={colorObj.id}
                      colorId={colorObj.id}
                      callback={this.onRemoveColorbuttonClick.bind(this)}
                      onReorder={this.onReorderColors.bind(this)}
                      onEdit={() => this.onColorSwatchEdit()}
                    />
                  ))}
                  {colors.length < 6 ? (
                    <button onClick={this.onAddColorButtonClick.bind(this)} className="button-small">
                      ADD COLOR <AddColorButton />
                    </button>
                  ) : (
                    ''
                  )}
                </div>
                <div className="row">
                  <button onClick={this.onClearColors.bind(this)} className="button-small">
                    CLEAR
                  </button>
                  <button onClick={this.onRainbowColors.bind(this)} className="button-small">
                    ADD 🌈
                  </button>
                </div>
              </>
            )}

            {settingsTab === 'geometry' && (
              <>
                <div className="settings-field">
                  <span className="settings-label">
                    Chance
                    <span className="settings-label-note">
                      {' '}
                      {geometrySettings.chance <= 0
                        ? 'never'
                        : geometrySettings.chance >= 1
                          ? 'always'
                          : `${Math.round(geometrySettings.chance * 100)}%`}
                    </span>
                  </span>
                  <input
                    type="range"
                    className="settings-range"
                    min="0"
                    max="100"
                    value={Math.round(geometrySettings.chance * 100)}
                    style={{ '--range-fill': `${Math.round(geometrySettings.chance * 100)}%` }}
                    aria-label="Geometry chance"
                    onChange={e =>
                      this.onGeometrySettingChange({ chance: Number(e.target.value) / 100 })
                    }
                  />
                </div>
                <div className="settings-field">
                  <span className="settings-label">
                    Points
                    <span className="settings-label-note">
                      {' '}
                      {geometrySettings.pointsMin === geometrySettings.pointsMax
                        ? geometrySettings.pointsMin
                        : `${geometrySettings.pointsMin}–${geometrySettings.pointsMax}`}
                    </span>
                  </span>
                  {/* Two stacked native ranges; only the thumbs take pointer events (see
                      components.css), so each thumb drags independently over the shared
                      track. Min and max may meet (pinning the vertex count) but never cross. */}
                  <div
                    className="settings-range-dual"
                    style={{
                      '--range-min': `${((geometrySettings.pointsMin - 3) / 9) * 100}%`,
                      '--range-max': `${((geometrySettings.pointsMax - 3) / 9) * 100}%`
                    }}
                  >
                    <input
                      type="range"
                      min="3"
                      max="12"
                      value={geometrySettings.pointsMin}
                      aria-label="Minimum points"
                      // Whichever thumb was grabbed last stays on top, so repeated touches in
                      // the same spot keep reaching it even once the two thumbs overlap.
                      // Falls back to the old "min sits high" rule before any grab happens.
                      style={
                        this.state.pointsActiveThumb
                          ? this.state.pointsActiveThumb === 'min'
                            ? { zIndex: 4 }
                            : undefined
                          : geometrySettings.pointsMin > 7
                            ? { zIndex: 4 }
                            : undefined
                      }
                      onPointerDown={() => this.setState({ pointsActiveThumb: 'min' })}
                      onChange={e =>
                        this.onGeometrySettingChange({
                          pointsMin: Math.min(Number(e.target.value), geometrySettings.pointsMax)
                        })
                      }
                    />
                    <input
                      type="range"
                      min="3"
                      max="12"
                      value={geometrySettings.pointsMax}
                      aria-label="Maximum points"
                      style={this.state.pointsActiveThumb === 'max' ? { zIndex: 4 } : undefined}
                      onPointerDown={() => this.setState({ pointsActiveThumb: 'max' })}
                      onChange={e =>
                        this.onGeometrySettingChange({
                          pointsMax: Math.max(Number(e.target.value), geometrySettings.pointsMin)
                        })
                      }
                    />
                  </div>
                </div>
                <div className="settings-field">
                  <span className="settings-label">
                    Coherence
                    <span className="settings-label-note">
                      {' '}{Math.round(geometrySettings.coherence * 100)}%
                    </span>
                  </span>
                  <input
                    type="range"
                    className="settings-range"
                    min="0"
                    max="100"
                    value={Math.round(geometrySettings.coherence * 100)}
                    style={{ '--range-fill': `${Math.round(geometrySettings.coherence * 100)}%` }}
                    aria-label="Geometry coherence"
                    onChange={e =>
                      this.onGeometrySettingChange({ coherence: Number(e.target.value) / 100 })
                    }
                  />
                </div>
                <div className="settings-field">
                  <span className="settings-label">
                    Size
                    <span className="settings-label-note">
                      {' '}
                      {geometrySettings.coherence <= 0
                        ? '—'
                        : geometrySettings.size <= 0
                          ? 'small'
                          : geometrySettings.size >= 1
                            ? 'max'
                            : `${Math.round(geometrySettings.size * 100)}%`}
                    </span>
                  </span>
                  <input
                    type="range"
                    className="settings-range"
                    min="0"
                    max="100"
                    value={Math.round(geometrySettings.size * 100)}
                    style={{ '--range-fill': `${Math.round(geometrySettings.size * 100)}%` }}
                    aria-label="Geometry size"
                    onChange={e =>
                      this.onGeometrySettingChange({ size: Number(e.target.value) / 100 })
                    }
                  />
                </div>
                <div className="settings-field">
                  <span className="settings-label">
                    Density
                    <span className="settings-label-note">
                      {' '}
                      {/* Mirror of Size's "—" treatment, opposite condition: Size only bites
                          at coherence > 0, Density only bites while chaotic shapes still
                          survive -- at full coherence none do, so the slider genuinely does
                          nothing and shouldn't imply otherwise. */}
                      {geometrySettings.coherence >= 1
                        ? '—'
                        : `${Math.round(geometrySettings.density * 100)}%`}
                    </span>
                  </span>
                  <input
                    type="range"
                    className="settings-range"
                    min="10"
                    max="100"
                    value={Math.round(geometrySettings.density * 100)}
                    style={{ '--range-fill': `${Math.round(((geometrySettings.density * 100 - 10) / 90) * 100)}%` }}
                    aria-label="Geometry density"
                    onChange={e =>
                      this.onGeometrySettingChange({ density: Number(e.target.value) / 100 })
                    }
                  />
                </div>
              </>
            )}

            {settingsTab === 'video' && (
              <>
                <div className="settings-field">
                  <span className="settings-label">
                    3D
                    <span className="settings-label-note"> fly through a 3D scene</span>
                  </span>
                  <button
                    className={'settings-toggle' + (threeDMode ? ' on' : '')}
                    onClick={this.onThreeDToggle.bind(this)}
                    aria-label={threeDMode ? '3D mode on' : '3D mode off'}
                  >
                    <span className="settings-toggle-thumb" />
                  </button>
                </div>
                {/* Frames / Star Frames only mean anything to the 2D crossfade flow --
                    in 3D the scene is continuous, so they disappear. Duration applies
                    live in 3D (the preview rebuilds instantly), hence no settingsDirty. */}
                {!threeDMode && (
                  <>
                    <div className="settings-field">
                      <span className="settings-label">Frames</span>
                      <div className="settings-stepper">
                        <button onClick={() => { const fc = Math.max(5, frameCount - 1); this.setState({ frameCount: fc, starFrameCount: Math.min(starFrameCount, maxStarFrames(fc)), settingsDirty: true }); }}>−</button>
                        <span>{frameCount}</span>
                        <button onClick={() => this.setState({ frameCount: Math.min(ANIM_LIMIT.frames, frameCount + 1), settingsDirty: true })}>+</button>
                      </div>
                    </div>
                    <div className="settings-field">
                      <span className="settings-label">Star Frames</span>
                      <div className="settings-stepper">
                        <button onClick={() => this.setState({ starFrameCount: Math.max(1, starFrameCount - 1), settingsDirty: true })}>−</button>
                        <span>{starFrameCount}</span>
                        <button onClick={() => this.setState({ starFrameCount: Math.min(maxStarFrames(frameCount), starFrameCount + 1), settingsDirty: true })}>+</button>
                      </div>
                    </div>
                  </>
                )}
                {/* Duration then Speed Ramp: how long a loop runs, then how that time is
                    paced. Both are timing, so they sit together at the end of the
                    scene group -- and the ramp reads as a modifier of the duration above
                    it rather than something unrelated wedged between the frame counts. */}
                <div className="settings-field">
                  <span className="settings-label">Duration</span>
                  <div className="settings-stepper">
                    <button onClick={() => this.setState({ cycleDuration: Math.max(5, cycleDuration - 1), settingsDirty: !threeDMode })}>−</button>
                    <span>{cycleDuration}s</span>
                    <button onClick={() => this.setState({ cycleDuration: Math.min(ANIM_LIMIT.duration, cycleDuration + 1), settingsDirty: !threeDMode })}>+</button>
                  </div>
                </div>
                {/* Playback-time warp only (see the speedRamp state comment) -- frame
                    content is untouched, so this applies live in both modes with no
                    "regenerate to apply" notice. */}
                <div className="settings-field">
                  <span className="settings-label">
                    Speed Ramp
                    <span className="settings-label-note"> ease in and out each loop</span>
                  </span>
                  <button
                    className={'settings-toggle' + (speedRamp ? ' on' : '')}
                    onClick={() => this.setState({ speedRamp: !speedRamp })}
                    aria-label={speedRamp ? 'Speed ramp on' : 'Speed ramp off'}
                  >
                    <span className="settings-toggle-thumb" />
                  </button>
                </div>
                {/* ── Export group ─────────────────────────────────────────────────────
                    Everything above this point describes the animation itself (what the
                    scene is, how long a loop runs, how it's paced); everything below only
                    affects the FILE that Download produces and changes nothing on screen.
                    Music belongs here, not up with the scene controls -- previews are
                    silent, so it has never had any effect except on the exported MP4.
                    The group is marked by a wider gap rather than a heading, which would
                    cost a whole row in a panel Aaron already called cluttered.

                    Ratio and frame rate share ONE row: both answer "what file comes out",
                    and two more full-width rows would crowd this further. */}
                <div className="settings-field settings-group-start">
                  <span className="settings-label">
                    Export
                    {/* No note in the normal case -- "16:9" and "24 fps" already say what
                        the selects do, and the longer text wrapped to a second line at
                        phone width. The one thing worth saying is that 3D re-renders at the
                        picked ratio while 2D crops its pre-rendered frames, and even that
                        only when the pick actually differs from the ratio those frames were
                        built at (16:9 desktop, 1:1 mobile) -- otherwise nothing is cropped
                        and the warning would be a lie. */}
                    {!threeDMode && this.exportWillCrop() && (
                      <span className="settings-label-note"> 2D crops to fit</span>
                    )}
                  </span>
                  <div className="settings-selects">
                    <select
                      className="settings-select"
                      value={exportAspect}
                      onChange={e => this.setState({ exportAspect: e.target.value })}
                      aria-label="Export aspect ratio"
                    >
                      {Object.keys(EXPORT_ASPECTS).map(ratio => (
                        <option key={ratio} value={ratio}>{ratio}</option>
                      ))}
                    </select>
                    <select
                      className="settings-select"
                      value={exportFps}
                      onChange={e => this.setState({ exportFps: Number(e.target.value) })}
                      aria-label="Export frame rate"
                    >
                      {ANIM_LIMIT.fps.map(fps => (
                        <option key={fps} value={fps}>{fps} fps</option>
                      ))}
                    </select>
                  </div>
                </div>
                <div className="settings-field">
                  <span className="settings-label">
                    Music
                    <span className="settings-label-note">
                      {audioExportSupported ? ' added to the export only' : ' unsupported here'}
                    </span>
                  </span>
                  <button
                    className={'settings-toggle' + (musicEnabled && audioExportSupported ? ' on' : '')}
                    onClick={() => audioExportSupported && this.setState({ musicEnabled: !musicEnabled })}
                    aria-label={!audioExportSupported ? 'Music export not supported in this browser' : musicEnabled ? 'Music on' : 'Music off'}
                    style={!audioExportSupported ? { opacity: 0.35, cursor: 'not-allowed' } : {}}
                  >
                    <span className="settings-toggle-thumb" />
                  </button>
                </div>
              </>
            )}
            {settingsTab === 'admin' && isAdmin && (
              <>
                {/* Playback/export only, exactly like Speed Ramp: it draws over finished
                    frames and changes no frame content, so no settingsDirty and no
                    "regenerate to apply" notice. It is not saved with the design either --
                    the mark is derived from the seed, so there is nothing to persist. */}
                <div className="settings-field">
                  <span className="settings-label">
                    Logo
                    <span className="settings-label-note"> flies through the loop seam</span>
                  </span>
                  <button
                    className={'settings-toggle' + (logoMark ? ' on' : '')}
                    onClick={() => this.setState({ logoMark: !logoMark })}
                    aria-label={logoMark ? 'Logo on' : 'Logo off'}
                  >
                    <span className="settings-toggle-thumb" />
                  </button>
                </div>
              </>
            )}
            </div>

            <div className="row">
              <button
                onClick={this.onSettingsCloseButtonClick.bind(this)}
                className="button-medium"
              >
                BACK
              </button>
            </div>
          </div>

          <div
            id="controls-save"
            className={
              'controls-inner controls-settings absolute z-[1] flex min-w-[400px] flex-col justify-center rounded-2xl bg-black/15 p-8 opacity-90 shadow-[0_4px_40px_rgba(0,0,0,0.4)]' +
              (saveVisible ? ' controls-visible' : '')
            }
          >
            {/* Confirmation message -- plain text on the glass, no nested gradient box. */}
            <div className="mb-6">
              {user ? (
                <>
                  {/* 'saving' and 'saved' are one continuous, animated transition (the same
                      session's save completing) -- they share this wrapper so the taller
                      "saved" content's height is reserved from the very first 'saving' frame
                      instead of appearing only once galleryStatus flips, which is what used
                      to force a height change (a container that changes height to fit new
                      content it's swapping in isn't itself smoothly animatable -- opacity is,
                      so the fix is to never need the container to resize at all). Every
                      attempt at timing/easing a height tween across that swap (measuring
                      before/after, then after the real async save) kept leaving some residual
                      pop/clip; not needing one is more robust than continuing to chase it.
                      The OTHER static case below (a design that was already saved when
                      loaded -- isSaved true, galleryStatus never leaves null this session) is
                      a completely separate, non-transitioning display and doesn't need this. */}
                  {(galleryStatus === 'saving' || galleryStatus === 'saved') ? (
                    <div className="relative">
                      {/* Height reserver: the FINAL saved content, in-flow but invisible, so
                          the panel's height is fixed to the (taller) saved copy from the very
                          first 'saving' frame -- the animated overlay below types in place
                          over it and the container never resizes. Same no-resize philosophy
                          as before; only the transition mechanism changed (TextPlugin type-
                          through + a popped-in check, in place of the old crossfade between
                          two separate blocks). */}
                      <div className="pointer-events-none opacity-0" aria-hidden="true">
                        <h6 className="m-0 font-display text-xl font-bold text-neutral-50">
                          Saved to your gallery
                        </h6>
                        <p className="mt-2 text-sm leading-snug text-white/60">
                          {animationMode
                            ? 'Your animation is in your gallery — view it any time.'
                            : 'Your design is in your gallery — view it any time or put it on a product.'}
                        </p>
                      </div>
                      {/* Animated overlay. The title span and subtitle both render their
                          'saving' text statically (never keyed to galleryStatus) so React
                          won't overwrite the text GSAP types onto them once 'saved' lands --
                          same trick as the .share-link-id box. saveToGallery drives the
                          TextPlugin type-through + the check's draw/pop-in. */}
                      <div className="absolute inset-0">
                        <h6 className="m-0 inline-flex items-center gap-2 font-display text-xl font-bold text-neutral-50">
                          <span className="gallery-status-title">Saving…</span>
                          <svg
                            className="gallery-saved-check text-[#a6e000]"
                            viewBox="0 0 24 24"
                            width="18"
                            height="18"
                            fill="none"
                            aria-hidden="true"
                            style={{ opacity: 0 }}
                          >
                            <path
                              d="M4 12.5 L10 18 L20 6"
                              stroke="currentColor"
                              strokeWidth="3"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            />
                          </svg>
                        </h6>
                        <p className="gallery-status-sub mt-2 text-sm leading-snug text-white/60">
                          Adding it to your gallery…
                        </p>
                      </div>
                    </div>
                  ) : (
                    <h6 className="m-0 inline-flex items-center gap-2 font-display text-xl font-bold text-neutral-50">
                      {galleryError && 'Save failed'}
                      {!galleryStatus && !galleryError && (
                        <>
                          Saved to your gallery
                          <svg
                            className="text-[#a6e000]"
                            viewBox="0 0 24 24"
                            width="18"
                            height="18"
                            fill="none"
                            aria-hidden="true"
                          >
                            <path
                              d="M4 12.5 L10 18 L20 6"
                              stroke="currentColor"
                              strokeWidth="3"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            />
                          </svg>
                        </>
                      )}
                    </h6>
                  )}
                  {galleryError && <p className="mt-2 text-sm text-red-300">{galleryError}</p>}
                </>
              ) : (
                <>
                  <h6 className="m-0 font-display text-xl font-bold text-neutral-50">
                    Save your design
                  </h6>
                  <p className="mt-2 text-sm leading-snug text-white/60">
                    Sign in to save this to your gallery, or use Download to keep a copy —
                    share links only exist for saved designs.
                  </p>
                </>
              )}
            </div>

            {/* Primary actions. Explicit gap -- .row's justify-content: space-between alone
                left these touching once both buttons' content filled most of the panel width. */}
            <div className="row gap-3">
              {user ? (
                <button onClick={() => this.props.onNavigate?.('/gallery')} className="button-medium">
                  Gallery
                </button>
              ) : (
                <button onClick={() => this.props.onNavigate?.('/account')} className="button-medium">
                  Sign in
                </button>
              )}
              {/* Animations aren't printable -- the merch pipeline expects a flat
                  { seed, colors } design, not a frames array (same reason the Gallery hides
                  its own "Print this" action for kind === 'animation'). Sending someone to
                  /shop right after saving an animation would land them on a picker that
                  correctly excludes the thing they just saved, which reads as broken rather
                  than intentional. */}
              {!animationMode && (
                <button onClick={() => this.props.onNavigate?.('/shop')} className="button-medium">
                  <span className="inline-flex items-center justify-center gap-1.5">
                    <ShirtIcon size={14} /> Shop
                  </span>
                </button>
              )}
            </div>

            {/* Share link -- shown as soon as a save is in flight (galleryStatus === 'saving')
                or already exists (isSaved && this.shareUrl), never for a signed-out/unsaved
                design (saveToGallery no-ops before ever setting galleryStatus there -- see
                that method). The url prefix (origin + pathname + "?id=") is static and always
                visible the moment the box appears; the id itself -- and therefore the ability
                to actually copy a working link, since onDirectLinkClick checks this.shareUrl
                -- only exists once the real database row does. For a design that arrived
                already-saved (loaded via ?id=) that's instant (the ref callback below sets it
                directly, no animation, since nothing is "completing" this session). For a
                fresh save, it's typed onto the end of the already-visible prefix via GSAP's
                TextPlugin once saveToGallery's row comes back (see that method) -- the same
                text-reveal mechanism ProductPage.jsx's mockup status narration uses -- rather
                than the whole box popping in only once everything is ready. */}
            {(galleryStatus === 'saving' || (isSaved && this.shareUrl)) && (
              <div className="mt-4">
                <div
                  onClick={this.onDirectLinkClick.bind(this)}
                  style={{
                    cursor: this.shareUrl ? 'pointer' : 'default',
                    opacity: this.shareUrl ? 1 : 0.5,
                    transition: 'opacity 0.2s ease-out',
                    padding: '10px',
                    background: 'rgba(0,0,0,0.25)',
                    borderRadius: '4px',
                    maxHeight: '100px',
                    overflow: 'auto',
                    wordBreak: 'break-all',
                    fontSize: '12px',
                    color: 'white'
                  }}
                >
                  {getShareUrlPrefix()}
                  {/* Deliberately no text child here -- same reason as ProductPage.jsx's
                      ScrambleText: TextPlugin needs the DOM's current textContent to still
                      be there when the tween starts, and rendering the id here would let
                      React commit it first, making the tween a same-to-same no-op. First
                      mount always sets *something* directly (never left empty): the real id
                      if one already exists (a design loaded via ?id=, no animation needed),
                      otherwise the placeholder -- which saveToGallery's GSAP call then
                      always has to animate away from, on every save, not just some. */}
                  <span
                    className="share-link-id"
                    ref={el => {
                      if (el && !el.textContent) {
                        el.textContent = this.shareUrl ? this.shareDesignId : SHARE_LINK_ID_PLACEHOLDER;
                      }
                    }}
                  />
                </div>
                {linkCopied && (
                  <span className="alert mt-1.5 inline-flex items-center text-xs font-bold text-[#a6e000] opacity-0">
                    ✓ Copied to clipboard
                  </span>
                )}
                {linkCopyFailed && (
                  <p className="mt-1.5 text-xs text-white/50">
                    Couldn't copy automatically — select the text above and copy it manually.
                  </p>
                )}
              </div>
            )}

            <div className="row">
              <button
                onClick={this.onSettingsCloseButtonClick.bind(this)}
                className="button-medium"
              >
                BACK
              </button>
            </div>
          </div>

        </div>
        {/* Homepage hero (compact) gets its copyright notice from the site's SiteFooter
            instead -- this tiny in-canvas notice is only needed on the standalone /studio
            page, which has no footer of its own. */}
        {!compact && <Copyright />}
      </div>
    );
  }
}
