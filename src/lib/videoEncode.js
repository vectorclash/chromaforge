import { Muxer, ArrayBufferTarget } from 'mp4-muxer';

// H.264 MP4 encoding (WebCodecs + mp4-muxer) for every video the app makes: the studio's
// Download (DisplayCanvas.encodeAnimationVideo) and the local ad builder (src/adBuilder), which
// also adds an AAC music track. Moved out of DisplayCanvas unchanged so the two cannot drift --
// the codec choice, bitrate rule and back-pressure below each fixed a real export bug.

// 25Mbps mobile (was 15): the fast parts of the animation — the 3D flythrough, and especially
// the speed ramp's mid-cycle peak — starve the encoder at 15 and came out visibly
// blocky/pixelated on real phone exports.
//
// Desktop bitrate is DERIVED from the export's own size and frame rate (2026-08-12, Aaron: 3D
// exports go blurry through the fast mid-cycle stretch). It used to be a flat 40Mbps, which is
// the actual fault — a 3840x2160 60fps export was handed the same budget as a 2160x2160 24fps
// one. Measured at the ramp's peak on a real 3D scene, encoded and decoded back through
// WebCodecs: 4K24 scored 29.5dB mean / 27.3dB worst PSNR at 40Mbps, 33.5/30.7 at 80, 35.7/34.0
// at 120, and was still climbing at 160.
//
// The exponent is measured, not assumed: the same quality needed 40Mbps at 1080p24 and 80Mbps
// at 4K24 — four times the pixels for twice the bitrate — so the target scales with the SQUARE
// ROOT of area, and linearly with frame rate. K is set so 4K24 lands on ~120Mbps, near the knee
// of that curve.
//
// Then capped by memory, because mp4-muxer holds the entire file in RAM (ArrayBufferTarget +
// fastStart: 'in-memory'), so bitrate x duration IS the allocation. Without the cap a 60s 4K60
// export would ask for ~2.2GB. Long exports trade quality for completing at all, which is the
// right way round.
//
// Mobile is deliberately left on its flat 25Mbps: phones already OOM-kill on this path (see
// DisplayCanvas's ANIM_LIMITS) and Aaron's ask was specifically desktop.
const VIDEO_QUALITY_K = 1736; // bits per (sqrt-pixel x frame)
const MAX_EXPORT_BYTES = 600 * 1024 * 1024;
const MOBILE_BITRATE = 25_000_000;

/** @param {{ width: number, height: number, fps: number, durationSec: number, mobile?: boolean }} o */
export function exportBitrate({ width, height, fps, durationSec, mobile = false }) {
  if (mobile) return MOBILE_BITRATE;
  return Math.min(
    Math.round(VIDEO_QUALITY_K * Math.sqrt(width * height) * fps),
    Math.floor((MAX_EXPORT_BYTES * 8) / durationSec)
  );
}

// Resolve a supported H.264 codec string. We prefer Constrained Baseline (profile 66 —
// `avc1.42xxxx`) because it CANNOT contain B-frames. The Windows hardware encoder otherwise
// emits B-frames and delivers chunks in decode order, so their presentation timestamps arrive
// non-monotonically; mp4-muxer then rejects every out-of-order chunk and drops ~half the frames,
// which is what collapsed 24fps exports to ~13fps on Windows. With no B-frames, decode order ==
// presentation order and nothing is dropped. High Profile is kept as a fallback (it works fine on
// macOS/VideoToolbox).
//
// latencyMode: 'quality' gives the encoder real rate control and motion estimation headroom;
// 'realtime' (used previously) trades that away for encode speed, which is the other half of the
// fast-motion blockiness. The reordering concern that motivated 'realtime' doesn't apply to
// Constrained Baseline — that profile structurally cannot contain B-frames — so only the High
// Profile fallback (which CAN reorder) keeps the 'realtime' hint.
const latencyFor = codec => (codec.startsWith('avc1.42') ? 'quality' : 'realtime');
const CODEC_CANDIDATES = [
  'avc1.42E034', // Constrained Baseline, Level 5.2 — no B-frames
  'avc1.42E028', // Constrained Baseline, Level 4.0 — no B-frames (lower-res fallback)
  'avc1.640034' // High Profile, Level 5.2 — may emit B-frames
];

