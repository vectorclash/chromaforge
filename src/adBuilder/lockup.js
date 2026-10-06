import tinycolor from 'tinycolor2';
import logoUrl from '../assets/images/logo.svg';

// The ad's brand lockup, drawn on a canvas at any frame time: the site's own wordmark (the logo,
// CHROMA in Exo 400, FORGE in Exo 900 soft lime -- Wordmark.jsx / .controls-inner h1), a
// hairline under it in the DESIGN's palette (the .cf-spectrum-line treatment, as the
// mini-generator's palette edge does it), and the URL. It speaks the site's motion language:
// it arrives with --animate-resolve-in (420ms, cubic-bezier(.16,1,.3,1), out of a blur, a short
// rise), and CHROMA runs the wordmark's hover hue-wave -- each letter cycling the colour wheel a
// beat after its neighbour -- on every cut to a new product.
//
// Sizes are authored at 1080 wide and scale with the frame.

const TEXT = '#fafafa';
const FORGE = '#cdf29c';
// The lockup's height as a fraction of a 9:16 frame -- the band the composer reserves for it.
export const LOCKUP_BAND = 0.088;

const RESOLVE_MS = 420;
// resolve-in's 8px of travel and 10px of blur are CSS px on a page; a 1080-wide video is shown
// about 390 CSS px wide on a phone, so they are scaled by that.
const PHONE_SCALE = 1080 / 390;
const WAVE_SECONDS = 0.8;
const WAVE_STAGGER = 0.07;

// cubic-bezier(0.16, 1, 0.3, 1), solved for x by Newton's method.
function resolveEase(x) {
  const [x1, y1, x2, y2] = [0.16, 1, 0.3, 1];
  const bx = t => 3 * x1 * t * (1 - t) ** 2 + 3 * x2 * t * t * (1 - t) + t ** 3;
  const by = t => 3 * y1 * t * (1 - t) ** 2 + 3 * y2 * t * t * (1 - t) + t ** 3;
  const dx = t => 3 * x1 * (1 - t) ** 2 + 6 * (x2 - x1) * t * (1 - t) + 3 * (1 - x2) * t * t;
  let t = x;
  for (let i = 0; i < 8; i++) {
    const d = dx(t);
    if (Math.abs(d) < 1e-6) break;
    t = Math.min(1, Math.max(0, t - (bx(t) - x) / d));
  }
  return by(t);
}
const clamp01 = x => (x < 0 ? 0 : x > 1 ? 1 : x);
const easeOut = x => 1 - (1 - x) ** 3;

// The logo SVG declares width/height 100%, so it has no reliable intrinsic size; it is
// rasterised at exactly the size it is drawn.
async function rasterLogo(heightPx) {
  const svg = await (await fetch(logoUrl)).text();
  const w = Math.round((heightPx * 72) / 81);
  const sized = svg.replace('width="100%" height="100%"', `width="${w}" height="${Math.round(heightPx)}"`);
  const img = new Image();
  img.src = URL.createObjectURL(new Blob([sized], { type: 'image/svg+xml' }));
  await img.decode();
  const c = document.createElement('canvas');
  c.width = w;
  c.height = Math.round(heightPx);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  URL.revokeObjectURL(img.src);
  return c;
}

/**
 * @param {{ width: number, height: number, palette: string[] }} o
 */
