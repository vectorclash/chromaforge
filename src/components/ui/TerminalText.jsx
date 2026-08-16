import React, { useEffect, useRef } from 'react';
import { gsap } from 'gsap/all';

/*
 * A machine clearing a line of text and retyping it, one character cell at a time.
 *
 * Per cell the full sequence is: old character -> underscore -> blank -> block -> new
 * character, with each cell starting at its own offset so a ragged head sweeps the line. It
 * runs as TWO passes over the line rather than one morph, and that structure is the whole
 * design -- see buildGrid for why.
 *
 * Replaces an earlier GSAP TextPlugin tween on the same copy. Two reasons it is hand-rolled
 * rather than a plugin call:
 *
 *  1. TextPlugin types through a whitespace-normalizing path that silently collapses the
 *     U+00A0 the callers' orphan guard depends on, so the guard only ever survived on the very
 *     first line shown. Building the cells ourselves means the exact source string --
 *     non-breaking space included -- is what lands in the DOM.
 *  2. It swapped the whole string in one flow, so a line-count change (one line to two) landed
 *     wherever the typing happened to cross the wrap boundary, and snapped the surrounding
 *     column's height with it. Here the only moment the wrap can change is the instant between
 *     the two passes, when every cell is blank -- so it is not visible at all.
 *
 * MONOSPACE IS LOAD-BEARING, not a style choice. Every phase below has to occupy exactly the
 * width of the character it replaces or each frame reflows everything after it. In a
 * proportional face that is only fixable by measuring and locking every cell, which is the
 * frozen-line-box fragility that got this project's SplitText reveal removed. In a monospace
 * face it is free. Callers must therefore keep the font-mono class on the element.
 */

// The erase pass is deliberately much quicker than the print pass: it is destroying text the
// reader has already had 30+ seconds to read, while the print pass is delivering text they
// have not. Both are a fixed total travel rather than a per-character stagger, so a 40- and a
// 90-character line take the same wall time instead of the long ones crawling.
const ERASE_SWEEP_MS = 220;
const ERASE_CELL_MS = 90;
const PRINT_SWEEP_MS = 520;
const PRINT_CELL_MS = 130;
// Each cell's start is nudged LATER by up to this many cells' worth of its pass, so a head
// reads as a ragged wipe rather than a ruler sliding across. Deterministic per index (see
// cellNoise) -- re-rolling per frame would make cells flicker between phases instead of
// advancing through them.
const JITTER_CELLS = 1.6;

const NBSP = '\u00A0'; // written as an escape on purpose: a literal U+00A0 here is invisible
const BLOCK_CLASS = 'terminal-text__cell--block';

// Phases, in the order a cell passes through them across the two passes.
const CHAR = 0; // the cell's own character (old text during erase, new text once printed)
const UNDERSCORE = 1;
const BLANK = 2;
const BLOCK = 3;

// Stable per-index value in [0, 1). An integer scramble rather than Math.random() so a cell's
// jitter is identical on every frame it is evaluated.
function cellNoise(i) {
  let h = Math.imul(i + 1, 2654435761);
  h ^= h >>> 15;
  h = Math.imul(h, 2246822519);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

/*
 * Builds one span per character of `str` and returns the animating cells plus how long the
 * pass needs.
 *
 * Each pass gets the grid of the string it is working on -- the outgoing string for the erase
 * pass, the incoming one for the print pass. That is the point of splitting the transition in
 * two, and it buys three things a single-pass morph cannot:
 *
 *  - The outgoing text stays INTACT and correctly wrapped while it is being eaten. Indexing
 *    the old string into the new string's grid instead leaves it punctured wherever the new
 *    string has a space, and re-wrapped from the first frame, so it reads as garbled
 *    fragments rather than as the previous line being cleared. (Measured, not assumed: that
 *    was the first version, and the captured frames are what killed it.)
 *  - The wrap can only change between the passes, when every cell is blank, so a one-line to
 *    two-line change is invisible instead of being a jump.
 *  - Nothing has to reconcile two different strings' lengths or space positions.
 *
 * `mode` decides what a cell starts as: 'erase' shows the string's own characters, 'print'
 * starts blank. Two rules keep the layout honest in both, and both are about break
 * opportunities rather than looks:
 *
 *  - A cell that is a space in `str` stays a literal space and never animates. It is a break
 *    opportunity in this pass's layout, so it has to be one for the whole pass.
 *  - A cell that is NOT a space must never CONTAIN a breakable space, so a blank one holds NBSP
 *    instead -- same width in a monospace face, but it cannot introduce a wrap that the
 *    settled text doesn't have.
 *
 * The callers' orphan guard rides through untouched: a U+00A0 in `str` is not a plain space, so
 * it becomes an ordinary non-breaking cell and still binds its two words.
 */
function buildGrid(host, str, mode) {
  host.textContent = '';
  const cells = [];
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (ch === ' ') {
      host.appendChild(document.createTextNode(' '));
      continue;
    }
    const span = document.createElement('span');
    span.textContent = mode === 'erase' ? ch : NBSP;
    cells.push({ el: span, ch, phase: mode === 'erase' ? CHAR : BLANK });
    host.appendChild(span);
  }

  const last = cells.length - 1;
  const sweep = mode === 'erase' ? ERASE_SWEEP_MS : PRINT_SWEEP_MS;
  const cellMs = mode === 'erase' ? ERASE_CELL_MS : PRINT_CELL_MS;
  const step = last <= 0 ? 0 : sweep / last;
  let maxStart = 0;
  for (let i = 0; i < cells.length; i++) {
    const start = i * step + cellNoise(i) * JITTER_CELLS * step;
    cells[i].start = start;
    if (start > maxStart) maxStart = start;
  }
  // Derived, not a constant: on a short line `step` is large, so the jitter can push the last
  // cells well past `sweep`, and a fixed total would cut their sequence short and snap them.
  return { cells, passMs: maxStart + cellMs };
}

