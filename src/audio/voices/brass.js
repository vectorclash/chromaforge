import { audio } from '../context.js';
import { state, SCALES, SCALE_NAMES, LOOKAHEAD, beat, rand, pick, midiToHz, scaleNotes } from '../state.js';
import { harmony } from '../harmony.js';

export const brassVoice = (() => {
  let nextTime = 0;

  function play(t) {
    const { ctx, masterGain, reverbNode } = audio;
    if (Math.random() < 0.3) return beat() * pick([1, 2]);

    const scale = SCALES[SCALE_NAMES[state.scaleIdx]];
    const hz    = midiToHz(harmony.pickChordTone(scaleNotes(state.rootBase + 24, scale, 2)));
    const dur   = beat() * pick([1, 1, 1.5, 2]);
    const gain  = rand(0.10, 0.16);

    // Two detuned oscillators — ensemble width, like two players on the same part
    const osc1 = ctx.createOscillator(), osc2 = ctx.createOscillator();
    const filt = ctx.createBiquadFilter();
    const env  = ctx.createGain(), wet = ctx.createGain();
    osc1.type = 'sawtooth'; osc1.frequency.value = hz; osc1.detune.value = -6;
    osc2.type = 'sawtooth'; osc2.frequency.value = hz; osc2.detune.value =  6;
    filt.type = 'bandpass'; filt.Q.value = 3.8;
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
    osc1.connect(filt); osc2.connect(filt); filt.connect(env);
    env.connect(masterGain); env.connect(wet); wet.connect(reverbNode);
    osc1.start(t); osc1.stop(t + dur + 0.05);
    osc2.start(t); osc2.stop(t + dur + 0.05);
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
