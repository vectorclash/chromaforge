import React from 'react';
import { gsap, Quad, Back, Bounce } from 'gsap';
import tinycolor from 'tinycolor2';
import saveAs from 'file-saver';
import { Muxer, ArrayBufferTarget } from 'mp4-muxer';

import './DisplayCanvas.scss';
import { getConfigFromUrl, generateShareUrl } from '../utils/urlConfig';

import Copyright from './Copyright';
import HexagonLoader from './HexagonLoader';
import AnimationPreview from './AnimationPreview';
import CloseButton from './buttons/CloseButton';
import LinearGradient from './Canvas/LinearGradient';
import GenerateLinearGradient from './Canvas/GenerateLinearGradient';
import LargeRadialField from './Canvas/LargeRadialField';
import GenerateLargeRadialField from './Canvas/GenerateLargeRadialField';
import GenerateStarField from './Canvas/GenerateStarField';
import StarField from './Canvas/StarField';
import GenerateGeometricShape from './Canvas/GenerateGeometricShape';
import GeometricShape from './Canvas/GeometricShape';
import FileName from './FileNameGenerator';
import SettingsButton from './buttons/SettingsButton';
import AddColorButton from './buttons/AddColorButton';
import ColorField from './ColorField';

import s1 from '../assets/images/star-sprite-large.png';
import s2 from '../assets/images/star-sprite-small.png';

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
      animationMode: false,
      animationFrames: [],
      animationProgress: 0,
      isExporting: false,
      exportProgress: 0
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
  }

  init() {
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
    } else {
      this.onGenerateButtonClick();
    }

    window.addEventListener('keyup', this.onKeyUp.bind(this));
  }

  buildConfig() {
    this.mainConfig = {};
    this.mainConfig.width = this.props.width;
    this.mainConfig.height = this.props.height;

    // Convert color objects to color values array
    const colorValues = this.state.colors.map(c => c.value || c);

    let gradientBackgroundConfig = new GenerateLinearGradient(
      this.props.width,
      this.props.height,
      1,
      colorValues.slice()
    );
    this.mainConfig.gradientBackgroundConfig = gradientBackgroundConfig;

    let radialChance = Math.random();

    if (radialChance > 0.4) {
      this.mainConfig.firstBlend = this.randomBlendMode();

      let radialFieldConfig = new GenerateLargeRadialField(
        this.props.width,
        this.props.height,
        colorValues.slice()
      );
      this.mainConfig.radialFieldConfig = radialFieldConfig;
    }

    this.mainConfig.secondBlend = this.randomBlendMode();

    let starFieldConfig = new GenerateStarField(
      this.props.width,
      this.props.height,
      colorValues.slice()
    );
    this.mainConfig.starFieldConfig = starFieldConfig;

    let geometryChance = Math.random();

    if (geometryChance >= 0.6) {
      this.mainConfig.thirdBlend = this.randomBlendMode();

      let geometryConfig = new GenerateGeometricShape(
        this.props.width,
        this.props.height,
        10 + Math.round(Math.random() * 30),
        colorValues.slice()
      );
      this.mainConfig.geometryConfig = geometryConfig;
    }

    let overlayChance = Math.random();

    if (overlayChance >= 0.7 && this.state.colors.length > 0) {
      this.mainConfig.overlayBlend = this.randomBlendMode();
      this.mainConfig.overlayAlpha = Math.random().toFixed(2);
      let overlayConfig = new GenerateLinearGradient(
        this.props.width,
        this.props.height,
        Math.round(Math.random() * 2),
        colorValues.slice()
      );
      this.mainConfig.overlayConfig = overlayConfig;
    }

    return this.mainConfig;
  }

  buildImage(config) {
    let canvas = document.createElement('canvas');
    let context = canvas.getContext('2d');

    canvas.width = config.width;
    canvas.height = config.height;

    this.setState({
      generateDisabled: true,
      linkCopied: false
    });

    let gradientBackground = LinearGradient(config.gradientBackgroundConfig);
    context.drawImage(gradientBackground, 0, 0);
    this.clearElement(gradientBackground);

    // change buttons to match backgroundImage
    this.changeGradient(config.gradientBackgroundConfig.colors);
    //

    if (config.radialFieldConfig) {
      context.globalCompositeOperation = config.firstBlend;

      let radialField = LargeRadialField(config.radialFieldConfig);
      context.drawImage(radialField, 0, 0);
      this.clearElement(radialField);
    }

    context.globalCompositeOperation = config.secondBlend;

    let starField = StarField(config.starFieldConfig, this.queue);
    context.drawImage(starField, 0, 0);
    this.clearElement(starField);

    if (config.geometryConfig) {
      context.globalCompositeOperation = config.thirdBlend;

      let geometry = GeometricShape(config.geometryConfig);
      context.drawImage(geometry, 0, 0);
      this.clearElement(geometry);
    }

    if (config.overlayConfig) {
      context.globalCompositeOperation = config.overlayBlend;
      context.globalAlpha = config.overlayAlpha;

      let gradientOverlay = LinearGradient(config.overlayConfig);
      context.drawImage(gradientOverlay, 0, 0);
      this.clearElement(gradientOverlay);
    }

    canvas.toBlob(this.setImage.bind(this), 'image/jpeg', 0.98);

    this.clearElement(canvas);
  }

  clearElement(element) {
    element.width = 0;
    element.height = 0;
    element = null;
  }

  buildImageAsBlob(config) {
    return new Promise(resolve => {
      let canvas = document.createElement('canvas');
      let context = canvas.getContext('2d');
      canvas.width = config.width;
      canvas.height = config.height;

      let gradientBackground = LinearGradient(config.gradientBackgroundConfig);
      context.drawImage(gradientBackground, 0, 0);
      this.clearElement(gradientBackground);

      if (config.radialFieldConfig) {
        context.globalCompositeOperation = config.firstBlend;
        let radialField = LargeRadialField(config.radialFieldConfig);
        context.drawImage(radialField, 0, 0);
        this.clearElement(radialField);
      }

      context.globalCompositeOperation = config.secondBlend;
      let starField = StarField(config.starFieldConfig, this.queue);
      context.drawImage(starField, 0, 0);
      this.clearElement(starField);

      if (config.geometryConfig) {
        context.globalCompositeOperation = config.thirdBlend;
        let geometry = GeometricShape(config.geometryConfig);
        context.drawImage(geometry, 0, 0);
        this.clearElement(geometry);
      }

      if (config.overlayConfig) {
        context.globalCompositeOperation = config.overlayBlend;
        context.globalAlpha = config.overlayAlpha;
        let gradientOverlay = LinearGradient(config.overlayConfig);
        context.drawImage(gradientOverlay, 0, 0);
        this.clearElement(gradientOverlay);
      }

      canvas.toBlob(blob => {
        this.clearElement(canvas);
        resolve(URL.createObjectURL(blob));
      }, 'image/jpeg', 0.98);
    });
  }

  async buildAnimationFrames() {
    const FRAME_COUNT = 6;
    const frames = [];
    this.animationConfigs = [];

    for (let i = 0; i < FRAME_COUNT; i++) {
      const config = this.buildConfig();
      this.animationConfigs.push(config);
      const blobUrl = await this.buildImageAsBlob(config);
      frames.push(blobUrl);
      this.setState({ animationProgress: i + 1 });
    }

    this.changeGradient(this.mainConfig.gradientBackgroundConfig.colors);

    this.setState({
      animationFrames: frames,
      generateDisabled: false,
      isLoading: false
    });
  }

  async loadAnimationFromConfigs(configs) {
    this.animationConfigs = configs;
    const frames = [];

    for (let i = 0; i < configs.length; i++) {
      const blobUrl = await this.buildImageAsBlob(configs[i]);
      frames.push(blobUrl);
      this.setState({ animationProgress: i + 1 });
    }

    this.changeGradient(configs[configs.length - 1].gradientBackgroundConfig.colors);

    this.setState({
      animationFrames: frames,
      generateDisabled: false,
      isLoading: false
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

  saveAnimationToUrl() {
    const shareUrl = generateShareUrl({ animation: true, frames: this.animationConfigs });

    if (shareUrl) {
      this.shareUrl = shareUrl;
      this.setState({ isSaved: true, isSaving: false, isLoading: false });
      this.openSavePanel();
    } else {
      this.setState({ isSaved: false, isSaving: false });
      console.error('Failed to generate animation share URL');
    }
  }

  saveImageToUrl() {
    const shareUrl = generateShareUrl(this.mainConfig);

    if (shareUrl) {
      this.shareUrl = shareUrl;

      this.setState({
        isSaved: true,
        isSaving: false,
        isLoading: false
      });

      this.openSavePanel();
    } else {
      this.setState({
        isSaved: false,
        isSaving: false
      });
      console.error('Failed to generate share URL');
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
      ease: Quad.easeInOut
    });

    this.buildImage(config);
  }

  setImage(blob) {
    this.blob = blob;
    let url = URL.createObjectURL(blob);
    let imageLoader = document.createElement('img');
    imageLoader.src = url;

    imageLoader.addEventListener('load', () => {
      gsap.delayedCall(1, () => {
        let imageContainer = document.querySelector('.image-container');
        imageContainer.style.backgroundImage = 'url(' + url + ')';

        gsap.to('.image-container', {
          duration: 0.2,
          alpha: 1,
          ease: Quad.easeInOut
        });

        this.setState({
          generateDisabled: false,
          isLoading: false
        });
      });
    });
  }

  randomBlendMode() {
    const blendModes = [
      'screen',
      'overlay',
      'multiply',
      'hard-light',
      'lighten',
      'darken',
      'soft-light',
      'source-over'
    ];

    let randomBlendMode = Math.floor(Math.random() * blendModes.length);
    return blendModes[randomBlendMode];
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
          ease: Back.easeOut
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
      ease: Back.easeOut
    });

    gsap.from('#controls-save', {
      duration: 0.2,
      alpha: 0,
      scale: 1.2,
      ease: Back.easeOut
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
      ease: Bounce.easeOut
    });

    gsap.to('input', {
      duration: 0.1,
      scale: 1,
      rotation: 0,
      skewY: 0,
      ease: Bounce.easeOut,
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
      this.openSavePanel();
      return;
    }

    if (animationMode) {
      if (this.animationConfigs && this.animationConfigs.length > 0 && !isSaving) {
        this.setState({ isSaving: true });
        this.saveAnimationToUrl();
      }
    } else {
      if (this.mainConfig && !isSaving) {
        this.setState({ isSaving: true, isLoading: true });
        this.saveImageToUrl();
      }
    }
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

    const { animationFrames } = this.state;
    this.setState({ isExporting: true, exportProgress: 0 });

    const images = await Promise.all(
      animationFrames.map(
        src =>
          new Promise(resolve => {
            const img = new Image();
            img.onload = () => resolve(img);
            img.src = src;
          })
      )
    );

    const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(
      navigator.userAgent
    );

    // Use a smaller export resolution on mobile to stay within iOS memory limits.
    // Full 4K encoding requires ~500 MB+ of GPU/RAM which iOS WebViews don't allow.
    const width  = isMobile ? 1080 : this.props.width;
    const height = isMobile ? 1080 : this.props.height;

    const FADE    = 3.0;
    const SPACING = 2.0; // must match AnimationPreview.js
    const SCALE_END = 1.45;
    const TOTAL_VISIBLE = 2 * FADE;
    // Ends when frame 0's return reaches full opacity — mirrors the opening state
    const CYCLE_DURATION = images.length * SPACING + FADE;
    const FPS = 24;
    const TOTAL_FRAMES = Math.ceil(CYCLE_DURATION * FPS);
    const FRAME_DURATION_US = Math.round(1_000_000 / FPS);

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');

    const easeInOut = t => (t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t);

    // Append frame 0 at the end so the last crossfade loops back to the first image
    const exportFrames = [...images, images[0]];

    const srcWidth  = this.props.width;
    const srcHeight = this.props.height;

    const drawAt = elapsed => {
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, width, height);
      exportFrames.forEach((img, i) => {
        // Frame 0 (first appearance) is already at full opacity — no fade from black.
        // Its fade-out starts at FADE seconds. Every other frame uses SPACING-based starts.
        const fadeOutStart = i === 0 ? FADE : i * SPACING + FADE;
        const fadeInStart  = fadeOutStart - FADE;
        const endTime      = fadeOutStart + FADE;

        if (elapsed >= endTime) return;
        if (elapsed < fadeInStart) return;

        let opacity;
        if (i === 0 && elapsed < FADE) {
          opacity = 1; // starts fully visible
        } else if (elapsed < fadeOutStart) {
          opacity = easeInOut((elapsed - fadeInStart) / FADE);
        } else {
          opacity = easeInOut(1 - (elapsed - fadeOutStart) / FADE);
        }

        const scaleElapsed = elapsed - fadeInStart;
        const scale = 1 + (SCALE_END - 1) * Math.min(1, scaleElapsed / TOTAL_VISIBLE);

        ctx.save();
        ctx.globalAlpha = Math.max(0, Math.min(1, opacity));
        ctx.translate(width / 2, height / 2);
        ctx.scale(scale, scale);
        // Draw source image scaled to the export canvas size
        ctx.drawImage(img, 0, 0, srcWidth, srcHeight, -width / 2, -height / 2, width, height);
        ctx.restore();
      });
    };

    // mp4-muxer + WebCodecs VideoEncoder — guarantees real H.264 MP4
    const target = new ArrayBufferTarget();
    const muxer = new Muxer({
      target,
      video: { codec: 'avc', width, height },
      fastStart: 'in-memory'
    });

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
        codec: 'avc1.4d0034', // H.264 Main Profile Level 5.2
        width,
        height,
        bitrate: isMobile ? 6_000_000 : 12_000_000,
        framerate: FPS
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
      const elapsed = f / FPS;
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

    // encoder.flush() has no progress callbacks — animate the bar from 90→99%
    // so it keeps visibly moving while we wait
    let fakeProgress = 90;
    const crawl = setInterval(() => {
      fakeProgress += (99 - fakeProgress) * 0.15; // asymptotic: approaches 99 but never reaches it
      this.setState({ exportProgress: Math.round(fakeProgress) });
    }, 200);

    await encoder.flush();
    clearInterval(crawl);

    muxer.finalize();

    this.setState({ exportProgress: 100 });
    const blob = new Blob([target.buffer], { type: 'video/mp4' });
    saveAs(blob, `${FileName()}-animation.mp4`);
    this.setState({ isExporting: false, exportProgress: 0 });
  }

  onGenerateButtonClick(e) {
    const { generateDisabled, animationMode, animationFrames } = this.state;

    if (!generateDisabled) {
      // Clear URL when generating new image
      window.history.pushState({}, '', window.location.pathname);

      if (animationMode) {
        // Revoke existing blob URLs to free memory
        animationFrames.forEach(url => URL.revokeObjectURL(url));

        this.setState({
          generateDisabled: true,
          isLoading: true,
          isSaved: false,
          animationFrames: [],
          animationProgress: 0
        });

        this.buildAnimationFrames();
      } else {
        gsap.to('.image-container', {
          duration: 0.2,
          alpha: 0,
          ease: Quad.easeInOut
        });

        this.setState({
          isLoading: true,
          isSaved: false
        });

        const config = this.buildConfig();
        this.buildImage(config);
      }
    }
  }

  onModeToggle(mode) {
    const { animationFrames } = this.state;

    // Revoke blob URLs when leaving animation mode
    if (!mode && animationFrames.length > 0) {
      animationFrames.forEach(url => URL.revokeObjectURL(url));
    }

    this.animationConfigs = null;

    this.setState({
      animationMode: mode,
      animationFrames: [],
      animationProgress: 0,
      isSaved: false
    });
  }

  onCloseButtonClick(e) {
    const { controlsAreOpen } = this.state;
    this.onSettingsCloseButtonClick();

    if (e.target.tagName !== 'BUTTON' && e.target.tagName !== 'INPUT') {
      if (controlsAreOpen) {
        this.setState({
          controlsAreOpen: false
        });

        gsap.to('#copyright', {
          duration: 0.3,
          alpha: 0.2,
          scale: 0.9,
          ease: Quad.easeInOut
        });

        gsap.to('.controls-container', {
          duration: 0.3,
          alpha: 0,
          ease: Quad.easeInOut,
          onComplete: () => {
            gsap.set('.controls-container', {
              display: 'none'
            });
          }
        });
      } else {
        this.setState({
          controlsAreOpen: true
        });

        gsap.to('#copyright', {
          duration: 1,
          alpha: 0.5,
          scale: 1,
          ease: Back.easeOut
        });

        gsap.to('.controls-container', {
          duration: 0.3,
          alpha: 1,
          ease: Quad.easeInOut,
          onStart: () => {
            gsap.set('.controls-container', {
              display: 'flex'
            });
          }
        });

        gsap.from('.row, .logo', {
          duration: 0.5,
          alpha: 0,
          y: 42,
          stagger: 0.05,
          ease: Back.easeOut
        });
      }
    }
  }

  onSettingsButtonClick(e) {
    gsap.to('#controls-main', {
      duration: 0.2,
      alpha: 0.5,
      scale: 0.9,
      filter: 'blur(3px)',
      ease: Back.easeOut
    });

    gsap.from('#controls-settings', {
      duration: 0.2,
      alpha: 0,
      scale: 1.2,
      ease: Back.easeOut
    });

    this.setState({
      controlsBlurred: true
    });
  }

  onSettingsCloseButtonClick(e) {
    gsap.to('#controls-main', {
      duration: 0.2,
      alpha: 0.9,
      scale: 1,
      filter: 'blur(0px)',
      ease: Back.easeOut,
      onComplete: () => {
        this.updateColors();
      }
    });

    this.setState({
      controlsBlurred: false,
      saveVisible: false,
      linkCopied: false
    });
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

    // Remove the dragged item
    const [draggedItem] = colors.splice(draggedIndex, 1);

    // Find the new target index (it may have shifted after removal)
    const newTargetIndex = colors.findIndex(c => c.id === targetColorId);

    // Insert the dragged item at the target position
    colors.splice(newTargetIndex, 0, draggedItem);

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
    if (isSaved && this.shareUrl) {
      navigator.clipboard.writeText(this.shareUrl).then(
        function () {
          this.setState({ linkCopied: true });
          gsap.fromTo(
            '.alert',
            {
              alpha: 0,
              y: 10
            },
            {
              alpha: 1,
              y: 0,
              duration: 0.3,
              ease: Bounce.easeOut
            }
          );
        }.bind(this),
        function () {
          console.log('Copy Error');
        }
      );
    }
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
      animationMode,
      animationFrames,
      animationProgress,
      isExporting,
      exportProgress
    } = this.state;

    return (
      <div
        className="display-canvas"
        ref={mount => {
          this.mount = mount;
        }}
      >
        {isLoading && !animationMode ? <HexagonLoader /> : ''}
        <div className="controls-open" onClick={this.onCloseButtonClick.bind(this)}>
          <CloseButton isOpen={controlsAreOpen} />
        </div>
        <div className="image-container" onClick={this.onCloseButtonClick.bind(this)}></div>
        {animationFrames.length > 0 && (
          <AnimationPreview
            frames={animationFrames}
            onClick={this.onCloseButtonClick.bind(this)}
          />
        )}
        <div className="controls-container">
          {controlsAreOpen ? (
            <div
              className="controls-background-click"
              onClick={this.onCloseButtonClick.bind(this)}
            ></div>
          ) : (
            ''
          )}
          <div
            id="controls-main"
            className={'controls-inner' + (controlsBlurred ? ' controls-blurred' : '')}
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
                    ? `Building ${animationProgress} / 6`
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
                      : `${(animationProgress / 6) * 100}%`
                  }}
                />
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

          <div
            id="controls-settings"
            className={
              'controls-inner controls-settings' + (controlsBlurred ? ' controls-visible' : '')
            }
          >
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
              'controls-inner controls-settings' + (saveVisible ? ' controls-visible' : '')
            }
          >
            <div className="row text-container">
              <h6>Shareable Link Created</h6>
              <p>
                Click the link below to copy it to your clipboard. Anyone with this link can view
                and recreate this image.
              </p>
              <div
                onClick={this.onDirectLinkClick.bind(this)}
                style={{
                  cursor: 'pointer',
                  padding: '10px',
                  background: 'rgba(0,0,0,0.2)',
                  borderRadius: '4px',
                  maxHeight: '100px',
                  overflow: 'auto',
                  wordBreak: 'break-all',
                  fontSize: '12px',
                  marginBottom: '10px'
                }}
              >
                {this.shareUrl || 'Generating link...'}
              </div>
              {linkCopied ? <p className="alert">Link copied to clipboard</p> : ''}
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
