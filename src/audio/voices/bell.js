import { audio } from '../context.js';
import { state, SCALES, SCALE_NAMES, LOOKAHEAD, beat, rand, pick, midiToHz, scaleNotes } from '../state.js';

export const bellVoice = (() => {
  let nextTime = 0;

  function play(t) {
    const { ctx, masterGain, reverbNode } = audio;
    const wait = beat() * pick([2, 3, 4, 4]);
    if (Math.random() < 0.3) return wait;

    const notes = scaleNotes(state.rootMidi + 48, SCALES[SCALE_NAMES[state.scaleIdx]], 2);
    const hz   = midiToHz(pick(notes));
    const dur  = rand(2.5, 5.0);
    const gain = rand(0.06, 0.11);

    // Carrier + two inharmonic partials (classic bell spectrum)
    for (const ratio of [1, 2.756, 5.404]) {
      const osc = ctx.createOscillator(), env = ctx.createGain(), wet = ctx.createGain();
      osc.type = 'sine'; osc.frequency.value = hz * ratio;
      const partialGain = gain / (ratio * 0.8);
      env.gain.setValueAtTime(0, t);
      env.gain.linearRampToValueAtTime(partialGain, t + 0.005);
      env.gain.exponentialRampToValueAtTime(0.001, t + dur * (ratio === 1 ? 1 : 0.5));
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
