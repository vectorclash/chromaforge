import { useEffect, useRef } from 'react';
import LinearGradient from '../Canvas/LinearGradient';
import GeometricShape from '../Canvas/GeometricShape';
import renderAvatar from '../../render/renderAvatar';
import { buildSmallStarSprite } from '../../render/starSprite';
import { coverCanvas, layoutFacets, drawFacets } from './facetMosaic';

// A new avatar building itself on the Account page, layer by layer, from its own design
// (Aaron, 2026-10-21: regenerating "just disappears and the new one fades in later").
//
// The design exists the moment Regenerate is pressed -- only the upload takes time -- so
// AuthContext publishes it as `freshAvatar` before the upload starts, and this plays over the
// avatar's <img> straight away:
//
//   0-420ms     the old avatar breaks into triangles that fall in toward the centre (the
//               product page's FacetSwap geometry, run backwards), over the new background
//   300-650     a spark where it collapsed
//   380-1050    the stars pop in, centre outward, already in their complementary colours
//   520-1300    the pinwheel's slices swing out from the hub one after another, the shadow
//               growing as they land
//   1200-1550   a band of light sweeps across the pinwheel
//   1550-1700   settles onto the real render, so the last frame is exactly the uploaded image
//
// With no old avatar (a first one), the background opens out of the centre instead.
//
// The canvas then holds that last frame until the <img> underneath is showing the uploaded
// file -- the same pixels -- and only then fades, so the handover is invisible. If the upload
// fails, the canvas fades away and the old avatar, never replaced, is what is left.
// Reduced motion shows the finished avatar at once, which still beats the old blank wait.

const DURATION = 1700;
const MAX_DPR = 3;
// How long to wait for the uploaded image to be on screen before letting go regardless.
const HANDOVER_TIMEOUT_MS = 4000;

const clamp01 = x => (x < 0 ? 0 : x > 1 ? 1 : x);
const span = (t, start, length) => clamp01((t - start) / length);
const easeOutCubic = p => 1 - (1 - p) ** 3;
const easeInQuad = p => p * p;
const easeOutBack = p => {
  const c1 = 1.7;
  const c3 = c1 + 1;
  return 1 + c3 * (p - 1) ** 3 + c1 * (p - 1) ** 2;
};
const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

const makeCanvas = (w, h) => {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
};

const release = c => {
  if (!c) return;
  c.width = 0;
  c.height = 0;
};

// Every layer of the avatar drawn once, at the generator's own size, to be scaled per frame.
function buildLayers(config) {
  const geometry = config.geometryConfig;
  return {
    background: LinearGradient(config.gradientBackgroundConfig),
    starTint: LinearGradient(config.starConfig.gradientConfig),
    sprite: buildSmallStarSprite(256, makeCanvas),
    // Centre first, so the stars spread outward from where the old avatar collapsed.
    stars: [...config.starConfig.stars].sort(
      (a, b) => Math.hypot(a.x - 0.5, a.y - 0.5) - Math.hypot(b.x - 0.5, b.y - 0.5)
    ),
    slices: geometry.shapes.map(shape => GeometricShape({ ...geometry, shapes: [shape] })),
    final: renderAvatar(config)
  };
}

function releaseLayers(layers) {
  if (!layers) return;
  release(layers.background);
  release(layers.starTint);
  release(layers.sprite);
  layers.slices.forEach(release);
  release(layers.final);
}

