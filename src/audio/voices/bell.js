import { audio } from '../context.js';
import { state, SCALES, SCALE_NAMES, LOOKAHEAD, beat, rand, pick, midiToHz, scaleNotes } from '../state.js';
import { harmony } from '../harmony.js';

export const bellVoice = (() => {
  let nextTime = 0;

  function play(t) {
    const { ctx, masterGain, reverbNode } = audio;
    const wait = beat() * pick([2, 3, 4, 4]);
    if (Math.random() < 0.3) return wait;

    const notes = scaleNotes(state.rootBase + 36, SCALES[SCALE_NAMES[state.scaleIdx]], 2);
    const hz   = midiToHz(harmony.pickChordTone(notes));
    const dur  = rand(2.5, 5.0);
    const gain = rand(0.07, 0.12);

    // Four inharmonic partials — each with its own decay rate (higher partials die faster)
    for (const [ratio, relGain, decayMul] of [
      [1,     1.00, 1.00],
      [2.756, 0.35, 0.55],
      [5.404, 0.16, 0.25],
      [8.801, 0.07, 0.11],
    ]) {
      const osc = ctx.createOscillator(), env = ctx.createGain(), wet = ctx.createGain();
      osc.type = 'sine'; osc.frequency.value = hz * ratio;
      env.gain.setValueAtTime(0, t);
      env.gain.linearRampToValueAtTime(gain * relGain, t + 0.005);
      env.gain.exponentialRampToValueAtTime(0.001, t + dur * decayMul);
      wet.gain.value = 0.7;
      osc.connect(env); env.connect(masterGain); env.connect(wet); wet.connect(reverbNode);
      osc.start(t); osc.stop(t + dur + 0.1);
    }
    return wait;
  }

  return {
    name: 'bell',
    tick(now) {
      while (nextTime < now + LOOKAHEAD) {
        if (!nextTime) nextTime = now;
        nextTime += play(nextTime);
      }
    },
    reset(now) { nextTime = now; },
  };
})();
