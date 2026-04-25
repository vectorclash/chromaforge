import { audio } from '../context.js';
import { state, SCALES, SCALE_NAMES, LOOKAHEAD, beat, rand, pick, lerp, midiToHz } from '../state.js';

export const choirVoice = (() => {
  let nextTime = 0;

  function play(t) {
    const { ctx, masterGain, reverbNode } = audio;
    const scale  = SCALES[SCALE_NAMES[state.scaleIdx]];
    const root   = state.rootMidi + 24;
    const degree = pick([0, 2, 4]);
    const chord  = [0, 2, 4].map(i => root + scale[(degree + i) % scale.length]);
    const dur    = beat() * pick([6, 8, 10]);
    const gain   = rand(0.04, 0.08);

    for (const midi of chord) {
      // 3 detuned sines per note for choir width
      for (const detune of [-12, 0, 12]) {
        const osc  = ctx.createOscillator(), filt = ctx.createBiquadFilter();
        const env  = ctx.createGain(),       wet  = ctx.createGain();
        osc.type = 'sine'; osc.frequency.value = midiToHz(midi); osc.detune.value = detune + rand(-3, 3);
        filt.type = 'bandpass'; filt.Q.value = 1.5;
        // Slow filter sweep for vowel movement
        filt.frequency.setValueAtTime(lerp(600, 1800, state.brightness), t);
        filt.frequency.linearRampToValueAtTime(lerp(1200, 3000, state.brightness), t + dur * 0.6);
        env.gain.setValueAtTime(0, t);
        env.gain.linearRampToValueAtTime(gain / 3, t + 1.2);
        env.gain.setValueAtTime(gain / 3, t + dur - 1.5);
        env.gain.linearRampToValueAtTime(0, t + dur);
        wet.gain.value = 0.8;
        osc.connect(filt); filt.connect(env);
        env.connect(masterGain); env.connect(wet); wet.connect(reverbNode);
        osc.start(t); osc.stop(t + dur + 0.1);
      }
    }
    return dur - 1.0;
  }

  return {
    name: 'choir',
    tick(now) {
      while (nextTime < now + LOOKAHEAD) {
        if (!nextTime) nextTime = now;
        nextTime += play(nextTime);
      }
    },
    reset(now) { nextTime = now; },
  };
})();
