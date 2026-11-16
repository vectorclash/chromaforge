// FacetSwap's drawing on the GPU: the same frame drawFacets (facetMosaic.js) draws on a 2D canvas --
// every triangle that has started landing, scaled about its centre (easeOutBack, 1.012 at rest),
// fading in, with a white glint along its edges while it lands -- as ONE WebGL draw per frame.
//
// WHY (2026-11-15, Aaron, Safari): the 2D drawing dropped frames on every product-page transition
// (worst ~40ms, 2-6 slow frames a run), and every variant that still redrew the 2D canvas each
// frame dropped them -- a quarter of the pixels, no glints, half the triangles -- while the same
// canvas drawn once and left up was smooth. So the cost was Safari redrawing a 2D canvas at all,
// ~70 clipped image draws a frame, which it can do on the CPU. A WebGL canvas is always on the GPU
// and this is a few hundred vertices.
//
// createFacetGl(canvas) returns null where WebGL is unavailable (FacetSwap then keeps the 2D path).

const VERT = `
attribute vec2 aPos;
attribute vec2 aUv;
attribute float aAlpha;
attribute float aWhite;
uniform vec2 uSize;
// The photo's cover crop: x, y offset and scale (canvas px per image px), and the image's size --
// to find where on the photo a pixel of the canvas is, for the mask, which does not move.
uniform vec3 uCrop;
uniform vec2 uImg;
varying vec2 vUv;
varying vec2 vMaskUv;
varying float vAlpha;
varying float vWhite;
void main() {
  vUv = aUv;
  vMaskUv = vec2((uCrop.x + aPos.x / uCrop.z) / uImg.x, (uCrop.y + aPos.y / uCrop.z) / uImg.y);
  vAlpha = aAlpha;
  vWhite = aWhite;
  gl_Position = vec4(aPos.x / uSize.x * 2.0 - 1.0, 1.0 - aPos.y / uSize.y * 2.0, 0.0, 1.0);
}`;

const FRAG = `
precision mediump float;
uniform sampler2D uTex;
uniform sampler2D uMask;
uniform float uUseMask;
varying vec2 vUv;
varying vec2 vMaskUv;
varying float vAlpha;
varying float vWhite;
void main() {
  vec4 c = vWhite > 0.5 ? vec4(1.0) : texture2D(uTex, vUv);
  // Only the print assembles: nothing is drawn where the SCREEN is not fabric, and a triangle
  // carries only the fabric of the photo it samples -- a landing triangle is scaled about its
  // centre, so without the second test one beside an arm would carry a sliver of the arm onto
  // the shirt.
  float onFabric = texture2D(uMask, vMaskUv).a;
  float ofFabric = vWhite > 0.5 ? 1.0 : texture2D(uMask, vUv).a;
  float m = mix(1.0, onFabric * ofFabric, uUseMask);
  gl_FragColor = c * vAlpha * m;
}`;

// Same timing and shape as facetMosaic.drawFacets.
const SPREAD = 0.55;
const EACH = 0.45;
const clamp01 = x => (x < 0 ? 0 : x > 1 ? 1 : x);
const easeOutBack = p => {
  const c1 = 1.9;
  const c3 = c1 + 1;
  return 1 + c3 * (p - 1) ** 3 + c1 * (p - 1) ** 2;
};

function compile(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) || 'shader');
  return shader;
}

