import { audio } from '../context.js';
import { state, SCALES, SCALE_NAMES, LOOKAHEAD, beat, rand, pick, midiToHz, scaleNotes } from '../state.js';
import { harmony } from '../harmony.js';

export const textureVoice = (() => {
  let nextTime = 0;

  function play(t) {
    const { ctx, masterGain, reverbNode } = audio;
    const wait = beat() * rand(1, 4);
    if (Math.random() < 0.4) return wait;

    const notes = scaleNotes(state.rootBase + 24, SCALES[SCALE_NAMES[state.scaleIdx]], 2);
    const hz    = midiToHz(harmony.pickChordTone(notes));
    const gain  = rand(0.05, 0.09);
    const dur   = rand(1.5, 4.0);
    const osc   = ctx.createOscillator(), env = ctx.createGain(), wet = ctx.createGain();
    osc.type = 'sine'; osc.frequency.value = hz;
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(gain, t + 0.15);
    env.gain.exponentialRampToValueAtTime(0.001, t + dur);
    wet.gain.value = 0.9;
    osc.connect(env); env.connect(masterGain); env.connect(wet); wet.connect(reverbNode);
    osc.start(t); osc.stop(t + dur + 0.1);
    return wait;
  }

  return {
    name: 'texture',
    tick(now) {
      while (nextTime < now + LOOKAHEAD) {
        if (!nextTime) nextTime = now;
        nextTime += play(nextTime);
      }
    },
    reset(now) { nextTime = now; },
  };
})();