function drawFrame(run, t) {
  const { ctx, W, H, layers, from, facets, starLayer, pinLayer, dpr } = run;

  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.clearRect(0, 0, W, H);

  // Background: under the old avatar if there is one, otherwise opening out of the centre.
  if (from) {
    ctx.drawImage(layers.background, 0, 0, W, H);
  } else {
    const r = easeOutCubic(span(t, 0, 450)) * Math.hypot(W, H) * 0.5;
    if (r > 0) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(W / 2, H / 2, r, 0, Math.PI * 2);
      ctx.clip();
      ctx.drawImage(layers.background, 0, 0, W, H);
      ctx.restore();
    }
  }

  // Stars, drawn white on their own layer and tinted through their alpha, as renderAvatar does.
  const sc = starLayer.getContext('2d');
  sc.globalCompositeOperation = 'source-over';
  sc.clearRect(0, 0, W, H);
  let anyStar = false;
  layers.stars.forEach((star, i) => {
    const p = span(t, 380 + i * 55, 420);
    if (p <= 0) return;
    anyStar = true;
    const s = star.size * W * easeOutBack(p);
    sc.save();
    sc.globalAlpha = Math.min(1, p * 3);
    sc.translate(star.x * W, star.y * H);
    sc.rotate((1 - p) * -1.6);
    sc.drawImage(layers.sprite, -s / 2, -s / 2, s, s);
    sc.restore();
  });
  if (anyStar) {
    sc.globalCompositeOperation = 'source-in';
    sc.drawImage(layers.starTint, 0, 0, W, H);
    ctx.drawImage(starLayer, 0, 0);
  }

  // The pinwheel: each slice swings out from the hub (the canvas centre) and overshoots a
  // little into place.
  const pc = pinLayer.getContext('2d');
  pc.globalCompositeOperation = 'source-over';
  pc.clearRect(0, 0, W, H);
  let landed = 0;
  layers.slices.forEach((slice, i) => {
    const p = span(t, 520 + i * 80, 480);
    landed += p;
    if (p <= 0) return;
    const e = easeOutBack(p);
    pc.save();
    pc.globalAlpha = Math.min(1, p * 3);
    pc.translate(W / 2, H / 2);
    pc.rotate((1 - e) * -0.9);
    pc.scale(0.15 + 0.85 * e, 0.15 + 0.85 * e);
    pc.translate(-W / 2, -H / 2);
    pc.drawImage(slice, 0, 0, W, H);
    pc.restore();
  });
  if (landed > 0) {
    // Light catching the gem: a bright band crossing the pinwheel only.
    const g = span(t, 1200, 350);
    if (g > 0 && g < 1) {
      const x = -0.4 * W + g * 1.8 * W;
      const band = pc.createLinearGradient(x - W * 0.18, x * 0.3, x + W * 0.18, x * 0.3 + W * 0.2);
      band.addColorStop(0, 'rgba(255,255,255,0)');
      band.addColorStop(0.5, 'rgba(255,255,255,0.6)');
      band.addColorStop(1, 'rgba(255,255,255,0)');
      pc.globalCompositeOperation = 'source-atop';
      pc.fillStyle = band;
      pc.fillRect(0, 0, W, H);
    }
    const shadow = landed / layers.slices.length;
    ctx.save();
    ctx.shadowColor = `rgba(10, 6, 20, ${0.45 * shadow})`;
    ctx.shadowBlur = W * 0.05;
    ctx.shadowOffsetY = H * 0.015;
    ctx.drawImage(pinLayer, 0, 0);
    ctx.restore();
  }

  // The old avatar falling in toward the centre, outermost triangles first.
  if (from) {
    const q = 1 - easeInQuad(span(t, 0, 420));
    if (q > 0) drawFacets(ctx, facets, from, q, 1.2 * dpr);
  }

  // The spark where it collapsed.
  const k = span(t, 300, 350);
  if (k > 0 && k < 1) {
    const r = W * (0.1 + 0.4 * easeOutCubic(k));
    const spark = ctx.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, r);
    const a = 0.8 * (1 - k);
    spark.addColorStop(0, `rgba(255,255,255,${a})`);
    spark.addColorStop(0.35, `rgba(255,255,255,${a * 0.4})`);
    spark.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = spark;
    ctx.fillRect(0, 0, W, H);
    ctx.globalCompositeOperation = 'source-over';
  }

  // Settle onto the real render.
  const f = span(t, DURATION - 150, 150);
  if (f > 0) {
    ctx.globalAlpha = f;
    ctx.drawImage(layers.final, 0, 0, W, H);
    ctx.globalAlpha = 1;
  }
}

