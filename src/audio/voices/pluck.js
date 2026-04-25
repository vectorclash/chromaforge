import { audio } from '../context.js';
import { state, SCALES, SCALE_NAMES, LOOKAHEAD, beat, rand, pick, midiToHz, scaleNotes } from '../state.js';

export const pluckVoice = (() => {
  let nextTime = 0;

  function play(t) {
    const { ctx, masterGain, reverbNode } = audio;
    if (Math.random() < 0.15) return beat() * pick([0.5, 1]);

    const notes = scaleNotes(state.rootMidi + 36, SCALES[SCALE_NAMES[state.scaleIdx]], 2);
    const hz    = midiToHz(pick(notes));
    const dur   = rand(0.4, 1.2);
    const gain  = rand(0.1, 0.18);

    // Noise burst through a narrow bandpass — simulates a plucked string body
    const buf  = ctx.createBuffer(1, ctx.sampleRate * 0.08, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource(); src.buffer = buf;
    const bp  = ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = hz; bp.Q.value = 28;
    const env = ctx.createGain(), wet = ctx.createGain();
    env.gain.setValueAtTime(gain, t);
    env.gain.exponentialRampToValueAtTime(0.001, t + dur);
    wet.gain.value = 0.5;
    src.connect(bp); bp.connect(env);
    env.connect(masterGain); env.connect(wet); wet.connect(reverbNode);
    src.start(t); src.stop(t + dur + 0.05);
    return beat() * pick([0.5, 0.5, 1, 1, 1.5]);
  }

  return {
    name: 'pluck',
    tick(now) {
      while (nextTime < now + LOOKAHEAD) {
        if (!nextTime) nextTime = now;
        nextTime += play(nextTime);
      }
    },
    reset(now) { nextTime = now; },
  };
})();
