import { audio } from '../context.js';
import { state, LOOKAHEAD, beat, rand, pick, midiToHz } from '../state.js';
import { harmony } from '../harmony.js';

// Hammond-style additive synthesis: 5 drawbar harmonics
const DRAWBARS = [[1, 0.8], [2, 0.5], [3, 0.3], [4, 0.2], [5, 0.15]];

export const organVoice = (() => {
  let nextTime = 0;

  function play(t) {
    const { ctx, masterGain } = audio;
    const chord  = harmony.chordMidis(state.rootBase + 24, 3);
    const dur    = beat() * pick([2, 3, 4]);

    for (const midi of chord) {
      const hz = midiToHz(midi);

      // Per-note ADSR envelope bus
      const adsr = ctx.createGain();
      adsr.gain.setValueAtTime(0, t);
      adsr.gain.linearRampToValueAtTime(1, t + 0.012);
      adsr.gain.setValueAtTime(1, t + dur - 0.05);
      adsr.gain.linearRampToValueAtTime(0, t + dur);

      // Leslie rotary speaker: AM tremolo at ~7 Hz on the output bus
      const bus    = ctx.createGain(); bus.gain.value = 1;
      const leslie = ctx.createOscillator(), lDepth = ctx.createGain();
      leslie.type = 'sine'; leslie.frequency.value = rand(6.8, 7.5);
      lDepth.gain.value = 0.07;
      leslie.connect(lDepth); lDepth.connect(bus.gain);
      leslie.start(t); leslie.stop(t + dur + 0.05);

      adsr.connect(bus); bus.connect(masterGain);

      for (const [ratio, vol] of DRAWBARS) {
        const osc = ctx.createOscillator(), dGain = ctx.createGain();
        osc.type = 'sine'; osc.frequency.value = hz * ratio;
        dGain.gain.value = rand(0.045, 0.07) * vol;
        osc.connect(dGain); dGain.connect(adsr);
        osc.start(t); osc.stop(t + dur + 0.05);
      }
    }
    return dur - 0.3;
  }

  return {
    name: 'organ',
    tick(now) {
      while (nextTime < now + LOOKAHEAD) {
        if (!nextTime) nextTime = now;
        nextTime += play(nextTime);
      }
    },
    reset(now) { nextTime = now; },
  };
})();
