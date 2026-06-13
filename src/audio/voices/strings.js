import { audio } from '../context.js';
import { state, LOOKAHEAD, beat, rand, pick, lerp, midiToHz } from '../state.js';
import { harmony } from '../harmony.js';

export const stringsVoice = (() => {
  let nextTime = 0;

  function play(t) {
    const { ctx, masterGain, reverbNode } = audio;
    const chord  = harmony.chordMidis(state.rootBase + 12, 3);
    const dur    = beat() * pick([4, 6, 8]);
    const gain   = rand(0.07, 0.11);

    for (const midi of chord) {
      const hz = midiToHz(midi);
      // Three detuned saws — width gives the ensemble string texture
      for (const detune of [-10, 0, 10]) {
        const osc  = ctx.createOscillator(), filt = ctx.createBiquadFilter();
        const env  = ctx.createGain(),       wet  = ctx.createGain();
        osc.type = 'sawtooth'; osc.frequency.value = hz; osc.detune.value = detune + rand(-3, 3);
        filt.type = 'lowpass'; filt.Q.value = 0.8;
        // Filter opens slowly — simulates bow pressure building
        filt.frequency.setValueAtTime(300, t);
        filt.frequency.linearRampToValueAtTime(lerp(800, 2800, state.brightness), t + dur * 0.4);
        env.gain.setValueAtTime(0, t);
        env.gain.linearRampToValueAtTime(gain / 3, t + dur * 0.35);
        env.gain.setValueAtTime(gain / 3, t + dur - 1.2);
        env.gain.linearRampToValueAtTime(0, t + dur);
        wet.gain.value = lerp(0.3, 0.8, state.spaciousness);
        osc.connect(filt); filt.connect(env);
        env.connect(masterGain); env.connect(wet); wet.connect(reverbNode);
        osc.start(t); osc.stop(t + dur + 0.1);
      }
    }
    return dur - 0.8;
  }

  return {
    name: 'strings',
    tick(now) {
      while (nextTime < now + LOOKAHEAD) {
        if (!nextTime) nextTime = now;
        nextTime += play(nextTime);
      }
    },
    reset(now) { nextTime = now; },
  };
})();
