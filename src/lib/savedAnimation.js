// The stored shape of a saved animation, and the helpers every surface that reads one shares.
//
// Both kinds live in `designs` as kind 'animation' -- the column's check constraint allows only
// 'image' and 'animation', and a 3D flight IS an animation, so no migration and no deploy
// ordering. `data` tells them apart:
//
//   2D: { animation: true, frames: [compact design, ...], video? }
//   3D: { animation: true, mode: '3d', sceneVersion, design: compact design, video }
//
// A 3D flight is a pure function of one design plus its Duration (tunnelScene uses no
// Math.random; the loop seam is byte-identical), so a saved one is a few hundred bytes and
// replays exactly -- and re-exports at any ratio or frame rate, since nothing is baked.
//
// `video` records how it was playing when saved. Rows from before 2026-09-30 have none (2D only)
// and replay with DEFAULT_VIDEO_PREFS.
import { toCompactDesign } from '../render/compactDesign';
import { DEFAULT_VIDEO_PREFS } from './studioPrefs';

// Bump alongside a change to src/animation3d/tunnelScene.js that changes how a saved flight
// looks. It is a record, not a rendering instruction: like GENERATOR_VERSION, nothing replays
// an older scene -- a saved flight always renders with the scene code in the bundle. It exists
// so a future change can at least tell which rows were saved under which scene.
export const SCENE_VERSION = 1;

export function is3DAnimation(data) {
  return !!(data && data.animation && data.mode === '3d' && data.design);
}

export function is2DAnimation(data) {
  return !!(data && data.animation && Array.isArray(data.frames) && data.frames.length > 0);
}

// Only what replays the animation; export ratio/fps stay the viewer's own choice.
export function compactVideo(video = {}) {
  return {
    duration: video.cycleDuration ?? DEFAULT_VIDEO_PREFS.cycleDuration,
    speedRamp: video.speedRamp ?? DEFAULT_VIDEO_PREFS.speedRamp,
    logoMark: video.logoMark ?? DEFAULT_VIDEO_PREFS.logoMark,
    ...(video.starFrameCount != null ? { starFrames: video.starFrameCount } : {})
  };
}

// The playback settings a stored row replays with, falling back to the defaults for anything a
// row predates. Durations are clamped to the studio's own floor.
export function storedVideo(data) {
  const v = (data && data.video) || {};
  return {
    cycleDuration: Number.isFinite(v.duration) && v.duration >= 5 ? v.duration : DEFAULT_VIDEO_PREFS.cycleDuration,
    speedRamp: typeof v.speedRamp === 'boolean' ? v.speedRamp : DEFAULT_VIDEO_PREFS.speedRamp,
    logoMark: v.logoMark === true,
    starFrameCount: Number.isInteger(v.starFrames) && v.starFrames >= 1 ? v.starFrames : null
  };
}

export function build3DAnimationData(design, video) {
  // Star frames are a 2D setting; a flight has none
  const { starFrames, ...playback } = compactVideo(video);
  return { animation: true, mode: '3d', sceneVersion: SCENE_VERSION, design: toCompactDesign(design), video: playback };
}

export function build2DAnimationData(configs, video) {
  return { animation: true, frames: configs.map(toCompactDesign), video: compactVideo(video) };
}

// Normalises any animation row's data for storage; idempotent, so the save path can apply it
// whatever a caller handed in. Anything that isn't an animation is returned as-is.
export function compactAnimationData(data) {
  if (is3DAnimation(data)) return { ...data, design: toCompactDesign(data.design) };
  if (is2DAnimation(data)) return { ...data, frames: data.frames.map(toCompactDesign) };
  return data;
}

// What "Print this design" prints for a gallery row, or null if it can't be printed. Animations
// never print (Aaron, 2026-09-30). A 3D flight IS one design, and briefly printed as it, but its
// thumbnail is a frame of the flight while the print is the flat 2D artwork -- the two can look
// nothing alike -- and the product page's artwork picker (images only) could not offer it either,
// so the two ways into a print disagreed.
export function printableRow(row) {
  if (!row || row.kind === 'animation') return null;
  return row;
}

// The design whose facts (seed, palette, settings) a row's detail view shows.
export function factsDesign(data) {
  if (is3DAnimation(data)) return data.design;
  if (data && data.animation) return null;
  return data;
}
