import { audio } from '../context.js';
import { state, LOOKAHEAD, beat, rand, pick, midiToHz } from '../state.js';
import { harmony } from '../harmony.js';

export const harpVoice = (() => {
  let nextTime = 0;

  function play(t) {
    const { ctx, masterGain, reverbNode } = audio;
    const wait = beat() * pick([2, 3, 4]);
    if (Math.random() < 0.25) return wait;

    const noteCount = 5 + Math.floor(Math.random() * 3); // 5–7 notes
    // Arpeggiate the current chord across octaves (stacked thirds), so the
    // sweep lands only on chord tones and stays locked to the progression.
    const notes = harmony.chordMidis(state.rootBase + 24, noteCount);
    if (Math.random() < 0.4) notes.reverse();

    const stepDur = beat() * pick([0.18, 0.22, 0.28]);
    for (let i = 0; i < notes.length; i++) {
      const st   = t + i * stepDur;
      const hz   = midiToHz(notes[i]);
      const dur  = rand(1.2, 2.5);
      const gain = rand(0.07, 0.12);

      // Pluck transient — narrow bandpass noise gives the physical string "ping"
      const pLen  = Math.ceil(ctx.sampleRate * 0.032);
      const pBuf  = ctx.createBuffer(1, pLen, ctx.sampleRate);
      const pData = pBuf.getChannelData(0);
      for (let j = 0; j < pLen; j++) pData[j] = Math.random() * 2 - 1;
      const pSrc = ctx.createBufferSource(); pSrc.buffer = pBuf;
      const pbp  = ctx.createBiquadFilter(); pbp.type = 'bandpass'; pbp.frequency.value = hz; pbp.Q.value = 30;
      const pEnv = ctx.createGain();
      pEnv.gain.setValueAtTime(gain * 1.1, st);
      pEnv.gain.exponentialRampToValueAtTime(0.001, st + 0.032);
      pSrc.connect(pbp); pbp.connect(pEnv); pEnv.connect(masterGain);
      pSrc.start(st); pSrc.stop(st + 0.038);

      // Fundamental — long sustain
      const osc = ctx.createOscillator(), env = ctx.createGain(), wet = ctx.createGain();
      osc.type = 'sine'; osc.frequency.value = hz;
      env.gain.setValueAtTime(gain, st);
      env.gain.exponentialRampToValueAtTime(0.001, st + dur);
      wet.gain.value = 0.65;
      osc.connect(env); env.connect(masterGain); env.connect(wet); wet.connect(reverbNode);
      osc.start(st); osc.stop(st + dur + 0.05);

      // 2nd harmonic — adds brightness, decays much faster
      const osc2 = ctx.createOscillator(), env2 = ctx.createGain();
      osc2.type = 'sine'; osc2.frequency.value = hz * 2;
      env2.gain.setValueAtTime(gain * 0.22, st);
      env2.gain.exponentialRampToValueAtTime(0.001, st + dur * 0.28);
      osc2.connect(env2); env2.connect(masterGain);
      osc2.start(st); osc2.stop(st + dur * 0.28 + 0.05);
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
