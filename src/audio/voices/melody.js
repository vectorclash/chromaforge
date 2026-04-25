import { audio } from '../context.js';
import { state, SCALES, SCALE_NAMES, LOOKAHEAD, beat, rand, pick, lerp, midiToHz, scaleNotes } from '../state.js';

export const melodyVoice = (() => {
  let nextTime = 0;
  let lastMidi  = -1;

  function play(t) {
    const { ctx, masterGain, reverbNode } = audio;
    if (Math.random() < 0.25) return beat() * pick([0.5, 1, 1]);

    const scale = SCALES[SCALE_NAMES[state.scaleIdx]];
    const notes = scaleNotes(state.rootMidi + 36, scale, 2);
    let midi;
    if (lastMidi > 0 && Math.random() < 0.65) {
      const idx = notes.indexOf(lastMidi);
      if (idx >= 0) {
        midi = notes[Math.max(0, Math.min(notes.length - 1, idx + (Math.random() < 0.5 ? 1 : -1)))];
      }
    }
    if (!midi) midi = pick(notes);
    lastMidi = midi;

    const hz   = midiToHz(midi);
    const dur  = beat() * pick([0.5, 0.5, 1, 1, 1.5, 2]);
    const gain = rand(0.07, 0.14) * lerp(0.4, 1.0, state.density);
    const osc  = ctx.createOscillator(), env = ctx.createGain(), wet = ctx.createGain();
    osc.type = Math.random() < 0.5 ? 'sine' : 'triangle';
    osc.frequency.value = hz; osc.detune.value = rand(-4, 4);
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(gain, t + 0.02);
    env.gain.exponentialRampToValueAtTime(0.001, t + dur * 0.88);
    wet.gain.value = 0.6;
    osc.connect(env); env.connect(masterGain); env.connect(wet); wet.connect(reverbNode);
    osc.start(t); osc.stop(t + dur + 0.05);
    return dur;
  }

  return {
    name: 'melody',
    tick(now) {
      while (nextTime < now + LOOKAHEAD) {
        if (!nextTime) nextTime = now;
        nextTime += play(nextTime);
      }
    },
    reset(now) { nextTime = now; },
  };
})();
