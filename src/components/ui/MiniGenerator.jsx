import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLocation, useNavigate } from 'react-router-dom';
import { gsap } from 'gsap/all';
import { DURATION_FAST, DURATION_SLOW } from '../../utils/motionTokens';
import { useStudio } from '../../context/StudioContext';
import { useAuth } from '../../context/AuthContext';
import { useCrossfadeImage } from '../../hooks/useCrossfadeImage';
import { useWidgetVisibility } from '../../hooks/useWidgetVisibility';
import { isScrollLocked, subscribeScrollLock } from '../../hooks/useScrollLock';
import GenerateGlow from './GenerateGlow';
import { afterFeedback } from '../../utils/afterFeedback';
import { beginCycle } from '../../utils/generationCycle';


// No more hover rotation -- it read as unrelated to anything since it fired on mouse
// position, not on actual work being done. `spinning` (MiniGenerator's `pending`, true from
// the moment Generate is clicked through the new preview actually crossfading in) drives a
// real GSAP tween instead of a CSS `animate-spin` class, which is what the old version used.
// That CSS approach had a real, confirmed bug: the icon's `transition-transform` (added so
// the *hover* rotation eased) was still present while spinning, so the instant `animate-spin`
// was removed mid-rotation, that leftover transition eased the icon from wherever it happened
// to be back to 0 over 500-700ms -- a slow, arbitrary-looking wobble that started only once
// generation had already finished, exactly the "disconnected from the process" complaint this
// replaces. GSAP owns the rotation outright now: a continuous fast linear spin for exactly as
// long as `spinning` is true, killed and snapped to rest the instant it isn't -- no transition
// left lying around to fight it.
function RefreshIcon({ spinning }) {
  const iconRef = useRef(null);

  useEffect(() => {
    const el = iconRef.current;
    if (!el) return;
    if (spinning) {
      const tween = gsap.to(el, { rotation: '+=360', duration: 0.4, ease: 'none', repeat: -1 });
      return () => tween.kill();
    }
    gsap.set(el, { rotation: 0 });
  }, [spinning]);

  return (
    <svg
      ref={iconRef}
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M3 12a9 9 0 0 1 15.3-6.4M21 12a9 9 0 0 1-15.3 6.4" />
      <path d="M21 4v5h-5M3 20v-5h5" />
    </svg>
  );
}

// A quick diagonal light sweep on hover -- the studio's own Generate button has this
// (`.button-large::before` in components.css); the mini widget's was plain, which is
// the "studio one feels more fun" gap the user pointed at.
function GenerateShine() {
  return (
    <span
      aria-hidden
      className="pointer-events-none absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-white/25 to-transparent transition-transform duration-500 ease-out group-hover:translate-x-full"
    />
  );
}

// The panel's top edge: the site's spectrum hairline (.cf-spectrum-line, the one under the
// wordmark) but built from the ACTIVE design's own colours, so the widget carries a trace of
// the artwork it just made instead of a fixed brand stripe. The stops run once, straight
// through: the brand line's closing #4c00ff exists so the studio panel's rounded ends meet the
// colour they started on, and nothing here has rounded ends, so repeating the first colour
// would just spend half the bar walking back to where it began.
//
// Two stacked copies rather than one whose background is swapped: a CSS gradient cannot be
// transitioned between arbitrary stop lists, and even where it could, a swap would snap. The
// old palette stays put while the new one fades in over it, which is the same crossfade (not
// dip-out) the artwork itself gets.
function edgeGradient(colors) {
  if (!colors || colors.length === 0) return null;
  // A one-colour palette still needs two stops to be a valid gradient at all -- that
  // duplicate is a syntax requirement, not the decorative repeat removed above.
  const stops = colors.length === 1 ? [colors[0], colors[0]] : colors;
  return `linear-gradient(90deg, ${stops.join(', ')})`;
}

function PaletteEdge({ inset, shownColors, incomingColors, incomingRef }) {
  const shownBg = edgeGradient(shownColors);
  if (!shownBg) return null;
  const incomingBg = edgeGradient(incomingColors);
  return (
    <>
      <span aria-hidden className={`mini-palette-edge ${inset}`} style={{ background: shownBg }} />
      {incomingBg && (
        <span
          ref={incomingRef}
          aria-hidden
          className={`mini-palette-edge ${inset}`}
          style={{ background: incomingBg, opacity: 0 }}
        />
      )}
    </>
  );
}

// What the Generate button dims to while a generate is in flight -- the value the
// `disabled:opacity-30` utility used to supply, kept here because GSAP now owns this
// property outright (see the tween in MiniGenerator below).
const DISABLED_OPACITY = 0.3;

// The two controls, in the two shapes the panel wears: `row` is the floating panel's strip
// under the image (icon-only Generate beside a flexible Save), `col` the docked panel's stack
// beside it. The ambient widget renders BOTH and crossfades between them during the morph,
// so their state (pending spin, save status) is shared by construction.
function GenerateButton({ variant, btnRef, onClick, pending }) {
  const row = variant === 'row';
  return (
    <button
      type="button"
      ref={btnRef}
      onClick={onClick}
      disabled={pending}
      aria-label="Generate new design"
      title="Generate new design"
      className={
        'mini-generate-btn group relative flex shrink-0 cursor-pointer items-center justify-center overflow-hidden border border-white/10 bg-white/5 text-text-secondary hover:border-accent/30 hover:bg-accent/10 hover:text-accent disabled:cursor-not-allowed disabled:hover:scale-100 ' +
        (row
          ? 'h-9 w-9 rounded-lg hover:scale-[1.08] active:scale-[0.92]'
          : 'h-12 w-full gap-2 rounded-xl text-xs font-bold uppercase tracking-wider hover:scale-[1.03] active:scale-[0.96]')
      }
    >
      <GenerateShine />
      <RefreshIcon spinning={pending} />
      {!row && <span>Generate</span>}
    </button>
  );
}

