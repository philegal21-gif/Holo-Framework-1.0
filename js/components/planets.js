/**
 * Mini-Planeten für das Orbit-Menü.
 *
 * Jede App bekommt eine prozedural erzeugte Oberflächen-Textur (Canvas, nahtlos
 * in der Breite), die als Hintergrund langsam durch die Kugel läuft. Licht und
 * Schatten kommen per CSS (siehe orbit.css, .orbit-planet).
 */

const W = 256;
const H = 128;

/* ---------- Rauschen (Value-Noise, in x nahtlos) ---------- */

const hash = (x, y, s) => {
  let h = (x * 374761393 + y * 668265263 + s * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};
const smooth = (t) => t * t * (3 - 2 * t);

const vnoise = (x, y, s, px) => {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const wrap = (i) => ((i % px) + px) % px;
  const a = hash(wrap(xi), yi, s);
  const b = hash(wrap(xi + 1), yi, s);
  const c = hash(wrap(xi), yi + 1, s);
  const d = hash(wrap(xi + 1), yi + 1, s);
  const u = smooth(xf);
  const v = smooth(yf);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
};

const fbm = (x, y, s, baseP, oct = 5) => {
  let amp = 0.5;
  let f = 1;
  let sum = 0;
  let norm = 0;
  for (let i = 0; i < oct; i++) {
    sum += amp * vnoise(x * f, y * f, s + i * 17, baseP * f);
    norm += amp;
    amp *= 0.5;
    f *= 2;
  }
  return sum / norm;
};

const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const step = (e0, e1, x) => {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/* ---------- Oberflächen-Arten ---------- */

const PAINT = {
  // Blaue Ozeanwelt mit Kontinenten, Wolken und Polkappen
  ocean(u, v, s) {
    const h = fbm(u, v, s, 4);
    const land = step(0.53, 0.58, h);
    const sea = mix([8, 36, 104], [28, 88, 170], fbm(u, v, s + 3, 4));
    const ground = mix([64, 122, 70], [156, 136, 86], fbm(u * 1.7, v * 1.7, s + 5, 4));
    let c = mix(sea, ground, land);
    const cloud = step(0.56, 0.78, fbm(u + 3, v * 1.3, s + 9, 4)) * 0.85;
    c = mix(c, [246, 248, 252], cloud);
    const pole = step(0.9, 1.0, Math.abs(v / 2 - 0.5) * 2);
    return mix(c, [240, 246, 250], pole);
  },

  // Gasriese mit Bändern (Teal und Creme)
  gas(u, v, s) {
    const warp = fbm(u, v * 2, s, 4) * 3.6;
    const b = Math.sin(v * Math.PI * 4.5 + warp) * 0.5 + 0.5;
    const c = mix([54, 118, 132], [228, 214, 186], b);
    const fine = fbm(u * 3, v * 6, s + 2, 8) - 0.5;
    return mix(c, fine > 0 ? [255, 255, 255] : [20, 50, 60], Math.abs(fine) * 0.7);
  },

  // Grüner, erdiger Planet
  terra(u, v, s) {
    const h = fbm(u, v, s, 4);
    const c = mix([38, 88, 52], [112, 142, 72], h);
    const dry = step(0.55, 0.7, fbm(u * 1.5, v * 1.5, s + 4, 4));
    return mix(c, [150, 120, 80], dry * 0.8);
  },

  // Rostroter Wüstenplanet
  mars(u, v, s) {
    const h = fbm(u, v, s, 4);
    const c = mix([104, 46, 32], [196, 98, 58], h);
    const dark = step(0.5, 0.36, fbm(u * 1.6, v * 1.6, s + 6, 4));
    const pole = step(0.93, 1.0, Math.abs(v / 2 - 0.5) * 2);
    return mix(mix(c, [70, 30, 24], dark * 0.6), [240, 232, 226], pole);
  },

  // Goldener Planet mit verwirbelten Bändern
  gold(u, v, s) {
    const warp = fbm(u * 1.5, v * 3, s, 6) * 4.2;
    const b = Math.sin(v * Math.PI * 6 + warp) * 0.5 + 0.5;
    return mix([196, 140, 56], [250, 232, 168], b);
  },

  // Violetter Wirbelplanet (verzerrtes Rauschen)
  violet(u, v, s) {
    const wu = u + fbm(u, v, s + 1, 4) * 2.2;
    const wv = v + fbm(u, v, s + 2, 4) * 2.2;
    const n = fbm(wu, wv, s + 3, 4);
    const c = mix([44, 22, 104], [196, 112, 226], n);
    return mix(c, [255, 190, 240], step(0.62, 0.8, fbm(u * 2, v * 2, s + 8, 4)) * 0.6);
  },

  // Grauer Mond (Krater folgen danach)
  moon(u, v, s) {
    const h = fbm(u, v, s, 4);
    return mix([112, 108, 104], [186, 182, 174], h);
  }
};

const CRATERS = { moon: 26, mars: 10 };

const drawCraters = (ctx, n, s) => {
  for (let i = 0; i < n; i++) {
    const x = hash(i, 1, s) * W;
    const y = 10 + hash(i, 2, s) * (H - 20);
    const r = 3 + Math.pow(hash(i, 3, s), 2) * 11;
    for (const dx of [-W, 0, W]) {   // nahtlos über den Rand
      const g = ctx.createRadialGradient(x + dx, y, r * 0.15, x + dx, y, r);
      g.addColorStop(0, 'rgba(20,18,16,0.38)');
      g.addColorStop(0.78, 'rgba(20,18,16,0.22)');
      g.addColorStop(0.92, 'rgba(255,250,240,0.30)');
      g.addColorStop(1, 'rgba(255,250,240,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x + dx, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }
};

/** Liefert eine Data-URL der Textur (nahtlos in x). */
export function makePlanetTexture(kind, seed = 1) {
  const paint = PAINT[kind];
  if (!paint) return null;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(W, H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const u = (x / W) * 4;          // 4 Zellen rund um den Planeten
      const v = (y / H) * 2;
      const [r, g, b] = paint(u, v, seed);
      const i = (y * W + x) * 4;
      img.data[i] = r;
      img.data[i + 1] = g;
      img.data[i + 2] = b;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  if (CRATERS[kind]) drawCraters(ctx, CRATERS[kind], seed);
  return canvas.toDataURL('image/png');
}

/**
 * Aussehen je Projekt: Oberfläche, Größe (Faktor), Drehdauer (s), Randlicht
 * (Atmosphäre, RGB) und optional ein Ring.
 */
export const PLANET_STYLE = {
  carousel:  { kind: 'gas',    seed: 3,  size: 1.08, spin: 120, rim: '110, 190, 200', base: '#3a7684' },
  sphere:    { kind: 'ocean',  seed: 11, size: 1.0,  spin: 95,  rim: '120, 170, 255', base: '#1e56a4' },
  nfl:       { kind: 'terra',  seed: 21, size: 0.96, spin: 110, rim: '150, 220, 160', base: '#3a6a3c' },
  watchtime: { kind: 'mars',   seed: 31, size: 0.92, spin: 140, rim: '255, 170, 120', base: '#9c4a2e' },
  favorites: { kind: 'gold',   seed: 41, size: 0.86, spin: 100, rim: '255, 220, 140', base: '#c8943c', ring: true },
  neural:    { kind: 'violet', seed: 51, size: 1.02, spin: 85,  rim: '210, 150, 255', base: '#6a3aa8' },
  notes:     { kind: 'moon',   seed: 61, size: 0.8,  spin: 160, rim: '220, 220, 215', base: '#8e8a84' },
  add:       { kind: null,     seed: 0,  size: 0.9,  spin: 0,   rim: '160, 170, 176', base: 'transparent' }
};
