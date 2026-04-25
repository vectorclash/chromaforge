import { audio } from '../context.js';
import { state, SCALES, SCALE_NAMES, LOOKAHEAD, beat, rand, pick, midiToHz, scaleNotes } from '../state.js';

export const malletVoice = (() => {
  let nextTime = 0;

  function play(t) {
    const { ctx, masterGain, reverbNode } = audio;
    if (Math.random() < 0.2) return beat() * pick([0.5, 1]);

    const notes = scaleNotes(state.rootMidi + 36, SCALES[SCALE_NAMES[state.scaleIdx]], 3);
    const hz   = midiToHz(pick(notes));
    const dur  = rand(0.3, 0.9);
    const gain = rand(0.09, 0.16);

    // Fundamental + octave with faster decay (marimba body)
    for (const [ratio, gMul, decayMul] of [[1, 1, 1], [2, 0.5, 0.4]]) {
      const osc = ctx.createOscillator(), env = ctx.createGain(), wet = ctx.createGain();
      osc.type = 'sine'; osc.frequency.value = hz * ratio;
      env.gain.setValueAtTime(0, t);
      env.gain.linearRampToValueAtTime(gain * gMul, t + 0.004);
      env.gain.exponentialRampToValueAtTime(0.001, t + dur * decayMul);
      wet.gain.value = 0.45;
      osc.connect(env); env.connect(masterGain); env.connect(wet); wet.connect(reverbNode);
      osc.start(t); osc.stop(t + dur + 0.05);
    }
    return beat() * pick([0.5, 0.5, 1, 1]);
  }

  return {
    name: 'mallet',
    tick(now) {
      while (nextTime < now + LOOKAHEAD) {
        if (!nextTime) nextTime = now;
        nextTime += play(nextTime);
      }
    },
    reset(now) { nextTime = now; },
  };
})();
