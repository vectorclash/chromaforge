import { audio } from './context.js';
import { state, SCALE_NAMES, TICK_MS, rand, pick } from './state.js';
import { harmony } from './harmony.js';

import { bassVoice }     from './voices/bass.js';
import { padVoice }      from './voices/pad.js';
import { melodyVoice }   from './voices/melody.js';
import { textureVoice }  from './voices/texture.js';
import { pluckVoice }    from './voices/pluck.js';
import { bellVoice }     from './voices/bell.js';
import { arpeggioVoice } from './voices/arpeggio.js';
import { malletVoice }   from './voices/mallet.js';
import { droneVoice }    from './voices/drone.js';
import { fluteVoice }    from './voices/flute.js';
import { choirVoice }    from './voices/choir.js';
import { stringsVoice }  from './voices/strings.js';
import { rhodesVoice }     from './voices/rhodes.js';
import { organVoice }      from './voices/organ.js';
import { glassVoice }      from './voices/glass.js';
import { harpVoice }       from './voices/harp.js';
import { brassVoice }      from './voices/brass.js';
import { drumsVoice }      from './voices/drums.js';
import { vibraphoneVoice } from './voices/vibraphone.js';
import { clavinetVoice }   from './voices/clavinet.js';
import { sitarVoice }      from './voices/sitar.js';
import { kalimbaVoice }    from './voices/kalimba.js';

export { bassVoice, drumsVoice };

// ─── Voice pool ───────────────────────────────────────────────────────────────
// Bass always plays. Each era draws 3–5 from this pool at random.
// Drums are weighted with two slots so they appear ~1/3 of eras on average.
const VOICE_POOL = [
  padVoice, melodyVoice, textureVoice, pluckVoice,
  bellVoice, arpeggioVoice, malletVoice, droneVoice, fluteVoice, choirVoice,
  stringsVoice, rhodesVoice, organVoice, glassVoice, harpVoice, brassVoice,
  vibraphoneVoice, clavinetVoice, sitarVoice, kalimbaVoice,
  drumsVoice, drumsVoice,
];

// All unique voice instances — used for bulk reset between renders.
export const ALL_VOICES = [
  bassVoice, padVoice, melodyVoice, textureVoice, pluckVoice,
  bellVoice, arpeggioVoice, malletVoice, droneVoice, fluteVoice, choirVoice,
  stringsVoice, rhodesVoice, organVoice, glassVoice, harpVoice, brassVoice,
  vibraphoneVoice, clavinetVoice, sitarVoice, kalimbaVoice,
  drumsVoice,
];

export let activeVoices = [];

export function pickVoices() {
  const seen     = new Set();
  const shuffled = VOICE_POOL.slice().sort(() => Math.random() - 0.5).filter(v => {
    if (seen.has(v)) return false;
    seen.add(v);
    return true;
  });
  activeVoices = shuffled.slice(0, 3 + Math.floor(Math.random() * 3));
}

export let eraTimer = 0;
export const ERA_DURATION = 38;

export function resetEraTimer() { eraTimer = 0; }

export function resetAllVoices(now) {
  harmony.reset(now);
  ALL_VOICES.forEach(v => v.reset(now));
}

function advanceEra() {
  state.era++;
  const shifts = [-7, -5, -2, 0, 0, 2, 5, 7];
  state.rootMidi     = Math.max(24, Math.min(48, state.rootMidi + pick(shifts)));
  state.scaleIdx     = Math.floor(Math.random() * SCALE_NAMES.length);
  state.tempo        = Math.max(48, Math.min(72, state.tempo + rand(-5, 5)));
  state.brightness   = rand(0.05, 0.35);
  state.spaciousness = rand(0.60, 0.95);
  state.density      = rand(0.15, 0.50);
  state.octaveShift  = pick([-1, 0, 0, 1]);
  state.chordBeats   = pick([4, 8, 8]);
  harmony.reroll();
  pickVoices();
  bassVoice.reroll();
  drumsVoice.reroll();
}

function evolve(dt) {
  eraTimer += dt;
  if (eraTimer >= ERA_DURATION) {
    eraTimer -= ERA_DURATION;
    advanceEra();
  }
  state.brightness   = Math.max(0.05, Math.min(0.95, state.brightness   + (Math.random() - 0.5) * 0.002));
  state.density      = Math.max(0.10, Math.min(1.00, state.density      + (Math.random() - 0.5) * 0.001));
  state.spaciousness = Math.max(0.10, Math.min(0.90, state.spaciousness + (Math.random() - 0.5) * 0.001));
}

export function tickAt(now, dt) {
  harmony.tick(now);
  try { bassVoice.tick(now); } catch (e) { console.warn('[Chromaforge audio] bassVoice.tick error:', e); }
  for (const v of activeVoices) {
    try { v.tick(now); } catch (e) { console.warn('[Chromaforge audio] voice tick error:', v.name, e); }
  }
  evolve(dt);
}

export { TICK_MS };
