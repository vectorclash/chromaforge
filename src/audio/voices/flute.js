import { audio } from '../context.js';
import { state, SCALES, SCALE_NAMES, LOOKAHEAD, beat, rand, pick, midiToHz, scaleNotes } from '../state.js';
import { harmony } from '../harmony.js';

export const fluteVoice = (() => {
  let nextTime = 0;

  function play(t) {
    const { ctx, masterGain, reverbNode } = audio;
    if (Math.random() < 0.2) return beat() * pick([1, 1, 2]);

    const notes = scaleNotes(state.rootBase + 36, SCALES[SCALE_NAMES[state.scaleIdx]], 2);
    const hz   = midiToHz(harmony.pickChordTone(notes));
    const dur  = beat() * pick([1, 1.5, 2, 3]);
    const gain = rand(0.06, 0.11);

    const osc = ctx.createOscillator(), env = ctx.createGain(), wet = ctx.createGain();
    osc.type = 'sine'; osc.frequency.value = hz;

    // Vibrato: pitch modulation with delayed onset — flute players add vibrato after the attack
    const lfo = ctx.createOscillator(), lfoGain = ctx.createGain();
    lfo.type = 'sine'; lfo.frequency.value = rand(4.8, 6.2);
    lfoGain.gain.setValueAtTime(0, t);
    lfoGain.gain.linearRampToValueAtTime(0, t + 0.28);
    lfoGain.gain.linearRampToValueAtTime(hz * 0.007, t + 0.55); // ~12 cents depth
    lfo.connect(lfoGain); lfoGain.connect(osc.frequency);

    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(gain, t + 0.08);
    env.gain.setValueAtTime(gain, t + dur - 0.12);
    env.gain.linearRampToValueAtTime(0, t + dur);
    wet.gain.value = 0.55;
    osc.connect(env); env.connect(masterGain); env.connect(wet); wet.connect(reverbNode);
    osc.start(t); osc.stop(t + dur + 0.05);
    lfo.start(t); lfo.stop(t + dur + 0.05);

    // Breath transient: highpass-filtered noise on the attack gives the characteristic air
    const bLen  = Math.ceil(ctx.sampleRate * 0.16);
    const bBuf  = ctx.createBuffer(1, bLen, ctx.sampleRate);
    const bData = bBuf.getChannelData(0);
    for (let i = 0; i < bLen; i++) bData[i] = Math.random() * 2 - 1;
    const bSrc = ctx.createBufferSource(); bSrc.buffer = bBuf;
    const bhp  = ctx.createBiquadFilter(); bhp.type = 'highpass'; bhp.frequency.value = hz * 2.2;
    const bEnv = ctx.createGain();
    bEnv.gain.setValueAtTime(gain * 0.20, t);
    bEnv.gain.exponentialRampToValueAtTime(0.001, t + 0.13);
    bSrc.connect(bhp); bhp.connect(bEnv); bEnv.connect(masterGain);
    bSrc.start(t); bSrc.stop(t + 0.17);

    return beat() * pick([1, 1, 1.5, 2]);
  }

  return {
    name: 'flute',
    tick(now) {
      while (nextTime < now + LOOKAHEAD) {
        if (!nextTime) nextTime = now;
        nextTime += play(nextTime);
      }
    },
    reset(now) { nextTime = now; },
  };
})();
