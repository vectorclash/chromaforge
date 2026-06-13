import { audio } from '../context.js';
import { state, SCALES, SCALE_NAMES, LOOKAHEAD, beat, rand, pick, midiToHz, scaleNotes } from '../state.js';
import { harmony } from '../harmony.js';

export const vibraphoneVoice = (() => {
  let nextTime = 0;
  let lastMidi = -1;

  function play(t) {
    const { ctx, masterGain, reverbNode } = audio;
    if (Math.random() < 0.15) return beat() * pick([0.5, 1]);

    const scale = SCALES[SCALE_NAMES[state.scaleIdx]];
    const notes = scaleNotes(state.rootBase + 36, scale, 2);
    let midi;
    if (lastMidi > 0 && Math.random() < 0.65) {
      const idx = notes.indexOf(lastMidi);
      if (idx >= 0) midi = notes[Math.max(0, Math.min(notes.length - 1, idx + pick([-2, -1, 1, 2])))];
    }
    if (!midi) midi = harmony.pickChordTone(notes);
    lastMidi = midi;

    const hz        = midiToHz(midi);
    const dur       = beat() * pick([1, 1.5, 2, 2]);
    const gain      = rand(0.07, 0.12);
    const decayTime = dur * 1.8 + rand(0.4, 0.9);

    // Fundamental sine through tremolo → envelope
    const osc     = ctx.createOscillator();
    const tremolo = ctx.createGain();
    const env     = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = hz;
    tremolo.gain.value = 1.0;
    env.gain.setValueAtTime(gain, t);
    env.gain.exponentialRampToValueAtTime(0.001, t + decayTime);

    // Motor LFO (~6 Hz amplitude tremolo)
    const lfo     = ctx.createOscillator();
    const lfoGain = ctx.createGain();
    lfo.frequency.value = 5.8 + rand(-0.4, 0.4);
    lfoGain.gain.value  = 0.09;
    lfo.connect(lfoGain);
    lfoGain.connect(tremolo.gain);

    // Inharmonic metallic partial — decays much faster
    const osc2 = ctx.createOscillator();
    const env2 = ctx.createGain();
    osc2.type = 'sine';
    osc2.frequency.value = hz * 2.756;
    env2.gain.setValueAtTime(gain * 0.12, t);
    env2.gain.exponentialRampToValueAtTime(0.001, t + 0.22);

    osc.connect(tremolo); tremolo.connect(env); env.connect(masterGain);
    osc2.connect(env2); env2.connect(masterGain);
    const wet = ctx.createGain(); wet.gain.value = 0.32;
    env.connect(wet); wet.connect(reverbNode);

    lfo.start(t); lfo.stop(t + decayTime + 0.05);
    osc.start(t); osc.stop(t + decayTime + 0.05);
    osc2.start(t); osc2.stop(t + 0.25);

    return beat() * pick([0.5, 1, 1, 1.5]);
  }

  return {
    name: 'vibraphone',
    tick(now) {
      while (nextTime < now + LOOKAHEAD) {
        if (!nextTime) nextTime = now;
        nextTime += play(nextTime);
      }
    },
    reset(now) { nextTime = now; lastMidi = -1; },
  };
})();
