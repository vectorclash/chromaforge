import { audio } from '../context.js';
import { state, SCALES, SCALE_NAMES, LOOKAHEAD, beat, rand, pick, lerp, midiToHz, scaleNotes } from '../state.js';
import { harmony } from '../harmony.js';

export const clavinetVoice = (() => {
  let nextTime = 0;
  let lastMidi = -1;

  function play(t) {
    const { ctx, masterGain } = audio;
    if (Math.random() < 0.1) return beat() * pick([0.25, 0.5]);

    const scale = SCALES[SCALE_NAMES[state.scaleIdx]];
    const notes = scaleNotes(state.rootBase + 24, scale, 2);
    let midi;
    if (lastMidi > 0 && Math.random() < 0.55) {
      const idx = notes.indexOf(lastMidi);
      if (idx >= 0) midi = notes[Math.max(0, Math.min(notes.length - 1, idx + pick([-3, -2, -1, 1, 2, 3])))];
    }
    if (!midi) midi = harmony.pickChordTone(notes);
    lastMidi = midi;

    const hz        = midiToHz(midi);
    const gain      = rand(0.10, 0.17) * (0.5 + state.density * 0.5);
    const decaySec  = rand(0.10, 0.22);

    const osc  = ctx.createOscillator();
    const filt = ctx.createBiquadFilter();
    const env  = ctx.createGain();

    osc.type = 'sawtooth';
    osc.frequency.value = hz;

    filt.type = 'bandpass';
    filt.frequency.value = lerp(700, 2200, state.brightness);
    filt.Q.value = 2.8;

    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(gain, t + 0.003);
    env.gain.exponentialRampToValueAtTime(0.001, t + decaySec);

    osc.connect(filt); filt.connect(env); env.connect(masterGain);
    osc.start(t); osc.stop(t + decaySec + 0.01);

    return beat() * pick([0.25, 0.5, 0.5, 0.75]);
  }

  return {
    name: 'clavinet',
    tick(now) {
      while (nextTime < now + LOOKAHEAD) {
        if (!nextTime) nextTime = now;
        nextTime += play(nextTime);
      }
    },
    reset(now) { nextTime = now; lastMidi = -1; },
  };
})();