async function pickVideoCodec(width, height, bitrate, fps) {
  for (const codec of CODEC_CANDIDATES) {
    const cfg = { codec, width, height, bitrate, framerate: fps, latencyMode: latencyFor(codec) };
    const ok = await VideoEncoder.isConfigSupported(/** @type {VideoEncoderConfig} */ (cfg))
      .then(r => r.supported)
      .catch(() => false);
    if (ok) return codec;
  }
  return 'avc1.640034';
}

// The encoder could not be set up at all in this browser -- distinct from a failure partway
// through, so a caller can say "not supported here" rather than "try again".
export class EncoderUnsupportedError extends Error {}

// ─── Audio (AAC) ──────────────────────────────────────────────────────────────
// Restored from the studio's removed music export (3e14cc8), for the ad builder only -- studio
// downloads stay silent by design (CLAUDE.md, "Exports are SILENT").
//
// AAC-LC AudioSpecificConfig (the esds "description" bytes): 5 bits object type (2 = AAC-LC),
// 4 bits sampling-frequency index, 4 bits channel config. mp4-muxer requires this to write a
// playable AAC track. Chrome's AudioEncoder always supplies it; WebKit's has been seen to omit
// it, which produces a file whose audio track is silently ignored by players.
const AAC_SAMPLE_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
function aacAudioSpecificConfig(sampleRate, numberOfChannels) {
  const freqIndex = AAC_SAMPLE_RATES.indexOf(sampleRate);
  if (freqIndex === -1) return null;
  return new Uint8Array([(2 << 3) | (freqIndex >> 1), ((freqIndex & 1) << 7) | (numberOfChannels << 3)]);
}

const AAC_CODEC = 'mp4a.40.2';
const AUDIO_BITRATES = [192_000, 128_000];

async function pickAudioBitrate(sampleRate) {
  if (typeof AudioEncoder === 'undefined' || typeof AudioData === 'undefined') return null;
  for (const bitrate of AUDIO_BITRATES) {
    const ok = await AudioEncoder.isConfigSupported({ codec: AAC_CODEC, numberOfChannels: 2, sampleRate, bitrate })
      .then(r => r.supported)
      .catch(() => false);
    if (ok) return bitrate;
  }
  return null;
}

async function encodeAudioTrack(audioBuffer, muxer, bitrate) {
  const left = audioBuffer.getChannelData(0);
  const right = audioBuffer.numberOfChannels > 1 ? audioBuffer.getChannelData(1) : left;
  const sampleRate = audioBuffer.sampleRate;
  const totalFrames = audioBuffer.length;
  const CHUNK_FRAMES = 4096;

  await new Promise((resolve, reject) => {
    const encoder = new AudioEncoder({
      output: (chunk, meta) => {
        if (!meta?.decoderConfig?.description) {
          const description = aacAudioSpecificConfig(sampleRate, 2);
          if (description) {
            meta = {
              ...meta,
              decoderConfig: { codec: AAC_CODEC, sampleRate, numberOfChannels: 2, ...meta?.decoderConfig, description }
            };
          }
        }
        muxer.addAudioChunk(chunk, meta);
      },
      error: reject
    });
    try {
      encoder.configure({ codec: AAC_CODEC, numberOfChannels: 2, sampleRate, bitrate });
      for (let offset = 0; offset < totalFrames; offset += CHUNK_FRAMES) {
        const frameCount = Math.min(CHUNK_FRAMES, totalFrames - offset);
        const planar = new Float32Array(frameCount * 2);
        planar.set(left.subarray(offset, offset + frameCount), 0);
        planar.set(right.subarray(offset, offset + frameCount), frameCount);
        const audioData = new AudioData({
          format: 'f32-planar',
          sampleRate,
          numberOfFrames: frameCount,
          numberOfChannels: 2,
          timestamp: Math.round((offset / sampleRate) * 1_000_000),
          data: planar
        });
        encoder.encode(audioData);
        audioData.close();
      }
      encoder
        .flush()
        .then(() => {
          encoder.close();
          resolve();
        })
        .catch(reject);
    } catch (e) {
      reject(e);
    }
  });
}

