import { audio } from '../context.js';
import { state, SCALES, SCALE_NAMES, LOOKAHEAD, beat, rand, pick, midiToHz, scaleNotes } from '../state.js';

export const brassVoice = (() => {
  let nextTime = 0;

  function play(t) {
    const { ctx, masterGain, reverbNode } = audio;
    if (Math.random() < 0.3) return beat() * pick([1, 2]);

    const scale = SCALES[SCALE_NAMES[state.scaleIdx]];
    const hz    = midiToHz(pick(scaleNotes(state.rootMidi + 24, scale, 2)));
    const dur   = beat() * pick([1, 1, 1.5, 2]);
    const gain  = rand(0.10, 0.16);

    const osc  = ctx.createOscillator(), filt = ctx.createBiquadFilter();
    const env  = ctx.createGain(),       wet  = ctx.createGain();
    osc.type = 'sawtooth'; osc.frequency.value = hz;
    filt.type = 'bandpass'; filt.Q.value = 4.5;
    // Formant sweep — lips opening then settling
    filt.frequency.setValueAtTime(hz * 1.5, t);
    filt.frequency.exponentialRampToValueAtTime(hz * 4.5, t + 0.04);
    filt.frequency.exponentialRampToValueAtTime(hz * 2.2, t + 0.18);
    filt.frequency.exponentialRampToValueAtTime(hz * 1.8, t + dur);
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(gain, t + 0.03);
    env.gain.setValueAtTime(gain * 0.75, t + 0.15);
    env.gain.exponentialRampToValueAtTime(0.001, t + dur);
    wet.gain.value = 0.3;
    osc.connect(filt); filt.connect(env);
    env.connect(masterGain); env.connect(wet); wet.connect(reverbNode);
    osc.start(t); osc.stop(t + dur + 0.05);
    return beat() * pick([1, 1, 2]);
  }

  return {
    name: 'brass',
    tick(now) {
      while (nextTime < now + LOOKAHEAD) {
        if (!nextTime) nextTime = now;
        nextTime += play(nextTime);
      }
    },
    reset(now) { nextTime = now; },
  };
})();
