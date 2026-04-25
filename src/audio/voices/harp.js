import { audio } from '../context.js';
import { state, SCALES, SCALE_NAMES, LOOKAHEAD, beat, rand, pick, midiToHz } from '../state.js';

export const harpVoice = (() => {
  let nextTime = 0;

  function play(t) {
    const { ctx, masterGain, reverbNode } = audio;
    const wait = beat() * pick([2, 3, 4]);
    if (Math.random() < 0.25) return wait;

    const scale     = SCALES[SCALE_NAMES[state.scaleIdx]];
    const root      = state.rootMidi + 36;
    const degree    = pick([0, 2, 4]);
    const noteCount = 5 + Math.floor(Math.random() * 3); // 5–7 notes

    const notes = Array.from({ length: noteCount }, (_, i) => {
      const idx = (degree + i) % scale.length;
      const oct = Math.floor((degree + i) / scale.length);
      return root + oct * 12 + scale[idx];
    });
    if (Math.random() < 0.4) notes.reverse(); // descending sometimes

    const stepDur = beat() * pick([0.18, 0.22, 0.28]);
    for (let i = 0; i < notes.length; i++) {
      const st   = t + i * stepDur;
      const hz   = midiToHz(notes[i]);
      const dur  = rand(1.2, 2.5);
      const gain = rand(0.07, 0.12);
      const osc  = ctx.createOscillator(), env = ctx.createGain(), wet = ctx.createGain();
      osc.type = 'triangle'; osc.frequency.value = hz;
      env.gain.setValueAtTime(gain, st);
      env.gain.exponentialRampToValueAtTime(0.001, st + dur);
      wet.gain.value = 0.65;
      osc.connect(env); env.connect(masterGain); env.connect(wet); wet.connect(reverbNode);
      osc.start(st); osc.stop(st + dur + 0.05);
    }
    return notes.length * stepDur + beat();
  }

  return {
    name: 'harp',
    tick(now) {
      while (nextTime < now + LOOKAHEAD) {
        if (!nextTime) nextTime = now;
        nextTime += play(nextTime);
      }
    },
    reset(now) { nextTime = now; },
  };
})();