// ─── Encode ───────────────────────────────────────────────────────────────────

/**
 * Encodes `totalFrames` frames into an MP4 and returns it.
 *
 * `renderFrame(f)` paints frame f and returns the canvas to capture. It must be SYNCHRONOUS: the
 * VideoFrame is constructed in the same task as the paint, which is what lets a WebGL canvas be
 * captured without preserveDrawingBuffer.
 *
 * Whatever this acquires registers its release on `releases`, which the caller runs in a
 * `finally` however the export ends (see DisplayCanvas.exportAnimationVideo).
 *
 * @param {{
 *   width: number, height: number, fps: number, totalFrames: number, bitrate: number,
 *   renderFrame: (f: number) => HTMLCanvasElement | OffscreenCanvas,
 *   releases: Array<() => void>,
 *   audio?: AudioBuffer | null,
 *   onFrame?: (f: number) => void,
 *   beforeFlush?: () => void
 * }} opts
 * @returns {Promise<Blob>}
 */
export async function encodeMp4({ width, height, fps, totalFrames, bitrate, renderFrame, releases, audio = null, onFrame, beforeFlush }) {
  const FRAME_DURATION_US = Math.round(1_000_000 / fps);

  // Probed BEFORE the muxer exists: an audio track declared in the muxer and then left empty
  // makes the MP4 unplayable.
  const audioBitrate = audio ? await pickAudioBitrate(audio.sampleRate) : null;
  if (audio && !audioBitrate) throw new EncoderUnsupportedError('AAC audio encoding is not supported in this browser.');

  const target = new ArrayBufferTarget();
  const muxer = new Muxer({
    target,
    video: { codec: 'avc', width, height, frameRate: fps },
    ...(audio ? { audio: { codec: 'aac', numberOfChannels: 2, sampleRate: audio.sampleRate } } : {}),
    fastStart: 'in-memory'
  });

  const videoCodec = await pickVideoCodec(width, height, bitrate, fps);
  let encoder;
  try {
    encoder = new VideoEncoder({
      output: (chunk, meta) => {
        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        muxer.addVideoChunkRaw(data, chunk.type, chunk.timestamp, FRAME_DURATION_US, meta);
      },
      error: e => console.error('VideoEncoder error:', e)
    });
    releases.push(() => {
      if (encoder.state !== 'closed') encoder.close();
    });
    encoder.configure({
      codec: videoCodec,
      width,
      height,
      bitrate,
      framerate: fps,
      latencyMode: latencyFor(videoCodec)
    });
  } catch (e) {
    console.error('VideoEncoder configure failed:', e);
    throw new EncoderUnsupportedError('H.264 encoding is not supported in this browser.');
  }

  // Encode frame by frame at a fixed timestep (no rAF timing jitter).
  // Back-pressure: if the encoder queue grows too deep, yield until it drains —
  // this prevents unbounded memory buildup that kills iOS tabs.
  for (let f = 0; f < totalFrames; f++) {
    const canvas = renderFrame(f);
    const frame = new VideoFrame(canvas, { timestamp: f * FRAME_DURATION_US });
    // Keyframe every 2s (was every 1s): forced keyframes are the most expensive frames in the
    // stream, and at fast-motion moments the bitrate they consume comes straight out of the
    // inter frames' budget — visibly blocky at the speed ramp's peak.
    // Closed even when encode() throws: a VideoFrame holds a full-size frame buffer.
    try {
      encoder.encode(frame, { keyFrame: f % (fps * 2) === 0 });
    } finally {
      frame.close();
    }

    // Drain the encoder queue before it grows too large
    while (encoder.encodeQueueSize > 5) {
      await new Promise(r => setTimeout(r, 0));
    }

    // Yield to the browser every 10 frames
    if (f % 10 === 0) {
      onFrame?.(f);
      await new Promise(r => setTimeout(r, 0));
    }
  }

  beforeFlush?.();
  await encoder.flush();
  if (audio) await encodeAudioTrack(audio, muxer, audioBitrate);

  muxer.finalize();
  return new Blob([target.buffer], { type: 'video/mp4' });
}
