import { audio } from '../context.js';
import { state, SCALES, SCALE_NAMES, LOOKAHEAD, beat, rand, pick, midiToHz, scaleNotes } from '../state.js';
import { harmony } from '../harmony.js';

export const sitarVoice = (() => {
  let nextTime = 0;
  let lastMidi = -1;

  function play(t) {
    const { ctx, masterGain, reverbNode } = audio;
    if (Math.random() < 0.18) return beat() * pick([0.5, 1]);

    const scale = SCALES[SCALE_NAMES[state.scaleIdx]];
    const notes = scaleNotes(state.rootBase + 24, scale, 2);
    let midi;
    if (lastMidi > 0 && Math.random() < 0.55) {
      const idx = notes.indexOf(lastMidi);
      if (idx >= 0) midi = notes[Math.max(0, Math.min(notes.length - 1, idx + pick([-2, -1, 1, 2])))];
    }
    if (!midi) midi = harmony.pickChordTone(notes);
    lastMidi = midi;

    const hz   = midiToHz(midi);
    const dur  = beat() * pick([1, 1.5, 2]);
    const gain = rand(0.10, 0.16);

    // ── Pluck transient: bandpass noise gives the initial "ping" ───────────
    const bufLen = Math.ceil(ctx.sampleRate * 0.055);
    const buf    = ctx.createBuffer(1, bufLen, ctx.sampleRate);
    const data   = buf.getChannelData(0);
    for (let i = 0; i < bufLen; i++) data[i] = Math.random() * 2 - 1;
    const src  = ctx.createBufferSource(); src.buffer = buf;
    const bpf  = ctx.createBiquadFilter();
    bpf.type = 'bandpass'; bpf.frequency.value = hz * 2; bpf.Q.value = 18;
    const tEnv = ctx.createGain();
    tEnv.gain.setValueAtTime(gain * 1.4, t);
    tEnv.gain.exponentialRampToValueAtTime(0.001, t + 0.055);
    src.connect(bpf); bpf.connect(tEnv); tEnv.connect(masterGain);
    src.start(t); src.stop(t + 0.06);

    // ── Additive harmonics — high partials decay fast, fundamental rings on ─
    // Meend: start slightly sharp, all harmonics slide together
    const slideFrom = hz * Math.pow(2, rand(0.5, 1.1) / 12);

    [
      [1, 0.90, dur],
      [2, 0.44, dur * 0.48],
      [3, 0.26, dur * 0.28],
    ].forEach(([n, amp, hdur]) => {
      const osc = ctx.createOscillator();
      const env = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(slideFrom * n, t);
      osc.frequency.exponentialRampToValueAtTime(hz * n, t + 0.045);
      env.gain.setValueAtTime(0, t);
      env.gain.linearRampToValueAtTime(gain * amp, t + 0.008);
      env.gain.exponentialRampToValueAtTime(0.001, t + hdur);
      osc.connect(env); env.connect(masterGain);
      if (n === 1) {
        const wet = ctx.createGain(); wet.gain.value = 0.22;
        env.connect(wet); wet.connect(reverbNode);
      }
      osc.start(t); osc.stop(t + hdur + 0.1);
    });

    // ── Jawari beat — detuned fundamental creates the characteristic shimmer ─
    const jaw    = ctx.createOscillator();
    const jawEnv = ctx.createGain();
    jaw.type = 'sine';
    jaw.frequency.setValueAtTime(slideFrom * 1.003, t);
    jaw.frequency.exponentialRampToValueAtTime(hz * 1.003, t + 0.045);
    jawEnv.gain.setValueAtTime(0, t);
    jawEnv.gain.linearRampToValueAtTime(gain * 0.38, t + 0.01);
    jawEnv.gain.exponentialRampToValueAtTime(0.001, t + dur * 0.55);
    jaw.connect(jawEnv); jawEnv.connect(masterGain);
    jaw.start(t); jaw.stop(t + dur * 0.55 + 0.1);

    // ── Sympathetic strings — bloom one by one after the pluck ─────────────
    scaleNotes(state.rootBase + 12, scale, 1).slice(0, 5).forEach((sm, i) => {
      const s  = ctx.createOscillator();
      const se = ctx.createGain();
      s.type = 'sine';
      s.frequency.value = midiToHz(sm);
      se.gain.setValueAtTime(0, t);
      se.gain.linearRampToValueAtTime(gain * 0.055, t + 0.06 + i * 0.018);
      se.gain.exponentialRampToValueAtTime(0.001, t + dur + rand(0.6, 1.8));
      s.connect(se); se.connect(masterGain);
      const sw = ctx.createGain(); sw.gain.value = 0.4;
      se.connect(sw); sw.connect(reverbNode);
      s.start(t); s.stop(t + dur + 2.2);
    });

    return beat() * pick([0.5, 1, 1, 1.5]);
  }

  return {
    name: 'sitar',
    tick(now) {
      while (nextTime < now + LOOKAHEAD) {
        if (!nextTime) nextTime = now;
        nextTime += play(nextTime);
      }
    },
    reset(now) { nextTime = now; lastMidi = -1; },
  };
})();