export async function createLockup({ width, height, palette }) {
  const u = width / 1080;
  const F = 78 * u; // wordmark size
  const URL_SIZE = 33 * u;
  await Promise.all([
    document.fonts.load(`400 ${F}px Exo`),
    document.fonts.load(`900 ${F}px Exo`),
    document.fonts.load(`700 ${URL_SIZE}px Quicksand`)
  ]);
  const logo = await rasterLogo(F * 0.92);

  const measure = document.createElement('canvas').getContext('2d');
  const tracking = -0.025 * F; // tracking-tight
  measure.font = `400 ${F}px Exo`;
  const chroma = [...'CHROMA'].map(ch => ({ ch, w: measure.measureText(ch).width + tracking }));
  measure.font = `900 ${F}px Exo`;
  const forgeW = measure.measureText('FORGE').width + 5 * tracking;
  const gap = 0.3 * F;
  const chromaW = chroma.reduce((a, c) => a + c.w, 0);
  const markW = logo.width + gap + chromaW + forgeW;

  // The hairline, at full width with its ends faded, drawn once; it sweeps open from the centre.
  const stops = (palette.length ? palette : ['#4c00ff', '#ff0059', '#ffbb00', '#eaff00', '#00e5ff']).map(c =>
    tinycolor(c).toHexString()
  );
  const line = document.createElement('canvas');
  line.width = Math.ceil(markW);
  line.height = Math.max(2, Math.round(3 * u));
  const lc = line.getContext('2d');
  const g = lc.createLinearGradient(0, 0, line.width, 0);
  stops.forEach((c, i) => g.addColorStop(stops.length === 1 ? 0 : i / (stops.length - 1), c));
  lc.fillStyle = g;
  lc.fillRect(0, 0, line.width, line.height);
  lc.globalCompositeOperation = 'destination-in';
  const fade = lc.createLinearGradient(0, 0, line.width, 0);
  const edge = Math.min(0.2, (40 * u) / line.width);
  fade.addColorStop(0, 'rgba(0,0,0,0)');
  fade.addColorStop(edge, '#000');
  fade.addColorStop(1 - edge, '#000');
  fade.addColorStop(1, 'rgba(0,0,0,0)');
  lc.fillStyle = fade;
  lc.fillRect(0, 0, line.width, line.height);

  // Where a CHROMA letter is in the most recent hue wave at time t: 0..1, or -1 if none.
  function wavePhase(t, ripples, k) {
    for (let r = ripples.length - 1; r >= 0; r--) {
      if (t < ripples[r]) continue;
      const ph = (t - ripples[r] - k * WAVE_STAGGER) / WAVE_SECONDS;
      return ph >= 0 && ph <= 1 ? ph : -1;
    }
    return -1;
  }

  /**
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} t
   * @param {{ top: number, appearAt: number, ripples: number[], url: string }} o  top in px
   */
  function draw(ctx, t, { top, appearAt, ripples, url }) {
    const e = clamp01((t - appearAt) / (RESOLVE_MS / 1000));
    if (e <= 0) return;
    const p = resolveEase(e);
    const cx = width / 2;
    const markY = top + 48 * u;
    const lineY = top + 102 * u;
    const urlY = top + 140 * u;

    ctx.save();
    ctx.globalAlpha = p;
    const blur = (1 - p) * 10 * PHONE_SCALE * u;
    if (blur > 0.3) ctx.filter = `blur(${blur.toFixed(2)}px)`;
    ctx.translate(0, (1 - p) * 8 * PHONE_SCALE * u);
    ctx.shadowColor = 'rgba(0, 0, 0, 0.5)';
    ctx.shadowBlur = 26 * u;

    let x = cx - markW / 2;
    ctx.drawImage(logo, x, markY - logo.height / 2);
    x += logo.width + gap;
    ctx.textBaseline = 'middle';
    ctx.font = `400 ${F}px Exo`;
    chroma.forEach(({ ch, w }, k) => {
      const ph = wavePhase(t, ripples, k);
      if (ph >= 0) {
        const strength = Math.sin(Math.PI * ph);
        const hue = tinycolor({ h: (k * 24 + ph * 360) % 360, s: 1, l: 0.55 });
        ctx.fillStyle = tinycolor.mix(TEXT, hue, strength * 100).toHexString();
        ctx.shadowColor = hue.setAlpha(0.9 * strength).toRgbString();
        ctx.shadowBlur = 16 * u;
      } else {
        ctx.fillStyle = TEXT;
        ctx.shadowColor = 'rgba(0, 0, 0, 0.5)';
        ctx.shadowBlur = 26 * u;
      }
      ctx.fillText(ch, x, markY);
      x += w;
    });
    ctx.shadowColor = 'rgba(0, 0, 0, 0.5)';
    ctx.shadowBlur = 26 * u;
    ctx.font = `900 ${F}px Exo`;
    ctx.letterSpacing = `${tracking.toFixed(2)}px`;
    ctx.fillStyle = FORGE;
    ctx.fillText('FORGE', x, markY);
    ctx.letterSpacing = '0px';

    // The hairline opens from the centre as the mark settles.
    const open = easeOut(clamp01((t - appearAt - 0.12) / 0.55));
    if (open > 0) {
      ctx.shadowColor = 'transparent';
      const w = line.width * open;
      ctx.drawImage(line, (line.width - w) / 2, 0, w, line.height, cx - w / 2, lineY, w, line.height);
    }

    if (url) {
      const a = easeOut(clamp01((t - appearAt - 0.22) / 0.4));
      if (a > 0) {
        ctx.globalAlpha = p * a * 0.92;
        ctx.shadowColor = 'rgba(0, 0, 0, 0.55)';
        ctx.shadowBlur = 18 * u;
        ctx.font = `700 ${URL_SIZE}px Quicksand, sans-serif`;
        ctx.letterSpacing = `${(0.14 * URL_SIZE).toFixed(2)}px`;
        ctx.textAlign = 'center';
        ctx.fillStyle = TEXT;
        ctx.fillText(url, cx, urlY);
      }
    }
    ctx.restore();
  }

  return { draw };
}
