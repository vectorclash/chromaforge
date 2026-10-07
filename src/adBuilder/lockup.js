import tinycolor from 'tinycolor2';
import logoUrl from '../assets/images/logo.svg';

// The ad's brand lockup, drawn on a canvas at any frame time: the site's own wordmark (the logo,
// CHROMA in Exo 400, FORGE in Exo 900 soft lime -- Wordmark.jsx / .controls-inner h1), a
// hairline under it in the DESIGN's palette (the .cf-spectrum-line treatment, as the
// mini-generator's palette edge does it), and the URL.
//
// It arrives on the music: a light draws the hairline left to right across one beat, each piece
// rises up out of the line as the light passes it, and the URL drops down out of it. CHROMA then
// runs the wordmark's hover hue-wave -- each letter cycling the colour wheel a beat after its
// neighbour -- and does again on later cuts to new products, with a glint along the hairline.
// Two other entrances were built beside this one and dropped (2026-10-07): the site's
// resolve-in (the whole lockup out of a blur, which was this one's predecessor) and a hammer
// "strike". One entrance, the same on every ad, is what makes it recognisable.
//
// Every piece (the logo, each letter, each letter of the URL) is rendered ONCE into its own small
// sprites: the glyph, its dark drop shadow, and a white mask and glow that are tinted per frame.
// That is what lets each letter move on its own, and it fixes the wave: drawn live, a letter's
// one canvas shadow had to switch from the dark drop shadow to the coloured glow, so the shadow
// vanished and snapped back letter by letter as the wave passed. Now the dark shadow never
// changes and the glow fades in over it. It also means no canvas shadow is drawn per frame,
// which Safari is slow at.
//
// Sizes are authored at 1080 wide and scale with the frame.

const TEXT = '#fafafa';
const FORGE = '#cdf29c';
// The lockup's height as a fraction of a 9:16 frame -- the band the composer reserves for it.
export const LOCKUP_BAND = 0.088;

const WAVE_SECONDS = 0.8;
const WAVE_STAGGER = 0.07;
const WAVE_SPAN = WAVE_SECONDS + 5 * WAVE_STAGGER;
// The wave marks a new product, but no more often than this: at a fast tempo, or with short
// products, a wave on every cut ran back to back and read as the wordmark pulsing.
const WAVE_MIN_BARS = 2;
const URL_ALPHA = 0.92;
// How long a piece takes to rise out of the line.
const RISE = 0.5;

// cubic-bezier(0.16, 1, 0.3, 1) -- --animate-resolve-in's curve -- solved for x by Newton's method.
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
const easeInOut = x => (x < 0.5 ? 4 * x ** 3 : 1 - (-2 * x + 2) ** 3 / 2);
const canvas = (w, h) => {
  const c = document.createElement('canvas');
  c.width = Math.max(1, w);
  c.height = Math.max(1, h);
  return c;
};

// The logo SVG declares width/height 100%, so it has no reliable intrinsic size; it is
// rasterised at exactly the size it is drawn.
async function rasterLogo(heightPx) {
  const svg = await (await fetch(logoUrl)).text();
  const w = Math.round((heightPx * 72) / 81);
  const sized = svg.replace('width="100%" height="100%"', `width="${w}" height="${Math.round(heightPx)}"`);
  const img = new Image();
  img.src = URL.createObjectURL(new Blob([sized], { type: 'image/svg+xml' }));
  await img.decode();
  const c = canvas(w, Math.round(heightPx));
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  URL.revokeObjectURL(img.src);
  return c;
}

// The sprites for one piece, placed in lockup coordinates: `paint(g, x, y)` draws the piece with
// its own origin at (x, y) of the context `g`. Each canvas covers the piece plus room for its
// shadow, and sits at the WHOLE pixel (sx, sy), so a piece at rest is blitted without resampling.
function makeSprite({ bounds, paint, shadow, glow = null }) {
  const pad = Math.ceil(Math.max(shadow.blur, glow?.blur ?? 0) * 1.6) + 2;
  const sx = Math.floor(bounds.x0) - pad;
  const sy = Math.floor(bounds.y0) - pad;
  const w = Math.ceil(bounds.x1) + pad - sx + 1;
  const h = Math.ceil(bounds.y1) + pad - sy + 1;
  const layer = draw => {
    const c = canvas(w, h);
    draw(c.getContext('2d'));
    return c;
  };
  // A shadow on its own: the piece is drawn off the canvas and only its shadow lands on it.
  const shadowOnly = (color, blur) =>
    layer(g => {
      g.shadowColor = color;
      g.shadowBlur = blur;
      g.shadowOffsetX = w + 64;
      paint(g, -sx - w - 64, -sy, '#000');
    });
  return {
    sx,
    sy,
    w,
    h,
    fill: layer(g => paint(g, -sx, -sy, null)),
    shadow: shadowOnly(shadow.color, shadow.blur),
    mask: glow ? layer(g => paint(g, -sx, -sy, '#fff')) : null,
    glow: glow ? shadowOnly('#fff', glow.blur) : null,
    tinted: glow ? [canvas(w, h), canvas(w, h)] : null
  };
}

