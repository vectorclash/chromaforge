// Studio settings remembered in localStorage across visits: the palette + geometry sliders
// (a design's own identity fields, minus the seed) and the Video tab's playback/export
// settings. Deliberately NOT the seed -- every visit still opens on fresh artwork, it just
// arrives in the colours and geometry style the user last chose.
//
// Two keys rather than one, because the two halves are written by different owners at
// different moments (StudioContext mirrors the active design; DisplayCanvas owns the Video
// tab's own state) and a single key would need a read-modify-write from both, where the
// later writer silently drops the other's changes.
//
// Everything here is best-effort in both directions: a browser with storage disabled, a
// quota error, or a hand-edited/stale entry must degrade to "no saved settings", never to a
// thrown error or -- worse -- a corrupt value reaching the renderer. Hence the explicit
// per-field validation below instead of trusting the parsed JSON's shape: these values flow
// into generateArtwork and, for colours, all the way to ctx.addColorStop, which is exactly
// the kind of "browsers are lenient until one isn't" surface that has bitten this project
// before (see GenerateLargeRadialField's alpha-as-a-string).
import {
  DEFAULT_GEOMETRY_SETTINGS,
  STUDIO_DEFAULT_GEOMETRY_CHANCE,
  STUDIO_DEFAULT_GEOMETRY_SPREAD,
  STUDIO_DEFAULT_GEOMETRY_STARS_ON_TOP,
  getGeometrySettings
} from '../render/designSettings';

const DESIGN_KEY = 'cf-studio:design';
const VIDEO_KEY = 'cf-studio:video';
// Bumped only if a stored shape changes meaning. A mismatch is discarded, not migrated --
// these are conveniences, and re-picking a palette costs the user seconds.
const VERSION = 1;

// The swatch panel's own ceiling (see DisplayCanvas's ADD COLOR button).
const MAX_COLORS = 6;
// What the app itself writes: tinycolor's toHexString and the rainbow presets are all
// '#rrggbb', and jscolor writes the same into its input. 3- and 8-digit forms are accepted
// so a hand-set or future shorthand value still loads; anything else is dropped rather than
// normalised, so what comes back out is always exactly what went in.
const HEX = /^#[0-9a-fA-F]{3}$|^#[0-9a-fA-F]{4}$|^#[0-9a-fA-F]{6}$|^#[0-9a-fA-F]{8}$/;

function readKey(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.v !== VERSION) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeKey(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify({ v: VERSION, ...value }));
  } catch {
    /* storage unavailable or full -- remembering settings is never worth an error */
  }
}

// Requires an actual number rather than coercing, because JSON.parse only ever yields
// numbers, strings, booleans, null, arrays and objects -- and coercion maps null, '' and []
// to a perfectly finite 0, which would silently read a corrupt entry as "the minimum" instead
// of falling back to the default. A genuinely stored value is always already a number.
function clampNumber(value, min, max, fallback) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function clampInt(value, min, max, fallback) {
  const n = clampNumber(value, min, max, fallback);
  return Math.min(max, Math.max(min, Math.round(n)));
}

// Clamp ranges mirror the sliders in DisplayCanvas's Geometry tab exactly, so a restored
// value can always be represented by the control that produced it -- a stored value outside
// a slider's range would show a thumb pinned at an end while rendering something else.
function sanitizeGeometry(geometry) {
  if (!geometry || typeof geometry !== 'object') return null;
  const d = DEFAULT_GEOMETRY_SETTINGS;
  const pointsMin = clampInt(geometry.pointsMin, 3, 12, d.pointsMin);
  const pointsMax = clampInt(geometry.pointsMax, 3, 12, d.pointsMax);
  return {
    // The studio's own odds for new work, so its fallback is the studio default rather than
    // the legacy resolution default the rest of these keys use.
    chance: clampNumber(geometry.chance, 0, 1, STUDIO_DEFAULT_GEOMETRY_CHANCE),
    // The dual slider's own invariant: the two thumbs may meet but never cross.
    pointsMin: Math.min(pointsMin, pointsMax),
    pointsMax: Math.max(pointsMin, pointsMax),
    coherence: clampNumber(geometry.coherence, 0, 1, d.coherence),
    size: clampNumber(geometry.size, 0, 1, d.size),
    // Falls back to the STUDIO default rather than the resolution one, like chance above --
    // this key is newer than the stored entries it has to read, so an absent value here means
    // "written before Spread existed", not "deliberately chose the old generator's 0.5".
    spread: clampNumber(geometry.spread, 0, 1, STUDIO_DEFAULT_GEOMETRY_SPREAD),
    density: clampNumber(geometry.density, 0.1, 1, d.density),
    // `=== true` would be wrong here for the same reason it is wrong in
    // getStudioGeometrySettings: it collapses "written before this defaulted on" and
    // "deliberately switched off" into one value, so the toggle could never be turned off
    // across a reload once the studio default became true. An explicit boolean is honoured
    // either way round; only an absent key takes the studio default.
    starsOnTop:
      typeof geometry.starsOnTop === 'boolean'
        ? geometry.starsOnTop
        : STUDIO_DEFAULT_GEOMETRY_STARS_ON_TOP
  };
}

