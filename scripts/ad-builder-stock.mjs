// Stock-video encoding for the ad builder's Flight mode (src/animation3d/stockRender.js). The browser
// renders each frame as 16-bit RGB and posts it here; this pipes the frames straight into ffmpeg,
// which writes the file into .ads/stock/. WebCodecs cannot write ProRes or 10-bit, and a stock file
// is judged on exactly those: an editor grades it, and an 8-bit H.264 bands the moment the sky
// gradient is pushed.
//
//   POST /__ads/stock/start   { name, width, height, fps, format } -> { id, file }
//   POST /__ads/stock/frame?id=   raw rgb48le bytes (application/octet-stream), one frame
//   POST /__ads/stock/finish?id=  -> { file, bytes }
//   POST /__ads/stock/cancel?id=
//
// Formats: 'prores' (ProRes 422 HQ, 10-bit, .mov -- what stock sites ask for) and 'hevc' (H.265 10-bit
// at a high quality, .mp4 -- a much smaller file to watch or upload where ProRes is not taken).
// Both are tagged BT.709, which is how sRGB-made footage is delivered for video.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const FORMATS = {
  prores: {
    ext: '.mov',
    args: ['-c:v', 'prores_ks', '-profile:v', '3', '-vendor', 'apl0', '-pix_fmt', 'yuv422p10le']
  },
  hevc: {
    ext: '.mp4',
    args: ['-c:v', 'libx265', '-preset', 'slow', '-crf', '10', '-pix_fmt', 'yuv420p10le', '-tag:v', 'hvc1', '-x265-params', 'log-level=error']
  }
};
const SAFE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/;

export function createStockEncoder({ root }) {
  const dir = path.join(root, '.ads', 'stock');
  const jobs = new Map();

  async function start({ name, width, height, fps, format = 'prores' }) {
    const f = FORMATS[format];
    if (!f) throw new Error(`Unknown format ${format}`);
    if (!SAFE.test(String(name))) throw new Error('Bad name');
    const w = Math.round(width), h = Math.round(height), r = Number(fps);
    if (!(w >= 16 && w <= 16384 && h >= 16 && h <= 16384 && r > 0 && r <= 120)) throw new Error('Bad size or rate');
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, `${name}${f.ext}`);
    const proc = spawn(
      'ffmpeg',
      [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'rawvideo', '-pix_fmt', 'rgb48le', '-s', `${w}x${h}`, '-r', String(r), '-i', 'pipe:0',
        '-vf', 'scale=out_color_matrix=bt709:out_range=tv,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv',
        ...f.args,
        '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-color_range', 'tv',
        '-r', String(r), '-movflags', '+faststart',
        file
      ],
      { stdio: ['pipe', 'ignore', 'pipe'] }
    );
    let stderr = '';
    proc.stderr.on('data', d => (stderr = (stderr + d).slice(-4000)));
    const done = new Promise(resolve => proc.on('close', code => resolve(code)));
    proc.stdin.on('error', () => {}); // a dead ffmpeg is reported by `done`
    const id = randomBytes(8).toString('hex');
    jobs.set(id, { proc, done, file, frameBytes: w * h * 6, frames: 0, stderr: () => stderr });
    return { id, file: path.relative(root, file) };
  }

  function job(id) {
    const j = jobs.get(id);
    if (!j) throw new Error('No such stock job (the dev server may have restarted)');
    return j;
  }

  async function frame(id, bytes) {
    const j = job(id);
    if (bytes.length !== j.frameBytes) throw new Error(`Frame is ${bytes.length} bytes, expected ${j.frameBytes}`);
    if (j.proc.exitCode !== null) throw new Error(`ffmpeg stopped: ${j.stderr()}`);
    if (!j.proc.stdin.write(bytes)) await new Promise(r => j.proc.stdin.once('drain', r));
    j.frames++;
    return { frames: j.frames };
  }

  async function finish(id) {
    const j = job(id);
    j.proc.stdin.end();
    const code = await j.done;
    jobs.delete(id);
    if (code !== 0) throw new Error(`ffmpeg failed (${code}): ${j.stderr()}`);
    const { size } = await fs.stat(j.file);
    return { file: path.relative(root, j.file), bytes: size, frames: j.frames };
  }

  async function cancel(id) {
    const j = jobs.get(id);
    if (!j) return { ok: true };
    jobs.delete(id);
    j.proc.kill('SIGKILL');
    await j.done;
    await fs.rm(j.file, { force: true });
    return { ok: true };
  }

  return { start, frame, finish, cancel };
}
