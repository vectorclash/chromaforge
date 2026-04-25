import { audio } from '../context.js';
import { state, SCALES, SCALE_NAMES, LOOKAHEAD, beat, rand, pick, midiToHz, scaleNotes } from '../state.js';

export const fluteVoice = (() => {
  let nextTime = 0;

  function play(t) {
    const { ctx, masterGain, reverbNode } = audio;
    if (Math.random() < 0.2) return beat() * pick([1, 1, 2]);

    const notes = scaleNotes(state.rootMidi + 48, SCALES[SCALE_NAMES[state.scaleIdx]], 2);
    const hz   = midiToHz(pick(notes));
    const dur  = beat() * pick([1, 1.5, 2, 3]);
    const gain = rand(0.06, 0.11);

    const osc = ctx.createOscillator(), env = ctx.createGain();
    const lfo = ctx.createOscillator(), lfoGain = ctx.createGain();
    const wet = ctx.createGain();
    osc.type = 'sine'; osc.frequency.value = hz;
    lfo.type = 'sine'; lfo.frequency.value = rand(4.5, 6.5);
    lfoGain.gain.value = gain * 0.25;
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(gain, t + 0.08);
    env.gain.setValueAtTime(gain, t + dur - 0.12);
    env.gain.linearRampToValueAtTime(0, t + dur);
    wet.gain.value = 0.55;
    lfo.connect(lfoGain); lfoGain.connect(env.gain);
    osc.connect(env); env.connect(masterGain); env.connect(wet); wet.connect(reverbNode);
    osc.start(t); osc.stop(t + dur + 0.05);
    lfo.start(t); lfo.stop(t + dur + 0.05);
    return beat() * pick([1, 1, 1.5, 2]);
  }

  return {
    name: 'flute',
    tick(now) {
      while (nextTime < now + LOOKAHEAD) {
        if (!nextTime) nextTime = now;
        nextTime += play(nextTime);
      }
    },
    reset(now) { nextTime = now; },
  };
})();
