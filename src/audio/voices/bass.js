import { audio } from '../context.js';
import { state, SCALES, SCALE_NAMES, LOOKAHEAD, beat, rand, pick, midiToHz } from '../state.js';

const STYLES = ['sub', 'plucked', 'walking', 'synth', 'rumble'];

export const bassVoice = (() => {
  let nextTime = 0;
  let style = 'sub';

  function playNote(t) {
    const { ctx, masterGain } = audio;
    const scale = SCALES[SCALE_NAMES[state.scaleIdx]];
    const midi  = state.rootMidi + pick([0, scale[4], scale[2]]);
    const hz    = midiToHz(midi);
    const b     = beat();

    if (style === 'sub') {
      const dur = b * pick([2, 2, 3, 4]);
      const gain = rand(0.20, 0.28);
      const osc = ctx.createOscillator(), sub = ctx.createOscillator();
      const env = ctx.createGain(), filt = ctx.createBiquadFilter();
      osc.type = 'triangle'; osc.frequency.value = hz;
      sub.type = 'sine';     sub.frequency.value = hz * 0.5;
      filt.type = 'lowpass'; filt.frequency.value = 260; filt.Q.value = 0.8;
      env.gain.setValueAtTime(0, t);
      env.gain.linearRampToValueAtTime(gain, t + 0.04);
      env.gain.exponentialRampToValueAtTime(0.001, t + dur * 0.88);
      osc.connect(filt); sub.connect(filt); filt.connect(env); env.connect(masterGain);
      osc.start(t); osc.stop(t + dur); sub.start(t); sub.stop(t + dur);
      return dur;

    } else if (style === 'plucked') {
      const dur = b * pick([0.5, 1, 1, 1.5]);
      const gain = rand(0.22, 0.30);
      const osc = ctx.createOscillator(), env = ctx.createGain(), filt = ctx.createBiquadFilter();
      osc.type = 'sawtooth'; osc.frequency.value = hz;
      filt.type = 'lowpass';
      filt.frequency.setValueAtTime(1200, t);
      filt.frequency.exponentialRampToValueAtTime(200, t + dur * 0.6);
      env.gain.setValueAtTime(0, t);
      env.gain.linearRampToValueAtTime(gain, t + 0.008);
      env.gain.exponentialRampToValueAtTime(0.001, t + dur * 0.75);
      osc.connect(filt); filt.connect(env); env.connect(masterGain);
      osc.start(t); osc.stop(t + dur);
      return dur;

    } else if (style === 'walking') {
      const stepDur = b * pick([0.5, 1]);
      const steps = [0, scale[2], scale[4], scale[2]];
      for (let i = 0; i < steps.length; i++) {
        const st  = t + i * stepDur;
        const shz = midiToHz(state.rootMidi + steps[i]);
        const gain = rand(0.16, 0.22);
        const osc = ctx.createOscillator(), env = ctx.createGain(), filt = ctx.createBiquadFilter();
        osc.type = 'triangle'; osc.frequency.value = shz;
        filt.type = 'lowpass'; filt.frequency.value = 320;
        env.gain.setValueAtTime(0, st);
        env.gain.linearRampToValueAtTime(gain, st + 0.015);
        env.gain.exponentialRampToValueAtTime(0.001, st + stepDur * 0.8);
        osc.connect(filt); filt.connect(env); env.connect(masterGain);
        osc.start(st); osc.stop(st + stepDur);
      }
      return steps.length * stepDur;

    } else if (style === 'synth') {
      const dur = b * pick([1, 2, 2]);
      const gain = rand(0.14, 0.20);
      for (const detune of [-8, 8]) {
        const osc = ctx.createOscillator(), filt = ctx.createBiquadFilter(), env = ctx.createGain();
        osc.type = 'sawtooth'; osc.frequency.value = hz; osc.detune.value = detune;
        filt.type = 'lowpass'; filt.Q.value = 6;
        filt.frequency.setValueAtTime(80, t);
        filt.frequency.exponentialRampToValueAtTime(600, t + 0.06);
        filt.frequency.exponentialRampToValueAtTime(180, t + dur * 0.7);
        env.gain.setValueAtTime(0, t);
        env.gain.linearRampToValueAtTime(gain / 2, t + 0.01);
        env.gain.exponentialRampToValueAtTime(0.001, t + dur * 0.9);
        osc.connect(filt); filt.connect(env); env.connect(masterGain);
        osc.start(t); osc.stop(t + dur);
      }
      return dur;

    } else { // rumble
      const dur = b * pick([3, 4, 4, 6]);
      const gain = rand(0.12, 0.18);
      const osc = ctx.createOscillator(), sub = ctx.createOscillator();
      const trem = ctx.createOscillator(), tremGain = ctx.createGain();
      const env = ctx.createGain(), filt = ctx.createBiquadFilter();
      osc.type  = 'square'; osc.frequency.value = hz;
      sub.type  = 'sine';   sub.frequency.value = hz * 0.5;
      trem.type = 'sine';   trem.frequency.value = rand(3, 6);
      tremGain.gain.value = gain * 0.3;
      filt.type = 'lowpass'; filt.frequency.value = 200; filt.Q.value = 1.5;
      env.gain.setValueAtTime(0, t);
      env.gain.linearRampToValueAtTime(gain, t + 0.2);
      env.gain.setValueAtTime(gain, t + dur - 0.6);
      env.gain.linearRampToValueAtTime(0, t + dur);
      trem.connect(tremGain); tremGain.connect(env.gain);
      osc.connect(filt); sub.connect(filt); filt.connect(env); env.connect(masterGain);
      osc.start(t); osc.stop(t + dur); sub.start(t); sub.stop(t + dur);
      trem.start(t); trem.stop(t + dur);
      return dur - 0.4;
    }
  }

  return {
    name: 'bass',
    get style() { return style; },
    reroll() { style = pick(STYLES); },
    tick(now) {
      while (nextTime < now + LOOKAHEAD) {
        if (!nextTime) nextTime = now;
        nextTime += playNote(nextTime);
      }
    },
    reset(now) { nextTime = now; },
  };
})();
