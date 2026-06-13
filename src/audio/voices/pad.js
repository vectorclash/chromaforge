import { audio } from '../context.js';
import { state, LOOKAHEAD, beat, rand, pick, lerp, midiToHz } from '../state.js';
import { harmony } from '../harmony.js';

export const padVoice = (() => {
  let nextTime = 0;

  function play(t) {
    const { ctx, masterGain, reverbNode } = audio;
    const chord  = harmony.chordMidis(state.rootBase + 12, 3);
    const dur    = beat() * pick([3, 4, 6, 8]);
    const gain   = rand(0.06, 0.12);

    for (const midi of chord) {
      const hz   = midiToHz(midi);
      const osc  = ctx.createOscillator(), filt = ctx.createBiquadFilter();
      const env  = ctx.createGain(),       wet  = ctx.createGain();
      osc.type = 'sawtooth'; osc.frequency.value = hz; osc.detune.value = rand(-8, 8);
      filt.type = 'lowpass'; filt.frequency.value = lerp(400, 2400, state.brightness); filt.Q.value = 1.2;
      const attackEnd = t + 0.8;
      const sustainAt = t + Math.max(0.8, dur - 1.0);
      env.gain.setValueAtTime(0, t);
      env.gain.linearRampToValueAtTime(gain, attackEnd);
      env.gain.setValueAtTime(gain, sustainAt);
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
