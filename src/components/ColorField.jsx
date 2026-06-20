import gsap from 'gsap/gsap-core';
import React from 'react';
// import gsap from 'gsap'
import tinycolor from 'tinycolor2';
import CloseColorButton from './buttons/CloseColorButton';

export default class ColorField extends React.Component {
  constructor(props) {
    super(props);
    // Bind drag handlers once so addEventListener/removeEventListener share the
    // SAME function reference. .bind() returns a new function each call, so
    // binding inline at add/remove time meant removeEventListener never matched
    // and the document listeners leaked/stacked across drags.
    this.boundHandleMove = this.handleMove.bind(this);
    this.boundHandleEnd = this.handleEnd.bind(this);
  }

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

    // Add listeners for both mouse and touch (same bound refs used to remove them)
    document.addEventListener('mousemove', this.boundHandleMove);
    document.addEventListener('mouseup', this.boundHandleEnd);
    document.addEventListener('touchmove', this.boundHandleMove, { passive: false });
    document.addEventListener('touchend', this.boundHandleEnd);
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

    // Move the clone immediately on every pointer event so it tracks the cursor 1:1.
    this.dragClone.style.left = this.initialX + (pos.clientX - this.startX) + 'px';
    this.dragClone.style.top = this.initialY + (pos.clientY - this.startY) + 'px';

    // Throttle the expensive drop-target hit-testing to once per animation frame.
    // elementsFromPoint() forces a synchronous layout, so running it on every pointer
    // event (60-120/s) periodically stalled the main thread (the intermittent freeze).
    // Coalescing to one rAF keeps the drag smooth.
    this.lastPointer = pos;
    if (this.hitTestRaf) return;
    this.hitTestRaf = requestAnimationFrame(() => {
      this.hitTestRaf = null;
      this.updateDropTarget();
    });
  }

  updateDropTarget() {
    if (!this.isDragging || !this.dragClone) return;
    const pos = this.lastPointer;

    // Find the nearest valid color-container whose bounding box (expanded by
    // GAP_TOLERANCE) contains the pointer. A plain elementsFromPoint() hit-test only
    // matches when the cursor is exactly over a painted swatch, so it misses whenever
    // the cursor is in one of the small gaps between swatches/rows (row-gap is 10px,
    // and the gap above the FIRST row — between it and the settings tabs — is 20px).
    // Landing in a gap left dropTarget null and silently dropped the reorder; this was
    // most reproducible on the first row since there's no row above it to catch an
    // overshoot, and its gap is twice as large.
    const GAP_TOLERANCE = 20;
    let targetContainer = null;
    let bestDist = Infinity;
    document.querySelectorAll('.color-container').forEach(el => {
      if (el === this.mount) return;
      if (el.classList.contains('drag-clone')) return;
      if (!el.getAttribute('data-color-id')) return;

      const r = el.getBoundingClientRect();
      const withinX = pos.clientX >= r.left - GAP_TOLERANCE && pos.clientX <= r.right + GAP_TOLERANCE;
      const withinY = pos.clientY >= r.top - GAP_TOLERANCE && pos.clientY <= r.bottom + GAP_TOLERANCE;
      if (!withinX || !withinY) return;

      const dist = Math.hypot(pos.clientX - (r.left + r.width / 2), pos.clientY - (r.top + r.height / 2));
      if (dist < bestDist) {
        bestDist = dist;
        targetContainer = el;
      }
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

  handleEnd() {
    if (!this.isDragging) return;

    this.isDragging = false;

    // Cancel any hit-test frame still queued from the last move
    if (this.hitTestRaf) {
      cancelAnimationFrame(this.hitTestRaf);
      this.hitTestRaf = null;
    }

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

    // Remove listeners (same bound refs that were added in startDrag)
    document.removeEventListener('mousemove', this.boundHandleMove);
    document.removeEventListener('mouseup', this.boundHandleEnd);
    document.removeEventListener('touchmove', this.boundHandleMove);
    document.removeEventListener('touchend', this.boundHandleEnd);
  }

  render() {
    return (
      <div
        className="color-container relative h-[60px] w-[48.5%] opacity-0 transition-[transform,box-shadow,opacity] duration-200 ease-[ease]"
        ref={mount => {
          this.mount = mount;
        }}
        data-color-id={this.props.colorId}
        onMouseDown={this.onMouseDown.bind(this)}
        onTouchStart={this.onTouchStart.bind(this)}
      >
        <div className="color-drag-handle absolute left-[5px] top-0 z-10 flex h-full w-[20px] cursor-grab touch-none select-none items-center justify-center text-[16px] tracking-[-2px] text-white/50 [-webkit-touch-callout:none] hover:text-white/80 active:cursor-grabbing">
          ⋮⋮
        </div>
        <div
          className="color-close-button absolute right-0 top-0 z-[100] h-full w-[25px] cursor-pointer pr-[10px]"
          onClick={this.onCloseClick.bind(this)}
        >
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
