export const audio = {
  ctx:        null,
  masterGain: null,
  reverbNode: null,
  started:    false,
};

function buildReverb(ctx, duration = 4, decay = 2.8) {
  const sr  = ctx.sampleRate;
  const len = sr * duration;
  const buf = ctx.createBuffer(2, len, sr);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) {
      d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
  }
  const conv = ctx.createConvolver();
  conv.buffer = buf;
  return conv;
}

export function initOfflineAudio(durationSec, sampleRate = 44100) {
  const frameCount  = Math.ceil(sampleRate * durationSec);
  const offlineCtx  = new OfflineAudioContext(2, frameCount, sampleRate);

  audio.ctx        = offlineCtx;
  audio.masterGain = offlineCtx.createGain();
  audio.masterGain.gain.value = 0.55;
  audio.reverbNode = buildReverb(offlineCtx);
  audio.started    = true;

  const reverbGain = offlineCtx.createGain();
  reverbGain.gain.value = 0.45;

  audio.masterGain.connect(offlineCtx.destination);
  audio.reverbNode.connect(reverbGain);
  reverbGain.connect(offlineCtx.destination);

  return offlineCtx;
}
