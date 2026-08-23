import gsap from 'gsap/gsap-core';
import React from 'react';
// import gsap from 'gsap'
import tinycolor from 'tinycolor2';
import CloseColorButton from './buttons/CloseColorButton';

// Is a pointer currently held down anywhere on the page? jscolor's pad/slider drag fires a
// native `input` event on the swatch on EVERY pointer move, so an `input` arriving while a
// pointer is down means the user is still mid-drag, still choosing. Applying those would kick
// off a full studio-resolution regenerate every time they paused for longer than the parent's
// debounce window -- which reads as the artwork thrashing while you pick. jscolor guarantees a
// native `change` event on pointer release (jsc.onDocumentPointerEnd triggers 'input' then
// 'change'), so that is the "done choosing" signal we commit on instead.
//
// A module-level flag with listeners installed once, rather than per-field: there can be up to
// six swatches mounted and they all ask the same question. `pointercancel` and the window's own
// blur clear it too, so a release the page never sees (dragged off-window, OS gesture) can't
// leave it stuck on and silently swallow every later edit.
let pointerIsDown = false;
let pointerTrackerInstalled = false;

function installPointerTracker() {
  if (pointerTrackerInstalled || typeof window === 'undefined') return;
  pointerTrackerInstalled = true;
  const down = () => {
    pointerIsDown = true;
  };
  const up = () => {
    pointerIsDown = false;
  };
  window.addEventListener('pointerdown', down, true);
  window.addEventListener('pointerup', up, true);
  window.addEventListener('pointercancel', up, true);
  window.addEventListener('blur', up);
}

export default class ColorField extends React.Component {
  constructor(props) {
    super(props);
    // Bind drag handlers once so addEventListener/removeEventListener share the
    // SAME function reference. .bind() returns a new function each call, so
    // binding inline at add/remove time meant removeEventListener never matched
    // and the document listeners leaked/stacked across drags.
    this.boundHandleMove = this.handleMove.bind(this);
    this.boundHandleEnd = this.handleEnd.bind(this);
    this.boundHandleColorCommit = this.handleColorCommit.bind(this);
  }

  componentDidMount() {
    window.jscolor.install();
    installPointerTracker();
    this.adjustColor(this.props.color);
    // React's `onChange` on a text input is really the `input` event, so the commit signal has
    // to come from a real DOM listener for the native `change` event.
    this.input?.addEventListener('change', this.boundHandleColorCommit);
  }

  componentWillUnmount() {
    this.input?.removeEventListener('change', this.boundHandleColorCommit);
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

  // Fires continuously while the picker is dragged, and once per keystroke for a typed hex.
  // The swatch's own label contrast follows immediately either way -- it's a cheap gsap.set on
  // one element, and the swatch must stay readable against the colour it's showing. Telling the
  // parent (which regenerates the artwork) waits until the drag is released; see the flag above.
  onColorInput(e) {
    this.adjustColor(e.target.value);
    this.reportEdit(e.target.value, !pointerIsDown);
  }

  // Native `change`: pointer released on the picker's pad/slider, or a typed hex committed with
  // Enter/blur. This is the one edit that always applies.
  handleColorCommit(e) {
    this.adjustColor(e.target.value);
    this.reportEdit(e.target.value, true);
  }

  // A typed hex reaches the parent twice -- once from the keystroke's `input`, then again from
  // the `change` that Enter/blur fires with the identical value -- and the parent answers each
  // with a full studio-resolution regenerate of the same artwork. Reporting only real value
  // changes drops the duplicate; the parent still reads the live DOM itself, so this only ever
  // suppresses a no-op.
  // Compared case-insensitively because jscolor normalises a typed `#11ee55` to `#11EE55` on
  // commit: the same colour, a different string, and comparing them literally would let the
  // duplicate render through.
  //
  // `committed` is false for the stream of edits arriving mid-drag. They are still reported --
  // a surface cheap enough to follow along should -- but they carry the flag that lets the
  // parent hold off the expensive half until the pointer is released.
  // The dedupe has to know about `committed`, not just the value: a drag reports its final
  // colour uncommitted on the last pointer move, and the `change` that follows on release
  // carries that same colour. Treating that as a duplicate would swallow the commit and the
  // 2D artwork would never regenerate at all -- so a repeat is only suppressed when the
  // previous report was at least as committed as this one.
  reportEdit(value, committed) {
    const normalized = String(value).toLowerCase();
    if (normalized === this.lastReportedValue && (this.lastReportedCommitted || !committed)) {
      return;
    }
    this.lastReportedValue = normalized;
    this.lastReportedCommitted = committed;
    this.props.onEdit?.(committed);
  }

  // Runs on mousedown/touchstart, i.e. before the browser applies focus for *this* tap --
  // document.activeElement still reflects whatever was focused going into this tap. If it's
  // already this same input, the picker is already open (jscolor's own hue/saturation/slider
  // controls aren't separately focusable, so activeElement stays this input for as long as
  // the popup stays open) and this is a deliberate repeat tap on the swatch itself -- allow
  // the native keyboard so the user can type a hex value directly. Otherwise this tap is the
  // one opening the picker fresh; keep the keyboard suppressed (see the input's inputMode
  // attribute) so the visual picker isn't immediately crowded by it. Self-resetting: once the
  // popup actually closes (a real blur), activeElement is no longer this input, so the next
  // fresh open goes back to suppressed by default.
  onColorInputPointerDown(e) {
    if (document.activeElement === e.currentTarget) {
      e.currentTarget.removeAttribute('inputmode');
    } else {
      e.currentTarget.setAttribute('inputmode', 'none');
    }
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
        className="color-container relative h-[60px] w-[48.5%] opacity-0 transition-[transform,box-shadow,opacity] duration-[var(--duration-fast)] ease-[ease]"
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
          ref={input => {
            this.input = input;
          }}
          data-jscolor=""
          defaultValue={this.props.color}
          onInput={this.onColorInput.bind(this)}
          onMouseDown={this.onColorInputPointerDown.bind(this)}
          onTouchStart={this.onColorInputPointerDown.bind(this)}
          // jscolor reuses this same element both to open the picker and as its manual
          // hex-entry field -- on touch, tapping it to open the picker is indistinguishable
          // to the browser from tapping into a text field, so it summoned the OS keyboard,
          // which then covers/crowds the visual picker for something almost nobody actually
          // uses on the FIRST tap. inputMode="none" here is just the initial value for the
          // very first open; onColorInputPointerDown flips it on/off per-tap after that (a
          // deliberate second tap on the already-open swatch re-enables the keyboard).
          inputMode="none"
        />
      </div>
    );
  }
}
