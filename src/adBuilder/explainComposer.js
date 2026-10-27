import { generateArtwork } from '../render/generateArtwork';
import renderArtwork from '../render/renderArtwork';
import { resolveDesignPalette } from '../render/resolvedPalette';
import { STUDIO_DEFAULT_GEOMETRY_SETTINGS } from '../render/designSettings';
import { makeRng } from '../render/prng';
import { SAFE_TOP } from './adComposer';
import { AD_FPS, SCENE_DURATION } from './adTimeline';
import { createFlightLoop } from './feedPost';
import { createLockup } from './lockup';
import { createExplainShirt } from './explainShirt';
import { createCaptions } from './captions';

// The explainer Reel ("How it works"), 2026-10-26: Aaron's friends were seeing the Reels and not
// realising they could make art themselves. Three sections on the music, no UI:
//   Tap   -- a fingertip taps, and each new piece BURSTS out of the tap point as an iris, punching
//            in while the old one recedes under it. The taps quicken onto the chosen design.
//   Keep  -- one more tap, and the camera pulls back: the piece was one card in a wall of them,
//            whose columns slide past each other.
//   Wear  -- a tap on the card; the wall falls away onto the design's own 3D flight (at constant
//            speed, no ramp), the garment rises in, and the card SLAMS into its chest --
//            shockwave, sparks and a camera shake on the impact -- then the garment turns once to
//            show the print on its back.
// Then the brand lockup.
//
// It is built as MOTION, not slides (Aaron, same day: "more motion graphics and less powerpoint
// presentation"): one camera that never stops (drift, punches on the taps, the pull-back, shake on
// impact), and every change of section a physical move rather than a cross-fade.
//
// Every frame is a pure function of time, like adComposer, so the preview and the export cannot
// disagree. The tapped pieces and the wall are FRESH designs at the studio's defaults for new
// work, so what the video shows a tap giving you is what a tap gives you. The kept one is the
// chosen design.

const TAP_BARS = 2;
const KEEP_BARS = 1;
const WEAR_BARS = 3;
// The beats the Tap section's taps land on; the last one lands the chosen design. They QUICKEN,
// like a wheel slowing onto a number: the first piece holds for 3 beats so "tap, then art" reads,
// the next for 2, then 1, and the chosen one holds into Keep.
const TAP_BEATS = [0, 3, 5, 6];
const TAPPED_FRESH = TAP_BEATS.length - 1;
// Where each caption changes, in beats. Changed only on section lines, the first caption held 8
// beats and the next two 4 each -- at 90bpm "Keep the ones you love." stood still for about a
// second before leaving (Aaron, 2026-10-26: "the second goes away as soon as it animates in").
// Now each holds 6: the second arrives as the chosen design lands (the last tap), so it is read
// before the keep tap it describes, and the lockup waits half a bar longer, landing as the
// garment finishes its turn.
const KEEP_CAPTION_BEAT = TAP_BEATS[TAPPED_FRESH];
const LOCKUP_BEATS_INTO_WEAR = 6;
// More fresh pieces for the wall. They are only ever seen small, so they render small.
const WALL_EXTRAS = 8;
const WALL_SCALE = 0.4;

// Motion blur, as a camera shutter makes it: each frame is the average of several moments spread
// across its exposure, so only what moves blurs, and by exactly how fast it moves. The open time
// as a fraction of a frame: light is film's 180 degree shutter, heavy a full 360.
export const MOTION_BLUR = [
  ['off', 'Off'],
  ['light', 'Light'],
  ['heavy', 'Heavy']
];
const SHUTTER = { off: 0, light: 0.5, heavy: 1 };

