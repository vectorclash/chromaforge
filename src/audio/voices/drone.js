import { audio } from '../context.js';
import { state, SCALES, SCALE_NAMES, LOOKAHEAD, beat, rand, pick, lerp, midiToHz } from '../state.js';

export const droneVoice = (() => {
  let nextTime = 0;

  function play(t) {
    const { ctx, masterGain, reverbNode } = audio;
    const scale = SCALES[SCALE_NAMES[state.scaleIdx]];
    const notes = [state.rootMidi + 12, state.rootMidi + 12 + scale[4]]; // root + fifth
    const dur   = beat() * pick([12, 16, 20, 24]);
    const gain  = rand(0.04, 0.08);

    for (const midi of notes) {
      const hz  = midiToHz(midi);
      // Two slightly detuned sines create a slow cosmic beating shimmer
      for (const detune of [-3, 3]) {
        const osc = ctx.createOscillator();
        const env = ctx.createGain(), wet = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = hz;
        osc.detune.value = detune;
        env.gain.setValueAtTime(0, t);
        env.gain.linearRampToValueAtTime(gain * 0.6, t + 3.5);
        env.gain.setValueAtTime(gain * 0.6, t + dur - 3.5);
        env.gain.linearRampToValueAtTime(0, t + dur);
        wet.gain.value = lerp(0.6, 0.95, state.spaciousness);
        osc.connect(env);
        env.connect(masterGain); env.connect(wet); wet.connect(reverbNode);
        osc.start(t); osc.stop(t + dur + 0.1);
      }
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
