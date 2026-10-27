import { layoutFacets, drawFacets } from '../components/ui/facetMosaic';

// The explainer's captions, in the site's display face (Exo 700, the key word in 900 in the
// wordmark's FORGE lime -- filled from the design's own palette it vanished into that same artwork
// behind it). The terminal type-on of the first version came from the mockup wait's
// narration and did not read in a video (Aaron, 2026-10-26: "let's come up with something better
// and more interesting"), so three styles are built here to be compared in the builder, the way
// the lockup's entrance was chosen -- and then, like the lockup, it should come down to one:
//   line  -- the lockup's own entrance: a light draws a hairline and each word rises out of it as
//            the light passes, then sinks back in on the way out. The captions and the brand then
//            speak one motion language.
//   pop   -- word by word, each popping in with an overshoot and a small turn, the key word last
//            with a glow; out, they lift away and fade.
//   facet -- the whole line assembles out of the product page's triangles (FacetSwap), from the
//            centre, and breaks apart toward it on the way out. No glints: over text they drew a
//            grid of white lines (Aaron, 2026-10-26).
//
// Every word is drawn ONCE into its own sprite, shadow included, so no canvas shadow is drawn per
// frame (Safari is slow at those -- the lockup's lesson).

export const CAPTION_STYLES = [
  ['line', 'Line'],
  ['pop', 'Pop'],
  ['facet', 'Facet']
];

// The wordmark's FORGE (lockup.js).
const KEY_COLOR = '#cdf29c';

const clamp01 = x => (x < 0 ? 0 : x > 1 ? 1 : x);
const easeOut = x => 1 - (1 - x) ** 3;
const easeIn = x => x * x * x;
const easeOutBack = p => {
  const c1 = 2.2;
  return 1 + (c1 + 1) * (p - 1) ** 3 + c1 * (p - 1) ** 2;
};
const canvas = (w, h) => {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.ceil(w));
  c.height = Math.max(1, Math.ceil(h));
  return c;
};

/**
 * @param {{ width: number, height: number, top: number, items: Array<{ words: Array<{ text: string, key?: boolean }>, palette: string[] }> }} o
 *   `top` is the y of the caption block's top edge.
 */