function SaveButton({ variant, isSaved, saveStatus, onSave }) {
  const size =
    variant === 'row'
      ? 'h-9 flex-1 rounded-lg text-[10px]'
      : 'h-12 w-full rounded-xl text-xs';
  const base = `${size} font-quicksand font-bold uppercase tracking-wider transition-all duration-200`;
  if (isSaved) {
    return (
      <button type="button" disabled className={`${base} cursor-default border border-white/10 bg-white/5 text-text-muted`}>
        Saved
      </button>
    );
  }
  if (saveStatus === 'saving') {
    return (
      <button type="button" disabled className={`${base} animate-pulse border border-white/10 bg-white/10 text-text-secondary`}>
        Saving
      </button>
    );
  }
  if (saveStatus === 'error') {
    return (
      <button type="button" disabled className={`${base} border border-red-500/30 bg-red-950/20 text-red-400`}>
        Error
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={onSave}
      className={`${base} cursor-pointer bg-accent text-ink-950 shadow-[0_4px_12px_rgba(166,224,0,0.25)] hover:scale-[1.02] hover:bg-accent-strong hover:shadow-[0_6px_16px_rgba(166,224,0,0.4)] active:scale-[0.98]`}
    >
      Save
    </button>
  );
}

// ── One widget, two docks ──────────────────────────────────────────────────────────────────
// There used to be two MiniGenerators on every page: a floating one that faded away when the
// footer scrolled into view, and a separate one rendered inside the footer. They were two
// objects that happened to look related. Now the floating widget IS the footer's: SiteFooter
// renders only an empty slot (`[data-mini-dock]`) the size of the docked panel, and this one
// widget flies into it, reshaping on the way (Aaron, 2026-09-23): the floating buttons go as the
// panel closes in around the image, and the panel then travels to the slot and widens to the
// docked width while the image shrinks into place and the docked buttons come in. Undocking is
// the same move backwards.
//
// It has TWO STATES, floating and docked, and a timed morph between them (MORPH_DURATION). It
// was scroll-linked for a while -- the morph tracked the page's position through a span at the top
// of the footer -- which read well on long pages and fell apart on short ones like /account, whose
// whole scroll range fits inside that span: almost any scroll started a morph that then had to
// settle back, and the page's height changing as it loaded moved the morph with no scroll at all
// (Aaron: "completely spazzes out sometimes and gets stuck in between forms"). Aaron chose two
// states everywhere over a hybrid. See the controller in useDockMorph for when each state applies.
//
// It must read as ONE move, not two (Aaron, after a first version ran the close and the flight
// as back-to-back tweens with a hop between them: "I just wanted the entire animation to feel
// like one smooth move and not two"). So nothing is sequenced. The whole shape is a function of
// two progress values -- `close` (floating -> the square around the image) and `open` (square ->
// docked, including the travel) -- that run on OVERLAPPING windows of the morph, so the
// flight picks up while the close is still finishing. Geometry is their sum of deltas, which is
// also what makes it clip-safe: the panel's height can never cut into the image, at any mix of
// the two (worked through in `shape` below). No overshoot eases and no extra beats -- each one
// read as a separate event.
//
// Every part is absolutely positioned and written from that shape, because the two layouts are
// a column and a row -- no single flex layout is both, and a FLIP scale of the box would distort
// the radius and the image. The controls hang off the IMAGE's geometry rather than the box's:
// the row sits under the image and the column to its left, so as the image slides right the
// column is revealed from behind it, clipped by the panel's own overflow.
//
// Three things worth not re-deriving:
// (1) It is ONE element, not a portal that moves. Re-parenting a React portal remounts its
//     subtree, which would drop a generate in flight (the spin, the crossfade) at the moment it
//     docks. So it lives in <body> the whole time, and its vertical position is never written
//     by script at all: it is `position: sticky` at the end of a track that ends at the slot, so
//     the browser floats it and docks it on the thread that scrolls the page. Script positioning
//     lags a real trackpad scroll by about a frame, and every attempt to hand over between a
//     script-placed state and a native one showed that lag as a jump (see "Vertical is CSS").
//     Script owns only the shape and the horizontal position, neither of which depends on scroll.
// (2) It sits out a scroll lock. A modal's lock pins the body and makes the page report scroll
//     0, which would read as "scrolled back to the top" and undock the panel behind every modal
//     opened from the footer.
// (3) The state is re-decided whenever the page changes height (content loading, the gallery's
//     infinite scroll), not only on scroll -- that moves the slot with no scroll at all.
const EDGE = 24; // the floating panel's right/bottom offset (was `bottom-6 right-6`)
const ROW_GAP = 10;
const ROW_H = 36;
const COL_W = 128;
const COL_H = 108;
const COL_GAP = 16;
const FLOAT = { w: 176, h: 222, pad: 12, imgX: 12, imgY: 12, img: 152 };
const DOCK = { w: 284, h: 140, pad: 16, imgX: 160, imgY: 16, img: 108 };
const SQUARE_H = FLOAT.pad * 2 + FLOAT.img; // the panel closed in around the floating image
// Where each progress runs across the morph (0..1 of MORPH_DURATION). The windows overlap by
// design (see above); the ease is shared so the two blend rather than hand over.
const EASE = 'power2.inOut';
// `row`/`col` are the two button groups' presence. They get their OWN windows rather than being
// derived from the shape's progress: derived, they rode the fastest stretch of the shape's
// in-out ease and each button's whole scale/slide flashed past. Linear here, since each button
// applies its own ease (buttonPhase).
const DOCK_WINDOWS = {
  close: [0, 0.56, EASE],
  open: [0.22, 1, EASE],
  row: [0, 0.5, 'none'],
  col: [0.38, 1, 'none']
};
// Undock only once the slot has dropped this far below the floating line -- half the docked
// panel's height. Docking happens the moment the slot reaches the line, so without this margin a
// short page (where a few pixels of scroll cross it) flips on every small scroll.
const UNDOCK_PX = DOCK.h / 2;
// How long a page's layout must hold still before it counts as loaded, and the most a load may take
// before the panel stops waiting for it (see "Settling" in useDockMorph).
const SETTLE_STABLE_MS = 800;
const SETTLE_MAX_MS = 2500;
// The dock/undock morph, and the span the entrance/exit tracks below are expressed over, in seconds.
const MORPH_DURATION = 0.8;

// The floating panel's own entrance and exit (page load, or the homepage hero scrolling away and
// back). It used to be a bare 300ms CSS fade-and-rise. It now speaks the same language as the
// dock: the panel grows out of its corner starting from the SQUARE around the image, unfolding
// downward as its buttons scale in -- the floating half of the dock, played backwards. Its values
// COMBINE with the scroll's (the more-closed and less-shown of the two win) rather than fighting
// it for the same properties, so an entrance and a dock can overlap in any order and neither
// can strand the other.
//
// ONE move, not two (Aaron: "that looks weird being two animations and not one smooth one"). A
// first version faded the square in and THEN unfolded it, which read as an appearance followed
// by a second animation. So every track starts at the same instant on the same deceleration and
// they finish together; only the buttons trail slightly, since they sit on the part of the panel
// that is still opening. The exit mirrors it on an accelerating curve.
const ENTER = {
  shown: [0, 0.6, 'power3.out'],
  close: [0, 0.6, 'power3.out'],
  row: [0.08, 0.6, 'none']
};
const EXIT = {
  row: [0, 0.4, 'none'],
  close: [0, 0.45, 'power2.in'],
  shown: [0, 0.45, 'power2.in']
};
const ENTER_RISE = 16; // px the panel rises through as it appears
const ENTER_SCALE = 0.9; // ...and the scale it grows from, anchored at its own corner
// The docked panel has always sat a touch translucent against the footer art.
const DOCKED_OPACITY = 0.9;

const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = v => Math.min(1, Math.max(0, v));

// The panel's shape at a given (close, open). `open` alone moves the image; `close` only takes
// height. Clip-safety: the image's bottom plus padding is SQUARE_H - (SQUARE_H - DOCK.h) * open,
// and the height is that plus (FLOAT.h - SQUARE_H) * (1 - close) -- never less, whatever the mix.
function shape(close, open) {
  return {
    w: lerp(FLOAT.w, DOCK.w, open),
    h: FLOAT.h - (FLOAT.h - SQUARE_H) * close - (SQUARE_H - DOCK.h) * open,
    pad: lerp(FLOAT.pad, DOCK.pad, open),
    imgX: lerp(FLOAT.imgX, DOCK.imgX, open),
    imgY: lerp(FLOAT.imgY, DOCK.imgY, open),
    img: lerp(FLOAT.img, DOCK.img, open)
  };
}

function rectStyle(left, top, width, height) {
  return { left, top, width, height };
}

// Each button's own entrance, as a function of its group's presence (0..1), staggered so the
// first button leads and the second follows -- still driven by the same progress as the panel's
// shape, so it is part of the one move rather than a second animation on top of it. Written to
// a WRAPPER around each button, never the button: the Generate button's opacity belongs to its
// dim tween and both buttons' transforms to CSS hover transitions, and a per-frame write to a
// property a transition is also animating smears.
const BUTTON_STAGGER = 0.3; // how far into the group's fade the second button starts
const ROW_FROM_SCALE = 0.6; // the side state: buttons scale up as they fade in
const COL_FROM_SCALE = 0.75; // the footer state: buttons slide over from behind the image...
const COL_FROM_X = 36; // ...this far to the right, i.e. out from under the image's edge

function buttonPhase(presence, index) {
  const start = index * BUTTON_STAGGER;
  const t = clamp01((presence - start) / (1 - BUTTON_STAGGER));
  // Smoothstep: an even in-and-out, so the scale and slide are visible across the whole window.
  // (An out-cubic here put nearly all of each button's motion into one or two frames.)
  return t * t * (3 - 2 * t);
}

function writeButtons(group, presence, from) {
  group.style.visibility = presence <= 0.001 ? 'hidden' : 'visible';
  [...group.children].forEach((el, i) => {
    const t = buttonPhase(presence, i);
    el.style.opacity = String(t);
    el.style.transform = `translateX(${(1 - t) * from.x}px) scale(${from.scale + (1 - from.scale) * t})`;
  });
}

// The progress of one window of the scroll span, eased.
function windowed(q, [a, b, ease]) {
  return gsap.parseEase(ease)(clamp01((q - a) / (b - a)));
}

function useDockMorph({ enabled, rootRef, trackRef, imageRef, rowRef, colRef, edgeRef, visible, pathname }) {
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const showRef = useRef(null);
  const settleRef = useRef(null);

  useLayoutEffect(() => {
    if (!enabled) return undefined;
    const root = rootRef.current;
    const slot = document.querySelector('[data-mini-dock]');
    const footer = slot?.closest('footer');
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    // q: the dock's scroll progress. e: the entrance -- starts hidden, folded up as the square.
    const s = { q: 0 };
    // `lift`: a vertical offset on top of the sticky position, only ever non-zero while undocking.
    const lift = { y: 0 };
    // While a page is SETTLING -- still changing height as its content arrives -- the panel does
    // not animate in response to it (see "Settling", below). On first load it is also held back
    // entirely, so its entrance plays once, into the state the finished page calls for.
    let settling = true;
    let holdEntrance = true;
    const e = { shown: 0, close: 1, row: 0 };
    let locked = isScrollLocked();

    const apply = () => {
      if (locked) return;
      const q = s.q;
      const open = windowed(q, DOCK_WINDOWS.open);
      const close = Math.max(e.close, windowed(q, DOCK_WINDOWS.close));
      const row = Math.min(e.row, 1 - windowed(q, DOCK_WINDOWS.row));
      const col = windowed(q, DOCK_WINDOWS.col);
      const g = shape(close, open);
      const st = root.style;

      // Horizontal only -- see "Vertical is CSS" below. Neither end depends on scroll: the floating
      // spot is fixed to the viewport's right edge and the slot sits in the footer at a fixed x.
      const floatLeft = document.documentElement.clientWidth - EDGE - FLOAT.w;
      const slotLeft = slot && open > 0 ? slot.getBoundingClientRect().left : floatLeft;
      st.marginLeft = `${lerp(floatLeft, slotLeft, open)}px`;
      st.width = `${g.w}px`;
      st.height = `${g.h}px`;
      st.opacity = String(e.shown * lerp(1, DOCKED_OPACITY, open));
      const rise = (1 - e.shown) * ENTER_RISE + lift.y;
      st.transform =
        e.shown >= 1 && Math.abs(lift.y) < 0.01
          ? ''
          : `translateY(${rise}px) scale(${lerp(ENTER_SCALE, 1, e.shown)})`;
      // Also off while mid-morph: the panel slides under a resting cursor, and the buttons' hover
      // scale then fired as they passed beneath it -- a sudden little "pop" in the middle of the
      // animation (Aaron: "a hiccup ... it seems to pop over slightly"). A half-drawn button is
      // not something to click anyway; hover comes back the moment it settles.
      st.pointerEvents = e.shown < 0.5 || (q > 0 && q < 1) ? 'none' : '';

      Object.assign(imageRef.current.style, {
        left: `${g.imgX}px`,
        top: `${g.imgY}px`,
        width: `${g.img}px`,
        height: `${g.img}px`
      });
      Object.assign(rowRef.current.style, {
        left: `${g.imgX}px`,
        top: `${g.imgY + g.img + ROW_GAP}px`,
        width: `${g.img}px`
      });
      writeButtons(rowRef.current, row, { x: 0, scale: ROW_FROM_SCALE });
      Object.assign(colRef.current.style, {
        left: `${g.imgX - COL_GAP - COL_W}px`,
        top: `${g.imgY + (g.img - COL_H) / 2}px`
      });
      writeButtons(colRef.current, col, { x: COL_FROM_X, scale: COL_FROM_SCALE });
      edgeRef.current.style.left = edgeRef.current.style.right = `${g.pad}px`;
    };

    // The entrance/exit. Shown while floating off the hero, and always once docking has begun
    // (the dock rule outranks the hero one). Safe to retarget mid-flight: it only ever moves its
    // own three values toward an end state, and the scroll's values are combined on top.
    let entrance = null;
    let showing = false;
    const updateShow = () => {
      // Docked is always shown; nothing is shown until the first load has settled.
      const v = !holdEntrance && (visibleRef.current || s.q > 0);
      if (v === showing) return;
      showing = v;
      entrance?.kill();
      const ends = v ? { shown: 1, close: 0, row: 1 } : { shown: 0, close: 1, row: 0 };
      if (reduced) {
        Object.assign(e, ends);
        apply();
        return;
      }
      entrance = gsap.timeline({ onUpdate: apply });
      for (const [key, [a, b, ease]] of Object.entries(v ? ENTER : EXIT)) {
        entrance.to(e, { [key]: ends[key], duration: (b - a) * MORPH_DURATION, ease }, a * MORPH_DURATION);
      }
    };
    showRef.current = updateShow;

    apply();
    if (!slot || !footer) {
      updateShow();
      return () => {
        entrance?.kill();
        showRef.current = null;
      };
    }

    // ── Two states, and a timed morph between them ─────────────────────────────────────────
    // The panel is FLOATING or DOCKED, never anything in between at rest. Whenever the facts
    // change -- a scroll, content loading, a resize -- decide() picks the state, and a change of
    // state plays the one-move morph over MORPH_DURATION, from wherever the panel is (so a change
    // of mind mid-morph just turns it around).
    //
    // It used to be scroll-LINKED: the morph tracked the page's position through a span at the top
    // of the footer. That read well on a long page and fell apart on a short one (Aaron, on
    // /account: "completely spazzes out sometimes and gets stuck in between forms"). There the
    // page's whole scroll range fits inside that span, so almost any scroll started a morph that
    // then had to settle back, and the page's own height changing as it loaded moved the morph
    // with no scroll at all. Aaron chose two states everywhere over a hybrid.
    //
    // Where each state sits, vertically, is still CSS -- see "Vertical is CSS" below:
    //   floating  `position: sticky` at the end of the track: EDGE above the viewport's bottom
    //             while the slot is below that line, riding the page once the slot is above it.
    //   docked    `position: relative` at the same spot -- the slot -- so it scrolls with the
    //             footer like any part of the page, however far the slot goes.
    // Dock happens once the slot has risen to the floating line, which is exactly where sticky has
    // already put the panel ON the slot: nothing to animate vertically. Undock happens only once
    // the slot has dropped UNDOCK_PX below that line -- the hysteresis that keeps a short page from
    // flipping on every small scroll -- and the panel then eases from where the slot was up to its
    // floating spot (`lift`, a translate applied on top of the sticky position).
    let docked = false;
    let morph = null;
    let liftTween = null;
    const morphTo = target => {
      morph?.kill();
      const duration = reduced ? 0 : MORPH_DURATION * Math.abs(target - s.q);
      if (duration <= 0) {
        s.q = target;
        apply();
        updateShow();
        return;
      }
      morph = gsap.to(s, {
        q: target,
        duration,
        ease: 'none', // each part of the morph carries its own ease (DOCK_WINDOWS)
        onUpdate: () => {
          apply();
          updateShow();
        }
      });
    };
    const liftTo = (from, duration) => {
      liftTween?.kill();
      lift.y = from;
      if (reduced || duration <= 0 || Math.abs(from) < 0.5) {
        lift.y = 0;
        apply();
        return;
      }
      // Written NOW, in the same frame the panel goes back to sticky -- not left to the tween's
      // first tick. Sticky pulls the panel up to its floating spot the instant it applies, so a
      // frame without this offset showed it jump ahead there and snap back before the undock
      // started (Aaron: "at the start it pops ahead and then back").
      apply();
      liftTween = gsap.to(lift, { y: 0, duration, ease: 'power2.inOut', onUpdate: apply });
    };

    // Vertical is CSS -- see the note on the track, below.
    const track = trackRef.current;
    const layoutTrack = () => {
      const bottom = slot.getBoundingClientRect().bottom + window.scrollY;
      track.style.height = `${Math.round(bottom)}px`;
    };

    // How far the slot's bottom edge sits BELOW the floating line (negative: above it).
    const slotGap = () => slot.getBoundingClientRect().bottom - (window.innerHeight - EDGE);

    const decide = wantAnimate => {
      if (locked) return;
      const gap = slotGap();
      // Layout churn while a page loads is never animated; nor is a jump that puts the slot more
      // than a screen away (a navigation's scroll-to-top) -- the panel would fly in from far off.
      const animate = wantAnimate && !settling && Math.abs(gap) < window.innerHeight;
      if (!docked && gap <= 0.5) {
        // Never dock while the page is still settling. A short page mid-load can reach the dock
        // and then grow out of it a moment later; floating is the state that is safe either way,
        // and endSettle docks it properly once the page has held still.
        if (settling) return;
        docked = true;
        // Same spot sticky already had it on. `bottom` must go with it: it is the sticky inset while
        // floating, but on a relative element it is an OFFSET and would lift the panel EDGE px off
        // its slot.
        root.style.position = 'relative';
        root.style.bottom = 'auto';
        if (animate) morphTo(1);
        else {
          // A snap must also cancel a morph still running the other way, or that morph goes on
          // and drags the shape back (found by a jump to the top mid-dock: a docked-shaped panel
          // left floating away from its slot).
          morph?.kill();
          s.q = 1;
          apply();
          updateShow();
        }
      } else if (docked && gap > UNDOCK_PX) {
        docked = false;
        root.style.position = ''; // back to sticky: pinned EDGE above the viewport's bottom
        root.style.bottom = '';
        // Sticky just pulled it up by `gap`; start it back where the slot is and ease it home.
        liftTo(animate ? gap : 0, reduced ? 0 : MORPH_DURATION);
        if (animate) morphTo(0);
        else {
          morph?.kill(); // see the dock branch
          s.q = 0;
          apply();
          updateShow();
        }
      }
    };

    // Vertical is CSS. The panel sits at the end of a track that runs from the top of the document
    // down to the slot's bottom edge (flex-aligned to the end), so its natural spot IS the slot.
    // Floating, it is `position: sticky; bottom: EDGE`, which holds it EDGE above the viewport's
    // bottom while the slot is below; docked, it is plain `relative` in that spot. The browser
    // places it on the thread that scrolls the page. Script placement lagged a real trackpad
    // scroll by about a frame, and every hand-over between a script-placed state and a native one
    // showed that lag as a jump (Aaron: "the entire mini generator box popping into a position").
    layoutTrack();
    decide(false);
    updateShow();

    // ── Settling ─────────────────────────────────────────────────────────────────────────────
    // A page's height moves while it loads -- a skeleton gives way to real content, a signed-in
    // account fills in its orders and designs -- and each move can push the slot across a dock
    // threshold with no scroll at all. Animating every one made the panel "freak out a little"
    // on short pages like /account and a near-empty gallery (Aaron). So after a load or a route
    // change, the page is SETTLING until its layout has held still for SETTLE_STABLE_MS (or at
    // most SETTLE_MAX_MS), or the moment the visitor scrolls or types. While settling the panel
    // never docks (a 400ms-still window was tried first and a page docked, then grew out of it)
    // and any undock snaps; on the first load the panel is not shown at all until settled, then
    // enters straight into the right state. Pinning each page to a minimum height
    // was the other option, and was not taken: it would have to guess every route's final height
    // (signed-in content, gallery size) and a wrong guess is the same reflow, on every page.
    let stableTimer = 0;
    let maxTimer = 0;
    const endSettle = () => {
      if (!settling) return;
      settling = false;
      clearTimeout(stableTimer);
      clearTimeout(maxTimer);
      layoutTrack();
      // First load: the panel is still hidden, so it simply takes the right state and then enters
      // in it. After a route change it is on screen, so docking plays as the normal morph.
      decide(!holdEntrance);
      if (holdEntrance) {
        holdEntrance = false;
        updateShow();
      }
    };
    const noteLayout = () => {
      if (!settling) return;
      clearTimeout(stableTimer);
      stableTimer = window.setTimeout(endSettle, SETTLE_STABLE_MS);
    };
    const startSettle = () => {
      settling = true;
      clearTimeout(maxTimer);
      maxTimer = window.setTimeout(endSettle, SETTLE_MAX_MS);
      noteLayout();
    };
    startSettle();
    settleRef.current = startSettle;
    // The visitor taking over ends it at once: from here on, what moves the slot is them.
    const onInput = () => {
      if (settling) endSettle();
    };
    window.addEventListener('wheel', onInput, { passive: true });
    window.addEventListener('touchstart', onInput, { passive: true });
    window.addEventListener('keydown', onInput);

    let raf = 0;
    const onScroll = () => {
      if (raf || locked) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        decide(true);
      });
    };
    // A page changing height as it loads, or a resize, moves the slot with no scroll at all.
    let layoutRaf = 0;
    const relayout = () => {
      if (layoutRaf || locked) return;
      layoutRaf = requestAnimationFrame(() => {
        layoutRaf = 0;
        noteLayout();
        layoutTrack();
        decide(true);
        apply();
      });
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', relayout);
    const ro = new ResizeObserver(relayout);
    const appRoot = document.getElementById('root');
    if (appRoot) ro.observe(appRoot);

    // Sits out a scroll lock: a modal pins the body, and the page's geometry reads wrong until it
    // is released -- decide() must not act on it.
    const unsubscribeLock = subscribeScrollLock(isLocked => {
      locked = isLocked;
      if (!isLocked) relayout();
    });

    return () => {
      clearTimeout(stableTimer);
      clearTimeout(maxTimer);
      settleRef.current = null;
      window.removeEventListener('wheel', onInput);
      window.removeEventListener('touchstart', onInput);
      window.removeEventListener('keydown', onInput);
      entrance?.kill();
      morph?.kill();
      liftTween?.kill();
      showRef.current = null;
      unsubscribeLock();
      if (raf) cancelAnimationFrame(raf);
      if (layoutRaf) cancelAnimationFrame(layoutRaf);
      ro.disconnect();
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', relayout);
    };
  }, [enabled, rootRef, trackRef, imageRef, rowRef, colRef, edgeRef]);

  useEffect(() => {
    showRef.current?.();
  }, [visible]);

  // A route change is a new page loading under the same panel: settle again. (Also runs on
  // mount, where the effect above has just started a settle -- restarting it is harmless.)
  useEffect(() => {
    settleRef.current?.();
  }, [pathname]);
}

