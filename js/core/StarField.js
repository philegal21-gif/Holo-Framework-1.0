/**
 * Dezenter Sternenhimmel als Hintergrund-Canvas.
 *
 * - Funkelnde Sterne, die langsam driften
 * - Feine Verbindungslinien zwischen nahen Sternen ("Sternbilder")
 * - Die Maus schiebt Sterne sanft weg und verbindet sich mit ihnen
 *
 * Farben aus der Framework-Palette. Schärfe auf HiDPI-Displays über
 * devicePixelRatio, Bewegung zeitbasiert (gleich schnell auf 60/120/144 Hz).
 */

const COLORS = {
  stars: [
    [255, 255, 255],   // Weiß
    [205, 211, 214],   // --silver-bright
    [92, 160, 171],     // --accent-light
    [140, 196, 206]    // helles Petrol
  ],
  line: '92, 160, 171',
  mouseLine: '92, 160, 171',
  aura: '92, 160, 171'
};

const CONFIG = {
  maxParticles: 90,
  areaPerParticle: 14000,  // px² pro Stern → Dichte skaliert mit Bildschirmgröße
  baseSpeed: 0.35,         // px pro Frame bei 60 fps
  maxDistance: 110,        // Linien zwischen Sternen bis zu dieser Distanz
  mouseRadius: 140,
  lineAlpha: 0.12,
  mouseLineAlpha: 0.28,
  auraAlpha: 0.06
};

export class StarField {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.particles = [];
    this.width = 0;
    this.height = 0;
    this.dpr = 1;
    this.mouse = { x: 0, y: 0, active: false };
    this.showConstellations = true;
    this.speed = 1;
    this._raf = null;
    this._last = 0;
    this._reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    // Leuchtender Stern als vorgerenderte Grafik – shadowBlur pro Frame wäre teuer
    this._glowSprites = COLORS.stars.map(c => this._makeGlow(c));

