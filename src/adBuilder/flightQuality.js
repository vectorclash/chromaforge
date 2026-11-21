// The flight's quality in every ad builder EXPORT (2026-11-21, Aaron: "i'd want my instagram ads to
// get the same new quality levels, not just stock video"): the Reel, the Flight mode (and its
// Instagram post), feed flight clips and covers, the Explainer, and the stock master. Previews keep
// the site's own flight so they play in real time; the file is what gets the quality.
//
//   nebula: a NEBULA_PROFILES name -- 'new' in the panel is 'blender' (the Blender Nebula Generator
//           recipe, coloured like the site's nebula)
//   stars:  a STAR_PROFILES name
//   blur:   the flight's motion blur, in shutter degrees (animation3d/stockRender.js: averaged in
//           linear light, capped at the ramp's peak, sharp head with a trail). The Reel, Flight mode,
//           feed clips, covers and the stock master. (The Reel's flight was kept sharp until Aaron saw
//           this blur, 2026-11-21: "the new blur looks much better so it can go on the reel flight".)
//           The Explainer already blurs its whole frame.
import { NEBULA_PROFILES, STAR_PROFILES } from '../animation3d/stockProfiles';

const KEY = 'cf-ads:flight-quality';
export const QUALITY_DEFAULTS = { nebula: 'blender', stars: 'deep', blur: 180 };

export function readFlightQuality() {
  try {
    return { ...QUALITY_DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || '{}') };
  } catch {
    return { ...QUALITY_DEFAULTS };
  }
}
export function writeFlightQuality(q) {
  try {
    localStorage.setItem(KEY, JSON.stringify(q));
  } catch {
    /* fine */
  }
}

// tunnelScene's `quality` for these settings, or null when everything is the site's own.
export function sceneQuality(q) {
  const nebula = NEBULA_PROFILES[q?.nebula] ?? null;
  const stars = STAR_PROFILES[q?.stars] ?? null;
  return nebula || stars ? { float: true, nebula, stars } : null;
}

// The shutter for stockRender, or 0 for none.
export const flightBlur = q => Math.max(0, Number(q?.blur) || 0);

// The settings to hand renderFlightClip / renderFlightFrame: null when they are all the site's own
// (the site's exact flight, as before), else the settings themselves.
export const clipQuality = q => (sceneQuality(q) || flightBlur(q) ? q : null);
