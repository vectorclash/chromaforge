import React from 'react';
import { gsap } from 'gsap';
import tinycolor from 'tinycolor2';
import saveAs from 'file-saver';
import { Muxer, ArrayBufferTarget } from 'mp4-muxer';

import { generateAudioBuffer } from '../audio/generateAudioBuffer';
import { getConfigFromUrl, generateShareUrl } from '../utils/urlConfig';
import { randomSeed } from '../render/prng';
import { generateArtwork } from '../render/generateArtwork';
import renderArtwork from '../render/renderArtwork';

import Copyright from './Copyright';
import HexagonLoader from './HexagonLoader';
import AnimationPreview from './AnimationPreview';
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

async function encodeAudioTrack(audioBuffer, muxer, audioCodec, onProgress) {
  const left        = audioBuffer.getChannelData(0);
  const right       = audioBuffer.numberOfChannels > 1 ? audioBuffer.getChannelData(1) : left;
  const sampleRate  = audioBuffer.sampleRate;
  const totalFrames = audioBuffer.length;
  const CHUNK_FRAMES = 4096;
  // Estimate output chunks: AAC uses 1024-sample frames, Opus uses 960 or 480.
  const frameSize = audioCodec === 'opus' ? 960 : 1024;
  const totalOutputChunks = Math.ceil(totalFrames / frameSize);
  let outputCount = 0;

  await new Promise((resolve, reject) => {
    const encoder = new AudioEncoder({
      output: (chunk, meta) => {
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
      cycleDuration: 10,
      starFrameCount: 10,
      animationPaused: false,
      settingsTab: 'color',
      animTiming: null,
      settingsDirty: false,
      galleryStatus: null,
      galleryError: null,
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
  }

  componentWillUnmount() {
    if (this.boundOnKeyUp) window.removeEventListener('keyup', this.boundOnKeyUp);
  }

  componentDidUpdate(prevProps) {
    if (
      this.props.initialDesign &&
      this.props.initialDesign !== prevProps.initialDesign &&
      this.props.initialDesign !== this.mainConfig
    ) {
      this.setState({ isLoading: true, generateDisabled: true, isSaved: false });
      const built = this.buildConfig(
        this.props.initialDesign.seed,
        this.props.width,
        this.props.height,
        this.props.initialDesign.colors
      );
      this.buildImage(built);
    }
  }

  async checkAudioExportSupport() {
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    if (isIOS || typeof AudioEncoder === 'undefined' || typeof AudioData === 'undefined') {
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
      gsap.to('.controls-open', { opacity: 1, duration: 0.4, delay: 0.2 });
    }

    const config = getConfigFromUrl();
    if (config) {
      if (config.animation && config.frames) {
        this.setState({
          animationMode: true,
          isLoading: true,
          isSaved: true,
          generateDisabled: true,
          animationProgress: 0
        });
        this.loadAnimationFromConfigs(config.frames);
      } else {
        this.setState({ isLoading: true, isSaved: true });
        this.loadImageFromUrl(config);
      }
    } else if (this.props.initialDesign) {
      // Continuity with whatever's already "active" (e.g. the homepage hero's showcase,
      // via StudioContext.currentDesign) -- render that exact design instead of a fresh
      // random one, so expanding into the full tool doesn't swap the artwork out from
      // under the user. Same seed + colors is a pure function (generateArtwork), so this
      // reproduces it pixel-for-pixel rather than approximating it.
      this.setState({ isLoading: true, generateDisabled: true, isSaved: false });
      const built = this.buildConfig(
        this.props.initialDesign.seed,
        this.props.width,
        this.props.height,
        this.props.initialDesign.colors
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

  // Thin wrapper over the pure generateArtwork() orchestrator. Defaults to a fresh seed
  // at the live on-screen size with the current UI palette; pass explicit args to
  // regenerate a stored design at any size (e.g. portrait print) deterministically.
  buildConfig(
    seed = randomSeed(),
    width = this.props.width,
    height = this.props.height,
    colorValues = null
  ) {
    if (!colorValues) {
      colorValues = this.state.colors.map(c => c.value || c);
    }
    const config = generateArtwork(seed, width, height, colorValues);
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

    return new Promise(resolve => {
      canvas.toBlob(blob => {
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

      canvas.toBlob(blob => {
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
      const starConfig = new GenerateStarField(this.props.width, this.props.height, colorValues.slice());
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
    this.animationConfigs = configs;
    const frames = [];
    const starFrames = [];

    const breathe = () => new Promise(r => setTimeout(r, 700));

    await breathe();

    for (let i = 0; i < configs.length; i++) {
      const blobUrl = await this.buildImageAsBlob(configs[i]);
      frames.push(blobUrl);
      this.setState({ animationProgress: i + 1 });
      if (i < configs.length - 1) await breathe();
    }

    this.changeGradient(configs[configs.length - 1].gradientBackgroundConfig.colors);

    const { starCount } = this.getAnimTiming(configs.length);
    const colorValues = configs[0].gradientBackgroundConfig.colors.slice();
    for (let i = 0; i < starCount; i++) {
      await breathe();
      const starConfig = new GenerateStarField(this.props.width, this.props.height, colorValues.slice());
      const blobUrl = await this.buildStarOnlyBlob(starConfig);
      starFrames.push(blobUrl);
    }

    this.setState({
      animationFrames: frames,
      animationStarFrames: starFrames,
      generateDisabled: false,
      isLoading: false,
      animTiming: this.getAnimTiming(configs.length),
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

  // Persist the design to the signed-in user's gallery -- the primary save action.
  // Silently no-ops when signed out (those users can still grab an optional share link).
  // Delegates the actual save + thumbnail upload to StudioContext.saveCurrentDesign (passed
  // down by StudioPage), shared with the mini-generator widget's Save button.
  async saveToGallery(kind, data) {
    if (!this.props.user) return;

    this.setState({ galleryStatus: 'saving', galleryError: null });
    try {
      await this.props.saveCurrentDesign(kind, data);
      this.setState({ galleryStatus: 'saved' });
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
      duration: 0.2,
      alpha: 0,
      ease: 'power2.inOut'
    });

    this.buildImage(config);
  }

  setImage(blob) {
    this.blob = blob;
    let url = URL.createObjectURL(blob);
    this.imageBlobUrl = url;
    let imageLoader = document.createElement('img');
    imageLoader.src = url;

    imageLoader.addEventListener('load', () => {
      gsap.delayedCall(1, () => {
        let imageContainer = document.querySelector('.image-container');
        imageContainer.style.backgroundImage = 'url(' + url + ')';

        // Animate backdrop-filter from 0 alongside the image fade. Because GSAP updates
        // the inline value every frame, iOS re-composites each frame rather than caching
        // a stale snapshot — so we can run both animations in parallel safely.
        const panel = document.querySelector('#controls-main');
        if (panel) {
          const { blur: cssBlur, brightness: cssBrightness } = this.readBackdropValues(panel);
          panel.style.backdropFilter = 'none';
          const f = { blur: 0, brightness: 1 };
          gsap.to(f, {
            blur: cssBlur, brightness: cssBrightness,
            duration: 0.5,
            ease: 'power2.inOut',
            onUpdate: () => { panel.style.backdropFilter = `blur(${f.blur}px) brightness(${f.brightness})`; },
            onComplete: () => { panel.style.backdropFilter = ''; }
          });
        }

        gsap.to('.image-container', {
          duration: 0.5,
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
    gsap.set(els, { alpha: 0, y: 20 });
    gsap.to(els, { duration: 0.4, alpha: 1, y: 0, stagger: 0.06, ease: 'back.out(1.7)' });
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
          duration: 0.2,
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
      duration: 0.2,
      alpha: 0.5,
      scale: 0.9,
      filter: 'blur(3px)',
      ease: 'back.out(1.7)'
    });

    gsap.from('#controls-save', {
      duration: 0.2,
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

    if (isSaved) {
      // Designs loaded via a share/gallery link arrive with isSaved already true but never
      // went through the generation below, so this.shareUrl can still be unset here.
      if (!this.shareUrl) {
        const loadedData = animationMode
          ? { animation: true, frames: this.animationConfigs }
          : this.mainConfig;
        this.shareUrl = generateShareUrl(loadedData);
      }
      this.openSavePanel();
      return;
    }

    const kind = animationMode ? 'animation' : 'image';
    const data = animationMode
      ? { animation: true, frames: this.animationConfigs }
      : this.mainConfig;
    const ready = animationMode
      ? this.animationConfigs && this.animationConfigs.length > 0
      : !!this.mainConfig;
    if (!ready || isSaving) return;

    // Gallery (DB) save is the primary action; the share link is secondary but always
    // shown (not gated behind an extra click) -- generateShareUrl is synchronous, so this
    // costs nothing to do eagerly.
    this.shareUrl = generateShareUrl(data);
    this.setState({ isSaved: true, isSaving: false });
    this.openSavePanel();
    this.saveToGallery(kind, data); // no-ops when signed out
  }

  onDownloadButtonClick(e) {
    const { animationMode, animationFrames, isExporting } = this.state;

    if (animationMode) {
      if (animationFrames.length > 0 && !isExporting) {
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

    const { animationFrames, animationStarFrames } = this.state;
    this.setState({ isExporting: true, exportProgress: 0 });

    const loadImg = src => new Promise(resolve => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.src = src;
    });

    const [images, starImages] = await Promise.all([
      Promise.all(animationFrames.map(loadImg)),
      Promise.all(animationStarFrames.map(loadImg)),
    ]);

    const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(
      navigator.userAgent
    );

    // Use a smaller export resolution on mobile to stay within iOS memory limits.
    // Full 4K encoding requires ~500 MB+ of GPU/RAM which iOS WebViews don't allow.
    const width  = isMobile ? 1080 : this.props.width;
    const height = isMobile ? 1080 : this.props.height;

    const { spacing: SPACING, fade: FADE, starSpacing: STAR_SPACING, starFade: STAR_FADE, cycleDuration: CYCLE_DURATION } =
      this.getAnimTiming(images.length);
    const SCALE_END = 1.45;
    const TOTAL_VISIBLE = 2 * FADE;
    const STAR_SCALE_END = 1.15;
    const STAR_TOTAL_VISIBLE = 2 * STAR_FADE;
    const PERIOD = CYCLE_DURATION;
    // Export exactly one cycle, starting one period in so start and end states are identical
    const OFFSET = PERIOD;
    const FPS = 24;
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
    }

    if (audioCodec) {
      audioBuffer = await generateAudioBuffer(totalDurationSec, audioSampleRate).catch(e => {
        console.warn('[ChromaForge audio] generateAudioBuffer failed:', e);
        return null;
      });
    }

    const includeAudio = audioBuffer !== null;
    const muxerAudioCodec = audioCodec === 'mp4a.40.2' ? 'aac' : 'opus';

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');

    const easeInOut = t => (t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t);

    const srcWidth  = this.props.width;
    const srcHeight = this.props.height;

    const drawAt = elapsed => {
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
        ctx.drawImage(img, 0, 0, srcWidth, srcHeight, -width / 2, -height / 2, width, height);
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
          ctx.drawImage(img, 0, 0, srcWidth, srcHeight, -width / 2, -height / 2, width, height);
          ctx.restore();
        });
        ctx.globalCompositeOperation = 'source-over';
      }
    };

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
    const bitrate = isMobile ? 15_000_000 : 40_000_000;
    const codecCandidates = [
      'avc1.42E034', // Constrained Baseline, Level 5.2 — no B-frames
      'avc1.42E028', // Constrained Baseline, Level 4.0 — no B-frames (lower-res fallback)
      'avc1.640034', // High Profile, Level 5.2 — may emit B-frames
    ];
    let videoCodec = null;
    for (const c of codecCandidates) {
      const cfg = { codec: c, width, height, bitrate, framerate: FPS, latencyMode: 'realtime' };
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
        // 'realtime' asks the encoder to avoid frame reordering; the Baseline
        // profile above is the structural guarantee, since some Windows
        // encoders ignore this hint.
        latencyMode: 'realtime'
      });
    } catch (e) {
      console.error('VideoEncoder configure failed:', e);
      this.setState({ isExporting: false, exportProgress: 0 });
      alert('MP4 export is not supported in this browser. Try Chrome or Edge on a desktop.');
      return;
    }

    // Encode frame by frame at a fixed timestep (no rAF timing jitter).
    // Back-pressure: if the encoder queue grows too deep, yield until it drains —
    // this prevents unbounded memory buildup that kills iOS tabs.
    for (let f = 0; f < TOTAL_FRAMES; f++) {
      const elapsed = OFFSET + f / FPS;
      drawAt(elapsed);

      const frame = new VideoFrame(canvas, { timestamp: f * FRAME_DURATION_US });
      encoder.encode(frame, { keyFrame: f % FPS === 0 });
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

    canvas.width = 0;
    canvas.height = 0;

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
        console.warn('[ChromaForge] Audio encoding failed:', e);
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
    } catch (e) {
      console.error('[ChromaForge] Export finalize failed:', e);
      alert('Export failed. Please try again.');
    } finally {
      this.setState({ isExporting: false, exportProgress: 0 });
    }
  }

  onGenerateButtonClick(e) {
    const { generateDisabled, animationMode, animationFrames } = this.state;

    if (!generateDisabled) {
      // Clear URL when generating new image
      window.history.pushState({}, '', window.location.pathname);

      if (animationMode) {
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
          duration: 0.2,
          alpha: 0,
          ease: 'power2.inOut'
        });

        this.setState({
          generateDisabled: true,
          isLoading: true,
          isSaved: false,
          animationFrames: [],
          animationStarFrames: [],
          animationProgress: 0,
          animationPaused: false
        });

        this.buildAnimationFrames();
      } else {
        gsap.to('.image-container', {
          duration: 0.2,
          alpha: 0,
          ease: 'power2.inOut'
        });

        this.setState({
          isLoading: true,
          generateDisabled: true,
          isSaved: false
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
        shareUrl: this.shareUrl
      };

      // Restore previous animation state if available
      if (this.animationModeState) {
        const { frames, starFrames, configs, isSaved: wasSaved, shareUrl } = this.animationModeState;
        this.animationModeState = null;
        this.animationConfigs = configs;
        this.shareUrl = shareUrl || null;
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
        gsap.to('.image-container', { duration: 0.2, alpha: 0, ease: 'power2.inOut' });
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
          shareUrl: this.shareUrl
        };
      }
      this.animationConfigs = null;

      // Restore previous image state if available
      if (this.imageModeState && this.imageModeState.blobUrl) {
        const { blob, blobUrl, config, isSaved: wasSaved, shareUrl } = this.imageModeState;
        this.imageModeState = null;
        this.blob = blob;
        this.imageBlobUrl = blobUrl;
        this.mainConfig = config;
        this.shareUrl = shareUrl || null;
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
      gsap.fromTo('.mode-toggle-btn.active',
        { opacity: 0.3, scale: 0.94 },
        { duration: 0.35, opacity: 1, scale: 1, ease: 'back.out(1.7)' }
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
    if (this.props.compact) return;

    const { controlsAreOpen } = this.state;
    this.onSettingsCloseButtonClick();

    if (e.target.tagName !== 'BUTTON' && e.target.tagName !== 'INPUT') {
      if (controlsAreOpen) {
        this.setState({ controlsAreOpen: false });

        gsap.to('#copyright', { duration: 0.3, alpha: 0.2, scale: 0.9, ease: 'power2.inOut' });
        gsap.to('.row, .logo', { duration: 0.2, alpha: 0, ease: 'power2.inOut' });

        const el = document.querySelector('.controls-inner');
        const { blur: cssBlur, brightness: cssBrightness } = this.readBackdropValues(el);
        const panelOut = { blur: cssBlur, brightness: cssBrightness, bgAlpha: 0.15, shadow: 40, shadowAlpha: 0.4 };
        gsap.to(panelOut, {
          blur: 0, brightness: 1, bgAlpha: 0, shadow: 0, shadowAlpha: 0,
          duration: 0.2,
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
          duration: 0.4,
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

        gsap.fromTo('.row, .logo',
          { alpha: 0, y: 42 },
          { duration: 0.5, alpha: 1, y: 0, stagger: 0.05, ease: 'back.out(1.7)' }
        );
      }
    }
  }

  onSettingsButtonClick(e) {
    gsap.to('#controls-main', {
      duration: 0.2,
      alpha: 0.5,
      scale: 0.9,
      filter: 'blur(3px)',
      ease: 'back.out(1.7)'
    });

    gsap.from('#controls-settings', {
      duration: 0.2,
      alpha: 0,
      scale: 1.2,
      ease: 'back.out(1.7)'
    });

    this.setState({ controlsBlurred: true }, () => this.animateSettingsTab());
  }

  onSettingsCloseButtonClick(e) {
    gsap.to('#controls-main', {
      duration: 0.2,
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
    this.setState({ colors: [] });
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
    });
    this.nextColorId = base + 5;
    gsap.delayedCall(0.05, () => this.animateColors());
  }

  onAddColorButtonClick(e) {
    let colors = [...this.state.colors];
    colors.push({
      id: this.nextColorId++,
      value: new tinycolor.random().toHexString()
    });
    this.setState({
      colors: colors
    });

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

    this.setState({
      colors: colors
    });
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

    this.setState({
      colors: colors
    });
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
    gsap.fromTo('.alert', { alpha: 0, y: 10 }, { alpha: 1, y: 0, duration: 0.3, ease: 'bounce.out' });
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
      musicEnabled,
      audioExportSupported,
      settingsTab,
      animTiming,
      settingsDirty,
      galleryStatus,
      galleryError,
    } = this.state;

    // `user` now comes from the auth provider via props (StudioPage), not local state.
    const user = this.props.user;
    const { spacing, fade, starSpacing, starFade } = animTiming ?? this.getAnimTiming();
    const compact = !!this.props.compact;

    return (
      <div
        className="display-canvas fixed left-0 top-0 flex h-full w-full items-center justify-center overflow-hidden"
        ref={mount => {
          this.mount = mount;
        }}
      >
        {isLoading ? <HexagonLoader /> : ''}
        {!compact && (
          <div
            className="controls-open absolute right-[25px] top-[25px] z-10 flex h-[3.5em] w-[3.5em] cursor-pointer items-center justify-center opacity-0 mix-blend-hard-light transition-all duration-300 ease-[ease] [-webkit-tap-highlight-color:transparent]"
            onClick={this.onCloseButtonClick.bind(this)}
          >
            <CloseButton isOpen={controlsAreOpen} />
          </div>
        )}
        <div
          className="image-container absolute left-0 top-0 z-0 h-full w-full bg-cover bg-center bg-no-repeat opacity-0"
          onClick={this.onCloseButtonClick.bind(this)}
        ></div>
        {animationFrames.length > 0 && (
          <AnimationPreview
            frames={animationFrames}
            starFrames={animationStarFrames}
            onClick={this.onCloseButtonClick.bind(this)}
            fade={fade}
            spacing={spacing}
            starFade={starFade}
            starSpacing={starSpacing}
            paused={animationPaused}
          />
        )}
        {animationFrames.length > 0 && (
          <button
            className="animation-pause absolute left-[25px] top-[25px] z-10 flex h-[5em] w-[5em] cursor-pointer items-center justify-center border-none bg-transparent p-0 mix-blend-hard-light transition-all duration-300 ease-[ease] [-webkit-tap-highlight-color:transparent]"
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
            // Homepage hero: a fixed, minimal state -- no glass chrome, no toggle. Image/
            // Animation, Download, and Settings only exist on the full standalone studio
            // (compact=false, see the other branch / pages/StudioPage.jsx's `compact` prop).
            <div
              id="controls-main"
              className={
                'controls-inner absolute z-[1] flex min-w-[400px] flex-col justify-center gap-3 rounded-2xl bg-black/15 p-8 opacity-90 shadow-[0_4px_40px_rgba(0,0,0,0.4)]' +
                (controlsBlurred ? ' controls-blurred' : '')
              }
            >
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
              <div className="row" style={{ justifyContent: 'center' }}>
                <button
                  onClick={() => this.props.onNavigate?.('/studio')}
                  style={{
                    background: 'transparent',
                    border: 'none',
                    boxShadow: 'none',
                    height: 'auto',
                    width: 'auto',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '6px',
                    color: 'var(--color-text-secondary)',
                    cursor: 'pointer',
                    fontFamily: 'var(--font-quicksand)',
                    fontSize: '13px',
                    fontWeight: 600,
                    textTransform: 'none',
                    letterSpacing: 'normal'
                  }}
                >
                  Go to studio <ArrowIcon />
                </button>
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
              <div className="row">
                <div className="mode-toggle">
                  <button
                    className={'mode-toggle-btn' + (!animationMode ? ' active' : '')}
                    onClick={() => this.onModeToggle(false)}
                  >
                    Image
                  </button>
                  <button
                    className={'mode-toggle-btn' + (animationMode ? ' active' : '')}
                    onClick={() => this.onModeToggle(true)}
                  >
                    Animation
                  </button>
                </div>
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
              {animationMode && settingsDirty && animationFrames.length > 0 && !generateDisabled && (
                <div className="settings-dirty-notice">
                  Regenerate to apply new settings
                </div>
              )}
              <div className="row">
                <button
                  onClick={this.onSaveButtonClick.bind(this)}
                  className="button-small"
                >
                  {isSaving ? 'Saving' : [isSaved ? 'Saved' : 'Save']}
                </button>
                <button
                  onClick={this.onDownloadButtonClick.bind(this)}
                  className="button-small"
                  disabled={isExporting || (animationMode && animationFrames.length === 0)}
                  style={
                    isExporting || (animationMode && animationFrames.length === 0)
                      ? { opacity: 0.4, cursor: 'not-allowed' }
                      : {}
                  }
                >
                  {isExporting ? 'Exporting...' : animationMode ? 'Export MP4' : 'Download'}
                </button>
              </div>
              <div className="row">
                <h1>
                  CHROMA<b>FORGE</b>
                </h1>
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
                className={'settings-tab-btn' + (settingsTab === 'video' ? ' active' : '')}
                onClick={() => this.setState({ settingsTab: 'video' }, () => this.animateSettingsTab())}
              >
                Video
              </button>
            </div>

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

            {settingsTab === 'video' && (
              <>
                <div className="settings-field">
                  <span className="settings-label">
                    Include Music
                    {!audioExportSupported && <span className="settings-label-note"> (unsupported)</span>}
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
                <div className="settings-field">
                  <span className="settings-label">Frames</span>
                  <div className="settings-stepper">
                    <button onClick={() => { const fc = Math.max(5, frameCount - 1); this.setState({ frameCount: fc, starFrameCount: Math.min(starFrameCount, fc), settingsDirty: true }); }}>−</button>
                    <span>{frameCount}</span>
                    <button onClick={() => this.setState({ frameCount: Math.min(60, frameCount + 1), settingsDirty: true })}>+</button>
                  </div>
                </div>
                <div className="settings-field">
                  <span className="settings-label">Star Frames</span>
                  <div className="settings-stepper">
                    <button onClick={() => this.setState({ starFrameCount: Math.max(1, starFrameCount - 1), settingsDirty: true })}>−</button>
                    <span>{starFrameCount}</span>
                    <button onClick={() => this.setState({ starFrameCount: Math.min(frameCount, starFrameCount + 1), settingsDirty: true })}>+</button>
                  </div>
                </div>
                <div className="settings-field">
                  <span className="settings-label">Duration</span>
                  <div className="settings-stepper">
                    <button onClick={() => this.setState({ cycleDuration: Math.max(5, cycleDuration - 1), settingsDirty: true })}>−</button>
                    <span>{cycleDuration}s</span>
                    <button onClick={() => this.setState({ cycleDuration: Math.min(60, cycleDuration + 1), settingsDirty: true })}>+</button>
                  </div>
                </div>
              </>
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
                  <h6 className="m-0 font-display text-xl font-bold text-neutral-50">
                    {galleryStatus === 'saving' && 'Saving…'}
                    {galleryStatus === 'saved' && (
                      <>
                        <span className="text-[#a6e000]">✓ </span>Saved to your gallery
                      </>
                    )}
                    {galleryError && 'Save failed'}
                    {!galleryStatus && !galleryError && 'Saved to your gallery'}
                  </h6>
                  {galleryStatus === 'saved' && (
                    <p className="mt-2 text-sm leading-snug text-white/60">
                      Your design is in your gallery — view it any time or put it on a product.
                    </p>
                  )}
                  {galleryError && <p className="mt-2 text-sm text-red-300">{galleryError}</p>}
                </>
              ) : (
                <>
                  <h6 className="m-0 font-display text-xl font-bold text-neutral-50">
                    Save your design
                  </h6>
                  <p className="mt-2 text-sm leading-snug text-white/60">
                    Sign in to save this to your gallery — or create a share link to keep it.
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
              <button onClick={() => this.props.onNavigate?.('/shop')} className="button-medium">
                <span className="inline-flex items-center justify-center gap-1.5">
                  <ShirtIcon size={14} /> Shop
                </span>
              </button>
            </div>

            {/* Share link -- secondary to the gallery save, always visible (generated eagerly
                on save, not gated behind an extra click or a separate button). The box itself
                is the click target, with a small inline indicator on success. */}
            <div className="mt-4">
              <div
                onClick={this.onDirectLinkClick.bind(this)}
                style={{
                  cursor: 'pointer',
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
                {this.shareUrl}
              </div>
              {linkCopied && (
                <span className="mt-1.5 inline-flex items-center text-xs font-bold text-[#a6e000]">
                  ✓ Copied to clipboard
                </span>
              )}
              {linkCopyFailed && (
                <p className="mt-1.5 text-xs text-white/50">
                  Couldn't copy automatically — select the text above and copy it manually.
                </p>
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

        </div>
        <Copyright />
      </div>
    );
  }
}