export async function createCaptions({ width, height, top, items }) {
  const k = width / 1080;
  const SIZE = 76 * k;
  const LEAD = SIZE * 1.12;
  const MAX_W = 0.84 * width;
  const PAD = 40 * k;
  const PLAIN = `700 ${SIZE}px Exo`;
  const KEY = `900 ${SIZE}px Exo`;
  await Promise.all([document.fonts.load(PLAIN), document.fonts.load(KEY)]);
  const measure = canvas(1, 1).getContext('2d');
  const widthOf = (font, s) => {
    measure.font = font;
    return measure.measureText(s).width;
  };
  const space = widthOf(PLAIN, ' ');

  const built = items.map(({ words, palette }) => {
    // Wrap into lines no wider than MAX_W, each centred.
    const sized = words.map(w => ({ ...w, font: w.key ? KEY : PLAIN, w: widthOf(w.key ? KEY : PLAIN, w.text) }));
    const lines = [[]];
    let lineW = 0;
    for (const w of sized) {
      const add = (lines.at(-1).length ? space : 0) + w.w;
      if (lines.at(-1).length && lineW + add > MAX_W) {
        lines.push([]);
        lineW = 0;
      }
      lineW += (lines.at(-1).length ? space : 0) + w.w;
      lines.at(-1).push(w);
    }
    const placed = [];
    const lineSpans = lines.map((line, li) => {
      const total = line.reduce((a, w, i) => a + w.w + (i ? space : 0), 0);
      let x = (width - total) / 2;
      const baseline = top + SIZE * 0.82 + li * LEAD;
      for (const w of line) {
        placed.push({ ...w, x, baseline, line: li });
        x += w.w + space;
      }
      return { x0: (width - total) / 2, x1: (width + total) / 2, baseline };
    });

    // Each word's sprite: the glyphs, their drop shadow, and for the key word a gradient fill from
    // the design's palette and a glow copy for pop's flash.
    for (const w of placed) {
      const sw = w.w + 2 * PAD;
      const sh = SIZE * 1.4 + 2 * PAD;
      const ox = PAD;
      const oy = PAD + SIZE * 1.05;
      const draw = (glow = false) => {
        const c = canvas(sw, sh);
        const ctx = c.getContext('2d');
        ctx.font = w.font;
        ctx.textBaseline = 'alphabetic';
        ctx.fillStyle = w.key ? KEY_COLOR : '#fafafa';
        if (glow) {
          ctx.shadowColor = KEY_COLOR;
          ctx.shadowBlur = 30 * k;
        } else {
          ctx.shadowColor = 'rgba(0, 0, 0, 0.6)';
          ctx.shadowBlur = 22 * k;
          ctx.shadowOffsetY = 4 * k;
        }
        ctx.fillText(w.text, ox, oy);
        return c;
      };
      w.sprite = draw();
      w.glow = w.key ? draw(true) : null;
      w.sx = w.x - ox;
      w.sy = w.baseline - oy;
    }

    // The whole caption on one band fitted to the text, for the facet style: the lattice spread
    // over the full frame width made long thin triangles whose glints ran far past the words.
    const bandTop = top - PAD * 0.5;
    const bandLeft = Math.min(...lineSpans.map(l => l.x0)) - PAD;
    const bandW = Math.max(...lineSpans.map(l => l.x1)) + PAD - bandLeft;
    const bandH = lines.length * LEAD + SIZE * 0.3 + PAD;
    const band = canvas(bandW, bandH);
    const bctx = band.getContext('2d');
    for (const w of placed) bctx.drawImage(w.sprite, w.sx - bandLeft, w.sy - bandTop);
    const facets = layoutFacets(band.width, band.height, band.width / 2, band.height / 2);
    const visible = coverage(band, facets);
    return { placed, lineSpans, palette, band, bandTop, bandLeft, facets, visible };
  });

  // Which of a band's triangles have any text in them, so empty ones draw no glint.
  function coverage(c, layout) {
    const ctx = c.getContext('2d', { willReadFrequently: true });
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    return layout.tris.map(tr => {
      for (let y = tr.by; y < tr.by + tr.bh; y += 3)
        for (let x = tr.bx; x < tr.bx + tr.bw; x += 3) if (d[(y * c.width + x) * 4 + 3] > 40) return true;
      return false;
    });
  }

  const drawSprite = (ctx, w, dx = 0, dy = 0, scale = 1, rot = 0, alpha = 1, img = w.sprite) => {
    if (alpha <= 0) return;
    ctx.save();
    ctx.globalAlpha = alpha;
    const cx = w.x + w.w / 2 + dx;
    const cy = w.baseline - SIZE * 0.35 + dy;
    ctx.translate(cx, cy);
    ctx.rotate(rot);
    ctx.scale(scale, scale);
    ctx.translate(-cx + dx, -cy + dy);
    ctx.drawImage(img, w.sx, w.sy);
    ctx.restore();
  };

  // ── line ──
  const RISE = 0.45;
  function drawLine(ctx, c, t, start, end, beat) {
    const inDur = Math.max(beat, 0.5);
    const outDur = 0.5;
    const n = c.lineSpans.length;
    const outAt = end - outDur;
    c.lineSpans.forEach((span, li) => {
      const lineY = span.baseline + SIZE * 0.2;
      const f = clamp01(((t - start) / inDur) * n - li);
      const o = clamp01(((t - outAt) / outDur) * n - (n - 1 - li));
      const headIn = span.x0 + (span.x1 - span.x0) * easeOut(f);
      const tailOut = span.x1 - (span.x1 - span.x0) * easeIn(o);
      // The hairline: drawn up to the light's head, retracting from the right on the way out.
      const x1 = t < outAt ? headIn : tailOut;
      if (f > 0 && x1 > span.x0) {
        const g = ctx.createLinearGradient(span.x0, 0, span.x1, 0);
        c.palette.forEach((col, i) => g.addColorStop(i / Math.max(1, c.palette.length - 1), col));
        ctx.save();
        ctx.globalAlpha = f < 1 ? 1 : t < outAt ? 0.75 : 0.75 * (1 - o);
        ctx.fillStyle = g;
        ctx.fillRect(span.x0, lineY - 1.5 * k, x1 - span.x0, 3 * k);
        if (f > 0 && f < 1) {
          const glow = ctx.createRadialGradient(headIn, lineY, 0, headIn, lineY, 26 * k);
          glow.addColorStop(0, 'rgba(255,255,255,0.95)');
          glow.addColorStop(1, 'rgba(255,255,255,0)');
          ctx.fillStyle = glow;
          ctx.fillRect(headIn - 26 * k, lineY - 26 * k, 52 * k, 52 * k);
        }
        ctx.restore();
      }
      // Words rise out of the line as the light passes them, and sink back in from the right.
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, lineY - LEAD * 1.5, width, LEAD * 1.5);
      ctx.clip();
      for (const w of c.placed) {
        if (w.line !== li) continue;
        const along = (w.x - span.x0) / Math.max(1, span.x1 - span.x0);
        const p = easeOut(clamp01((t - start - ((li + along) / n) * inDur) / RISE));
        const back = (span.x1 - (w.x + w.w)) / Math.max(1, span.x1 - span.x0);
        const q = easeIn(clamp01((t - outAt - ((n - 1 - li + back) / n) * outDur * 0.6) / 0.3));
        const dy = (1 - p) * LEAD + q * LEAD;
        drawSprite(ctx, w, 0, dy, 1, 0, Math.min(1, p * 1.6) * (1 - q * 0.3));
      }
      ctx.restore();
    });
  }

  // ── pop ──
  function drawPop(ctx, c, t, start, end) {
    const STEP = 0.12;
    c.placed.forEach((w, i) => {
      const at = start + i * STEP + (w.key ? 0.06 : 0);
      const p = clamp01((t - at) / (w.key ? 0.5 : 0.38));
      if (p <= 0) return;
      const q = clamp01((t - (end - 0.32) - i * 0.035) / 0.24);
      const turn = (i % 2 ? 1 : -1) * 0.14 * (1 - easeOut(p));
      const scale = (0.35 + 0.65 * easeOutBack(p)) * (1 - 0.15 * q) * (w.key ? 1 + 0.06 * Math.sin(Math.min(1, p) * Math.PI) : 1);
      const dy = (1 - easeOut(p)) * 24 * k - easeOut(q) * 50 * k;
      const alpha = Math.min(1, p * 3) * (1 - q);
      if (w.glow) {
        // The key word flashes in its own colours as it lands.
        const flash = Math.sin(clamp01((t - at - 0.15) / 0.6) * Math.PI);
        drawSprite(ctx, w, 0, dy, scale * 1.02, turn, alpha * flash * 0.9, w.glow);
      }
      drawSprite(ctx, w, 0, dy, scale, turn, alpha);
    });
  }

  // ── facet ──
  function drawFacet(ctx, c, t, start, end) {
    const IN = 0.56;
    const OUT = 0.44;
    const p = t < end - OUT ? clamp01((t - start) / IN) : clamp01((end - t) / OUT);
    if (p <= 0) return;
    ctx.save();
    ctx.translate(c.bandLeft, c.bandTop);
    if (p >= 1) ctx.drawImage(c.band, 0, 0);
    else drawFacets(ctx, c.facets, c.band, p, 0, c.visible);
    ctx.restore();
  }

  /**
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} t
   * @param {{ style: string, beat: number, spans: Array<[number, number]> }} o
   */
  function draw(ctx, t, { style, beat, spans }) {
    built.forEach((c, i) => {
      const [start, end] = spans[i];
      if (t < start || t > end) return;
      if (style === 'pop') drawPop(ctx, c, t, start, end);
      else if (style === 'facet') drawFacet(ctx, c, t, start, end);
      else drawLine(ctx, c, t, start, end, beat);
    });
  }

  return { draw };
}
