import { useEffect, useRef, useState } from 'react';

// A label that scrambles into its new text when it changes, resolving left to right. Only the
// characters that change or are new scramble; a shared prefix holds still.
// Built for the studio's Generate button (Generate <-> Generating), so it has to be over
// almost before it is seen: RESOLVE_MS for the whole word, a fresh random glyph every frame
// until each character lands.
//
// A change that only touches DIGITS is applied instantly -- "Generating 3 / 20" ticks once per
// frame built, and a counter that scrambles never shows its number (the TerminalText rule).
// Nothing animates on mount or under prefers-reduced-motion.

const GLYPHS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ#%&*+=<>/\\';
const RESOLVE_MS = 200; // last character lands here
const LEAD_MS = 60; // first character lands here

const digitsOnlyChange = (a, b) => a.replace(/\d/g, '0') === b.replace(/\d/g, '0');

const reducedMotion = () =>
  typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

export default function ScrambleText({ text }) {
  const [shown, setShown] = useState(text);
  const prevRef = useRef(text);
  const rafRef = useRef(0);

  useEffect(() => {
    const prev = prevRef.current;
    prevRef.current = text;
    cancelAnimationFrame(rafRef.current);
    if (prev === text || digitsOnlyChange(prev, text) || reducedMotion()) {
      setShown(text);
      return undefined;
    }
    // Only the characters that differ from the old text at the same position (or are new)
    // scramble; the rest hold still. The changed ones land left to right across the window.
    const n = text.length;
    const changed = [];
    for (let i = 0; i < n; i++) if (text[i] !== prev[i] && text[i] !== ' ') changed.push(i);
    const landsAt = new Map(
      changed.map((i, k) => [
        i,
        changed.length > 1 ? LEAD_MS + ((RESOLVE_MS - LEAD_MS) * k) / (changed.length - 1) : RESOLVE_MS
      ])
    );
    const start = performance.now();
    const tick = (now) => {
      const t = now - start;
      let out = '';
      for (let i = 0; i < n; i++) {
        const at = landsAt.get(i);
        out += at === undefined || t >= at ? text[i] : GLYPHS[(Math.random() * GLYPHS.length) | 0];
      }
      setShown(out);
      if (t < RESOLVE_MS) rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [text]);

  return (
    <>
      <span aria-hidden="true">{shown}</span>
      <span className="sr-only">{text}</span>
    </>
  );
}