// Ambient presence of the generator: either a floating widget or docked in the footer.
// The thumbnail and the footer's art band both read the same StudioContext.previewUrl,
// so regenerating here updates both at once, fading the same way.
//
// `style`/`className` exist for ONE reason and it is load-bearing, not convenience: an entrance
// animation for this widget has to be applied to the glass surface ITSELF, never to a wrapper
// around it. Any ancestor with opacity < 1 (or a transform/filter) becomes a *backdrop root*,
// and a backdrop-filter can only sample what is painted inside its own backdrop root -- so a
// wrapper that contains nothing behind the panel leaves the filter with an empty backdrop and
// the glass renders inert: the artwork behind shows through sharp and unblurred, then snaps to
// frosted the instant the animation ends. That was a real bug in MobileNav, which used to put
// `fade-slide-up` on the padding div around this (Aaron: "doesn't show the artwork correctly
// behind it at first but then it settles"). Verified in Chromium: an ancestor's opacity kills
// the blur, the element's OWN opacity does not -- which is why moving the animation down one
// level is the whole fix, and why the floating variant below can animate its own opacity freely.
export default function MiniGenerator({ inline = false, className = '', style }) {
  const {
    previewUrl,
    previewPalette,
    currentDesign,
    generateRandom,
    saveCurrentDesign,
    isCurrentDesignSaved
  } = useStudio();
  const { user } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const visible = useWidgetVisibility();

  const rootRef = useRef(null);
  const trackRef = useRef(null);
  const imageRef = useRef(null);
  const rowRef = useRef(null);
  const colRef = useRef(null);
  const edgeRef = useRef(null);
  useDockMorph({
    enabled: !inline,
    rootRef,
    trackRef,
    imageRef,
    rowRef,
    colRef,
    edgeRef,
    visible,
    pathname: location.pathname
  });

  const { shown, incoming, shownRef, incomingRef, holding } = useCrossfadeImage(previewUrl);

  // The top edge's colours, kept on the artwork's own beat rather than the design's. The whole
  // point is that they change WITH the thumbnail, and the two facts arrive at different times:
  // previewPalette lands with the new preview url, at the START of the reveal (the fade-out),
  // while `incoming` is set at the instant the fade-in begins. So the palette is held in a ref
  // and only committed when `incoming` appears -- the same trigger, the same DURATION_SLOW, the
  // same power2.inOut the hook fades the image with, which is what makes the two read as one
  // event instead of two things that happen to be near each other. Keying off previewPalette
  // directly would recolour the edge a full second before the image it belongs to (the artwork
  // is still fading the PREVIOUS design out at that point), which is the same mistake as
  // watching currentDesign instead of previewUrl -- see the site-wide rule in CLAUDE.md.
  const [edgeColors, setEdgeColors] = useState(null);
  const [edgeIncomingColors, setEdgeIncomingColors] = useState(null);
  const edgeIncomingRef = useRef(null);
  const latestPaletteRef = useRef(null);
  latestPaletteRef.current = previewPalette;

  const [saveStatus, setSaveStatus] = useState('idle'); // idle | saving | error
  // Real work happens between clicking Generate and the new preview actually landing:
  // currentDesign updates instantly, but previewUrl (and therefore the crossfade's
  // `incoming`) only appears once StudioContext has actually re-rendered the design to an
  // image -- a genuine gap, not a fixed guess. `generating` covers that whole span so the
  // icon animates continuously from the click through to the new image fading in, instead
  // of stopping early (a fixed-duration burst) or starting late (keying off `incoming`
  // alone, which is exactly the "feels disconnected" complaint this replaces).
  const [generating, setGenerating] = useState(false);
  // `holding` is load-bearing here, not belt-and-braces: useCrossfadeImage's reveal is
  // fade-out -> DURATION_HOLD blank beat -> fade-in, and `incoming` is only set at the
  // START of the fade-in. `generating` ends the moment previewUrl lands, i.e. at the start
  // of the fade-out -- so without `holding` there is a ~1.2s dead gap covering the whole
  // fade-out + hold, in which the icon snaps to rest and then starts spinning again. That
  // is a real, measured regression from the crossfade rework (dd61219, which added the
  // hold): sampled rotation went 0deg at the click, ~33deg by 74ms, back to 0 from 77ms to
  // 1294ms, then spinning again to 1786ms -- exactly the "almost starts, then nothing, then
  // starts a moment too late" symptom.
  //
  // It deliberately ends AT the fade-in rather than after it, so the icon settling and the
  // button coming back live are the same beat as the new artwork appearing, instead of the
  // reveal finishing and the button waking up a half-second later. That's the same instant
  // GenerateGlow's own fade-out is timed to (it rides `holding` too, see useCrossfadeImage's
  // comment) -- so every "working" signal in the widget resolves together, on the artwork.
  // Hence `incoming` is intentionally NOT part of this.
  const pending = generating || holding;

  // The button's dimmed/live state is the same motion as the artwork's, not a lookalike:
  // GSAP drives its opacity with the exact durations and ease useCrossfadeImage uses on the
  // images themselves -- dim over DURATION_FAST alongside the old preview's fade-out,
  // restore over DURATION_SLOW alongside the new one's fade-in, both power2.inOut. Matching
  // them in CSS was tried and abandoned: a hand-picked cubic-bezier tracks a JS ease only
  // approximately (measured drift of ~7 opacity points mid-curve even with the durations
  // equal), and the two engines can't be reconciled by tuning -- so the same engine runs
  // both, and .mini-generate-btn deliberately leaves opacity out of its CSS transition.
  // useLayoutEffect, not useEffect, so the dim is committed in the same frame as the click
  // rather than a paint later, and so it pairs with the hook's own layout effect.
  // Two Generate buttons on the ambient widget (the floating row's and the docked column's),
  // one on the inline one -- all of them dim together.
  const genRowRef = useRef(null);
  const genColRef = useRef(null);
  useLayoutEffect(() => {
    const els = [genRowRef.current, genColRef.current].filter(Boolean);
    if (!els.length) return;
    const tween = gsap.to(els, {
      opacity: pending ? DISABLED_OPACITY : 1,
      duration: pending ? DURATION_FAST : DURATION_SLOW,
      ease: 'power2.inOut'
    });
    return () => tween.kill();
  }, [pending]);

  // First appearance only -- the hook shows the very first preview with no fade at all (there
  // is nothing to fade from), so the edge has to arrive the same way rather than waiting for an
  // `incoming` that will never come for that first design.
  useEffect(() => {
    if (!previewPalette) return;
    setEdgeColors(prev => prev ?? previewPalette);
  }, [previewPalette]);

  // A reveal has reached its fade-in: start the edge's own crossfade on the same frame.
  // useLayoutEffect, not useEffect: a passive effect commits this a render later, so the edge's
  // tween started roughly a frame and a half behind the image's and the two curves visibly
  // separated (measured mid-fade: edge 0.747 against image 0.837). A layout effect's state
  // update is flushed before paint, so both tweens begin in the same frame.
  // The palette is snapshotted here rather than read live, so a second generate landing during
  // this fade-in can't swap the colours mid-crossfade.
  useLayoutEffect(() => {
    if (!incoming) return;
    setEdgeIncomingColors(latestPaletteRef.current);
  }, [incoming]);

  // Layout effect for the same reason the hook uses one on its incoming image: the new layer
  // must be at opacity 0 before the browser paints it, or it flashes at full strength for a
  // frame ahead of the tween.
  useLayoutEffect(() => {
    if (!edgeIncomingColors || !edgeIncomingRef.current) return;
    const el = edgeIncomingRef.current;
    gsap.set(el, { opacity: 0 });
    const tween = gsap.to(el, {
      opacity: 1,
      duration: DURATION_SLOW,
      ease: 'power2.inOut',
      onComplete: () => {
        // Promote the incoming palette to the resting layer and drop the second one, so the
        // next reveal starts from a single opaque edge again.
        setEdgeColors(edgeIncomingColors);
        setEdgeIncomingColors(null);
      }
    });
    return () => tween.kill();
  }, [edgeIncomingColors]);

  // Clear any stale error state from a previous design's failed save attempt
  useEffect(() => {
    setSaveStatus('idle');
  }, [currentDesign]);

  // previewUrl only changes once the render StudioContext kicked off for the new design
  // actually finishes -- that's the real "done generating" signal.
  useEffect(() => {
    setGenerating(false);
  }, [previewUrl]);

  // The active state (dim, spin) goes on screen first; the design is generated once it has.
  // See afterFeedback for why, and the measured delay this removes.
  const cancelGenerateRef = useRef(null);
  useEffect(() => () => cancelGenerateRef.current?.(), []);
  const onGenerate = () => {
    // Every surface showing the design goes into its loading state now, together -- see
    // utils/generationCycle.js.
    beginCycle();
    setGenerating(true);
    cancelGenerateRef.current?.();
    cancelGenerateRef.current = afterFeedback(() => {
      cancelGenerateRef.current = null;
      generateRandom();
    });
  };

  const onSave = async () => {
    if (!user) {
      navigate('/account');
      return;
    }
    if (isCurrentDesignSaved || saveStatus === 'saving') return;
    setSaveStatus('saving');
    try {
      await saveCurrentDesign('image', currentDesign);
      setSaveStatus('idle');
    } catch {
      setSaveStatus('error');
      setTimeout(() => setSaveStatus('idle'), 2500);
    }
  };

  // Plain navigate, no ?config= URL -- StudioPage already passes StudioContext's
  // currentDesign through as DisplayCanvas's `initialDesign` prop on every /studio mount,
  // so the design carries over via React state, not the URL (same pattern as
  // DisplayCanvas's own compact "Go to studio" button). This used to build a share-style
  // URL instead (generateShareUrl(toCompactDesign(currentDesign))), which caused two real
  // bugs: an uncompacted currentDesign could blow past the URL length limit and throw on
  // navigate() (fixed once by compacting first), and -- the reason it's gone now, not just
  // patched -- DisplayCanvas.jsx's init() treats *any* design loaded via a `?config=` URL
  // as already-saved (isSaved: true), which is correct for a real share/gallery link but
  // wrong here: this design may never have been saved at all. Confirmed live: generating in
  // the mini-widget without saving, then clicking through to the studio, showed "Saved"
  // for a design that was never actually persisted. The `initialDesign` prop path
  // DisplayCanvas already has for this exact "hand off the live design" case correctly
  // sets isSaved based on StudioContext's own isCurrentDesignSaved fact (via StudioPage's
  // isDesignSaved/savedDesignId props) instead of assuming false -- otherwise a design
  // already saved from this widget showed "Save" again in the Studio and produced a
  // duplicate row on click.
  const onOpenStudio = () => {
    navigate('/studio', { state: { from: location.pathname } });
  };

  const generateProps = { onClick: onGenerate, pending };
  const saveProps = { user, isSaved: isCurrentDesignSaved, saveStatus, onSave };

  const image = (
    <button
      type="button"
      ref={imageRef}
      onClick={onOpenStudio}
      aria-label="Open this design in the studio"
      className="group absolute block cursor-pointer overflow-hidden rounded-xl border border-white/10 bg-ink-950 transition-[scale,border-color,box-shadow] duration-300 hover:scale-[1.03] hover:border-accent/40 hover:shadow-[0_0_15px_rgba(166,224,0,0.2)]"
      style={inline ? rectStyle(DOCK.imgX, DOCK.imgY, DOCK.img, DOCK.img) : undefined}
    >
      {shown && <img ref={shownRef} src={shown} alt="" className="absolute inset-0 h-full w-full object-cover" />}
      {incoming && (
        <img
          ref={incomingRef}
          src={incoming}
          alt=""
          className="absolute inset-0 h-full w-full object-cover"
          style={{ opacity: 0 }}
        />
      )}
      <GenerateGlow active={holding} blurClass="blur-xl" />
      <div className="pointer-events-none absolute inset-0 bg-interactive/10 opacity-0 transition-opacity duration-300 group-hover:opacity-100" />
    </button>
  );

  const edge = (
    <span
      ref={edgeRef}
      aria-hidden
      className="pointer-events-none absolute top-0 h-[2px]"
      style={inline ? { left: DOCK.pad, right: DOCK.pad } : undefined}
    >
      <PaletteEdge
        inset="left-0 right-0"
        shownColors={edgeColors}
        incomingColors={edgeIncomingColors}
        incomingRef={edgeIncomingRef}
      />
    </span>
  );

  // The docked layout's controls: a column of two full-width buttons to the image's left.
  const column = (
    <div
      ref={colRef}
      className="absolute flex flex-col gap-3"
      style={{ width: COL_W, height: COL_H, ...(inline ? { left: DOCK.pad, top: DOCK.pad } : null) }}
    >
      <div>
        <GenerateButton variant="col" btnRef={genColRef} {...generateProps} />
      </div>
      <div>
        <SaveButton variant="col" {...saveProps} />
      </div>
    </div>
  );

  const panelClass =
    'overflow-hidden rounded-2xl border border-white/10 bg-black/15 shadow-[0_4px_40px_rgba(0,0,0,0.4),inset_0_1px_0_rgba(255,255,255,0.14)] backdrop-blur-[4px] backdrop-brightness-[0.95]';

  // 1. Inline: the docked layout, static. MobileNav, and the footer below `sm` (where there is
  // no floating widget to morph from).
  if (inline) {
    return (
      <div
        className={`relative shrink-0 opacity-90 ${panelClass} ${className}`}
        style={{ width: DOCK.w, height: DOCK.h, ...style }}
      >
        {edge}
        {column}
        {image}
      </div>
    );
  }

  // 2. Ambient: ONE widget that is both the floating panel and the footer's docked one. See
  // useDockMorph above for how it moves between them.
  return createPortal(
    <div ref={trackRef} className="mini-dock-track hidden sm:flex">
    <div
      ref={rootRef}
      className={
        // Opacity, transform and pointer-events are written by useDockMorph (the entrance and
        // the dock are one timeline), so there is deliberately no CSS transition here to fight it.
        `mini-dock-panel origin-bottom-right ${panelClass}` + (className ? ' ' + className : '')
      }
      style={style}
    >
      {edge}
      <div ref={rowRef} className="absolute flex gap-2" style={{ height: ROW_H }}>
        <div className="shrink-0">
          <GenerateButton variant="row" btnRef={genRowRef} {...generateProps} />
        </div>
        <div className="flex flex-1">
          <SaveButton variant="row" {...saveProps} />
        </div>
      </div>
      {column}
      {image}
    </div>
    </div>,
    document.body
  );
}