// `source` (white) recoloured into `into`, for the heat colour of a letter or its glow.
function tint(into, source, color) {
  const g = into.getContext('2d');
  g.globalCompositeOperation = 'copy';
  g.drawImage(source, 0, 0);
  g.globalCompositeOperation = 'source-in';
  g.fillStyle = color;
  g.fillRect(0, 0, into.width, into.height);
  return into;
}

/**
 * @param {{ width: number, height: number, palette: string[] }} o
 */
export async function createLockup({ width, height, palette }) {
  const u = width / 1080;
  const F = 78 * u; // wordmark size
  const URL_SIZE = 33 * u;
  const WORD_FONT = `400 ${F}px Exo`;
  const FORGE_FONT = `900 ${F}px Exo`;
  const URL_FONT = `700 ${URL_SIZE}px Quicksand, sans-serif`;
  await Promise.all([
    document.fonts.load(WORD_FONT),
    document.fonts.load(FORGE_FONT),
    document.fonts.load(`700 ${URL_SIZE}px Quicksand`)
  ]);
  const logo = await rasterLogo(F * 0.92);

  const measure = canvas(1, 1).getContext('2d');
  measure.textBaseline = 'middle';
  const advance = (font, s) => {
    measure.font = font;
    return measure.measureText(s).width;
  };
  const tracking = -0.025 * F; // tracking-tight
  const chromaW = [...'CHROMA'].map(ch => advance(WORD_FONT, ch) + tracking);
  // FORGE's letters sit where the whole word would put them, kerning included.
  const forgeAt = [...'FORGE'].map((_, k) => advance(FORGE_FONT, 'FORGE'.slice(0, k)) + k * tracking);
  const forgeW = advance(FORGE_FONT, 'FORGE') + 5 * tracking;
  const gap = 0.3 * F;
  const markW = logo.width + gap + chromaW.reduce((a, b) => a + b, 0) + forgeW;

  // Positions in lockup coordinates: x across the frame, y down from the top of the band. Whole
  // pixels vertically, so the hairline is crisp and every piece at rest lands on the pixel grid.
  const cx = width / 2;
  const markY = Math.round(48 * u);
  const lineY = Math.round(102 * u);
  const urlY = Math.round(140 * u);
  const left = cx - markW / 2;

  const SHADOW = { color: 'rgba(0, 0, 0, 0.5)', blur: 26 * u };
  const GLOW = { blur: 16 * u };
  const textSprite = (font, ch, x, y, color, shadow, glow) => {
    measure.font = font;
    const m = measure.measureText(ch);
    return makeSprite({
      bounds: {
        x0: x - m.actualBoundingBoxLeft,
        x1: x + m.actualBoundingBoxRight,
        y0: y - m.actualBoundingBoxAscent,
        y1: y + m.actualBoundingBoxDescent
      },
      shadow,
      glow,
      paint: (g, ox, oy, override) => {
        g.font = font;
        g.textBaseline = 'middle';
        g.fillStyle = override || color;
        g.fillText(ch, x + ox, y + oy);
      }
    });
  };

  const pieces = [];
  let x = left;
  const logoY = markY - logo.height / 2;
  pieces.push({
    kind: 'logo',
    k: 0,
    ...makeSprite({
      bounds: { x0: x, x1: x + logo.width, y0: logoY, y1: logoY + logo.height },
      shadow: SHADOW,
      paint: (g, ox, oy) => g.drawImage(logo, x + ox, logoY + oy)
    })
  });
  x += logo.width + gap;
  [...'CHROMA'].forEach((ch, k) => {
    pieces.push({ kind: 'chroma', k, ...textSprite(WORD_FONT, ch, x, markY, TEXT, SHADOW, GLOW) });
    x += chromaW[k];
  });
  [...'FORGE'].forEach((ch, k) => {
    pieces.push({ kind: 'forge', k, ...textSprite(FORGE_FONT, ch, x + forgeAt[k], markY, FORGE, SHADOW, GLOW) });
  });

  // The URL's letters, at 0.14em spacing, rebuilt when the text changes.
  let urlCache = { text: null, letters: [] };
  function urlLetters(text) {
    if (urlCache.text === text) return urlCache.letters;
    const SP = 0.14 * URL_SIZE;
    const x0 = cx - (advance(URL_FONT, text) + (text.length - 1) * SP) / 2;
    const letters = [...text].map((ch, k) =>
      textSprite(URL_FONT, ch, x0 + advance(URL_FONT, text.slice(0, k)) + k * SP, urlY, TEXT, {
        color: 'rgba(0, 0, 0, 0.55)',
        blur: 18 * u
      })
    );
    urlCache = { text, letters };
    return letters;
  }

  // The hairline, at full width with its ends faded, drawn once.
  const stops = (palette.length ? palette : ['#4c00ff', '#ff0059', '#ffbb00', '#eaff00', '#00e5ff']).map(c =>
    tinycolor(c).toHexString()
  );
  const line = canvas(Math.ceil(markW), Math.max(2, Math.round(3 * u)));
  {
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
  }
  const lineX = Math.round(cx - line.width / 2);
  const lineScratch = canvas(line.width, line.height);

  // A light on the hairline: the leading end of a line being drawn.
  const HEAD_R = 14 * u;
  function drawHead(ctx, hx, a) {
    if (a <= 0) return;
    const y = lineY + line.height / 2;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = a;
    ctx.translate(hx, y);
    ctx.scale(3.5, 1);
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, HEAD_R);
    g.addColorStop(0, 'rgba(255,255,255,0.9)');
    g.addColorStop(0.2, 'rgba(255,255,255,0.4)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(-HEAD_R, -HEAD_R, 2 * HEAD_R, 2 * HEAD_R);
    ctx.restore();
  }

  // The hairline from x0 to x1 (absolute), with a glint travelling along it at `glint` (0..1 of
  // its length, or -1 for none).
  function drawLine(ctx, x0, x1, alpha, glint) {
    const s0 = Math.max(0, x0 - lineX);
    const s1 = Math.min(line.width, x1 - lineX);
    if (s1 <= s0 || alpha <= 0) return;
    let src = line;
    if (glint >= 0) {
      const g = lineScratch.getContext('2d');
      g.globalCompositeOperation = 'copy';
      g.drawImage(line, 0, 0);
      g.globalCompositeOperation = 'source-atop';
      const gx = glint * (line.width + 240 * u) - 120 * u;
      const grad = g.createLinearGradient(gx - 120 * u, 0, gx + 120 * u, 0);
      grad.addColorStop(0, 'rgba(255,255,255,0)');
      grad.addColorStop(0.5, `rgba(255,255,255,${0.85 * Math.sin(Math.PI * glint)})`);
      grad.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = grad;
      g.fillRect(0, 0, line.width, line.height);
      src = lineScratch;
    }
    ctx.save();
    ctx.globalAlpha *= alpha;
    ctx.drawImage(src, s0, 0, s1 - s0, line.height, lineX + s0, lineY, s1 - s0, line.height);
    ctx.restore();
  }

  // One piece at a pose: { alpha, dy, heat (0..1), hue (the heat colour), clip ([y0, y1] it is
  // drawn within, while it rises out of the line) }.
  function drawPiece(ctx, p, pose) {
    const alpha = pose.alpha ?? 1;
    if (alpha <= 0) return;
    ctx.save();
    if (pose.clip) {
      ctx.beginPath();
      ctx.rect(0, pose.clip[0], width, pose.clip[1] - pose.clip[0]);
      ctx.clip();
    }
    ctx.translate(0, pose.dy ?? 0);
    ctx.globalAlpha = alpha;
    ctx.drawImage(p.shadow, p.sx, p.sy);
    const heat = pose.heat ?? 0;
    if (heat > 0 && p.glow) {
      ctx.globalAlpha = alpha * heat * 0.9;
      ctx.drawImage(tint(p.tinted[0], p.glow, pose.hue), p.sx, p.sy);
    }
    ctx.globalAlpha = alpha;
    ctx.drawImage(p.fill, p.sx, p.sy);
    if (heat > 0 && p.mask) {
      ctx.globalAlpha = alpha * heat;
      ctx.drawImage(tint(p.tinted[1], p.mask, pose.hue), p.sx, p.sy);
    }
    ctx.restore();
  }

  const waveHue = (k, ph) => tinycolor({ h: (k * 24 + ph * 360) % 360, s: 1, l: 0.6 }).toHexString();

  // Where CHROMA letter k is in the most recent hue wave at time t: 0..1, or -1 if none.
  function wavePhase(t, ripples, k) {
    for (let r = ripples.length - 1; r >= 0; r--) {
      if (t < ripples[r]) continue;
      const ph = (t - ripples[r] - k * WAVE_STAGGER) / WAVE_SECONDS;
      return ph >= 0 && ph <= 1 ? ph : -1;
    }
    return -1;
  }
  function glintAt(t, ripples) {
    for (let r = ripples.length - 1; r >= 0; r--) {
      if (t < ripples[r]) continue;
      const g = (t - ripples[r]) / WAVE_SPAN;
      return g <= 1 ? g : -1;
    }
    return -1;
  }

  // ── The entrance ────────────────────────────────────────────────────────────
  // How every piece, the hairline and the URL stand `e` seconds after the lockup appears. The
  // light crosses the line in one beat of the music (held to a sensible range for very fast or
  // slow tempos), so the whole entrance lands on the beat.
  const runOf = beat => Math.min(0.7, Math.max(0.42, beat));
  const settleOf = beat => runOf(beat) * 0.8 + RISE;

  function entrance(e, beat) {
    const run = runOf(beat);
    const head = lineX + line.width * easeInOut(clamp01(e / run));
    // When the light passes x: the inverse of the head's ease, by bisection.
    const passes = px => {
      const f = clamp01((px - lineX) / line.width);
      let lo = 0;
      let hi = 1;
      for (let i = 0; i < 20; i++) {
        const mid = (lo + hi) / 2;
        if (easeInOut(mid) < f) lo = mid;
        else hi = mid;
      }
      return lo * run;
    };
    const below = lineY + line.height;
    const urlQ = clamp01((e - run * 0.8) / RISE);
    return {
      // Each piece starts wholly below the line, hidden by it, and rises into place.
      piece: p => {
        const q = clamp01((e - passes(p.sx + p.w * 0.35)) / RISE);
        if (q >= 1) return {};
        const r = resolveEase(q);
        return { alpha: clamp01(q * 4), dy: (1 - r) * (lineY - p.sy + 2), clip: [-height, lineY] };
      },
      line: { x1: head, head: 1 - clamp01((e - run) / 0.3) },
      // The URL starts wholly above the line's bottom edge and drops into place.
      url: p => {
        if (urlQ >= 1) return { alpha: URL_ALPHA };
        const r = resolveEase(urlQ);
        return { alpha: clamp01(urlQ * 4) * URL_ALPHA, dy: -(1 - r) * (p.sy + p.h - below + 2), clip: [below, height] };
      }
    };
  }

  // When CHROMA's hue wave runs: once the line is drawn, then on the later cuts.
  function ripplesFor(appearAt, beat, cuts) {
    const out = [appearAt + runOf(beat)];
    // Spaced from the first product's downbeat, a beat before the lockup appears: the arrival
    // is the first flourish, and counting from the wave's own start a beat or two later would
    // skip a cut that is already a comfortable 1.5 bars after it.
    let last = appearAt - beat;
    const gap = WAVE_MIN_BARS * 4 * beat - 1e-6;
    for (const c of cuts) {
      if (c - last < gap) continue;
      out.push(c);
      last = c;
    }
    return out;
  }

  // Draws the lockup at time t, its top at y = 0 of the context.
  /**
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} t
   * @param {{ appearAt: number, beat: number, cuts: number[], url: string }} o
   */
  function drawLive(ctx, t, { appearAt, beat, cuts, url }) {
    const ent = entrance(t - appearAt, beat);
    const ripples = ripplesFor(appearAt, beat, cuts);

    for (const p of pieces) {
      const pose = ent.piece(p);
      if (p.kind === 'chroma') {
        const ph = wavePhase(t, ripples, p.k);
        if (ph >= 0) {
          pose.heat = Math.sin(Math.PI * ph);
          pose.hue = waveHue(p.k, ph);
        }
      }
      drawPiece(ctx, p, pose);
    }

    drawLine(ctx, lineX, ent.line.x1, 1, glintAt(t, ripples));
    drawHead(ctx, ent.line.x1, ent.line.head);

    if (url) for (const p of urlLetters(url)) drawPiece(ctx, p, ent.url(p));
  }

  // Once it has arrived and no wave is running, the lockup is a still picture -- so it is drawn
  // once into a cache and blitted.
  const margin = Math.ceil(40 * u); // room for the shadows
  const bandHeight = Math.ceil(LOCKUP_BAND * height) + 2 * margin;
  let cache = null;
  let cacheKey = null;
  function settledImage(url) {
    if (cache && cacheKey === url) return cache;
    cache = canvas(width, bandHeight);
    const g = cache.getContext('2d');
    g.translate(0, margin);
    drawLive(g, 1e6, { appearAt: 0, beat: 0.5, cuts: [], url });
    cacheKey = url;
    return cache;
  }

  /**
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} t
   * @param {{ top: number, appearAt: number, beat: number, cuts: number[], url: string }} o
   *   top in px of the context; cuts are the times of the later product cuts
   */
  function draw(ctx, t, o) {
    if (t < o.appearAt) return;
    const top = Math.round(o.top);
    const waving = glintAt(t, ripplesFor(o.appearAt, o.beat, o.cuts)) >= 0;
    if (t < o.appearAt + settleOf(o.beat) || waving) {
      ctx.save();
      ctx.translate(0, top);
      drawLive(ctx, t, o);
      ctx.restore();
      return;
    }
    ctx.drawImage(settledImage(o.url), 0, top - margin);
  }

  return { draw, margin, bandHeight };
}
