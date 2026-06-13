import { state, SCALES, SCALE_NAMES, beat, pick } from './state.js';

// ─── Shared harmonic context ────────────────────────────────────────────────
// Every harmonic and melodic voice reads the *current chord* from here instead
// of rolling its own random scale degree. This is what turns a pile of
// independently-random voices into a coherent chord progression: at any instant
// the pad, choir, bass and melody all agree on which chord is sounding.
//
// Chords are expressed as a root *scale degree* (an index into the active
// scale). Building the triad by stacking diatonic thirds (degree, +2, +4, …)
// yields the correct chord quality for whatever mode is active — minor in
// aeolian, major in lydian, and so on — automatically.

// Progressions for 7-note (diatonic) scales — classic, resolving motion that
// sounds good in any mode because every chord is diatonic. Degrees are 0-based
// (0 = i/I, 3 = iv/IV, 4 = v/V, 5 = VI, …).
const PROG_7 = [
  [0, 3, 4, 0], // i – iv – v – i
  [0, 5, 3, 4], // i – VI – iv – v
  [0, 4, 5, 3], // i – v – VI – iv
  [0, 5, 1, 4], // i – VI – ii – v
  [0, 3, 0, 4], // i – iv – i – v
  [5, 3, 0, 4], // VI – iv – i – v
  [0, 6, 5, 4], // i – VII – VI – v   (descending)
  [0, 2, 3, 4], // i – III – iv – v   (gentle rise)
];

// Progressions for 5-note (pentatonic) scales — gentler, fewer degrees.
const PROG_5 = [
  [0, 2, 3, 0],
  [0, 3, 2, 0],
  [0, 2, 4, 3],
  [0, 3, 0, 2],
];

function currentScale() { return SCALES[SCALE_NAMES[state.scaleIdx]]; }

let progression = PROG_7[0];
let idx         = 0;
let barStart    = 0;   // audio-clock time the current chord began
let progLen     = 7;   // scale length the current progression was chosen for

function reroll() {
  const scale = currentScale();
  progLen     = scale.length;
  progression = pick(progLen <= 5 ? PROG_5 : PROG_7);
  idx         = 0;
}

export const harmony = {
  reroll,

  reset(now) {
    barStart = now;
    idx      = 0;
  },

  // Advance the chord clock. Called once per scheduler tick at the real "now",
  // so every voice scheduling within the lookahead window reads the same chord.
  tick(now) {
    if (currentScale().length !== progLen) reroll(); // scale switched (manual mode)
    if (!barStart) barStart = now;
    const barDur = (state.chordBeats || 4) * beat();
    while (now >= barStart + barDur) {
      barStart += barDur;
      idx = (idx + 1) % progression.length;
    }
  },

  get rootDegree() { return progression[idx]; },

  // Ascending diatonic chord built from the current root degree by stacking
  // thirds. Octave-correct: wrapping past the top of the scale adds 12
  // semitones rather than collapsing back down.
  chordMidis(baseMidi, count = 3) {
    const scale = currentScale();
    const d     = this.rootDegree;
    const out   = [];
    for (let i = 0; i < count; i++) {
      const deg = d + i * 2;
      const oct = Math.floor(deg / scale.length);
      out.push(baseMidi + oct * 12 + scale[deg % scale.length]);
    }
    return out;
  },

  // Pitch classes (mod 12) of the current chord's tones — used by melodic
  // voices to tell chord tones from passing tones.
  chordPCs() {
    const scale = currentScale();
    const d     = this.rootDegree;
    const pcs   = new Set();
    for (const i of [0, 2, 4, 6]) {
      pcs.add((state.rootMidi + scale[(d + i) % scale.length]) % 12);
    }
    return pcs;
  },

  isChordTone(midi) { return this.chordPCs().has(midi % 12); },

  // Pick a note from a list of scale notes, biased toward chord tones. With
  // probability `chance` the result is a chord tone (consonant, locks to the
  // progression); otherwise any scale note is allowed (passing-tone colour).
  // Defaults to the live `harmonyLock` control so the bias is dialable.
  pickChordTone(notes, chance = state.harmonyLock) {
    if (Math.random() < chance) {
      const pcs   = this.chordPCs();
      const tones = notes.filter(m => pcs.has(m % 12));
      if (tones.length) return pick(tones);
    }
    return pick(notes);
  },
};
