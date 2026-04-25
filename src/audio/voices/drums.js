import { audio } from '../context.js';
import { state, LOOKAHEAD, beat, rand, pick } from '../state.js';

// ─── Synthesis helpers ────────────────────────────────────────────────────────

function kick(ctx, dest, t, gain) {
  // Sine sweep: 155 Hz → 38 Hz transient body
  const osc = ctx.createOscillator();
  const env = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(155, t);
  osc.frequency.exponentialRampToValueAtTime(38, t + 0.08);
  env.gain.setValueAtTime(0.001, t);
  env.gain.linearRampToValueAtTime(gain, t + 0.003);
  env.gain.exponentialRampToValueAtTime(0.001, t + 0.30);
  osc.connect(env); env.connect(dest);
  osc.start(t); osc.stop(t + 0.31);

  // High click for attack definition
  const click = ctx.createOscillator();
  const cEnv  = ctx.createGain();
  click.type = 'square'; click.frequency.value = 900;
  cEnv.gain.setValueAtTime(gain * 0.07, t);
  cEnv.gain.exponentialRampToValueAtTime(0.001, t + 0.011);
  click.connect(cEnv); cEnv.connect(dest);
  click.start(t); click.stop(t + 0.013);
}

function snare(ctx, dest, reverbDest, t, gain) {
  // Noise burst through highpass
  const dur    = 0.16;
  const bufLen = Math.ceil(ctx.sampleRate * (dur + 0.01));
  const buf    = ctx.createBuffer(1, bufLen, ctx.sampleRate);
  const data   = buf.getChannelData(0);
  for (let i = 0; i < bufLen; i++) data[i] = Math.random() * 2 - 1;
  const src = ctx.createBufferSource(); src.buffer = buf;
  const hp  = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 1800;
  const env = ctx.createGain();
  env.gain.setValueAtTime(0.001, t);
  env.gain.linearRampToValueAtTime(gain, t + 0.003);
  env.gain.exponentialRampToValueAtTime(0.001, t + dur);
  src.connect(hp); hp.connect(env);
  env.connect(dest);
  // Small reverb tail gives snare some room
  const wet = ctx.createGain(); wet.gain.value = 0.18;
  env.connect(wet); wet.connect(reverbDest);
  src.start(t); src.stop(t + dur + 0.01);

  // Tonal body (snare "crack" tone)
  const osc  = ctx.createOscillator();
  const tEnv = ctx.createGain();
  osc.type = 'triangle'; osc.frequency.value = 188;
  tEnv.gain.setValueAtTime(gain * 0.5, t);
  tEnv.gain.exponentialRampToValueAtTime(0.001, t + 0.06);
  osc.connect(tEnv); tEnv.connect(dest);
  osc.start(t); osc.stop(t + 0.065);
}

function hihat(ctx, dest, t, gain, open = false) {
  const dur    = open ? 0.22 : 0.045;
  const bufLen = Math.ceil(ctx.sampleRate * (dur + 0.01));
  const buf    = ctx.createBuffer(1, bufLen, ctx.sampleRate);
  const data   = buf.getChannelData(0);
  for (let i = 0; i < bufLen; i++) data[i] = Math.random() * 2 - 1;
  const src = ctx.createBufferSource(); src.buffer = buf;
  const hp  = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 8500;
  const env = ctx.createGain();
  env.gain.setValueAtTime(gain, t);
  env.gain.exponentialRampToValueAtTime(0.001, t + dur);
  src.connect(hp); hp.connect(env); env.connect(dest);
  src.start(t); src.stop(t + dur + 0.01);
}

// ─── Patterns (16 steps = 1 bar of 16th notes) ───────────────────────────────
// Values: 1 = full hit, 0 = rest, 0.4 = ghost note (quieter)
// H = open hi-hat (stored as negative — handled in scheduleBar)

const PATTERNS = {
  minimal: {
    kick:  [1,0,0,0, 0,0,0,0, 1,0,0,0, 0,0,0,0],
    snare: [0,0,0,0, 1,0,0,0, 0,0,0,0, 1,0,0,0],
    hihat: [0,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,0],
  },
  four_four: {
    kick:  [1,0,0,0, 0,0,0,0, 1,0,0,0, 0,0,0,0],
    snare: [0,0,0,0, 1,0,0,0, 0,0,0,0, 1,0,0,0],
    hihat: [1,0,1,0, 1,0,1,0, 1,0,1,0, 1,0,1,0],
  },
  jungle: {
    kick:  [1,0,0,0, 0,0,1,0, 0,0,0,0, 1,0,0,0],
    snare: [0,0,0,0, 1,0,0,0.4, 0,0,0.4,0, 1,0,0,0],
    hihat: [1,1,0,1, 1,0,1,1, 0,1,1,0, 1,1,0,1],
  },
  shuffle: {
    kick:  [1,0,0,0, 0,0,0,0, 1,0,0,0, 0,0,0,0],
    snare: [0,0,0,0, 1,0,0,0, 0,0,0.4,0, 1,0,0,0],
    hihat: [1,0,0,1, 0,0,1,0, 1,0,0,1, 0,0,1,0],
  },
  trap: {
    kick:  [1,0,0,0, 0,0,0,0, 0,1,0,0, 0,0,0,0],
    snare: [0,0,0,0, 0,0,0,0, 1,0,0,0, 0,0,0,0],
    hihat: [1,1,1,1, 1,1,1,1, 1,1,1,1, 1,1,1,1],
  },
  ghost: {
    kick:  [1,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,1,0],
    snare: [0,0,0,0, 0,0,1,0, 0,0,0,0, 1,0,0,0],
    hihat: [0,0,1,0, 0,0,0,0, 0,1,0,0, 0,0,0,0],
  },
};

const STYLE_NAMES = Object.keys(PATTERNS);

// ─── Voice ────────────────────────────────────────────────────────────────────

export const drumsVoice = (() => {
  let nextTime = 0;
  let style    = pick(STYLE_NAMES);

  function scheduleBar(t) {
    const { ctx, masterGain, reverbNode } = audio;
    const b       = beat();
    const stepDur = b / 4; // 16th note duration
    const p       = PATTERNS[style];

    // Scale gains with musical state
    const densityMod = 0.5 + state.density * 0.5;
    const kGain = rand(0.28, 0.36) * densityMod;
    const sGain = rand(0.15, 0.22) * densityMod;
    const hGain = rand(0.06, 0.10) * (0.4 + state.brightness * 0.6);

    for (let i = 0; i < 16; i++) {
      const st = t + i * stepDur;
      if (p.kick[i])  kick(ctx, masterGain, st, kGain  * p.kick[i]);
      if (p.snare[i]) snare(ctx, masterGain, reverbNode, st, sGain * p.snare[i]);
      if (p.hihat[i]) hihat(ctx, masterGain, st, hGain  * p.hihat[i]);
    }

    return b * 4; // one bar
  }

  return {
    name: 'drums',
    get style() { return style; },
    reroll() { style = pick(STYLE_NAMES); },
    tick(now) {
      while (nextTime < now + LOOKAHEAD) {
        if (!nextTime) nextTime = now;
        nextTime += scheduleBar(nextTime);
      }
    },
    reset(now) { nextTime = now; },
  };
})();
