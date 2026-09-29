/**
 * Zeichnet die beiden Hintergrund-Verläufe (#bg-base, #bg-breath) per Canvas.
 *
 * Warum nicht per CSS? Die Verläufe sind sehr dunkel – in 8 Bit bleiben nur
 * eine Handvoll Helligkeitsstufen, die als Ringe sichtbar werden (Banding).
 * Hier bekommt jedes Pixel ein Rauschen von ±1 Stufe, bevor gerundet wird.
 * Das verteilt die Stufen unsichtbar, statt sichtbare Körnung darüberzulegen.
 *
 * Gezeichnet wird einmal beim Start und nach Größenänderungen. Das Atmen
 * von #bg-breath bleibt eine reine CSS-Animation (opacity/transform).
 */

// Grundverlauf: Ellipse 90 % × 70 % um (50 %, 45 %), Teal → Schwarz
const BASE_STOPS = [
  [0.00, 0, 22, 25],
  [0.12, 0, 21, 24],
  [0.25, 0, 18, 21],
  [0.37, 0, 15, 17],
  [0.50, 0, 11, 13],
  [0.62, 0, 8, 9],
  [0.75, 0, 5, 6],
  [0.87, 0, 2, 3],
  [1.00, 0, 0, 0]
];

// Atmender Kern: Gauß-Abfall, am Kreisrand exakt 0
const BREATH_COLOR = [0, 210, 180];
const BREATH_PEAK = 0.10;
const BREATH_K = 3.2;

function sampleStops(stops, t) {
  if (t >= 1) return stops[stops.length - 1];
  let i = 1;
  while (stops[i][0] < t) i++;
  const [t0, r0, g0, b0] = stops[i - 1];
  const [t1, r1, g1, b1] = stops[i];
  const k = (t - t0) / (t1 - t0);
  return [0, r0 + (r1 - r0) * k, g0 + (g1 - g0) * k, b0 + (b1 - b0) * k];
}

// Dreieck-verteiltes Rauschen (TPDF, ±1 Stufe). Gleichverteiltes ±½ reicht
// nicht: Liegt der Wert fast genau auf einer Stufe, rundet es immer gleich –
// es entstehen flache Plateaus, die wieder als Ringe sichtbar sind.
const dither = (v) =>
  Math.max(0, Math.min(255, Math.round(v + Math.random() - Math.random())));

function sizeCanvas(canvas) {
  // Absichtlich 1:1 zu CSS-Pixeln: ein weicher Verlauf braucht keine
  // HiDPI-Auflösung, und so bleibt das Neuzeichnen schnell.
  const w = Math.max(1, Math.round(canvas.clientWidth));
  const h = Math.max(1, Math.round(canvas.clientHeight));
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  return [w, h];
}

function paintBase(canvas) {
  const [w, h] = sizeCanvas(canvas);
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(w, h);
  const d = img.data;
  const cx = w * 0.5, cy = h * 0.45;
  const rx = w * 0.9, ry = h * 0.7;

  for (let y = 0, i = 0; y < h; y++) {
    const dy = (y + 0.5 - cy) / ry;
    for (let x = 0; x < w; x++, i += 4) {
      const dx = (x + 0.5 - cx) / rx;
      const c = sampleStops(BASE_STOPS, Math.sqrt(dx * dx + dy * dy));
      d[i] = dither(c[1]);
      d[i + 1] = dither(c[2]);
      d[i + 2] = dither(c[3]);
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}

function paintBreath(canvas) {
  const [w, h] = sizeCanvas(canvas);
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(w, h);
  const d = img.data;
  const cx = w / 2, cy = h / 2;
  const r = Math.min(w, h) / 2;
  const edge = Math.exp(-BREATH_K);
  const [cr, cg, cb] = BREATH_COLOR;

  for (let y = 0, i = 0; y < h; y++) {
    const dy = (y + 0.5 - cy) / r;
    for (let x = 0; x < w; x++, i += 4) {
      const dx = (x + 0.5 - cx) / r;
      const u2 = dx * dx + dy * dy;
      if (u2 >= 1) continue;   // außerhalb: transparent (ImageData ist 0)
      const a = BREATH_PEAK * (Math.exp(-BREATH_K * u2) - edge * u2);
      d[i] = cr;
      d[i + 1] = cg;
      d[i + 2] = cb;
      // Über die Deckkraft dithern – sie bestimmt die sichtbare Helligkeit
      d[i + 3] = dither(a * 255);
    }
  }
  ctx.putImageData(img, 0, 0);
}

export class BackgroundGlow {
  constructor(baseCanvas, breathCanvas) {
    this.base = baseCanvas;
    this.breath = breathCanvas;
    this._timer = null;

    this.paint();
    window.addEventListener('resize', () => {
      clearTimeout(this._timer);
      this._timer = setTimeout(() => this.paint(), 150);
    });
  }

  paint() {
    if (this.base) paintBase(this.base);
    if (this.breath) paintBreath(this.breath);
  }
}
