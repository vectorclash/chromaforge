import { audio } from '../context.js';
import { state, SCALES, SCALE_NAMES, LOOKAHEAD, beat, rand, pick, lerp, midiToHz } from '../state.js';

export const padVoice = (() => {
  let nextTime = 0;

  function play(t) {
    const { ctx, masterGain, reverbNode } = audio;
    const scale  = SCALES[SCALE_NAMES[state.scaleIdx]];
    const root   = state.rootMidi + 24;
    const degree = pick([0, 2, 4, 1, 3]);
    const chord  = [0, 2, 4].map(i => root + scale[(degree + i) % scale.length]);
    const dur    = beat() * pick([3, 4, 6, 8]);
    const gain   = rand(0.06, 0.12);

    for (const midi of chord) {
      const hz   = midiToHz(midi);
      const osc  = ctx.createOscillator(), filt = ctx.createBiquadFilter();
      const env  = ctx.createGain(),       wet  = ctx.createGain();
      osc.type = 'sawtooth'; osc.frequency.value = hz; osc.detune.value = rand(-8, 8);
      filt.type = 'lowpass'; filt.frequency.value = lerp(400, 2400, state.brightness); filt.Q.value = 1.2;
      env.gain.setValueAtTime(0, t);
      env.gain.linearRampToValueAtTime(gain, t + 0.8);
      env.gain.setValueAtTime(gain, t + dur - 1.0);
      env.gain.linearRampToValueAtTime(0, t + dur);
      wet.gain.value = lerp(0.2, 0.8, state.spaciousness);
      osc.connect(filt); filt.connect(env);
      env.connect(masterGain); env.connect(wet); wet.connect(reverbNode);
      osc.start(t); osc.stop(t + dur + 0.1);
    }
    return dur - 0.5;
  }

  return {
    name: 'pad',
    tick(now) {
      while (nextTime < now + LOOKAHEAD) {
        if (!nextTime) nextTime = now;
        nextTime += play(nextTime);
      }
    },
    reset(now) { nextTime = now; },
  };
})();
