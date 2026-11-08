// Procedural theatre dressing for the landing hero: velvet curtain texture
// (pleats, sheen, grain) and a swagged valance with gold fringe and tassels.
// Pure canvas, no image assets.

const lerp = (a, b, t) => a + (b - a) * t;
const mix = (c1, c2, t) => c1.map((v, i) => lerp(v, c2[i], t));
const rnd = (() => { let s = 7; return () => ((s = (s * 16807) % 2147483647) / 2147483647); })();

/** Velvet curtain: vertical pleats lit from the upper left. Returns a data URL. */
export function velvetTexture(w = 720, h = 1000) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  const img = g.createImageData(w, h);
  const d = img.data;

  // irregular pleat widths, like real fabric
  // widths are rescaled to sum to exactly w so the texture tiles without a seam
  const widths = [];
  for (let sum = 0; sum < w;) { const fw = 34 + rnd() * 34; widths.push(fw); sum += fw; }
  const scale = w / widths.reduce((a, b) => a + b, 0);
  const folds = [];
  for (let i = 0, x = 0; i < widths.length; i++) { const fw = widths[i] * scale; folds.push([x, fw, 0]); x += fw; }
  const foldAt = (x) => { for (const f of folds) if (x < f[0] + f[1]) return f; return folds[folds.length - 1]; };

  const deep = [28, 3, 8], base = [92, 12, 26], lit = [176, 32, 52], sheen = [235, 120, 140];

  for (let y = 0; y < h; y++) {
    const v = y / h;
    // darker under the valance and toward the floor, brightest a third of the way down
    const vert = 0.55 + 0.45 * Math.max(0, 1 - Math.abs(v - 0.36) * 1.5);
    for (let x = 0; x < w; x++) {
      const f = foldAt(x);
      // pleats drift a little as they fall
      const xx = x + Math.sin(y * 0.006) * 3 * Math.sin(Math.PI * x / w); // zero at both tile edges
      const t = ((xx - f[0]) / f[1] + 1) % 1;
      const ridge = 0.5 - 0.5 * Math.cos(Math.PI * 2 * t); // 0 in the valley, 1 on the ridge
      const lean = 0.78 + 0.22 * Math.sin(Math.PI * 2 * t - 1.1); // light from the left
      let s = Math.pow(ridge, 1.4) * lean;
      let col = s < 0.5 ? mix(deep, base, s * 2) : mix(base, lit, (s - 0.5) * 2);
      const glint = Math.pow(ridge, 10) * 0.55 * vert; // velvet sheen on the crests
      col = mix(col, sheen, glint);
      const grain = (rnd() - 0.5) * 14; // pile texture
      const k = vert;
      const i = (y * w + x) * 4;
      d[i] = Math.max(0, col[0] * k + grain);
      d[i + 1] = Math.max(0, col[1] * k + grain * 0.3);
      d[i + 2] = Math.max(0, col[2] * k + grain * 0.4);
      d[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);

  // soft shadow under the valance and a hem at the bottom
  let gr = g.createLinearGradient(0, 0, 0, 160);
  gr.addColorStop(0, 'rgba(0,0,0,.75)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = gr; g.fillRect(0, 0, w, 160);
  gr = g.createLinearGradient(0, h - 90, 0, h);
  gr.addColorStop(0, 'rgba(0,0,0,0)'); gr.addColorStop(1, 'rgba(0,0,0,.6)');
  g.fillStyle = gr; g.fillRect(0, h - 90, w, 90);
  return c.toDataURL('image/jpeg', 0.9);
}

/** Swagged valance across the whole width, drawn into an existing canvas. */
export function drawValance(cv) {
  const dpr = Math.min(devicePixelRatio || 1, 2);
  const W = cv.clientWidth, H = cv.clientHeight;
  cv.width = W * dpr; cv.height = H * dpr;
  const g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, W, H);

  const rail = 16, depth = H - rail - 34;
  const n = Math.max(3, Math.round(W / 230));
  const sw = W / n;

  // swags, drawn back-to-front so each overlaps its neighbour a little
  for (let i = 0; i < n; i++) {
    const x0 = i * sw - sw * 0.08, x1 = (i + 1) * sw + sw * 0.08, mid = (x0 + x1) / 2;
    const bottom = rail + depth;
    const swag = (dd) => {
      g.beginPath();
      g.moveTo(x0, rail);
      g.lineTo(x1, rail);
      g.bezierCurveTo(x1 - sw * 0.06, rail + dd * 0.55, mid + sw * 0.28, rail + dd, mid, rail + dd);
      g.bezierCurveTo(mid - sw * 0.28, rail + dd, x0 + sw * 0.06, rail + dd * 0.55, x0, rail);
      g.closePath();
    };
    // body
    swag(depth);
    let gr = g.createLinearGradient(0, rail, 0, bottom);
    gr.addColorStop(0, '#3a0710'); gr.addColorStop(0.55, '#8e1b2c'); gr.addColorStop(1, '#4a0b15');
    g.fillStyle = gr; g.fill();
    // nested folds: alternating light ridges and dark valleys
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
    // side shading so each swag looks rounded
    g.save(); swag(depth); g.clip();
    gr = g.createLinearGradient(x0, 0, x1, 0);
    gr.addColorStop(0, 'rgba(0,0,0,.5)'); gr.addColorStop(0.3, 'rgba(0,0,0,0)'); gr.addColorStop(0.7, 'rgba(0,0,0,0)'); gr.addColorStop(1, 'rgba(0,0,0,.55)');
    g.fillStyle = gr; g.fillRect(x0, rail, x1 - x0, depth);
    g.restore();

    // gold fringe along the hem
    for (let t = 0.02; t < 0.98; t += 0.008) {
      // point on the lower curve (approximate with the same beziers)
      const u = t < 0.5 ? t * 2 : (t - 0.5) * 2;
      const bz = (p0, p1, p2, p3, s) => (1 - s) ** 3 * p0 + 3 * (1 - s) ** 2 * s * p1 + 3 * (1 - s) * s * s * p2 + s ** 3 * p3;
      const px = t < 0.5 ? bz(x0, x0 + sw * 0.06, mid - sw * 0.28, mid, u) : bz(mid, mid + sw * 0.28, x1 - sw * 0.06, x1, u);
      const py = t < 0.5 ? bz(rail, rail + depth * 0.55, rail + depth, rail + depth, u) : bz(rail + depth, rail + depth, rail + depth * 0.55, rail, u);
      const len = 9 + rnd() * 3;
      gr = g.createLinearGradient(px, py, px, py + len);
      gr.addColorStop(0, '#f3d58d'); gr.addColorStop(1, 'rgba(160,110,40,.2)');
      g.strokeStyle = gr; g.lineWidth = 1.1;
      g.beginPath(); g.moveTo(px, py - 1); g.lineTo(px + (rnd() - 0.5) * 1.5, py + len); g.stroke();
    }
    // braid on the hem
    g.save(); swag(depth); g.strokeStyle = '#c9a24f'; g.lineWidth = 2.5; g.stroke(); g.restore();
  }

  // tassels where swags meet
  for (let i = 0; i <= n; i++) {
    const x = i * sw, top = rail + 4;
    const gr = g.createLinearGradient(x - 6, 0, x + 6, 0);
    gr.addColorStop(0, '#8a6424'); gr.addColorStop(0.5, '#f6e0a4'); gr.addColorStop(1, '#8a6424');
    g.fillStyle = gr;
    g.beginPath(); g.ellipse(x, top + 10, 7, 9, 0, 0, Math.PI * 2); g.fill(); // knot
    g.beginPath(); g.moveTo(x - 4, top + 17); g.lineTo(x + 4, top + 17); g.lineTo(x + 9, top + 52); g.lineTo(x - 9, top + 52); g.closePath(); g.fill(); // skirt
    g.strokeStyle = 'rgba(90,60,20,.6)'; g.lineWidth = 0.8;
    for (let k = -8; k <= 8; k += 2) { g.beginPath(); g.moveTo(x + k * 0.45, top + 19); g.lineTo(x + k, top + 52); g.stroke(); }
  }

  // gilded rail with dentils
  let gr = g.createLinearGradient(0, 0, 0, rail);
  gr.addColorStop(0, '#6b4a18'); gr.addColorStop(0.35, '#f6e0a4'); gr.addColorStop(0.7, '#c9a24f'); gr.addColorStop(1, '#5a3c12');
  g.fillStyle = gr; g.fillRect(0, 0, W, rail);
  g.fillStyle = 'rgba(60,35,10,.45)';
  for (let x = 4; x < W; x += 14) g.fillRect(x, rail - 6, 6, 4);
}

export function dressStage() {
  const tex = velvetTexture();
  document.querySelectorAll('.cur').forEach((el) => { el.style.backgroundImage = `url(${tex})`; });
  const cv = document.getElementById('valance');
  if (cv) {
    drawValance(cv);
    let t; addEventListener('resize', () => { clearTimeout(t); t = setTimeout(() => drawValance(cv), 120); });
  }
}