// One caption per section; the key word is set heavier, in the wordmark's lime. The three key
// words tell the story on their own: make, keep, wear. The first line says YOU make it, which is
// the point of the whole Reel ("Tap. New art." read as two fragments and left that out -- Aaron,
// 2026-10-26).
export const EXPLAIN_CAPTIONS = [
  [{ text: 'Tap' }, { text: 'to' }, { text: 'make', key: true }, { text: 'art.' }],
  [{ text: 'Keep', key: true }, { text: 'the' }, { text: 'ones' }, { text: 'you' }, { text: 'love.' }],
  [{ text: 'Then' }, { text: 'wear', key: true }, { text: 'it.' }]
];

/** @param {number} tempo */
export function explainTimeline(tempo) {
  const beat = 60 / tempo;
  const bar = 4 * beat;
  const keep = TAP_BARS * bar;
  const wear = keep + KEEP_BARS * bar;
  const total = wear + WEAR_BARS * bar;
  const taps = TAP_BEATS.map(b => b * beat);
  // The card hits the garment two beats into Wear -- but never sooner than the garment can rise
  // into place, at a fast tempo.
  const impact = wear + Math.max(2 * beat, 0.85);
  return {
    beat,
    bar,
    taps,
    keep,
    wear,
    impact,
    total,
    segments: [
      { label: 'Tap', start: 0, end: keep },
      { label: 'Keep', start: keep, end: wear },
      { label: 'Wear', start: wear, end: total }
    ]
  };
}

const clamp01 = x => (x < 0 ? 0 : x > 1 ? 1 : x);
const lerp = (a, b, f) => a + (b - a) * f;
const easeInOut = x => (x < 0.5 ? 4 * x ** 3 : 1 - (-2 * x + 2) ** 3 / 2);
const easeOut = x => 1 - (1 - x) ** 3;
const easeIn = x => x * x * x;
const easeOutBack = (x, s = 1.6) => 1 + (s + 1) * (x - 1) ** 3 + s * (x - 1) ** 2;
const canvas = (w, h) => {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
};
const nextTask = () => new Promise(r => setTimeout(r, 0));

/** The fresh designs for this ad: the tapped ones, then the wall's. `salt` reshuffles them. */
function freshDesigns(design, salt) {
  return Array.from({ length: TAPPED_FRESH + WALL_EXTRAS }, (_, k) => ({
    seed: `${design.seed}-${salt}-${k}`,
    colors: [],
    settings: { geometry: STUDIO_DEFAULT_GEOMETRY_SETTINGS }
  }));
}

/**
 * @param {{ design: { seed: string, colors?: string[], settings?: any }, width: number, height: number, salt?: number, garment?: 'tee' | 'hoodie', blurSamples?: number, exact?: boolean }} o
 *   `blurSamples`: moments averaged per frame when motion blur is on -- fewer for the live preview,
 *   more for the file, where the fastest move (the iris burst) shows steps at 10.
 *   `exact`: the flight's exact path, for the file (see adComposer); the preview runs its cache.
 */
