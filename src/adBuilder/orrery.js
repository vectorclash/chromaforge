// Music from Orrery (~/Workspace/orrery), rendered by Orrery's OWN export renderer -- the same
// one its EXPORT button uses -- loaded into a hidden iframe from the sibling repo through the
// dev server (scripts/ad-builder-dev.mjs serves it at /orrery/). Chromaforge holds no copy of
// the music code: a new instrument in Orrery is here the next time a track renders.
//
// The iframe is also what Orrery itself does: every audio module keeps its state at module
// level, so a render needs its own copy of all of them. Loaded by URL rather than imported,
// which keeps the repo's typecheck and CI from ever looking for a folder only this machine has.

const RENDER_URL = '/orrery/src/render.js';
export const MUSIC_SAMPLE_RATE = 48000;

async function withRenderer(fn) {
  const frame = document.createElement('iframe');
  frame.style.display = 'none';
  frame.srcdoc = `<script type="module" src="${RENDER_URL}"></script>`;
  const loaded = new Promise((resolve, reject) => {
    frame.onload = resolve;
    frame.onerror = reject;
  });
  document.body.appendChild(frame);
  try {
    await loaded;
    const w = /** @type {any} */ (frame.contentWindow);
    if (typeof w.renderExport !== 'function' || typeof w.planFromShare !== 'function') {
      throw new Error(
        'Orrery’s renderer did not load. Is the orrery repo next to this one (or ORRERY_DIR set), and up to date?'
      );
    }
    return await fn(w);
  } finally {
    frame.remove();
  }
}

// An Orrery SHARE link as a plan for renderMusic, or null if it is not one. Copied out as plain
// data so nothing from the iframe outlives it.
export function planFromLink(link) {
  return withRenderer(w => {
    const plan = w.planFromShare(link);
    return plan ? JSON.parse(JSON.stringify(plan)) : null;
  });
}

// Renders `durationSec` of the plan, with beat 0 at the very first sample so bar lines fall
// where adTimeline puts the cuts. Orrery starts its music a moment in (exportBeatZero), so this
// renders that much extra and drops it. Every render is a new performance: Orrery's choices
// are random, so the same link never plays the same notes twice.
/**
 * @param {any} plan
 * @param {number} durationSec
 * @param {(fraction: number) => void} [onProgress]
 * @returns {Promise<AudioBuffer>}
 */
export function renderMusic(plan, durationSec, onProgress) {
  return withRenderer(async w => {
    const lead = Number(w.exportBeatZero) || 0;
    const rendered = await w.renderExport(plan, durationSec + lead, MUSIC_SAMPLE_RATE, f => onProgress?.(f));
    const skip = Math.round(lead * MUSIC_SAMPLE_RATE);
    const length = Math.round(durationSec * MUSIC_SAMPLE_RATE);
    // Copied into a buffer of this page's own, so it stays valid once the iframe is gone.
    const out = new AudioBuffer({ length, numberOfChannels: 2, sampleRate: MUSIC_SAMPLE_RATE });
    for (let c = 0; c < 2; c++) {
      const src = rendered.getChannelData(Math.min(c, rendered.numberOfChannels - 1));
      out.copyToChannel(src.subarray(skip, skip + length), c);
    }
    return out;
  });
}

// 16-bit PCM WAV, for keeping a take with a saved ad.
export function encodeWav(buffer) {
  const channels = buffer.numberOfChannels;
  const frames = buffer.length;
  const bytes = new ArrayBuffer(44 + frames * channels * 2);
  const v = new DataView(bytes);
  const str = (o, s) => [...s].forEach((ch, i) => v.setUint8(o + i, ch.charCodeAt(0)));
  str(0, 'RIFF');
  v.setUint32(4, 36 + frames * channels * 2, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, channels, true);
  v.setUint32(24, buffer.sampleRate, true);
  v.setUint32(28, buffer.sampleRate * channels * 2, true);
  v.setUint16(32, channels * 2, true);
  v.setUint16(34, 16, true);
  str(36, 'data');
  v.setUint32(40, frames * channels * 2, true);
  const data = [...Array(channels)].map((_, c) => buffer.getChannelData(c));
  let o = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      const s = Math.max(-1, Math.min(1, data[c][i]));
      v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      o += 2;
    }
  }
  return new Blob([bytes], { type: 'audio/wav' });
}

// A saved take back into a buffer, at the rate it was rendered at (an AudioContext would
// resample it to the device's rate).
export async function loadWav(url) {
  const data = await (await fetch(url)).arrayBuffer();
  return new OfflineAudioContext(2, 1, MUSIC_SAMPLE_RATE).decodeAudioData(data);
}