export function createFacetGl(canvas) {
  let gl = null;
  try {
    gl = /** @type {WebGLRenderingContext | null} */ (
      canvas.getContext('webgl', { alpha: true, premultipliedAlpha: true, antialias: true, preserveDrawingBuffer: false })
    );
  } catch {
    gl = null;
  }
  if (!gl) return null;
  let program;
  try {
    program = gl.createProgram();
    gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERT));
    gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) || 'link');
  } catch (err) {
    console.warn('facet transition: WebGL unavailable', err);
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return null;
  }
  gl.useProgram(program);
  const loc = {
    pos: gl.getAttribLocation(program, 'aPos'),
    uv: gl.getAttribLocation(program, 'aUv'),
    alpha: gl.getAttribLocation(program, 'aAlpha'),
    white: gl.getAttribLocation(program, 'aWhite'),
    size: gl.getUniformLocation(program, 'uSize'),
    tex: gl.getUniformLocation(program, 'uTex'),
    mask: gl.getUniformLocation(program, 'uMask'),
    useMask: gl.getUniformLocation(program, 'uUseMask'),
    crop: gl.getUniformLocation(program, 'uCrop'),
    img: gl.getUniformLocation(program, 'uImg')
  };
  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  const STRIDE = 6 * 4;
  gl.enableVertexAttribArray(loc.pos);
  gl.vertexAttribPointer(loc.pos, 2, gl.FLOAT, false, STRIDE, 0);
  gl.enableVertexAttribArray(loc.uv);
  gl.vertexAttribPointer(loc.uv, 2, gl.FLOAT, false, STRIDE, 8);
  gl.enableVertexAttribArray(loc.alpha);
  gl.vertexAttribPointer(loc.alpha, 1, gl.FLOAT, false, STRIDE, 16);
  gl.enableVertexAttribArray(loc.white);
  gl.vertexAttribPointer(loc.white, 1, gl.FLOAT, false, STRIDE, 20);
  const texture = gl.createTexture();
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.uniform1i(loc.tex, 0);
  const maskTexture = gl.createTexture();
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, maskTexture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.uniform1i(loc.mask, 1);
  gl.uniform1f(loc.useMask, 0);
  gl.activeTexture(gl.TEXTURE0);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);

  // The photo's cover crop (CSS object-cover), as a map from canvas pixels to texture coordinates.
  let crop = null;
  let data = new Float32Array(0);
  return {
    gl,
    // The incoming photo (a decoded <img>), cover-fitted to a W x H canvas.
    setImage(img, W, H) {
      const iw = img.naturalWidth || img.width;
      const ih = img.naturalHeight || img.height;
      const scale = Math.max(W / iw, H / ih);
      crop = { sx: (iw - W / scale) / 2, sy: (ih - H / scale) / 2, scale, iw, ih };
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
      gl.uniform3f(loc.crop, crop.sx, crop.sy, crop.scale);
      gl.uniform2f(loc.img, iw, ih);
    },
    // Confine the drawing to where `mask` (an image the photo's size; alpha = fabric) is opaque, or
    // draw everywhere (null).
    setMask(mask) {
      gl.uniform1f(loc.useMask, mask ? 1 : 0);
      if (!mask) return;
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, maskTexture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, mask);
      gl.activeTexture(gl.TEXTURE0);
    },
    // One frame at run progress t, like drawFacets(ctx, layout, cover, t, glintWidth).
    draw(layout, t, glintWidth, W, H) {
      const { tris, maxD } = layout;
      const need = tris.length * (3 + 18) * 6;
      if (data.length < need) data = new Float32Array(need);
      let n = 0;
      const put = (x, y, u, v, a, white) => {
        data[n++] = x;
        data[n++] = y;
        data[n++] = u;
        data[n++] = v;
        data[n++] = a;
        data[n++] = white;
      };
      const uOf = x => (crop.sx + x / crop.scale) / crop.iw;
      const vOf = y => (crop.sy + y / crop.scale) / crop.ih;
      const hw = glintWidth / 2;
      for (const tr of tris) {
        const p = clamp01((t - (tr.d / maxD) * SPREAD) / EACH);
        if (p <= 0) continue;
        const s = easeOutBack(p) * 1.012;
        const alpha = Math.min(1, p * 2.5);
        // Scaled about the centre, the texture coordinates staying with the unscaled corners --
        // the 2D version's ctx.scale moves the path and the image together, which is this.
        const q = tr.p.map(([x, y]) => [tr.cx + (x - tr.cx) * s, tr.cy + (y - tr.cy) * s]);
        for (let k = 0; k < 3; k++) put(q[k][0], q[k][1], uOf(tr.p[k][0]), vOf(tr.p[k][1]), alpha, 0);
        // The glint: each edge a quad glintWidth wide, extended half a width past each corner so
        // the corners close (the 2D stroke's round joins).
        if (p < 1 && glintWidth > 0) {
          const ga = (1 - p) * 0.9;
          for (let k = 0; k < 3; k++) {
            const [ax, ay] = q[k];
            const [bx, by] = q[(k + 1) % 3];
            const len = Math.hypot(bx - ax, by - ay) || 1;
            const dx = ((bx - ax) / len) * hw;
            const dy = ((by - ay) / len) * hw;
            const x0 = ax - dx;
            const y0 = ay - dy;
            const x1 = bx + dx;
            const y1 = by + dy;
            const nx = -dy;
            const ny = dx;
            put(x0 + nx, y0 + ny, 0, 0, ga, 1);
            put(x1 + nx, y1 + ny, 0, 0, ga, 1);
            put(x1 - nx, y1 - ny, 0, 0, ga, 1);
            put(x0 + nx, y0 + ny, 0, 0, ga, 1);
            put(x1 - nx, y1 - ny, 0, 0, ga, 1);
            put(x0 - nx, y0 - ny, 0, 0, ga, 1);
          }
        }
      }
      gl.viewport(0, 0, W, H);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.uniform2f(loc.size, W, H);
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, data.subarray(0, n), gl.DYNAMIC_DRAW);
      gl.drawArrays(gl.TRIANGLES, 0, n / 6);
    },
    clear() {
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
    },
    dispose() {
      gl.deleteTexture(texture);
      gl.deleteTexture(maskTexture);
      gl.deleteBuffer(buffer);
      gl.deleteProgram(program);
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    }
  };
}
