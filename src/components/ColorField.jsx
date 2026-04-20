import gsap from 'gsap/gsap-core';
import React from 'react';
// import gsap from 'gsap'
import tinycolor from 'tinycolor2';
import CloseColorButton from './buttons/CloseColorButton';

import './ColorField.scss';

export default class ColorField extends React.Component {
  componentDidMount() {
    window.jscolor.install();
    this.adjustColor(this.props.color);
  }

  adjustColor(color) {
    if (tinycolor(color).isLight()) {
      gsap.set(this.mount.querySelector('.color'), {
        color: '#333333'
      });

      gsap.set(this.mount.querySelector('svg'), {
        fill: '#333333'
      });
    } else if (tinycolor(color).isDark()) {
      gsap.set(this.mount.querySelector('.color'), {
        color: '#FAFAFA'
      });

      gsap.set(this.mount.querySelector('svg'), {
        fill: '#FAFAFA'
      });
    }
  }

  onCloseClick() {
    this.props.callback(this.props.colorId);
  }

  onColorInput(e) {
    this.adjustColor(e.target.value);
  }

  getPointerPosition(e) {
    // Handle both mouse and touch events
    if (e.touches && e.touches.length > 0) {
      return {
        clientX: e.touches[0].clientX,
        clientY: e.touches[0].clientY
      };
    }
    return {
      clientX: e.clientX,
      clientY: e.clientY
    };
  }

  startDrag(e) {
    // Only start drag from the drag handle
    const target = e.target || (e.touches && e.touches[0].target);
    if (!target || !target.classList.contains('color-drag-handle')) {
      return;
    }

    e.preventDefault();

    this.isDragging = true;
    const pos = this.getPointerPosition(e);
    this.startX = pos.clientX;
    this.startY = pos.clientY;

    // Get initial position
    const rect = this.mount.getBoundingClientRect();
    this.initialX = rect.left;
    this.initialY = rect.top;

    // Create a clone for visual dragging
    this.dragClone = this.mount.cloneNode(true);
    this.dragClone.classList.add('drag-clone');
    this.dragClone.style.position = 'fixed';
    this.dragClone.style.left = rect.left + 'px';
    this.dragClone.style.top = rect.top + 'px';
    this.dragClone.style.width = rect.width + 'px';
    this.dragClone.style.height = rect.height + 'px';
    this.dragClone.style.pointerEvents = 'none';
    this.dragClone.style.zIndex = '1000';

    // Copy ALL computed styles from the original container
    const originalStyle = window.getComputedStyle(this.mount);
    this.dragClone.style.border = originalStyle.border;
    this.dragClone.style.borderRadius = originalStyle.borderRadius;
    this.dragClone.style.boxShadow = originalStyle.boxShadow;
    this.dragClone.style.transform = originalStyle.transform;

    // Copy essential styles from the original input to maintain appearance
    const originalInput = this.mount.querySelector('.color');
    const cloneInput = this.dragClone.querySelector('.color');
    if (originalInput && cloneInput) {
      const computedStyle = window.getComputedStyle(originalInput);
      cloneInput.style.width = '100%';
      cloneInput.style.height = computedStyle.height;
      cloneInput.style.backgroundColor = computedStyle.backgroundColor;
      cloneInput.style.color = computedStyle.color;
      cloneInput.style.border = computedStyle.border;
      cloneInput.style.borderRadius = computedStyle.borderRadius;
      cloneInput.style.borderColor = computedStyle.borderColor;
      cloneInput.style.boxShadow = computedStyle.boxShadow;
      cloneInput.style.textAlign = 'center';
      cloneInput.style.paddingLeft = '30px';
      cloneInput.style.paddingRight = '30px';
      cloneInput.style.fontSize = computedStyle.fontSize;
      cloneInput.style.fontWeight = 'bold';
      cloneInput.style.fontFamily = computedStyle.fontFamily;
      cloneInput.style.letterSpacing = computedStyle.letterSpacing;
      cloneInput.style.boxSizing = 'border-box';
    }

    // Copy styles from drag handle
    const originalHandle = this.mount.querySelector('.color-drag-handle');
    const cloneHandle = this.dragClone.querySelector('.color-drag-handle');
    if (originalHandle && cloneHandle) {
      const computedStyle = window.getComputedStyle(originalHandle);
      cloneHandle.style.position = computedStyle.position;
      cloneHandle.style.left = computedStyle.left;
      cloneHandle.style.top = computedStyle.top;
      cloneHandle.style.width = computedStyle.width;
      cloneHandle.style.height = computedStyle.height;
      cloneHandle.style.color = computedStyle.color;
    }

    // Copy styles from close button
    const originalCloseButton = this.mount.querySelector('.color-close-button');
    const cloneCloseButton = this.dragClone.querySelector('.color-close-button');
    if (originalCloseButton && cloneCloseButton) {
      const computedStyle = window.getComputedStyle(originalCloseButton);
      cloneCloseButton.style.position = computedStyle.position;
      cloneCloseButton.style.right = computedStyle.right;
      cloneCloseButton.style.top = computedStyle.top;
      cloneCloseButton.style.width = computedStyle.width;
      cloneCloseButton.style.height = computedStyle.height;
    }

    const originalClose = this.mount.querySelector('.color-close-button svg');
    const cloneClose = this.dragClone.querySelector('.color-close-button svg');
    if (originalClose && cloneClose) {
      const computedStyle = window.getComputedStyle(originalClose);
      cloneClose.style.fill = computedStyle.fill;
    }

    document.body.appendChild(this.dragClone);

    // Add dragging class to original
    this.mount.classList.add('dragging');

    // Add listeners for both mouse and touch
    document.addEventListener('mousemove', this.onMouseMove.bind(this));
    document.addEventListener('mouseup', this.onMouseUp.bind(this));
    document.addEventListener('touchmove', this.onTouchMove.bind(this), { passive: false });
    document.addEventListener('touchend', this.onTouchEnd.bind(this));
  }

