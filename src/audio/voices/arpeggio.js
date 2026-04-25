import { audio } from '../context.js';
import { state, SCALES, SCALE_NAMES, LOOKAHEAD, beat, rand, pick, midiToHz } from '../state.js';

export const arpeggioVoice = (() => {
  let nextTime = 0;

  function play(t) {
    const { ctx, masterGain, reverbNode } = audio;
    const scale  = SCALES[SCALE_NAMES[state.scaleIdx]];
    const root   = state.rootMidi + 36;
    const degree = pick([0, 2, 4]);
    const chord  = [0, 2, 4, 7].map(i => root + scale[(degree + i) % scale.length]);
    const stepDur = beat() * pick([0.25, 0.25, 0.5]);
    const gain    = rand(0.07, 0.12);
    const pattern = Math.random() < 0.5 ? chord : [...chord, ...chord.slice(0, -1).reverse()];

    for (let i = 0; i < pattern.length; i++) {
      const st  = t + i * stepDur;
      const hz  = midiToHz(pattern[i]);
      const osc = ctx.createOscillator(), env = ctx.createGain(), wet = ctx.createGain();
      osc.type = 'triangle'; osc.frequency.value = hz; osc.detune.value = rand(-3, 3);
      env.gain.setValueAtTime(0, st);
      env.gain.linearRampToValueAtTime(gain, st + 0.01);
      env.gain.exponentialRampToValueAtTime(0.001, st + stepDur * 0.85);
      wet.gain.value = 0.4;
      osc.connect(env); env.connect(masterGain); env.connect(wet); wet.connect(reverbNode);
      osc.start(st); osc.stop(st + stepDur);
    }
    return pattern.length * stepDur;
  }

  return {
    name: 'arpeggio',
    tick(now) {
      while (nextTime < now + LOOKAHEAD) {
        if (!nextTime) nextTime = now;
        nextTime += play(nextTime);
      }
    },
    reset(now) { nextTime = now; },
  };
})();
