// Theatre dressing for the landing hero, all procedural canvas, no assets and
// no dependencies, so it paints on the first frame (it must not wait for three.js).
//
// - velvetTexture(): a seamless pleated-velvet tile, built column-first so
//   it costs a few milliseconds.
// - Curtains are drawn row by row: each row of fabric is squeezed into that
//   row's curtain width. When the curtain is tied back the pleats really fan
//   in toward the tie and flare out below it, instead of a flat horizontal squash.
// - drawValance(): swagged pelmet with fringe, tassels and a gilded rail.

const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = (t) => Math.max(0, Math.min(1, t));
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
let seed = 7;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

// ------------------------------------------------------------------ velvet

export function velvetTexture(w = 640, h = 900) {
  seed = 7;
  // pleat widths rescaled to sum to exactly w, so the tile repeats seamlessly
  const widths = [];
  for (let s = 0; s < w;) { const fw = 58 + rnd() * 40; widths.push(fw); s += fw; }
  const k = w / widths.reduce((a, b) => a + b, 0);

  // one colour per column: pleat shading and sheen don't depend on y
  const deep = [26, 3, 8], base = [96, 12, 27], lit = [182, 34, 55], sheen = [240, 128, 146];
  const colR = new Float32Array(w), colG = new Float32Array(w), colB = new Float32Array(w), glint = new Float32Array(w);
  for (let i = 0, x0 = 0; i < widths.length; i++) {
    const fw = widths[i] * k;
    for (let x = Math.floor(x0); x < Math.min(w, Math.ceil(x0 + fw)); x++) {
      const t = (x - x0) / fw;
      const ridge = 0.5 - 0.5 * Math.cos(2 * Math.PI * t);
      const s = Math.pow(ridge, 1.35) * (0.78 + 0.22 * Math.sin(2 * Math.PI * t - 1.1));
      const c = s < 0.5 ? [lerp(deep[0], base[0], s * 2), lerp(deep[1], base[1], s * 2), lerp(deep[2], base[2], s * 2)]
        : [lerp(base[0], lit[0], (s - 0.5) * 2), lerp(base[1], lit[1], (s - 0.5) * 2), lerp(base[2], lit[2], (s - 0.5) * 2)];
      colR[x] = c[0]; colG[x] = c[1]; colB[x] = c[2]; glint[x] = Math.pow(ridge, 10);
    }
    x0 += fw;
  }
  const noise = new Float32Array(4096);
  for (let i = 0; i < noise.length; i++) noise[i] = (rnd() - 0.5) * 14;

  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  const img = g.createImageData(w, h), d = img.data;
  for (let y = 0; y < h; y++) {
    const v = y / h;
    const vert = 0.55 + 0.45 * Math.max(0, 1 - Math.abs(v - 0.36) * 1.5);
    const drift = Math.sin(y * 0.006) * 3; // pleats wander slightly as they fall
    for (let x = 0; x < w; x++) {
      const sx = Math.round(x + drift * Math.sin((Math.PI * x) / w)) % w; // zero at tile edges
      const gl = glint[sx] * 0.55 * vert;
      const n = noise[(x * 31 + y * 17) & 4095];
      const i = (y * w + x) * 4;
      d[i] = (colR[sx] + (sheen[0] - colR[sx]) * gl) * vert + n;
      d[i + 1] = (colG[sx] + (sheen[1] - colG[sx]) * gl) * vert + n * 0.3;
      d[i + 2] = (colB[sx] + (sheen[2] - colB[sx]) * gl) * vert + n * 0.4;
      d[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  let gr = g.createLinearGradient(0, 0, 0, 150);
  gr.addColorStop(0, 'rgba(0,0,0,.75)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = gr; g.fillRect(0, 0, w, 150);
  gr = g.createLinearGradient(0, h - 80, 0, h);
  gr.addColorStop(0, 'rgba(0,0,0,0)'); gr.addColorStop(1, 'rgba(0,0,0,.6)');
  g.fillStyle = gr; g.fillRect(0, h - 80, w, 80);
  return c;
}

// ------------------------------------------------------------------ curtains

const TIE = 0.48; // tie height as a fraction of the stage
// Left curtain's leading edge as a fraction of stage width, when tied back.
function openEdge(v) {
  return v <= TIE
    ? 0.105 + 0.075 * Math.pow((TIE - v) / TIE, 0.6)
    : 0.105 + 0.07 * Math.pow((v - TIE) / (1 - TIE), 0.8);
}

function makeCurtains(cv, tex) {
  const g = cv.getContext('2d');
  let W = 0, H = 0, fabric = null, p = 0;

  function resize() {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    W = cv.clientWidth; H = cv.clientHeight;
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    // one curtain's worth of fabric, tiled from the texture
    const F = Math.ceil(W * 0.56);
    fabric = document.createElement('canvas');
    fabric.width = F; fabric.height = tex.height;
    const fg = fabric.getContext('2d');
    for (let x = 0; x < F; x += tex.width) fg.drawImage(tex, x, 0);
    draw();
  }

  const edgeAt = (v) => W * lerp(0.52, openEdge(v), p);

  function curtain() {
    const step = 2, sh = fabric.height / H;
    // fabric rows squeezed into each row's width: pleats converge on the tie
    for (let y = 0; y < H; y += step) {
      const e = edgeAt(y / H);
      g.drawImage(fabric, 0, y * sh, fabric.width, step * sh + 1, 0, y, e, step + 0.5);
    }
    if (p > 0.01) {
      // the gathered fabric bunches up and darkens around the tie
      const ty = H * TIE, te = edgeAt(TIE);
      const gr = g.createRadialGradient(te * 0.6, ty, 0, te * 0.6, ty, H * 0.32);
      gr.addColorStop(0, `rgba(0,0,0,${0.45 * p})`); gr.addColorStop(1, 'rgba(0,0,0,0)');
      g.save(); g.beginPath(); edgePath(); g.clip();
      g.fillStyle = gr; g.fillRect(0, 0, W, H);
      g.restore();
    }
    // depth toward the leading edge
    g.save(); g.beginPath(); edgePath(); g.clip();
    for (let y = 0; y < H; y += 8) {
      const e = edgeAt(y / H);
      const gr = g.createLinearGradient(e - 40, 0, e, 0);
      gr.addColorStop(0, 'rgba(0,0,0,0)'); gr.addColorStop(1, 'rgba(0,0,0,.35)');
      g.fillStyle = gr; g.fillRect(e - 40, y, 40, 8);
    }
    g.restore();
    // gold braid along the leading edge
    g.beginPath();
    for (let y = 0; y <= H; y += 4) { const e = edgeAt(y / H); y ? g.lineTo(e, y) : g.moveTo(e, y); }
    g.strokeStyle = '#d9b25e'; g.lineWidth = 3; g.stroke();
    g.strokeStyle = 'rgba(80,50,15,.6)'; g.lineWidth = 1; g.setLineDash([2, 3]); g.stroke(); g.setLineDash([]);
  }

  function edgePath() {
    g.moveTo(0, 0);
    for (let y = 0; y <= H; y += 4) g.lineTo(edgeAt(y / H), y);
    g.lineTo(0, H); g.closePath();
  }

  function tie() {
    const a = clamp01((p - 0.75) / 0.25);
    if (a <= 0) return;
    const ty = H * TIE, x1 = edgeAt(TIE) + 10;
    g.save(); g.globalAlpha = a;
    // twisted rope wrapped round the gathered curtain
    g.shadowColor = 'rgba(0,0,0,.6)'; g.shadowBlur = 10; g.shadowOffsetY = 5;
    g.lineCap = 'round'; g.lineWidth = 13; g.strokeStyle = '#a07a30';
    g.beginPath(); g.moveTo(-4, ty - 6); g.quadraticCurveTo(x1 * 0.5, ty + 8, x1, ty); g.stroke();
    g.shadowColor = 'transparent';
    g.lineWidth = 3; g.strokeStyle = '#f6e0a4';
    for (let i = -2; i < x1 / 9; i++) {
      const x = i * 9, t = x / x1, yy = (1 - t) * (1 - t) * (ty - 6) + 2 * (1 - t) * t * (ty + 8) + t * t * ty;
      g.beginPath(); g.moveTo(x, yy - 5); g.lineTo(x + 6, yy + 5); g.stroke();
    }
    // tassel
    const gr = g.createLinearGradient(x1 - 9, 0, x1 + 9, 0);
    gr.addColorStop(0, '#7a5418'); gr.addColorStop(0.5, '#f6e0a4'); gr.addColorStop(1, '#7a5418');
    g.fillStyle = gr;
    g.beginPath(); g.ellipse(x1, ty + 4, 9, 10, 0, 0, Math.PI * 2); g.fill();
    g.beginPath(); g.moveTo(x1 - 5, ty + 12); g.lineTo(x1 + 5, ty + 12); g.lineTo(x1 + 12, ty + 62); g.lineTo(x1 - 12, ty + 62); g.closePath(); g.fill();
    g.strokeStyle = 'rgba(90,60,20,.55)'; g.lineWidth = 0.8;
    for (let k = -11; k <= 11; k += 2) { g.beginPath(); g.moveTo(x1 + k * 0.4, ty + 14); g.lineTo(x1 + k, ty + 62); g.stroke(); }
    g.restore();
  }

  function draw() {
    if (!fabric) return;
    g.clearRect(0, 0, W, H);
    for (const mirror of [false, true]) {
      g.save();
      if (mirror) { g.translate(W, 0); g.scale(-1, 1); }
      curtain(); tie();
      g.restore();
    }
  }

  function open(duration = 2400) {
    const t0 = performance.now();
    const frame = (now) => {
      p = ease(clamp01((now - t0) / duration));
      draw();
      if (p < 1) requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }

  resize();
  let rt; addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(resize, 100); });
  return { open, set: (v) => { p = v; draw(); } };
}

// ------------------------------------------------------------------ valance

export function drawValance(cv) {
  seed = 11;
  const dpr = Math.min(devicePixelRatio || 1, 2);
  const W = cv.clientWidth, H = cv.clientHeight;
  cv.width = W * dpr; cv.height = H * dpr;
  const g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, W, H);

  const rail = 16, depth = H - rail - 34;
  const n = Math.max(3, Math.round(W / 230));
  const sw = W / n;
  const bz = (p0, p1, p2, p3, s) => (1 - s) ** 3 * p0 + 3 * (1 - s) ** 2 * s * p1 + 3 * (1 - s) * s * s * p2 + s ** 3 * p3;

  for (let i = 0; i < n; i++) {
    const x0 = i * sw - sw * 0.08, x1 = (i + 1) * sw + sw * 0.08, mid = (x0 + x1) / 2;
    const swag = (dd) => {
      g.beginPath(); g.moveTo(x0, rail); g.lineTo(x1, rail);
      g.bezierCurveTo(x1 - sw * 0.06, rail + dd * 0.55, mid + sw * 0.28, rail + dd, mid, rail + dd);
      g.bezierCurveTo(mid - sw * 0.28, rail + dd, x0 + sw * 0.06, rail + dd * 0.55, x0, rail);
      g.closePath();
    };
    swag(depth);
    let gr = g.createLinearGradient(0, rail, 0, rail + depth);
    gr.addColorStop(0, '#3a0710'); gr.addColorStop(0.55, '#8e1b2c'); gr.addColorStop(1, '#4a0b15');
    g.fillStyle = gr; g.fill();
    for (let k = 5; k >= 1; k--) {
      const dd = depth * (k / 6);
      g.save(); swag(dd); g.clip();
      gr = g.createLinearGradient(0, rail + dd * 0.6, 0, rail + dd);
      gr.addColorStop(0, 'rgba(0,0,0,0)');
      gr.addColorStop(0.7, k % 2 ? 'rgba(210,60,84,.35)' : 'rgba(0,0,0,.35)');
      gr.addColorStop(1, 'rgba(0,0,0,.45)');
      g.fillStyle = gr; g.fillRect(x0, rail, x1 - x0, depth);
      g.restore();
    }
    g.save(); swag(depth); g.clip();
    gr = g.createLinearGradient(x0, 0, x1, 0);
    gr.addColorStop(0, 'rgba(0,0,0,.5)'); gr.addColorStop(0.3, 'rgba(0,0,0,0)'); gr.addColorStop(0.7, 'rgba(0,0,0,0)'); gr.addColorStop(1, 'rgba(0,0,0,.55)');
    g.fillStyle = gr; g.fillRect(x0, rail, x1 - x0, depth);
    g.restore();
    for (let t = 0.02; t < 0.98; t += 0.008) {
      const u = t < 0.5 ? t * 2 : (t - 0.5) * 2;
      const px = t < 0.5 ? bz(x0, x0 + sw * 0.06, mid - sw * 0.28, mid, u) : bz(mid, mid + sw * 0.28, x1 - sw * 0.06, x1, u);
      const py = t < 0.5 ? bz(rail, rail + depth * 0.55, rail + depth, rail + depth, u) : bz(rail + depth, rail + depth, rail + depth * 0.55, rail, u);
      const len = 9 + rnd() * 3;
      gr = g.createLinearGradient(px, py, px, py + len);
      gr.addColorStop(0, '#f3d58d'); gr.addColorStop(1, 'rgba(160,110,40,.2)');
      g.strokeStyle = gr; g.lineWidth = 1.1;
      g.beginPath(); g.moveTo(px, py - 1); g.lineTo(px + (rnd() - 0.5) * 1.5, py + len); g.stroke();
    }
    g.save(); swag(depth); g.strokeStyle = '#c9a24f'; g.lineWidth = 2.5; g.stroke(); g.restore();
  }
  for (let i = 0; i <= n; i++) {
    const x = i * sw, top = rail + 4;
    const gr = g.createLinearGradient(x - 6, 0, x + 6, 0);
    gr.addColorStop(0, '#8a6424'); gr.addColorStop(0.5, '#f6e0a4'); gr.addColorStop(1, '#8a6424');
    g.fillStyle = gr;
    g.beginPath(); g.ellipse(x, top + 10, 7, 9, 0, 0, Math.PI * 2); g.fill();
    g.beginPath(); g.moveTo(x - 4, top + 17); g.lineTo(x + 4, top + 17); g.lineTo(x + 9, top + 52); g.lineTo(x - 9, top + 52); g.closePath(); g.fill();
    g.strokeStyle = 'rgba(90,60,20,.6)'; g.lineWidth = 0.8;
    for (let k = -8; k <= 8; k += 2) { g.beginPath(); g.moveTo(x + k * 0.45, top + 19); g.lineTo(x + k, top + 52); g.stroke(); }
  }
  const gr = g.createLinearGradient(0, 0, 0, rail);
  gr.addColorStop(0, '#6b4a18'); gr.addColorStop(0.35, '#f6e0a4'); gr.addColorStop(0.7, '#c9a24f'); gr.addColorStop(1, '#5a3c12');
  g.fillStyle = gr; g.fillRect(0, 0, W, rail);
  g.fillStyle = 'rgba(60,35,10,.45)';
  for (let x = 4; x < W; x += 14) g.fillRect(x, rail - 6, 6, 4);
}

// ------------------------------------------------------------------ entry

/**
 * Paint curtains + valance right away, then open them.
 * mode: 'animate' (default), 'open' (already open, for screenshots), 'closed'.
 */
export function dressStage(mode = 'animate') {
  const stage = document.getElementById('stage');
  const curtains = makeCurtains(document.getElementById('curtains'), velvetTexture());
  const val = document.getElementById('valance');
  drawValance(val);
  let t; addEventListener('resize', () => { clearTimeout(t); t = setTimeout(() => drawValance(val), 120); });

  performance.mark('curtains-painted');
  if (mode === 'open') { curtains.set(1); stage.classList.add('open'); return; }
  if (mode === 'closed') return;
  setTimeout(() => { stage.classList.add('open'); curtains.open(); }, 350);
}