export default function AvatarBuild({ fresh }) {
  const canvasRef = useRef(null);
  const runRef = useRef(null);
  // Only an avatar made while this page is open is built; one made earlier is already the <img>.
  const seenKeyRef = useRef(fresh?.key ?? 0);

  const stop = () => {
    const run = runRef.current;
    if (!run) return;
    runRef.current = null;
    cancelAnimationFrame(run.raf);
    clearTimeout(run.fadeTimer);
    releaseLayers(run.layers);
    release(run.from);
    release(run.starLayer);
    release(run.pinLayer);
    const canvas = canvasRef.current;
    if (canvas) {
      canvas.style.transition = '';
      canvas.style.opacity = '';
      canvas.style.visibility = '';
      release(canvas);
    }
  };

  // Fades the canvas off whatever is under it, then takes it down.
  const fadeOut = run => {
    if (run.fading) return;
    run.fading = true;
    cancelAnimationFrame(run.raf);
    const canvas = canvasRef.current;
    canvas.style.transition = 'opacity 250ms ease-out';
    canvas.style.opacity = '0';
    run.fadeTimer = setTimeout(() => {
      if (runRef.current === run) stop();
    }, 260);
  };

  // Once the build is finished and uploaded, wait for the <img> underneath to be fully showing
  // the uploaded file (FadeImage fades a new src in), then let go.
  const handOver = run => {
    if (!run.built || !run.url || run.handingOver) return;
    run.handingOver = true;
    const started = performance.now();
    const check = () => {
      if (runRef.current !== run) return;
      const img = canvasRef.current?.parentElement?.querySelector('img');
      const showing =
        img &&
        img.getAttribute('src') === run.url &&
        img.complete &&
        img.naturalWidth > 0 &&
        // FadeImage's fade-in fills forwards, so it stays listed once finished.
        img.getAnimations().every(a => a.playState === 'finished') &&
        getComputedStyle(img).opacity === '1';
      if (showing || performance.now() - started > HANDOVER_TIMEOUT_MS) fadeOut(run);
      else run.raf = requestAnimationFrame(check);
    };
    run.raf = requestAnimationFrame(check);
  };

  const play = config => {
    const canvas = canvasRef.current;
    const box = canvas.parentElement.getBoundingClientRect();
    const dpr = Math.min(MAX_DPR, window.devicePixelRatio || 1);
    const W = Math.max(1, Math.round(box.width * dpr));
    const H = Math.max(1, Math.round(box.height * dpr));

    // What is on screen now is what breaks apart: a build still playing, or the current avatar.
    let from = null;
    const previous = runRef.current;
    if (previous && canvas.width === W && canvas.height === H) {
      from = makeCanvas(W, H);
      from.getContext('2d').drawImage(canvas, 0, 0);
    } else {
      const img = canvas.parentElement.querySelector('img');
      if (img && img.complete && img.naturalWidth > 0) from = coverCanvas(img, W, H);
    }
    stop();

    canvas.width = W;
    canvas.height = H;
    canvas.style.visibility = 'visible';
    const run = {
      ctx: canvas.getContext('2d'),
      W,
      H,
      dpr,
      from,
      layers: buildLayers(config),
      facets: layoutFacets(W, H, W / 2, H / 2),
      starLayer: makeCanvas(W, H),
      pinLayer: makeCanvas(W, H),
      raf: 0,
      built: false,
      url: null
    };
    runRef.current = run;

    if (reducedMotion()) {
      drawFrame(run, DURATION);
      run.built = true;
      return run;
    }
    let t0 = null;
    const frame = now => {
      if (runRef.current !== run) return;
      if (t0 === null) t0 = now;
      const t = Math.min(DURATION, now - t0);
      drawFrame(run, t);
      if (t < DURATION) {
        run.raf = requestAnimationFrame(frame);
      } else {
        run.built = true;
        handOver(run);
      }
    };
    // The first frame now, so the old <img> is covered in the same paint the click lands in.
    drawFrame(run, 0);
    run.raf = requestAnimationFrame(frame);
    return run;
  };

  useEffect(() => {
    if (!fresh || !canvasRef.current) return;
    if (fresh.key > seenKeyRef.current) {
      seenKeyRef.current = fresh.key;
      play(fresh.config);
    }
    const run = runRef.current;
    if (!run) return;
    if (fresh.failed) fadeOut(run);
    else if (fresh.url) {
      run.url = fresh.url;
      handOver(run);
    }
    // play/fadeOut/handOver only touch refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fresh]);

  useEffect(() => stop, []);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className="pointer-events-none invisible absolute inset-0 h-full w-full"
    />
  );
}
