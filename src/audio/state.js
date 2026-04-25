export const SEMITONE = Math.pow(2, 1 / 12);
export const C2 = 65.406;

export const SCALES = {
  aeolian:    [0, 2, 3, 5, 7, 8, 10],
  dorian:     [0, 2, 3, 5, 7, 9, 10],
  phrygian:   [0, 1, 3, 5, 7, 8, 10],
  minor_pent: [0, 3, 5, 7, 10],
  major_pent: [0, 2, 4, 7, 9],
  lydian:     [0, 2, 4, 6, 7, 9, 11],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
};
export const SCALE_NAMES = Object.keys(SCALES);

export const state = {
  rootMidi:     36,
  scaleIdx:     0,
  tempo:        88,
  density:      0.5,
  brightness:   0.3,
  spaciousness: 0.5,
  era:          0,
};

export const LOOKAHEAD = 0.12;
export const TICK_MS   = 60;

export function rand(a, b)    { return a + Math.random() * (b - a); }
export function pick(arr)     { return arr[Math.floor(Math.random() * arr.length)]; }
export function lerp(a, b, t) { return a + (b - a) * t; }

export function midiToHz(midi) { return C2 * Math.pow(SEMITONE, midi - 24); }
export function beat()         { return 60 / state.tempo; }

export function scaleNotes(rootMidi, scaleIntervals, octaves = 3) {
  const notes = [];
  for (let o = 0; o < octaves; o++) {
    for (const i of scaleIntervals) notes.push(rootMidi + o * 12 + i);
  }
  return notes;
}