export async function createExplainComposer({
  design,
  width,
  height,
  salt = 0,
  garment = 'tee',
  blurSamples = 16,
  exact = true
}) {
  const k = width / 1080;
  const fresh = freshDesigns(design, salt);
  // arts: the three tapped pieces, the chosen design (KEPT), then the wall's extras (small).
  const all = [...fresh.slice(0, TAPPED_FRESH), design, ...fresh.slice(TAPPED_FRESH)];
  const KEPT = TAPPED_FRESH;
  const arts = [];
  for (let i = 0; i < all.length; i++) {
    const d = all[i];
    const s = i > KEPT ? WALL_SCALE : 1;
    const w = Math.round(width * s);
    const h = Math.round(height * s);
    arts.push(renderArtwork(generateArtwork(d.seed, w, h, d.colors || [], d.settings ?? null)));
    await nextTask();
  }
  const palettes = all.map(d => resolveDesignPalette(d));

  // Behind everything once the wall appears: the kept piece, blurred and dimmed.
  const backdrop = canvas(width, height);
  {
    const b = backdrop.getContext('2d');
    b.filter = `blur(${Math.round(36 * k)}px) brightness(0.42) saturate(1.2)`;
    const over = 80 * k;
    b.drawImage(arts[KEPT], -over, -over, width + 2 * over, height + 2 * over);
  }

  // The garment is imagery, not text, so it is not held to the safe zone: it fills the middle of
  // the frame and its hem runs on into the lower zone, still well clear of Instagram's caption row.
  const shirtSize = Math.round(0.9 * width);
  const shirt = await createExplainShirt({ design, size: shirtSize, garment });
  // One draw now, mid-effect, so its shaders compile while the composer builds rather than on the
  // first frame of Wear (a 100ms hitch in playback).
  shirt.draw(0.1, { strikeAt: 0, landAt: 0.05, land: 0.5, rise: 0.05, yaw: 0 });
  const lockup = await createLockup({ width, height, palette: palettes[KEPT] });
  // Behind the garment in Wear: the kept design's own flight, at constant speed.
  const flight = await createFlightLoop(design, width, height, {
    exact,
    seconds: SCENE_DURATION,
    ramp: false
  });
  // How far into its loop the flight is when Wear begins: past the opening, already under way.
  const FLIGHT_FROM = 2;
  // Dimmed under the garment, so the print on it stands off the same colours behind it.
  const FLIGHT_DIM = 0.35;

  // The dot grid the homepage's ripple runs through.
  const ringDots = canvas(width, height);
  {
    const c = ringDots.getContext('2d');
    c.fillStyle = '#fff';
    const step = 30 * k;
    for (let y = step / 2; y < height; y += step)
      for (let x = step / 2; x < width; x += step) {
        c.beginPath();
        c.arc(x, y, 3.2 * k, 0, Math.PI * 2);
        c.fill();
      }
  }
  const scratch = canvas(width, height);

  // ── The wall: cards the size of the frame, in world space, the kept one at the origin ──
  const GAP = 0.09 * width;
  const COLS = [-2, -1, 0, 1, 2];
  const ROWS = [-2, -1, 0, 1, 2];
  const wallRng = makeRng(`${design.seed}-${salt}-wall`);
  const wall = [];
  for (const c of COLS)
    for (const r of ROWS) {
      let art;
      if (c === 0 && r === 0) art = KEPT;
      else if (Math.abs(c) + Math.abs(r) === 1) art = [0, 1, 2, KEPT + 1][wall.filter(w => w.near).length];
      else art = KEPT + 1 + Math.floor(wallRng() * WALL_EXTRAS);
      wall.push({ c, r, art, near: Math.abs(c) + Math.abs(r) === 1 });
    }
  const CARD_R = 0.05 * width;
  // Columns slide past each other once the wall is showing: alternate directions, the kept column
  // still. World units per second.
  const columnDrift = c => (c === 0 ? 0 : (c % 2 ? 1 : -1) * 0.22 * height * (1 + 0.15 * Math.abs(c)));

  const FINGER = { x: 0.5 * width, y: 0.6 * height };
  const CENTRE = { x: 0.5 * width, y: 0.5 * height };
  const SHIRT_Y = 0.5 * height;
  const CHEST_Y = SHIRT_Y - 0.05 * height;

  // A rounded rect path starting at the top centre and running clockwise, returning its length.
  // Written out rather than ctx.roundRect, whose starting point differs between engines -- with a
  // dash traced along it, the gap at the end of the trace landed partway down one side in Safari
  // (Aaron, 2026-10-26), and its length has to be known exactly for the trace to close.
  function roundRectPath(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + w / 2, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
    return 2 * (w + h) - (8 - 2 * Math.PI) * r;
  }

  function drawCard(ctx, img, x, y, w, h, r, alpha = 1) {
    if (alpha <= 0) return;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, r);
    ctx.clip();
    ctx.drawImage(img, x, y, w, h);
    ctx.restore();
  }

  // The homepage's loading ripple: a coloured ring running outward through the dot grid.
  const RIPPLE = 1.4;
  function drawRipple(ctx, t, at, centre, colors) {
    const p = (t - at) / RIPPLE;
    if (p < 0 || p >= 1) return;
    const r = easeOut(p) * Math.hypot(width, height) * 0.8;
    const s = scratch.getContext('2d');
    s.globalCompositeOperation = 'source-over';
    s.clearRect(0, 0, width, height);
    const outer = r + 50 * k;
    const g = s.createRadialGradient(centre.x, centre.y, 0, centre.x, centre.y, outer);
    const stop = v => clamp01(v / outer);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(stop(r - 130 * k), 'rgba(0,0,0,0)');
    g.addColorStop(stop(r - 60 * k), colors[0]);
    g.addColorStop(stop(r), colors[1 % colors.length]);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    s.fillStyle = g;
    s.fillRect(0, 0, width, height);
    s.globalCompositeOperation = 'destination-in';
    s.drawImage(ringDots, 0, 0);
    ctx.save();
    ctx.globalAlpha = 1 - p;
    ctx.drawImage(scratch, 0, 0);
    ctx.restore();
  }

  // A fingertip, the way a screen recording shows touches: it presses on each tap.
  function drawFinger(ctx, t, pos, taps, alpha) {
    if (alpha <= 0) return;
    let press = 0;
    for (const at of taps) {
      const d = t - at;
      if (d > -0.08 && d < 0.22) press = Math.max(press, d < 0 ? 1 + d / 0.08 : 1 - d / 0.22);
    }
    const r = 46 * k * (1 - 0.14 * press);
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.shadowColor = 'rgba(0,0,0,0.35)';
    ctx.shadowBlur = 18 * k;
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, r, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(255,255,255,${0.28 + 0.3 * press})`;
    ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.lineWidth = 3 * k;
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.stroke();
    ctx.restore();
  }

  // Camera shake: each hit kicks it, decaying fast. Two incommensurate sines per axis, so it reads
  // as a jolt rather than a wobble.
  function shake(t, hits) {
    let x = 0;
    let y = 0;
    for (const [at, amp] of hits) {
      const d = t - at;
      if (d < 0 || d > 0.5) continue;
      const a = amp * Math.exp(-d / 0.12);
      x += a * Math.sin(d * 97 + at);
      y += a * Math.cos(d * 83 + at * 1.7);
    }
    return { x, y };
  }

  // The captions sit at the top of the safe zone, one at a time, where the lockup lands last.
  const captions = await createCaptions({
    width,
    height,
    top: 0.15 * height,
    items: EXPLAIN_CAPTIONS.map((words, i) => ({
      words,
      palette: palettes[i === 0 ? 0 : KEPT]
    }))
  });

  /**
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} t
   * @param {{ timeline: ReturnType<typeof explainTimeline>, overlay: { text: string, show: boolean }, explain?: { captionStyle?: string, motionBlur?: string } }} o
   */
  function drawFrame(ctx, t, { timeline: tl, overlay, explain }) {
    const { beat, taps, keep, wear, impact } = tl;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, width, height);
    ctx.restore();

    const hits = [...taps.map(a => [a, 7 * k]), [keep, 5 * k], [wear, 5 * k], [impact, 26 * k]];
    const jolt = shake(t, hits);

    // The camera: a slow drift and turn throughout, a punch-in on every tap, the pull-back in
    // Keep. `zoom` 1 shows exactly one card (the frame); the base overscans a little so the turn
    // never shows a corner.
    let punch = 0;
    for (const at of [...taps, keep]) if (t >= at) punch = 0.05 * Math.exp(-(t - at) / 0.16);
    const drift = 1.06 + 0.03 * Math.sin(t * 0.7);
    const pull = easeInOut(clamp01((t - keep - 0.12) / 1.0));
    const zoom = lerp(drift + punch, 0.3 - 0.02 * clamp01((t - keep - 1.12) / 2), pull);
    const turn = lerp(0.012 * Math.sin(t * 0.9), 0, clamp01((t - keep) / 1.2)) - 0.05 * Math.sin(pull * Math.PI);
    const camera = ctx2 => {
      ctx2.translate(CENTRE.x + jolt.x, CENTRE.y + jolt.y);
      ctx2.rotate(turn);
      ctx2.scale(zoom, zoom);
    };

    if (t >= wear) {
      // Wear's background: the design's flight, coming up as the wall falls away in front of it.
      // Copied out of WebGL in the same task it is drawn.
      const u = t - wear;
      flight.draw(FLIGHT_FROM + u);
      ctx.save();
      ctx.globalAlpha = clamp01(u / 0.4);
      ctx.drawImage(flight.canvas, jolt.x, jolt.y, width, height);
      ctx.globalAlpha *= FLIGHT_DIM;
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, width, height);
      ctx.restore();
    }

    if (t < keep) {
      // ── Tap: each piece bursts out of the tap as an iris over the one before ──
      let i = 0;
      for (let j = 0; j < taps.length; j++) if (t >= taps[j]) i = j;
      const since = t - taps[i];
      const gap = (i + 1 < taps.length ? taps[i + 1] : keep) - taps[i];
      const open = easeOut(clamp01(since / Math.min(0.55, gap * 0.7)));
      if (i > 0) {
        // The outgoing piece recedes and darkens as the new one opens over it.
        ctx.save();
        camera(ctx);
        const s = 1 - 0.08 * open;
        ctx.scale(s, s);
        ctx.drawImage(arts[i - 1], -width / 2, -height / 2, width, height);
        ctx.restore();
        ctx.save();
        ctx.globalAlpha = 0.5 * open;
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, width, height);
        ctx.restore();
      }
      const maxR = Math.hypot(width, height);
      const R = open * maxR;
      ctx.save();
      ctx.beginPath();
      ctx.arc(FINGER.x, FINGER.y, Math.max(1, R), 0, Math.PI * 2);
      ctx.clip();
      camera(ctx);
      const s = lerp(1.18, 1, easeOut(clamp01(since / 0.7)));
      ctx.scale(s, s);
      ctx.drawImage(arts[i], -width / 2, -height / 2, width, height);
      ctx.restore();
      // A bright rim on the iris's edge, in the incoming piece's own colours.
      if (open < 1) {
        ctx.save();
        ctx.globalAlpha = 1 - open;
        ctx.lineWidth = 14 * k;
        ctx.strokeStyle = palettes[i][0];
        ctx.shadowColor = palettes[i][palettes[i].length - 1];
        ctx.shadowBlur = 30 * k;
        ctx.beginPath();
        ctx.arc(FINGER.x, FINGER.y, R, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }
    } else if (t < wear || t < wear + 0.6) {
      // ── Keep: pull back from the piece to the wall it is one card of ──
      const u = t - keep;
      const fall = clamp01((t - wear) / 0.5); // in Wear, the wall drops away behind the card
      ctx.save();
      ctx.globalAlpha = clamp01(pull * 1.5) * (1 - fall);
      ctx.drawImage(backdrop, 0, 0);
      ctx.restore();
      ctx.save();
      camera(ctx);
      const zFall = 1 - 0.45 * easeIn(fall);
      ctx.scale(zFall, zFall);
      const slide = Math.max(0, u - 0.12);
      for (const card of wall) {
        if (card.c === 0 && card.r === 0) continue;
        const x = card.c * (width + GAP) - width / 2;
        const y = card.r * (height + GAP) - height / 2 + columnDrift(card.c) * slide * pull;
        drawCard(ctx, arts[card.art], x, y, width, height, CARD_R, clamp01(pull * 4) * (1 - fall));
      }
      if (t < wear) {
        drawCard(ctx, arts[KEPT], -width / 2, -height / 2, width, height, CARD_R * pull);
        // Saved: a lime outline traces round the kept card, starting at the tap.
        const trace = easeInOut(clamp01((u - 0.05) / 0.6));
        if (trace > 0) {
          ctx.save();
          ctx.lineWidth = (7 * k) / zoom;
          ctx.strokeStyle = '#d1ff1a';
          ctx.shadowColor = '#d1ff1a';
          ctx.shadowBlur = 30 * k;
          const pad = (10 * k) / zoom;
          const perim = roundRectPath(
            ctx,
            -width / 2 - pad,
            -height / 2 - pad,
            width + 2 * pad,
            height + 2 * pad,
            CARD_R * pull + pad
          );
          // Traced as a dash growing to the path's exact length, then a plain closed stroke.
          if (trace < 1) ctx.setLineDash([perim * trace, perim]);
          ctx.stroke();
          ctx.restore();
        }
      }
      ctx.restore();
    }

    // ── Wear ──
    if (t >= wear) {
      const u = t - wear;
      // The garment rises in from below, white, overshoots and settles; at the impact it takes
      // the print with the hero's shockwave and sparks; then it turns once to show the back.
      const rise = easeOutBack(clamp01((u - 0.1) / 0.6), 1.2);
      const spinStart = impact + 0.45;
      const spin = easeInOut(clamp01((t - spinStart) / Math.max(1.2, 3 * beat)));
      const settle = clamp01((t - spinStart - Math.max(1.2, 3 * beat)) / 0.8);
      const yaw =
        spin * Math.PI * 2 +
        0.3 * Math.sin((2 * Math.PI * (t - spinStart)) / (2 * tl.bar)) * settle -
        0.12 * (1 - clamp01((t - impact) / 0.3)) * (t < impact ? 1 : 0);
      const c = shirt.draw(t, {
        strikeAt: impact,
        landAt: impact + 0.06,
        land: 0.35,
        rise: 0.06,
        yaw
      });
      const side = c.width;
      // A squash on the impact, sprung back.
      const sq = t >= impact ? 0.06 * Math.exp(-(t - impact) / 0.12) * Math.cos((t - impact) * 30) : 0;
      const gy = SHIRT_Y + (1 - rise) * 0.75 * height;
      ctx.save();
      ctx.translate(width / 2 + jolt.x, gy + jolt.y);
      ctx.scale(1 + sq, 1 - sq);
      ctx.shadowColor = 'rgba(0, 0, 0, 0.55)';
      ctx.shadowBlur = 60 * k;
      ctx.shadowOffsetY = 36 * k;
      ctx.drawImage(c, -side / 2, -side / 2, side, side);
      ctx.restore();

      // The card: it leaves the wall at the size the camera left it, hovers over the chest, winds
      // up and slams in.
      if (t < impact) {
        const z0 = zoom;
        const hover = easeInOut(clamp01(u / 0.5));
        const wind = clamp01((t - (impact - 0.32)) / 0.14);
        const slam = easeIn(clamp01((t - (impact - 0.18)) / 0.18));
        const scale = lerp(z0, 0.24, hover) * (1 + 0.12 * wind) * lerp(1, 0.35, slam);
        const cy = lerp(lerp(CENTRE.y, CHEST_Y - 0.03 * height, hover), CHEST_Y, slam);
        const tilt = lerp(0, -0.08, hover) * (1 - slam) + 0.02 * Math.sin(u * 5) * hover * (1 - wind);
        const w = width * scale;
        const h = height * scale;
        ctx.save();
        ctx.translate(CENTRE.x + jolt.x, cy + jolt.y);
        ctx.rotate(tilt);
        ctx.shadowColor = 'rgba(0, 0, 0, 0.5)';
        ctx.shadowBlur = 40 * k;
        ctx.shadowOffsetY = 20 * k;
        drawCard(ctx, arts[KEPT], -w / 2, -h / 2, w, h, CARD_R * scale);
        ctx.shadowColor = 'transparent';
        ctx.lineWidth = 6 * k;
        ctx.strokeStyle = '#d1ff1a';
        ctx.globalAlpha = 1 - hover * 0.6;
        ctx.beginPath();
        ctx.roundRect(-w / 2, -h / 2, w, h, CARD_R * scale);
        ctx.stroke();
        ctx.restore();
      }

      // The hit: a white flash ring out of the chest.
      const hitP = (t - impact) / 0.5;
      if (hitP >= 0 && hitP < 1) {
        ctx.save();
        ctx.globalAlpha = (1 - hitP) ** 2;
        ctx.lineWidth = 26 * k * (1 - hitP) + 2 * k;
        ctx.strokeStyle = '#ffffff';
        ctx.shadowColor = palettes[KEPT][0];
        ctx.shadowBlur = 40 * k;
        ctx.beginPath();
        ctx.arc(CENTRE.x + jolt.x, CHEST_Y + jolt.y, easeOut(hitP) * 0.75 * width, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }
    }

    // ── Ripples and the fingertip ──
    taps.forEach((at, i) => drawRipple(ctx, t, at, FINGER, palettes[i]));
    drawRipple(ctx, t, keep, FINGER, palettes[KEPT]);
    drawRipple(ctx, t, wear, CENTRE, palettes[KEPT]);
    const toCard = easeInOut(clamp01((t - (wear - 0.4)) / 0.35));
    const fingerPos = { x: FINGER.x, y: lerp(FINGER.y, CENTRE.y, toCard) };
    const fingerAlpha = t < wear + 0.3 ? clamp01(t / 0.15) : 1 - clamp01((t - wear - 0.3) / 0.3);
    drawFinger(ctx, t, fingerPos, [...taps, keep, wear], fingerAlpha);

    // ── Captions and the lockup ──
    // One line of text at the top at a time: the last caption leaves as the lockup arrives in its
    // place, so nothing sits under the garment.
    const lockupAt = wear + LOCKUP_BEATS_INTO_WEAR * beat;
    const keepCaption = KEEP_CAPTION_BEAT * beat;
    captions.draw(ctx, t, {
      style: explain?.captionStyle || 'line',
      beat,
      spans: [
        [0, keepCaption],
        [keepCaption, wear],
        [wear, overlay.show ? lockupAt : Infinity]
      ]
    });
    if (overlay.show) {
      lockup.draw(ctx, t, {
        top: (SAFE_TOP + 0.004) * height,
        appearAt: lockupAt,
        beat,
        cuts: [],
        url: overlay.text
      });
    }
  }

  // A frame with motion blur: `blurSamples` moments across the shutter, centred on `t`, averaged
  // into `accum` (a running mean, so each sample lands with weight 1/n as it arrives).
  const accum = canvas(width, height);
  const sample = canvas(width, height);
  /** Same arguments as drawFrame. */
  function draw(ctx, t, opts) {
    const open = (SHUTTER[opts.explain?.motionBlur ?? 'heavy'] ?? 0) / AD_FPS;
    if (!open || blurSamples < 2) return drawFrame(ctx, t, opts);
    const a = accum.getContext('2d');
    const s = sample.getContext('2d');
    for (let i = 0; i < blurSamples; i++) {
      drawFrame(s, t + ((i + 0.5) / blurSamples - 0.5) * open, opts);
      a.globalAlpha = 1 / (i + 1);
      a.drawImage(sample, 0, 0);
    }
    a.globalAlpha = 1;
    ctx.drawImage(accum, 0, 0);
  }

  return {
    width,
    height,
    draw,
    dispose() {
      shirt.dispose();
      flight.dispose();
      for (const a of arts) {
        a.width = 0;
        a.height = 0;
      }
    }
  };
}