// The palette + geometry settings last used, in the shape a design carries them:
// `{ colors, settings }` where settings is undefined at the defaults (see compactSettings --
// keeping it absent is what makes a default-settings design byte-identical to a
// pre-settings one). Returns null when there is nothing valid stored.
export function readDesignPrefs() {
  const stored = readKey(DESIGN_KEY);
  if (!stored) return null;
  const colors = Array.isArray(stored.colors)
    ? stored.colors.filter(c => typeof c === 'string' && HEX.test(c)).slice(0, MAX_COLORS)
    : [];
  const geometry = sanitizeGeometry(stored.settings?.geometry);
  return { colors, settings: geometry ? { geometry } : undefined };
}

// The geometry block is always written out in FULL, even when it matches the resolution
// defaults and a design would therefore omit it (compactSettings). The two are answering
// different questions: an absent block on a DESIGN means "the legacy defaults, forever",
// while an absent entry here means "this browser has never been to the studio", which is what
// entitles a first visit to the studio defaults (see STUDIO_DEFAULT_GEOMETRY_SETTINGS).
// Storing nothing at the legacy defaults would conflate the two -- someone who deliberately
// pulls geometry chance back down to 0.4 would find it at 0.7 again on their next visit.
export function writeDesignPrefs({ colors, settings }) {
  writeKey(DESIGN_KEY, {
    colors: Array.isArray(colors) ? colors.slice(0, MAX_COLORS) : [],
    settings: { geometry: getGeometrySettings(settings) }
  });
}

// Video-tab defaults, kept here rather than inline in DisplayCanvas's constructor so the
// stored shape and the fallback can't drift apart. These are the same values the component
// used before any of this existed; see its state comments for why each is what it is.
export const DEFAULT_VIDEO_PREFS = {
  threeDMode: false,
  frameCount: 20,
  starFrameCount: 10,
  cycleDuration: 5,
  speedRamp: true,
  logoMark: false,
  exportAspect: '16:9',
  exportFps: 24
};

// `limits` is the caller's resolved ANIM_LIMIT (device-dependent: a phone caps frames,
// duration and frame rate lower than a desktop). Passing it in rather than importing it
// keeps this module free of device detection, and means a preference saved on a desktop and
// synced to a phone lands inside that phone's caps instead of asking it to build an
// animation it cannot hold in memory.
export function readVideoPrefs(limits, aspects) {
  const stored = readKey(VIDEO_KEY);
  if (!stored) return { ...DEFAULT_VIDEO_PREFS };
  const d = DEFAULT_VIDEO_PREFS;
  const frameCount = clampInt(stored.frameCount, 5, limits.frames, d.frameCount);
  return {
    threeDMode: stored.threeDMode === true,
    frameCount,
    // Mirrors maxStarFrames(frameCount) -- star frames cost exactly what main frames cost,
    // so they are always capped at half, and a restored pair must satisfy that too.
    starFrameCount: clampInt(stored.starFrameCount, 1, Math.max(1, Math.floor(frameCount / 2)), d.starFrameCount),
    cycleDuration: clampInt(stored.cycleDuration, 5, limits.duration, d.cycleDuration),
    speedRamp: stored.speedRamp !== false,
    logoMark: stored.logoMark === true,
    exportAspect: aspects.includes(stored.exportAspect) ? stored.exportAspect : d.exportAspect,
    exportFps: limits.fps.includes(stored.exportFps) ? stored.exportFps : d.exportFps
  };
}

export function writeVideoPrefs(video) {
  const out = {};
  for (const key of Object.keys(DEFAULT_VIDEO_PREFS)) out[key] = video[key];
  writeKey(VIDEO_KEY, out);
}

// Forget everything -- what a "reset to defaults" control calls. Clearing storage alone
// only takes effect on the next load, so a caller must also put its own live state back to
// the defaults above (and to STUDIO_DEFAULT_GEOMETRY_SETTINGS / an empty palette).
export function clearStudioPrefs() {
  try {
    localStorage.removeItem(DESIGN_KEY);
    localStorage.removeItem(VIDEO_KEY);
  } catch {
    /* nothing stored is the same outcome as failing to clear an unreadable store */
  }
}
