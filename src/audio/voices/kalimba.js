import { audio } from '../context.js';
import { state, SCALES, SCALE_NAMES, LOOKAHEAD, beat, rand, pick, midiToHz, scaleNotes } from '../state.js';
import { harmony } from '../harmony.js';

export const kalimbaVoice = (() => {
  let nextTime = 0;

  function play(t) {
    const { ctx, masterGain, reverbNode } = audio;
    if (Math.random() < 0.1) return beat() * 0.25;

    const scale    = SCALES[SCALE_NAMES[state.scaleIdx]];
    const notes    = scaleNotes(state.rootBase + 36, scale, 2);
    const numNotes = Math.random() < 0.4 ? 2 : 1; // two thumbs occasionally

    for (let n = 0; n < numNotes; n++) {
      const midi      = harmony.pickChordTone(notes);
      const hz        = midiToHz(midi);
      const offset    = n * 0.04; // thumb stagger
      const gain      = rand(0.05, 0.09);
      const decayTime = rand(0.8, 1.4);

      // Fundamental tine (pure sine)
      const osc = ctx.createOscillator();
      const env = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = hz;
      env.gain.setValueAtTime(gain, t + offset);
      env.gain.exponentialRampToValueAtTime(0.001, t + offset + decayTime);

      // Inharmonic tine overtone — brief metallic click on attack
      const osc2 = ctx.createOscillator();
      const env2 = ctx.createGain();
      osc2.type = 'sine';
      osc2.frequency.value = hz * 5.44;
      env2.gain.setValueAtTime(gain * 0.18, t + offset);
      env2.gain.exponentialRampToValueAtTime(0.001, t + offset + 0.10);

      osc.connect(env); env.connect(masterGain);
      osc2.connect(env2); env2.connect(masterGain);
      const wet = ctx.createGain(); wet.gain.value = 0.42;
      env.connect(wet); wet.connect(reverbNode);

      osc.start(t + offset); osc.stop(t + offset + decayTime + 0.05);
      osc2.start(t + offset); osc2.stop(t + offset + 0.12);
    }

    return beat() * pick([0.25, 0.5, 0.5, 0.75]);
  }

  return {
    name: 'kalimba',
    tick(now) {
      while (nextTime < now + LOOKAHEAD) {
        if (!nextTime) nextTime = now;
        nextTime += play(nextTime);
      }
    },
    reset(now) { nextTime = now; },
  };
})();