function paint(cell, phase) {
  if (cell.phase === phase) return;
  cell.phase = phase;
  if (phase === UNDERSCORE) {
    cell.el.textContent = '_';
  } else if (phase === BLANK) {
    cell.el.textContent = NBSP;
    cell.el.classList.remove(BLOCK_CLASS);
  } else if (phase === BLOCK) {
    // The block is a background on the cell, not a substituted U+2588 glyph: a real block
    // character can fall out of the monospace stack into a fallback face with a different
    // advance width, which would reflow the line on every frame it appeared. A background is
    // exactly the cell's own width whatever the font resolves to. The character underneath is
    // the incoming one purely so the cell keeps its box; CSS makes it transparent.
    cell.el.textContent = cell.ch;
    cell.el.classList.add(BLOCK_CLASS);
  } else {
    cell.el.textContent = cell.ch;
    cell.el.classList.remove(BLOCK_CLASS);
  }
}

// Erase: the cell's own character, then an underscore where it used to be, then nothing.
function erasePhase(u) {
  if (u < 0) return CHAR;
  return u < 0.5 ? UNDERSCORE : BLANK;
}

// Print: nothing, then the write head sitting on the cell, then the character it left behind.
function printPhase(u) {
  if (u < 0) return BLANK;
  return u < 0.5 ? BLOCK : CHAR;
}

export default function TerminalText({ text, className = '', style }) {
  const hostRef = useRef(null);
  const prevText = useRef(null);
  const tweenRef = useRef(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;

    const prev = prevText.current;
    if (prev === text) return undefined;
    prevText.current = text;

    tweenRef.current?.kill();
    tweenRef.current = null;

    // First mount has nothing to erase, and reduced motion asks for no transition at all --
    // both land straight on the settled string.
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (prev === null || reduced) {
      buildGrid(host, text, 'erase'); // 'erase' mode == every cell showing its own character
      return undefined;
    }

    const erase = buildGrid(host, prev, 'erase');
    // The print pass's own timing depends on the NEW string's length, which is known now even
    // though its grid is not built until the handover.
    const printMs = buildGrid(document.createElement('p'), text, 'print').passMs;
    const totalMs = erase.passMs + printMs;

    let printing = null;
    const driver = { t: 0 };
    tweenRef.current = gsap.to(driver, {
      t: totalMs,
      duration: totalMs / 1000,
      ease: 'none',
      onUpdate: () => {
        if (driver.t < erase.passMs) {
          for (let i = 0; i < erase.cells.length; i++) {
            const cell = erase.cells[i];
            paint(cell, erasePhase((driver.t - cell.start) / ERASE_CELL_MS));
          }
          return;
        }
        // Handover. Every cell of the outgoing grid is blank by now, so this is the one moment
        // the line can be re-wrapped without it being visible -- which is exactly why the
        // transition is split in two.
        if (!printing) printing = buildGrid(host, text, 'print');
        for (let i = 0; i < printing.cells.length; i++) {
          const cell = printing.cells[i];
          paint(cell, printPhase((driver.t - erase.passMs - cell.start) / PRINT_CELL_MS));
        }
      },
      onComplete: () => {
        if (!printing) printing = buildGrid(host, text, 'print');
        for (let i = 0; i < printing.cells.length; i++) paint(printing.cells[i], CHAR);
      }
    });

    return () => {
      tweenRef.current?.kill();
      tweenRef.current = null;
    };
  }, [text]);

  return (
    <>
      {/*
        The animated grid is a pile of single-character spans holding intermediate glyphs
        mid-sweep, which is nonsense to a screen reader -- hence aria-hidden here, with the
        settled string carried in a polite live region beside it instead.
      */}
      <p ref={hostRef} aria-hidden className={className} style={style} />
      <span className="sr-only" aria-live="polite">
        {text}
      </span>
    </>
  );
}