  onMouseDown(e) {
    this.startDrag(e);
  }

  onTouchStart(e) {
    this.startDrag(e);
  }

  handleMove(e) {
    if (!this.isDragging || !this.dragClone) return;

    e.preventDefault();

    const pos = this.getPointerPosition(e);
    const deltaX = pos.clientX - this.startX;
    const deltaY = pos.clientY - this.startY;

    this.dragClone.style.left = this.initialX + deltaX + 'px';
    this.dragClone.style.top = this.initialY + deltaY + 'px';

    // Check if we're over another color container
    const elements = document.elementsFromPoint(pos.clientX, pos.clientY);
    const targetContainer = elements.find(el => {
      // Must be a color-container
      if (!el.classList.contains('color-container')) return false;
      // Must not be the clone
      if (el.classList.contains('drag-clone')) return false;
      // Must not be the currently dragging element
      if (el === this.mount) return false;
      // Must have a valid color ID
      const colorId = el.getAttribute('data-color-id');
      if (!colorId) return false;

      return true;
    });

    // Clear previous hover states
    document.querySelectorAll('.color-container.drag-over').forEach(el => {
      if (el !== targetContainer) {
        el.classList.remove('drag-over');
      }
    });

    // Add hover state to current target
    if (targetContainer) {
      targetContainer.classList.add('drag-over');
      this.dropTarget = targetContainer;
    } else {
      this.dropTarget = null;
    }
  }

  onMouseMove(e) {
    this.handleMove(e);
  }

  onTouchMove(e) {
    this.handleMove(e);
  }

  handleEnd() {
    if (!this.isDragging) return;

    this.isDragging = false;

    // Remove clone
    if (this.dragClone && this.dragClone.parentNode) {
      this.dragClone.parentNode.removeChild(this.dragClone);
      this.dragClone = null;
    }

    // Remove dragging class
    if (this.mount) {
      this.mount.classList.remove('dragging');
    }

    // Handle drop
    if (this.dropTarget && this.props.onReorder) {
      const targetColorId = parseInt(this.dropTarget.getAttribute('data-color-id'), 10);
      if (!isNaN(targetColorId) && targetColorId !== this.props.colorId) {
        this.props.onReorder(this.props.colorId, targetColorId);
      }
    }

    // Clean up
    document.querySelectorAll('.color-container.drag-over').forEach(el => {
      el.classList.remove('drag-over');
    });
    this.dropTarget = null;

    // Remove listeners
    document.removeEventListener('mousemove', this.onMouseMove.bind(this));
    document.removeEventListener('mouseup', this.onMouseUp.bind(this));
    document.removeEventListener('touchmove', this.onTouchMove.bind(this));
    document.removeEventListener('touchend', this.onTouchEnd.bind(this));
  }

  onMouseUp() {
    this.handleEnd();
  }

  onTouchEnd() {
    this.handleEnd();
  }

  render() {
    return (
      <div
        className="color-container"
        ref={mount => {
          this.mount = mount;
        }}
        data-color-id={this.props.colorId}
        onMouseDown={this.onMouseDown.bind(this)}
        onTouchStart={this.onTouchStart.bind(this)}
      >
        <div className="color-drag-handle">⋮⋮</div>
        <div className="color-close-button" onClick={this.onCloseClick.bind(this)}>
          <CloseColorButton />
        </div>
        <input
          className="color"
          data-jscolor=""
          defaultValue={this.props.color}
          onInput={this.onColorInput.bind(this)}
        />
      </div>
    );
  }
}
