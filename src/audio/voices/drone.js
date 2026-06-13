import { audio } from '../context.js';
import { state, SCALES, SCALE_NAMES, LOOKAHEAD, beat, rand, pick, lerp, midiToHz } from '../state.js';

export const droneVoice = (() => {
  let nextTime = 0;

  function play(t) {
    const { ctx, masterGain, reverbNode } = audio;
    const scale = SCALES[SCALE_NAMES[state.scaleIdx]];
    const notes = [state.rootBase + 12, state.rootBase + 12 + scale[4]]; // root + fifth
    const dur   = beat() * pick([8, 12, 16]);
    const gain  = rand(0.06, 0.10);

    for (const midi of notes) {
      const hz  = midiToHz(midi);
      const osc = ctx.createOscillator(), filt = ctx.createBiquadFilter();
      const env = ctx.createGain(),       wet  = ctx.createGain();
      osc.type = Math.random() < 0.5 ? 'sawtooth' : 'square';
      osc.frequency.value = hz; osc.detune.value = rand(-6, 6);
      filt.type = 'lowpass'; filt.frequency.value = lerp(200, 800, state.brightness); filt.Q.value = 0.8;
      const attackEnd = t + 2.5;
      const sustainAt = t + Math.max(2.5, dur - 2.5);
      env.gain.setValueAtTime(0, t);
      env.gain.linearRampToValueAtTime(gain, attackEnd);
      env.gain.setValueAtTime(gain, sustainAt);
      env.gain.linearRampToValueAtTime(0, t + dur);
      wet.gain.value = lerp(0.4, 0.9, state.spaciousness);
      osc.connect(filt); filt.connect(env);
      env.connect(masterGain); env.connect(wet); wet.connect(reverbNode);
      osc.start(t); osc.stop(t + dur + 0.1);
    }
    return dur - 1.0;
  }

  return {
    name: 'drone',
    tick(now) {
      while (nextTime < now + LOOKAHEAD) {
        if (!nextTime) nextTime = now;
        nextTime += play(nextTime);
      }
    },
    reset(now) { nextTime = now; },
  };
})();
