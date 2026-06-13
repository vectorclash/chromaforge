import { audio, initOfflineAudio } from './context.js';
import { state, SCALE_NAMES, TICK_MS, rand, pick } from './state.js';
import { harmony } from './harmony.js';
import { bassVoice, drumsVoice, pickVoices, tickAt, resetAllVoices, resetEraTimer } from './scheduler.js';

export async function generateAudioBuffer(durationSec, sampleRate = 44100) {
  const offlineCtx = initOfflineAudio(durationSec, sampleRate);

  // Seed a fresh generative session the way the live engine does, so every
  // export exercises the full system: a random key/scale, an octave shift, a
  // varied tempo/feel, and a fresh draw from the whole instrument pool (which
  // now includes vibraphone, clavinet, sitar and kalimba). Eras still evolve
  // every 38s for longer exports, cycling octave, voices and harmony further.
  state.rootMidi     = 36 + Math.floor(Math.random() * 12);
  state.octaveShift  = pick([-2, -1, -1, 0, 0, 1]);
  state.scaleIdx     = Math.floor(Math.random() * SCALE_NAMES.length);
  state.tempo        = Math.floor(rand(56, 100));
  state.density      = rand(0.30, 0.65);
  state.brightness   = rand(0.20, 0.60);
  state.spaciousness = rand(0.55, 0.90);
  state.harmonyLock  = 0.78;
  state.chordBeats   = pick([4, 4, 8]);
  state.era          = 0;

  harmony.reroll();
  pickVoices();
  bassVoice.reroll();
  drumsVoice.reroll();
  resetEraTimer();
  resetAllVoices(0);

  const TICK_SEC = TICK_MS / 1000;
  for (let t = 0; t < durationSec + TICK_SEC; t += TICK_SEC) {
    tickAt(t, TICK_SEC);
  }

  return offlineCtx.startRendering();
}
