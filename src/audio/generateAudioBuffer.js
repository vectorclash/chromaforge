import { audio, initOfflineAudio } from './context.js';
import { state, TICK_MS } from './state.js';
import { bassVoice, drumsVoice, pickVoices, tickAt, resetAllVoices, resetEraTimer } from './scheduler.js';

export async function generateAudioBuffer(durationSec, sampleRate = 44100) {
  const offlineCtx = initOfflineAudio(durationSec, sampleRate);

  state.rootMidi     = 36;
  state.scaleIdx     = 0;
  state.tempo        = 78;
  state.density      = 0.5;
  state.brightness   = 0.3;
  state.spaciousness = 0.5;
  state.era          = 0;

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
