import React from 'react';
import { gsap, Quad, Back, Bounce } from 'gsap';
import tinycolor from 'tinycolor2';
import saveAs from 'file-saver';

import './DisplayCanvas.scss';
import { getConfigFromUrl, generateShareUrl } from '../utils/urlConfig';

import Copyright from './Copyright';
import HexagonLoader from './HexagonLoader';
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
      linkCopied: false
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
      this.setState({
        isLoading: true,
        isSaved: true
      });
      this.loadImageFromUrl(config);
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

    this.buildImage(this.mainConfig);
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
    const { isSaving, isSaved } = this.state;

    if (this.mainConfig && !isSaved && !isSaving) {
      this.setState({
        isSaving: true,
        isLoading: true
      });

      this.saveImageToUrl();
    }

    if (isSaved) {
      this.openSavePanel();
    }
  }

  onDownloadButtonClick(e) {
    if (this.blob) {
      const filename = FileName();
      saveAs(this.blob, filename + '.jpg');
    }
  }

  onGenerateButtonClick(e) {
    const { generateDisabled } = this.state;

    if (!generateDisabled) {
      gsap.to('.image-container', {
        duration: 0.2,
        alpha: 0,
        ease: Quad.easeInOut
      });

      this.setState({
        isLoading: true,
        isSaved: false
      });

      // Clear URL when generating new image
      window.history.pushState({}, '', window.location.pathname);

      this.buildConfig();
    }
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
      linkCopied
    } = this.state;

    return (
      <div
        className="display-canvas"
        ref={mount => {
          this.mount = mount;
        }}
      >
        {isLoading ? <HexagonLoader /> : ''}
        <div className="controls-open" onClick={this.onCloseButtonClick.bind(this)}>
          <CloseButton isOpen={controlsAreOpen} />
        </div>
        <div className="image-container" onClick={this.onCloseButtonClick.bind(this)}></div>
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
              <button
                onClick={this.onGenerateButtonClick.bind(this)}
                className={'button-large' + (generateDisabled ? ' disabled' : ' enabled')}
              >
                {generateDisabled ? 'Generating' : 'Generate'}
              </button>
            </div>
            <div className="row">
              <button onClick={this.onSaveButtonClick.bind(this)} className="button-small">
                {isSaving ? 'Saving' : [isSaved ? 'Saved' : 'Save']}
              </button>
              <button onClick={this.onDownloadButtonClick.bind(this)} className="button-small">
                Download
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