    this._resize();
    this._init();
    this._bind();
    this._raf = requestAnimationFrame(t => this._frame(t));
  }

  _makeGlow([r, g, b]) {
    const size = 32;
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const g2 = c.getContext('2d');
    const grad = g2.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    grad.addColorStop(0, `rgba(${r}, ${g}, ${b}, 0.55)`);
    grad.addColorStop(0.35, `rgba(${r}, ${g}, ${b}, 0.18)`);
    grad.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0)`);
    g2.fillStyle = grad;
    g2.fillRect(0, 0, size, size);
    return c;
  }

  _resize() {
    const oldW = this.width;
    const oldH = this.height;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.width = window.innerWidth;
    this.height = window.innerHeight;
    this.canvas.width = Math.round(this.width * this.dpr);
    this.canvas.height = Math.round(this.height * this.dpr);
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

    // Bestehende Sterne proportional mitskalieren statt neu zu würfeln
    if (oldW && oldH) {
      const sx = this.width / oldW;
      const sy = this.height / oldH;
      this.particles.forEach(p => { p.x *= sx; p.y *= sy; });
      this._adjustCount();
    }
  }

  _targetCount() {
    const byArea = Math.floor((this.width * this.height) / CONFIG.areaPerParticle);
    return Math.max(40, Math.min(byArea, CONFIG.maxParticles));
  }

  _spawn() {
    const colorIndex = Math.floor(Math.random() * COLORS.stars.length);
    return {
      x: Math.random() * this.width,
      y: Math.random() * this.height,
      size: Math.random() * 1.8 + 0.6,
      baseAlpha: Math.random() * 0.45 + 0.2,
      vx: (Math.random() - 0.5) * CONFIG.baseSpeed,
      vy: (Math.random() - 0.5) * CONFIG.baseSpeed,
      colorIndex,
      rgb: COLORS.stars[colorIndex].join(', '),
      twinkleSpeed: Math.random() * 1.2 + 0.4,     // rad/s
      twinkleOffset: Math.random() * Math.PI * 2
    };
  }

  _init() {
    this.particles = [];
    const n = this._targetCount();
    for (let i = 0; i < n; i++) this.particles.push(this._spawn());
  }

  _adjustCount() {
    const n = this._targetCount();
    while (this.particles.length < n) this.particles.push(this._spawn());
    if (this.particles.length > n) this.particles.length = n;
  }

  _bind() {
    let resizeT = null;
    window.addEventListener('resize', () => {
      clearTimeout(resizeT);
      resizeT = setTimeout(() => this._resize(), 120);
    });

    window.addEventListener('mousemove', (e) => {
      this.mouse.x = e.clientX;
      this.mouse.y = e.clientY;
      this.mouse.active = true;
    }, { passive: true });

    document.addEventListener('mouseleave', () => { this.mouse.active = false; });

    window.addEventListener('touchmove', (e) => {
      if (!e.touches.length) return;
      this.mouse.x = e.touches[0].clientX;
      this.mouse.y = e.touches[0].clientY;
      this.mouse.active = true;
    }, { passive: true });

    window.addEventListener('touchend', () => { this.mouse.active = false; }, { passive: true });
  }

  _frame(now) {
    this._raf = requestAnimationFrame(t => this._frame(t));

    // Zeitbasiert: k = 1 entspricht einem 60-fps-Frame
    const dt = this._last ? Math.min(50, now - this._last) : 16.67;
    this._last = now;
    const k = this._reduced ? 0 : (dt / 16.67) * this.speed;
    const t = now / 1000;

    const { ctx, width, height, mouse } = this;
    ctx.clearRect(0, 0, width, height);

    const R = CONFIG.mouseRadius;
    const mouseOn = mouse.active && !this._reduced;

    for (const p of this.particles) {
      // Bewegung + Wrap an den Rändern
      p.x += p.vx * k;
      p.y += p.vy * k;
      if (p.x < 0) p.x += width;
      else if (p.x > width) p.x -= width;
      if (p.y < 0) p.y += height;
      else if (p.y > height) p.y -= height;

      // Maus schiebt Sterne sanft weg
      if (mouseOn) {
        const dx = mouse.x - p.x;
        const dy = mouse.y - p.y;
        const distSq = dx * dx + dy * dy;
        if (distSq < R * R && distSq > 0.01) {
          const dist = Math.sqrt(distSq);
          const force = (R - dist) / R;
          p.x -= (dx / dist) * force * 1.5 * k;
          p.y -= (dy / dist) * force * 1.5 * k;
        }
      }

      // Funkeln
      const alpha = Math.max(0.08, Math.min(1,
        p.baseAlpha + Math.sin(t * p.twinkleSpeed + p.twinkleOffset) * 0.22));

      // Größere Sterne bekommen einen weichen Schein
      if (p.size > 1.5) {
        const g = p.size * 6;
        ctx.globalAlpha = alpha * 0.8;
        ctx.drawImage(this._glowSprites[p.colorIndex], p.x - g / 2, p.y - g / 2, g, g);
      }

      ctx.globalAlpha = alpha;
      ctx.fillStyle = `rgb(${p.rgb})`;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    if (this.showConstellations) this._drawLines(mouseOn);
  }

  _drawLines(mouseOn) {
    const { ctx, particles, mouse } = this;
    const maxD = CONFIG.maxDistance;
    const maxDSq = maxD * maxD;
    const R = CONFIG.mouseRadius;

    ctx.lineWidth = 0.5;
    for (let i = 0; i < particles.length; i++) {
      const a = particles[i];
      for (let j = i + 1; j < particles.length; j++) {
        const b = particles[j];
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        const dSq = dx * dx + dy * dy;
        if (dSq >= maxDSq) continue;
        const o = (1 - Math.sqrt(dSq) / maxD) * CONFIG.lineAlpha;
        ctx.strokeStyle = `rgba(${COLORS.line}, ${o.toFixed(3)})`;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
    }

    if (!mouseOn) return;

    ctx.lineWidth = 0.75;
    for (const p of particles) {
      const dx = p.x - mouse.x;
      const dy = p.y - mouse.y;
      const dSq = dx * dx + dy * dy;
      if (dSq >= R * R) continue;
      const o = (1 - Math.sqrt(dSq) / R) * CONFIG.mouseLineAlpha;
      ctx.strokeStyle = `rgba(${COLORS.mouseLine}, ${o.toFixed(3)})`;
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(mouse.x, mouse.y);
      ctx.stroke();
    }

    // Weicher Lichthof um den Cursor
    const grad = ctx.createRadialGradient(mouse.x, mouse.y, 0, mouse.x, mouse.y, R);
    grad.addColorStop(0, `rgba(${COLORS.aura}, ${CONFIG.auraAlpha})`);
    grad.addColorStop(1, `rgba(${COLORS.aura}, 0)`);
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(mouse.x, mouse.y, R, 0, Math.PI * 2);
    ctx.fill();
  }

  /** Schneller / normal – wie "Geschwindigkeit anpassen" im Original. */
  toggleSpeed() { this.speed = this.speed === 1 ? 2.5 : 1; }

  /** Sternbild-Linien an/aus. */
  toggleConstellations() { this.showConstellations = !this.showConstellations; }

  destroy() {
    cancelAnimationFrame(this._raf);
  }
}
