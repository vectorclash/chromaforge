import { audio } from '../context.js';
import { state, SCALES, SCALE_NAMES, LOOKAHEAD, beat, rand, pick, midiToHz } from '../state.js';

// Hammond-style additive synthesis: 5 drawbar harmonics
const DRAWBARS = [[1, 0.8], [2, 0.5], [3, 0.3], [4, 0.2], [5, 0.15]];

export const organVoice = (() => {
  let nextTime = 0;

  function play(t) {
    const { ctx, masterGain } = audio;
    const scale  = SCALES[SCALE_NAMES[state.scaleIdx]];
    const root   = state.rootMidi + 24;
    const degree = pick([0, 2, 4]);
    const chord  = [0, 2, 4].map(i => root + scale[(degree + i) % scale.length]);
    const dur    = beat() * pick([2, 3, 4]);

    for (const midi of chord) {
      const hz = midiToHz(midi);
      for (const [ratio, vol] of DRAWBARS) {
        const osc = ctx.createOscillator(), env = ctx.createGain();
        osc.type = 'sine'; osc.frequency.value = hz * ratio;
        const g = rand(0.03, 0.05) * vol;
        env.gain.setValueAtTime(0, t);
        env.gain.linearRampToValueAtTime(g, t + 0.01); // fast click-free attack
        env.gain.setValueAtTime(g, t + dur - 0.05);
        env.gain.linearRampToValueAtTime(0, t + dur);
        osc.connect(env); env.connect(masterGain);
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
