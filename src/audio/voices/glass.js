import { audio } from '../context.js';
import { state, SCALES, SCALE_NAMES, LOOKAHEAD, beat, rand, pick, midiToHz, scaleNotes } from '../state.js';

export const glassVoice = (() => {
  let nextTime = 0;

  function play(t) {
    const { ctx, masterGain, reverbNode } = audio;
    const wait = beat() * rand(2, 5);
    if (Math.random() < 0.35) return wait;

    const notes = scaleNotes(state.rootMidi + 48, SCALES[SCALE_NAMES[state.scaleIdx]], 2);
    const hz   = midiToHz(pick(notes));
    const dur  = rand(3.0, 7.0);
    const gain = rand(0.04, 0.08);

    // FM: modulator at 1.003x creates subtle beating shimmer
    const mod = ctx.createOscillator(), modGain = ctx.createGain();
    const car = ctx.createOscillator(), env = ctx.createGain(), wet = ctx.createGain();
    mod.type = 'sine'; mod.frequency.value = hz * 1.003;
    modGain.gain.value = hz * 0.012;
    mod.connect(modGain); modGain.connect(car.frequency);
    car.type = 'sine'; car.frequency.value = hz;
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(gain, t + 0.3);
    env.gain.exponentialRampToValueAtTime(0.001, t + dur);
    wet.gain.value = 0.95;
    car.connect(env); env.connect(masterGain); env.connect(wet); wet.connect(reverbNode);
    mod.start(t); mod.stop(t + dur + 0.1);
    car.start(t); car.stop(t + dur + 0.1);
    return wait;
  }

  return {
    name: 'glass',
    tick(now) {
      while (nextTime < now + LOOKAHEAD) {
        if (!nextTime) nextTime = now;
        nextTime += play(nextTime);
      }
    },
    reset(now) { nextTime = now; },
  };
})();
