import { audio } from '../context.js';
import { state, SCALES, SCALE_NAMES, LOOKAHEAD, beat, rand, pick, midiToHz, scaleNotes } from '../state.js';

export const rhodesVoice = (() => {
  let nextTime = 0;
  let lastMidi  = -1;

  function play(t) {
    const { ctx, masterGain, reverbNode } = audio;
    if (Math.random() < 0.2) return beat() * pick([0.5, 1]);

    const scale = SCALES[SCALE_NAMES[state.scaleIdx]];
    const notes = scaleNotes(state.rootMidi + 36, scale, 2);
    let midi;
    if (lastMidi > 0 && Math.random() < 0.6) {
      const idx = notes.indexOf(lastMidi);
      if (idx >= 0) midi = notes[Math.max(0, Math.min(notes.length - 1, idx + pick([-2, -1, 1, 2])))];
    }
    if (!midi) midi = pick(notes);
    lastMidi = midi;

    const hz   = midiToHz(midi);
    const dur  = beat() * pick([0.75, 1, 1.5, 2]);
    const gain = rand(0.10, 0.16);

    // Sine carrier with a very brief inharmonic "clunk" partial on attack
    const osc = ctx.createOscillator(), env = ctx.createGain();
    osc.type = 'sine'; osc.frequency.value = hz;
    env.gain.setValueAtTime(gain, t);
    env.gain.exponentialRampToValueAtTime(gain * 0.4, t + 0.1);
    env.gain.exponentialRampToValueAtTime(0.001, t + dur);
    osc.connect(env); env.connect(masterGain);

    const clunk    = ctx.createOscillator(), clunkEnv = ctx.createGain();
    clunk.type = 'sine'; clunk.frequency.value = hz * 7.1;
    clunkEnv.gain.setValueAtTime(gain * 0.6, t);
    clunkEnv.gain.exponentialRampToValueAtTime(0.001, t + 0.04);
    clunk.connect(clunkEnv); clunkEnv.connect(masterGain);

    const wet = ctx.createGain(); wet.gain.value = 0.35;
    env.connect(wet); wet.connect(reverbNode);

    osc.start(t); osc.stop(t + dur + 0.05);
    clunk.start(t); clunk.stop(t + 0.06);
    return beat() * pick([0.5, 1, 1, 1.5]);
  }

  return {
    name: 'rhodes',
    tick(now) {
      while (nextTime < now + LOOKAHEAD) {
        if (!nextTime) nextTime = now;
        nextTime += play(nextTime);
      }
    },
    reset(now) { nextTime = now; },
  };
})();
