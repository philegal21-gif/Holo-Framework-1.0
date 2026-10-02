import { PROJECTS } from '../data/projects.js';
import { ViewManager } from '../core/ViewManager.js';
import { audio } from '../core/AudioEngine.js';
import {
  Mat3, clamp01, easeInCubic, easeOutCubic, easeOutBack, rand, smoothstep, prefersReducedMotion
} from '../core/utils.js';
import { buildEarth, BOOT_EARTH_MS } from './EarthGlobe.js';

// Rotationsmatrix gegen Rundungsdrift wieder orthonormal machen (Gram-Schmidt)
const orthonormalize = (m) => {
  const norm = (v) => {
    const l = Math.hypot(v[0], v[1], v[2]) || 1;
    return [v[0] / l, v[1] / l, v[2] / l];
  };
  const a = norm([m[0], m[1], m[2]]);
  const d = a[0] * m[3] + a[1] * m[4] + a[2] * m[5];
  const b = norm([m[3] - d * a[0], m[4] - d * a[1], m[5] - d * a[2]]);
  const c = [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0]
  ];
  return [...a, ...b, ...c];
};

// Zeitplan der Öffnungsanimation (ms)
const INTRO = {
  charge: 1100,   // Aufladen bis zum Knall
  fly: 950,       // Flugdauer eines Widgets
  stagger: 55     // Versatz zwischen den Widgets
};
const INTRO_REDUCED = { charge: 250, fly: 420, stagger: 0 };

// Zeitplan der Schließanimation (ms)
const OUTRO = {
  fly: 310,       // Flugdauer eines Widgets zurück in die Erde
  stagger: 18     // Versatz zwischen den Widgets
};
const OUTRO_REDUCED = { fly: 150, stagger: 0 };

// Zoom der Erde (Mausrad, Pinch, +/-): Faktor auf die Grundgröße
const ZOOM_MIN = 0.7;
const ZOOM_MAX = 2.6;

export class OrbitMenu {
  constructor(rootEl, options = {}) {
    this.root = rootEl;
    this.onOpenProject = options.onOpenProject || (() => {});
    this.isOpenable = options.isOpenable || (() => false);

    const reducedMotion = prefersReducedMotion();
    // Startsequenz: Erde bleibt leer, bis playStartup() sie aufbaut
    this._bootHold = !!options.startHidden && !reducedMotion;
    this._bootStart = null;

    // Zoom: _zoom = aktueller (animierter) Wert, _zoomBase = Größe, in der das
    // Canvas zuletzt scharf gerendert wurde. Dazwischen skaliert CSS (flüssig),
    // nach kurzer Ruhe wird die Auflösung nachgezogen (_commitZoom).
    this._zoom = 1;
    this._zoomTarget = 1;
    this._zoomBase = 1;
    this._zoomIdleAt = 0;
    this._zoomResetting = false;
    this._zoomWaiters = [];

    // Während des Ein-/Ausflugs in ein Modul bleibt alles stehen (Drehung, Schweben,
    // Parallaxe, Magnet), damit die Scheibe beim Zurückkommen an derselben Stelle liegt
    this._rotFrozen = false;
    this._floatT = 0;

    this._items = [];
    this._toast = null;
    this._toastTimer = null;
    this._paused = false;
    this._rafId = null;
    // Ausrichtung des Orbits als Rotationsmatrix (Trackball) – frei in alle Richtungen
    this._orientation = Mat3.identity();

    this._targetParallaxX = 0;
    this._targetParallaxY = 0;
    this._currentParallaxX = 0;
    this._currentParallaxY = 0;

    this._isDragging = false;
    this._dragLastX = 0;
    this._dragLastY = 0;
    this._dragLastTime = 0;
    // Drehgeschwindigkeit um die Bildschirm-X- und -Y-Achse (rad/ms) für den Schwung
    this._spin = { x: 0, y: 0 };

    this._radiusMin = 300;
    this._radiusMax = 460;

    this._autoRotationSpeed = 0.05;
    this._dragSensitivity = 0.008;
    this._inertiaDecay = 0.94;
    this._baseTiltX = 10;

    this._expanded = false;
    this._transitioning = false;
    this._transitionTimer = null;
    this._intro = null;      // { release, fly } während die Widgets rausfliegen
    this._outro = null;      // { start, fly } während die Widgets zurückfliegen
    this._fxTimers = [];

    this._three = null;
    this._earthGroup = null;
    this._earthRafId = null;

    // Frame-Drosselung für den Widget-RAF-Loop
    this._lastWidgetFrame = 0;
    this._widgetFrameInterval = 1000 / 60; // 60 fps – die Flug-Animation läuft hier mit

    // Dirty-Flag: nur rendern, wenn sich wirklich was ändert
    this._widgetsDirty = true;

    this._build();
    this._bindMouse();
    this._bindDrag();
    this._bindZoom();
    this._bindResize();
    this._bindViewChanges();
    this._startRaf();
  }

  _build() {
    this.root.innerHTML = '';

    const orbit = document.createElement('div');
    orbit.className = 'orbit';
    this._orbit = orbit;
    const cluster = document.createElement('div');
    cluster.className = 'orbit-cluster';
    this._cluster = cluster;
    orbit.appendChild(cluster);
    this.root.appendChild(orbit);

    // Die Erde liegt IM Cluster: So teilt sie sich die Stapel-Ebene mit den
    // Widgets und wird per z-index zwischen vorne (> 1000) und hinten (< 1000)
    // einsortiert. Siehe _applyItemTransform.
    const core = document.createElement('div');
    core.className = 'orbit-core';
    core.title = 'Klicken zum Öffnen';
    this._core = core;

    core.addEventListener('click', (e) => {
      e.stopPropagation();
      if (this._transitioning) return;
      if (this._isDragging) return;
      if (this._expanded) return;
      this.expand();
    });

    const earth = document.createElement('div');
    earth.className = 'orbit-earth';
    this._earthEl = earth;
    core.appendChild(earth);
    cluster.appendChild(core);

    this._buildEarth(earth);

    this._total = PROJECTS.length;
    const n = this._total;
    const goldenAngle = Math.PI * (3 - Math.sqrt(5));

    PROJECTS.forEach((project, i) => {
      // Fibonacci-Kugel: gleichmäßige Verteilung über die Kugelschale.
      // (i + 0.5) hält die Widgets von den Polen fern (y bleibt in ±(1 - 1/n)),
      // dort würden sie sich bei der Rotation kaum bewegen.
      // Bildschirm-y zeigt nach unten → erstes Projekt oben, letztes unten.
      const uy = ((i + 0.5) / n) * 2 - 1;
      const ringScale = Math.sqrt(1 - uy * uy);
      const angle = goldenAngle * i;

      const ux = Math.cos(angle) * ringScale;
      const uz = Math.sin(angle) * ringScale;

      // Alle auf derselben Schale (Mitte zwischen _radiusMin und _radiusMax).
      // Der absolute Radius wird pro Frame berechnet, damit Resize greift.
      const rFactor = 0.5;

      const phase = Math.random() * Math.PI * 2;
      const floatAmp = 6 + Math.random() * 6;
      const floatSpeed = 0.3 + Math.random() * 0.4;

      const item = document.createElement('button');
      item.className = 'orbit-item';
      item.dataset.projectId = project.id;
      item.dataset.target = project.target || 'placeholder';
      item.title = project.name;

      item.innerHTML = `
        <div class="orbit-item-inner">
          <i class="${project.icon}"></i>
          <span class="orbit-item-label">${project.name}</span>
        </div>
      `;

      item.addEventListener('click', (e) => {
        e.stopPropagation();
        if (this._isDragging) return;
        if (!this._expanded || this._transitioning) return;
        this._handleClick(project, item);
      });

      item.addEventListener('mouseenter', () => { this._paused = true; });
      item.addEventListener('mouseleave', () => { this._paused = false; });

      cluster.appendChild(item);

      this._items.push({
        el: item,
        project,
        ux, uy, uz,
        rFactor,
        phase,
        floatAmp,
        floatSpeed,
        warping: false
      });
    });

    this._toast = document.createElement('div');
    this._toast.id = 'orbit-toast';
    this.root.appendChild(this._toast);
  }

  /**
   * Projiziert ein Item (inkl. optionalem Schweben) mit aktueller Rotation & Neigung.
   * extraRot dreht das Item zusätzlich um die Y-Achse (Spirale beim Rausfliegen).
   */
  _projectItem(item, floatY = 0, floatZ = 0, extraRot = 0) {
    const r = this._radiusMin + item.rFactor * (this._radiusMax - this._radiusMin);
    const x0 = item.ux * r;
    const y0 = item.uy * r + floatY;
    const z0 = item.uz * r + floatZ;

    // Spirale beim Rausfliegen: vorab um die eigene Y-Achse drehen
    let lx = x0;
    let lz = z0;
    if (extraRot) {
      const c = Math.cos(extraRot);
      const s = Math.sin(extraRot);
      lx = x0 * c + z0 * s;
      lz = -x0 * s + z0 * c;
    }

    // Ausrichtung des Orbits (frei drehbar)
    const [x1, y1, z1] = Mat3.transformPoint(this._orientation, [lx, y0, lz]);

    // Blickneigung (Grundneigung + Maus-Parallax) obendrauf
    const tiltXRad = ((this._currentParallaxX + this._baseTiltX) * Math.PI) / 180;
    const cosX = Math.cos(tiltXRad);
    const sinX = Math.sin(tiltXRad);

    return {
      x: x1,
      y: y1 * cosX - z1 * sinX,
      z: y1 * sinX + z1 * cosX
    };
  }

  /**
   * Dreht den Orbit um eine Achse in der Bildschirmebene (Trackball):
   * wx = Winkel um die X-Achse (hoch/runter), wy = um die Y-Achse (links/rechts).
   */
  _rotateScreen(wx, wy) {
    const angle = Math.hypot(wx, wy);
    if (angle < 1e-7) return;
    const r = Mat3.fromAxisAngle([wx, wy, 0], angle);
    this._orientation = orthonormalize(Mat3.multiply(r, this._orientation));
  }

  _applyItemTransform(el, p, scaleMul = 1, fade = 1, fx = null) {
    const depthNorm = Math.max(-1, Math.min(1, p.z / this._radiusMax));
    const scale = (0.7 + (depthNorm + 1) * 0.5 * 0.3) * scaleMul;
    const opacity = (0.35 + (depthNorm + 1) * 0.5 * 0.65) * fade;

    // Magnet: Verschiebung weg von der Maus (Dock-Effekt)
    const ox = fx ? fx.dx : 0;
    const oy = fx ? fx.dy : 0;

    el.style.transform =
      `translate3d(${(p.x + ox).toFixed(2)}px, ${(p.y + oy).toFixed(2)}px, ${p.z.toFixed(2)}px) ` +
      `scale(${scale.toFixed(3)})`;
    // Als CSS-Variable, damit Placeholder/Empty-Dimmung im CSS weiter greift
    el.style.setProperty('--depth-opacity', opacity.toFixed(3));
    // Tiefensortierung: Die Erde hat z-index 1000 (= Tiefe 0). Vordere Widgets
    // liegen darüber, hintere darunter und werden von ihr verdeckt.
    el.style.zIndex = String(Math.round(1000 + p.z + (fx ? fx.mag * 40 : 0)));

    // Glanzlicht wandert zur Maus (Prozent innerhalb der Kugel)
    if (fx) {
      el.style.setProperty('--hx', fx.hx.toFixed(1));
      el.style.setProperty('--hy', fx.hy.toFixed(1));
    }

    // Rückseite: weich abdunkeln, sobald das Widget hinter die Erde wandert,
    // und dort nicht mehr anwählbar machen.
    const R = (this._radiusMin + this._radiusMax) / 2;
    const behind = smoothstep(0.05, -0.45, p.z / R);
    el.style.setProperty('--behind', behind.toFixed(3));
    el.classList.toggle('is-behind', p.z < -R * 0.1);

    // Tiefenschärfe: je weiter hinten, desto unschärfer (in 0,5-px-Schritten)
    el.style.setProperty('--dof-px', (Math.round(behind * 3.2 * 2) / 2).toFixed(1) + 'px');
  }

  /**
   * Magnet-Effekt: Kugel nahe der Maus wächst und tritt nach vorn, die anderen
   * weichen leicht aus; das Glanzlicht blickt zur Maus. Werte werden weich
   * nachgeführt (item.mag / hx / hy).
   */
  _magnetFor(item, p, center) {
    // Eingefroren: Zustand von vorhin behalten, nichts nachführen
    if (this._rotFrozen && item._fxLast) return item._fxLast;

    const m = this._mouse;
    const persp = 1100;
    const f = persp / Math.max(200, persp - p.z);
    const sx = center.x + p.x * f;
    const sy = center.y + p.y * f;

    const usable = m && m.active && !this._isDragging && this._canMagnet(p);
    const dxm = usable ? m.x - sx : 0;
    const dym = usable ? m.y - sy : 0;
    const d = Math.hypot(dxm, dym);

    const targetMag = usable ? Math.exp(-Math.pow(d / 120, 2)) : 0;
    const targetHx = usable ? 50 + Math.max(-1, Math.min(1, dxm / 90)) * 24 : 34;
    const targetHy = usable ? 50 + Math.max(-1, Math.min(1, dym / 90)) * 24 : 26;

    item.mag = (item.mag ?? 0) + (targetMag - (item.mag ?? 0)) * 0.2;
    item.hx = (item.hx ?? 34) + (targetHx - (item.hx ?? 34)) * 0.25;
    item.hy = (item.hy ?? 26) + (targetHy - (item.hy ?? 26)) * 0.25;

    // Andere weichen aus: Richtung weg von der Maus, nahe Kugel bleibt stehen
    const push = usable && d > 1
      ? 14 * Math.exp(-Math.pow(d / 190, 2)) * (1 - item.mag)
      : 0;
    const dx = push ? (-dxm / d) * push : 0;
    const dy = push ? (-dym / d) * push : 0;

    // Solange etwas nachläuft, weiter rendern
    if (Math.abs(targetMag - item.mag) > 0.003 ||
        Math.abs(targetHx - item.hx) > 0.2 ||
        Math.abs(targetHy - item.hy) > 0.2) {
      this._widgetsDirty = true;
    }
    item._fxLast = { mag: item.mag, hx: item.hx, hy: item.hy, dx, dy };
    return item._fxLast;
  }

  /** Nur Kugeln vor der Erde reagieren auf die Maus. */
  _canMagnet(p) {
    const R = (this._radiusMin + this._radiusMax) / 2;
    return p.z > -R * 0.1;
  }

  _buildEarth(container) {
    buildEarth(this, container);
  }

  /* ============================================================
     ÖFFNEN: Aufladen → Knall → Widgets fliegen raus
     Die Erde (Zittern, Aufleuchten, Rückstoß) wird über
     this._earthFx im Erd-Loop gesteuert, der Flug der Widgets
     über this._intro im Widget-Loop – beides framegenau.
     ============================================================ */
  expand() {
    if (this._expanded || this._transitioning) return;

    // Gezoomte Erde erst auf Normalgröße, dann laden (Widgets kreisen auf festem Radius)
    if (Math.abs(this._zoom - 1) > 1e-3 || this._zoomBase !== 1) {
      if (this._zoomResetting) return;
      this._zoomResetting = true;
      this._resetZoom().then(() => {
        this._zoomResetting = false;
        this.expand();
      });
      return;
    }

    this._transitioning = true;

    const reduced = prefersReducedMotion();
    const T = reduced ? INTRO_REDUCED : INTRO;
    const now = performance.now();

    this._earthFx = reduced ? null : { start: now, release: now + T.charge };
    this._core.classList.add('is-charging');
    audio.charge(T.charge / 1000);

    this._items.forEach(({ el }) => {
      el.style.opacity = '';
      el.style.filter = '';
      el.style.zIndex = '';
    });

    if (!reduced) this._spawnChargeFx(T.charge);

    this._later(() => this._release(T, reduced), T.charge);
  }

  /* ============================================================
     STARTSEQUENZ – Erde baut sich auf (Linien ziehen, Land blendet ein).
     Das Öffnen/Schließen der Widgets steuert der Aufrufer über
     expand() / collapse().
     ============================================================ */
  playStartup() {
    this._bootHold = false;
    this._bootStart = performance.now();
  }

  /** Startaufbau sofort beenden (Nutzer hat eingegriffen). */
  skipStartup() {
    this._bootHold = false;
    this._bootStart = null;
  }

  /** Erd-Texturen geladen (Startsequenz wartet darauf). */
  get ready() { return this._earthReady || Promise.resolve(); }

  get isExpanded() { return this._expanded; }
  get isBusy() { return this._transitioning; }
  /** Nutzer fasst gerade das Menü an (Drag oder Hover auf einem Widget). */
  get isInUse() { return this._isDragging || this._paused; }

  _bootValue(now) {
    if (this._bootStart === null) return this._bootHold ? 0 : 1;
    return clamp01((now - this._bootStart) / BOOT_EARTH_MS);
  }

  /* ============================================================
     ZOOM – Mausrad, Pinch (Touch) und +/−/0. Nur auf HOME und solange
     der Orbit eingeklappt ist.
     ============================================================ */
  _canZoom() {
    return ViewManager.getState() === 'HOME' && !this._expanded &&
      !this._transitioning && !this._zoomResetting;
  }

  _setZoomTarget(z) {
    this._zoomTarget = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z));
  }

  /** Canvas in der aktuellen Zoomstufe neu auflösen (scharf statt hochskaliert). */
  _commitZoom() {
    this._zoomBase = this._zoom;
    this._core.style.setProperty('--earth-zoom', this._zoom.toFixed(4));
    this._earthEl.style.transform = '';
    if (this._earthResize) this._earthResize();
    if (this._zoom === 1) this._zoomWaiters.splice(0).forEach((fn) => fn());
  }

  _resetZoom() {
    return new Promise((resolve) => {
      if (this._zoom === 1 && this._zoomBase === 1) { resolve(); return; }
      this._zoomTarget = 1;
      this._zoomWaiters.push(resolve);
    });
  }

  _bindZoom() {
    this._onWheelZoom = (e) => {
      if (!this._canZoom()) return;
      e.preventDefault();
      // Trackpad-Pinch kommt als wheel mit ctrlKey und kleinen Deltas
      const k = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0008));
      this._setZoomTarget(this._zoomTarget * k);
    };
    window.addEventListener('wheel', this._onWheelZoom, { passive: false });

    let pinch = null;
    const dist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    this._onPinchStart = (e) => {
      if (e.touches.length === 2 && this._canZoom()) {
        pinch = { d0: dist(e.touches), z0: this._zoomTarget };
      }
    };
    this._onPinchMove = (e) => {
      if (!pinch || e.touches.length !== 2 || !this._canZoom()) return;
      e.preventDefault();
      this._setZoomTarget(pinch.z0 * dist(e.touches) / pinch.d0);
    };
    this._onPinchEnd = (e) => { if (e.touches.length < 2) pinch = null; };
    window.addEventListener('touchstart', this._onPinchStart, { passive: true });
    window.addEventListener('touchmove', this._onPinchMove, { passive: false });
    window.addEventListener('touchend', this._onPinchEnd, { passive: true });
    window.addEventListener('touchcancel', this._onPinchEnd, { passive: true });

    this._onKeyZoom = (e) => {
      if (!this._canZoom() || e.ctrlKey || e.metaKey || e.altKey) return;
      const tag = e.target && e.target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (e.key === '+' || e.key === '=') this._setZoomTarget(this._zoomTarget * 1.2);
      else if (e.key === '-') this._setZoomTarget(this._zoomTarget / 1.2);
      else if (e.key === '0') this._setZoomTarget(1);
    };
    window.addEventListener('keydown', this._onKeyZoom);
  }

  _later(fn, ms) {
    const id = setTimeout(() => {
      this._fxTimers = this._fxTimers.filter(x => x !== id);
      fn();
    }, ms);
    this._fxTimers.push(id);
  }

  /** Bildschirm-Radius der Erdkugel (die Kugel füllt ~82 % der Core-Höhe). */
  _earthScreenRadius() {
    const w = this._core ? this._core.offsetWidth : 460;
    return w * 0.41;
  }

  /** Kurzlebiges Effekt-Element, das sich nach seiner Animation selbst entfernt. */
  _fx(parent, className, vars, maxLife = 2500) {
    const el = document.createElement('div');
    el.className = 'orbit-fx ' + className;
    for (const k in vars) el.style.setProperty(k, vars[k]);
    const done = () => el.remove();
    el.addEventListener('animationend', done, { once: true });
    setTimeout(done, maxLife);
    parent.appendChild(el);
    return el;
  }

  /** Phase 1: Energie strömt in die Atmosphäre, Ringe ziehen sich zusammen. */
  _spawnChargeFx(charge) {
    const R = this._earthScreenRadius();
    const orbit = this._orbit;
    const mobile = window.innerWidth < 640;

    // Goldener Staub wird spiralförmig in die Erde gezogen; sqrt(random) →
    // zum Ende hin dichter, das Aufladen schwillt an
    const count = mobile ? 18 : 30;
    for (let i = 0; i < count; i++) {
      const delay = charge * 0.82 * Math.sqrt(Math.random());
      const dur = Math.max(260, Math.min(rand(520, 820), charge - delay));
      this._fx(orbit, 'orbit-charge-particle', {
        '--angle': rand(0, 360).toFixed(1) + 'deg',
        '--from': (R * rand(1.35, 2.2)).toFixed(1) + 'px',
        '--to': (R * 1.02).toFixed(1) + 'px',
        '--size': rand(2, 4.2).toFixed(1) + 'px',
        '--dur': dur.toFixed(0) + 'ms',
        '--delay': delay.toFixed(0) + 'ms'
      }, charge + 400);
    }

    // Sonne taucht hinter dem Erdrand auf: warmer Lichtsaum um die Erde und
    // ein Glanzpunkt an der Kante (oben rechts); beides schwillt bis zum Knall an
    this._fx(orbit, 'orbit-halo', {
      '--size': (R * 3.4).toFixed(0) + 'px',
      '--dur': charge.toFixed(0) + 'ms'
    }, charge + 400);
    this._fx(orbit, 'orbit-glint', {
      '--size': (R * 0.95).toFixed(0) + 'px',
      '--r': (R * 0.98).toFixed(0) + 'px',
      '--angle': '-38deg',
      '--dur': charge.toFixed(0) + 'ms'
    }, charge + 400);
  }

  /** Phase 2 + 3: Knall, dann fliegen die Widgets als Welle raus. */
  _release(T, reduced) {
    const orbit = this._orbit;
    const core = this._core;
    const R = this._earthScreenRadius();

    core.classList.remove('is-charging');
    core.classList.add('is-open');
    core.title = 'Klicken zum Schließen';
    audio.boom();

    if (!reduced) {
      // Vor der Erde (root-Ebene, über dem Core)
      this._fx(this.root, 'orbit-flash', {
        '--size': (R * 2.3).toFixed(0) + 'px'
      });
      // Lichtsaum und Glanzpunkt blühen auf und klingen aus
      this._fx(orbit, 'orbit-halo-out', {
        '--size': (R * 3.4).toFixed(0) + 'px'
      }, 1600);
      this._fx(orbit, 'orbit-glint-out', {
        '--size': (R * 0.95).toFixed(0) + 'px',
        '--r': (R * 0.98).toFixed(0) + 'px',
        '--angle': '-38deg'
      }, 1400);
    }

    this._expanded = true;
    orbit.classList.add('is-expanded');

    // Startreihenfolge nach Bildschirmwinkel → die Widgets fächern sich als Welle auf
    const order = this._items
      .map(item => {
        const p = this._projectItem(item);
        return { item, p, a: Math.atan2(p.y, p.x) };
      })
      .sort((u, v) => u.a - v.a);

    order.forEach(({ item }, rank) => {
      const delay = rank * T.stagger;
      item.launchDelay = delay;
      item.el.style.setProperty('--burst-delay', delay + 'ms');
      item.el.classList.add('is-bursting');
    });

    this._intro = { release: performance.now(), fly: T.fly };
    this._widgetsDirty = true;

    const total = T.fly + T.stagger * (this._items.length - 1);
    clearTimeout(this._transitionTimer);
    this._transitionTimer = setTimeout(() => this._finishIntro(), total + 30);
  }

  _finishIntro() {
    this._intro = null;
    this._items.forEach(item => {
      item.launchDelay = 0;
      item.el.classList.remove('is-bursting');
    });
    this._transitioning = false;
    this._widgetsDirty = true;
  }

  /** Liegt der Bildschirmpunkt auf der Erdkugel? */
  _isOnEarth(x, y) {
    if (!this._core) return false;
    const r = this._core.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    // Die Kugel füllt ~82 % der Core-Höhe (siehe _earthScreenRadius)
    return Math.hypot(x - cx, y - cy) <= r.width * 0.41;
  }

  /* ============================================================
     SCHLIESSEN: Widgets fliegen zurück in die Erde, die Erde
     wächst wieder auf volle Größe und fängt sie mit einem
     kurzen Aufleuchten auf.
     ============================================================ */
  collapse() {
    if (!this._expanded || this._transitioning) return;
    this._transitioning = true;

    const reduced = prefersReducedMotion();
    const T = reduced ? OUTRO_REDUCED : OUTRO;

    audio.close();
    this._spin = { x: 0, y: 0 };
    this._orbit.classList.add('is-retracting');
    this._orbit.classList.remove('is-over-earth');

    // Reihenfolge nach Bildschirmwinkel → die Widgets werden als Welle eingesaugt
    this._items
      .map(item => {
        const p = this._projectItem(item);
        return { item, a: Math.atan2(p.y, p.x) };
      })
      .sort((u, v) => u.a - v.a)
      .forEach(({ item }, rank) => { item.launchDelay = rank * T.stagger; });

    const now = performance.now();
    this._outro = { start: now, fly: T.fly };
    this._widgetsDirty = true;

    const total = T.fly + T.stagger * (this._items.length - 1);

    // Die Erde wächst schon während des Rückflugs wieder auf volle Größe
    this._core.classList.remove('is-open');
    this._core.title = 'Klicken zum Öffnen';

    // Auffangen: kurzer, schwacher Rückstoß im Erd-Loop
    if (!reduced) {
      this._earthFx = { start: now + total - 1, release: now + total, amp: 0.45 };
    }

    clearTimeout(this._transitionTimer);
    this._transitionTimer = setTimeout(() => this._finishOutro(), total + 30);
  }

  _finishOutro() {
    this._outro = null;
    this._expanded = false;
    this._orbit.classList.remove('is-expanded', 'is-retracting');
    this._items.forEach(item => {
      item.launchDelay = 0;
      item.el.classList.remove('is-behind');
    });
    this._transitioning = false;
    this._widgetsDirty = true;
  }

  _bindMouse() {
    this._mouse = { x: 0, y: 0, active: false };
    this._boundMove = (e) => {
      this._mouse.x = e.clientX;
      this._mouse.y = e.clientY;
      this._mouse.active = true;
      const nx = (e.clientX / window.innerWidth) * 2 - 1;
      const ny = (e.clientY / window.innerHeight) * 2 - 1;
      this._targetParallaxY = nx * 14;
      this._targetParallaxX = -ny * 10;
      this._widgetsDirty = true;

      if (this._orbit) {
        const overEarth = this._expanded && !this._transitioning &&
          this._isOnEarth(e.clientX, e.clientY);
        this._orbit.classList.toggle('is-over-earth', overEarth);
      }
    };

    this._boundLeave = () => {
      this._targetParallaxX = 0;
      this._targetParallaxY = 0;
      this._mouse.active = false;
      this._widgetsDirty = true;
    };

    window.addEventListener('mousemove', this._boundMove);
    document.addEventListener('mouseleave', this._boundLeave);
  }

  _bindDrag() {
    const orbit = this._orbit;

    this._onPointerDown = (e) => {
      if (ViewManager.getState() !== 'HOME') return;
      if (!this._expanded) return;
      if (e.button !== undefined && e.button !== 0) return;

      this._downX = e.clientX;
      this._downY = e.clientY;

      const target = e.target;
      if (target && target.closest && target.closest('.orbit-item')) return;
      if (target && target.closest && target.closest('.orbit-core')) return;

      this._isDragging = true;
      this._dragLastX = e.clientX;
      this._dragLastY = e.clientY;
      this._dragLastTime = performance.now();
      this._spin = { x: 0, y: 0 };

      orbit.classList.add('is-dragging');

      // will-change nur beim Drag setzen
      if (this._cluster) this._cluster.style.willChange = 'transform';

      if (e.pointerId !== undefined && orbit.setPointerCapture) {
        try { orbit.setPointerCapture(e.pointerId); } catch (_) {}
      }
    };

    this._onPointerMove = (e) => {
      if (!this._isDragging) return;

      const now = performance.now();
      const dt = Math.max(1, now - this._dragLastTime);
      const dx = e.clientX - this._dragLastX;
      const dy = e.clientY - this._dragLastY;

      // Links/rechts → um die Y-Achse, hoch/runter → um die X-Achse.
      // (Bildschirm-y zeigt nach unten, daher das Minus.)
      const wx = -dy * this._dragSensitivity;
      const wy = dx * this._dragSensitivity;
      this._rotateScreen(wx, wy);
      this._spin = { x: wx / dt, y: wy / dt };

      this._dragLastX = e.clientX;
      this._dragLastY = e.clientY;
      this._dragLastTime = now;
      this._widgetsDirty = true;
    };

    this._onPointerUp = (e) => {
      if (!this._isDragging) return;
      this._isDragging = false;

      // Maus vor dem Loslassen angehalten → kein Nachschwingen
      if (performance.now() - this._dragLastTime > 80) this._spin = { x: 0, y: 0 };
      orbit.classList.remove('is-dragging');

      // will-change wieder abgeben
      if (this._cluster) this._cluster.style.willChange = 'auto';

      if (e.pointerId !== undefined && orbit.releasePointerCapture) {
        try { orbit.releasePointerCapture(e.pointerId); } catch (_) {}
      }
    };

    // Klick auf die geöffnete Erde → Widgets einsammeln. Die Erde selbst
    // ist dann pointer-events: none, damit Ziehen über ihr weiter dreht –
    // der Treffer wird deshalb hier per Kreis-Test ermittelt.
    this._onOrbitClick = (e) => {
      if (!this._expanded || this._transitioning) return;
      if (ViewManager.getState() !== 'HOME') return;
      if (e.target && e.target.closest && e.target.closest('.orbit-item')) return;
      const moved = Math.hypot(e.clientX - (this._downX ?? e.clientX),
                               e.clientY - (this._downY ?? e.clientY));
      if (moved > 6) return;
      if (!this._isOnEarth(e.clientX, e.clientY)) return;
      this.collapse();
    };

    orbit.addEventListener('pointerdown', this._onPointerDown);
    orbit.addEventListener('click', this._onOrbitClick);
    window.addEventListener('pointermove', this._onPointerMove);
    window.addEventListener('pointerup', this._onPointerUp);
    window.addEventListener('pointercancel', this._onPointerUp);

    this._boundOnPointerDown = this._onPointerDown;
    this._boundOnPointerMove = this._onPointerMove;
    this._boundOnPointerUp = this._onPointerUp;
  }

  _bindResize() {
    this._boundResize = () => {
      const vmin = Math.min(window.innerWidth, window.innerHeight);
      const scale = Math.max(0.6, Math.min(1.0, vmin / 900));
      this._radiusMin = 280 * scale;
      this._radiusMax = 440 * scale;
      this._widgetsDirty = true;
    };
    window.addEventListener('resize', this._boundResize);
    this._boundResize();
  }

  _bindViewChanges() {
    this._unsubscribeView = ViewManager.onChange((next) => {
      if (next === 'HOME') {
        this._diveBack();
        setTimeout(() => {
          this._resetWarpState();
          if (this._expanded && this._orbit) {
            this._orbit.classList.add('is-expanded');
            this._transitioning = false;
          }
          this._widgetsDirty = true;
        }, 50);
      }
    });
  }

  _resetWarpState() {
    this._items.forEach(({ el }) => {
      el.classList.remove('is-warping', 'is-shrinking', 'is-collapsing', 'is-bursting');
      el.style.position = '';
      el.style.left = '';
      el.style.top = '';
      el.style.width = '';
      el.style.height = '';
      el.style.marginLeft = '';
      el.style.marginTop = '';
      el.style.pointerEvents = '';
      el.style.opacity = '';
      el.style.visibility = '';
      el.style.transition = '';
      el.style.willChange = '';
    });
    this._items.forEach(i => { i.warping = false; });

    document.querySelectorAll(
      '.orbit-fx'
    ).forEach(n => n.remove());
  }

  _startRaf() {
    const start = performance.now();
    let lastNow = start;

    const tick = (now) => {
      this._rafId = requestAnimationFrame(tick);

      // Frame-Throttle: max 30 fps (2 ms Toleranz gegen RAF-Timing-Jitter)
      if (now - this._lastWidgetFrame < this._widgetFrameInterval - 2) return;
      this._lastWidgetFrame = now;

      const dt = Math.min(50, now - lastNow);
      lastNow = now;
      if (!this._rotFrozen) this._floatT += dt / 1000;
      const t = this._floatT;

      const isHome = ViewManager.getState() === 'HOME';

      if (isHome && this._expanded && !this._transitioning && !this._rotFrozen) {
        if (!this._isDragging) {
          if (Math.hypot(this._spin.x, this._spin.y) > 0.00001) {
            // Schwung nach dem Loslassen, klingt exponentiell aus
            this._rotateScreen(this._spin.x * dt, this._spin.y * dt);
            const decay = Math.pow(this._inertiaDecay, dt / 16);
            this._spin.x *= decay;
            this._spin.y *= decay;
            this._widgetsDirty = true;
          } else {
            this._spin.x = 0;
            this._spin.y = 0;
            if (!this._paused) {
              // Ruhige Eigenrotation um die senkrechte Bildschirmachse
              this._rotateScreen(0, this._autoRotationSpeed * (dt / 1000));
            }
          }
        }
      }

      // Parallax nur interpolieren, wenn wir uns bewegen
      const pxDelta = Math.abs(this._targetParallaxX - this._currentParallaxX);
      const pyDelta = Math.abs(this._targetParallaxY - this._currentParallaxY);
      if (!this._rotFrozen && (pxDelta > 0.01 || pyDelta > 0.01)) {
        this._currentParallaxX += (this._targetParallaxX - this._currentParallaxX) * 0.06;
        this._currentParallaxY += (this._targetParallaxY - this._currentParallaxY) * 0.06;
        this._widgetsDirty = true;
      }

      // Wenn nichts dirty und nicht expanded: skip
      const needsUpdate = this._widgetsDirty
                       || this._intro
                       || this._outro
                       || (!this._paused && this._expanded);

      if (!needsUpdate) return;

      this._widgetsDirty = false;

      // Bildschirmmitte des Orbits (für den Magnet-Effekt)
      const cr = this._core ? this._core.getBoundingClientRect() : null;
      const center = cr
        ? { x: cr.left + cr.width / 2, y: cr.top + cr.height / 2 }
        : { x: window.innerWidth / 2, y: window.innerHeight / 2 };

      this._items.forEach((item) => {
        if (item.warping) {
          const el = item.el;
          const isMidWarp = el.classList.contains('is-warping')
                         || el.classList.contains('is-shrinking')
                         || el.classList.contains('is-collapsing');
          if (!isMidWarp) {
            item.warping = false;
            el.style.position = '';
            el.style.left = '';
            el.style.top = '';
            el.style.width = '';
            el.style.height = '';
            el.style.marginLeft = '';
            el.style.marginTop = '';
            el.style.transform = '';
            el.style.zIndex = '';
            el.style.pointerEvents = '';
            el.style.opacity = '';
            el.style.visibility = '';
          } else {
            return;
          }
        }

        if (!this._expanded) return;

        const { el, phase, floatAmp, floatSpeed } = item;

        const floatY = Math.sin(t * floatSpeed + phase) * floatAmp;
        const floatZ = Math.cos(t * floatSpeed * 0.7 + phase) * floatAmp * 0.5;

        // Rausfliegen: Zielposition wird live berechnet (inkl. Schweben), daher
        // gibt es am Ende des Flugs keinen Sprung in die normale Umlaufbahn.
        if (this._intro) {
          const k = clamp01((now - this._intro.release - (item.launchDelay || 0)) / this._intro.fly);
          if (k < 1) {
            const spiral = (1 - easeOutCubic(k)) * 0.55;
            const p = this._projectItem(item, floatY, floatZ, -spiral);
            const reach = easeOutBack(k, 1.2);   // leichtes Überschwingen nach außen
            p.x *= reach;
            p.y *= reach;
            p.z *= reach;
            this._applyItemTransform(el, p, 0.2 + 0.8 * easeOutCubic(k), clamp01(k * 2.5));
            return;
          }
        }

        // Zurückfliegen: Spiegelbild des Rausfliegens – spiralförmig nach
        // innen, dabei kleiner und durchsichtig, bis die Erde sie schluckt.
        if (this._outro) {
          const k = clamp01((now - this._outro.start - (item.launchDelay || 0)) / this._outro.fly);
          const e = easeInCubic(k);
          const p = this._projectItem(item, floatY, floatZ, e * 0.55);
          const reach = 1 - e;
          p.x *= reach;
          p.y *= reach;
          p.z *= reach;
          this._applyItemTransform(el, p, 1 - 0.8 * e, 1 - clamp01((k - 0.55) / 0.45));
          return;
        }

        const pn = this._projectItem(item, floatY, floatZ);
        const fxm = this._magnetFor(item, pn, center);
        this._applyItemTransform(el, pn, 1 + fxm.mag * 0.26, 1, fxm);
      });
    };

    this._rafId = requestAnimationFrame(tick);
  }

  _handleClick(project, btn) {
    audio.click();

    const isReal = this.isOpenable(project);

    if (!isReal) {
      btn.animate(
        [
          { transform: btn.style.transform + ' scale(1)' },
          { transform: btn.style.transform + ' scale(0.92)' },
          { transform: btn.style.transform + ' scale(1)' }
        ],
        { duration: 260, easing: 'ease-out' }
      );

      if (project.target === 'placeholder') {
        this._showToast(`${project.name} · in Vorbereitung`);
      } else if (project.target === 'empty') {
        this._showToast('Platz frei');
      } else {
        this._showToast('Unbekanntes Ziel');
      }
      return;
    }

    this._diveInto(project, btn);
  }

  /* ============================================================
     EINFLUG
     Die Szene fliegt auf die angeklickte Scheibe zu, das Modul wird durch einen
     Kreis aufgedeckt, der von der Scheibe aus wächst (CSS: body.is-diving-in).
     Beim Zurückgehen schließt sich der Kreis wieder auf die Scheibe
     (body.is-diving-out, .module-slot.is-leaving).
     ============================================================ */
  _setDiveVars(d) {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const rf = Math.hypot(Math.max(d.cx, vw - d.cx), Math.max(d.cy, vh - d.cy)) + 4;
    const st = document.body.style;
    st.setProperty('--dive-x', d.cx + 'px');
    st.setProperty('--dive-y', d.cy + 'px');
    st.setProperty('--dive-r0', (d.dia / 2) + 'px');
    st.setProperty('--dive-rf', rf + 'px');
  }

  /**
   * Ruft fn auf, sobald alle laufenden Einflug-Animationen (dive*) wirklich fertig sind.
   * Ein fester Timer reicht nicht: Beim Öffnen eines Moduls starten die Animationen
   * oft später als gedacht (Hauptthread belegt), und die Klasse würde sie mittendrin abschneiden.
   */
  _whenDiveDone(fn, maxMs = 2000) {
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const anims = [];
      const stage = document.getElementById('orbit-stage');
      if (stage) anims.push(...stage.getAnimations());
      document.querySelectorAll('.module-slot').forEach((sl) => {
        anims.push(...sl.getAnimations({ subtree: true }));
      });
      const dive = anims.filter((a) => /^dive/.test(a.animationName || ''));
      const timeout = new Promise((r) => setTimeout(r, maxMs));
      Promise.race([Promise.allSettled(dive.map((a) => a.finished)), timeout]).then(fn);
    }));
  }

  _diveInto(project, btn) {
    const reduced = prefersReducedMotion();

    const rect = btn.getBoundingClientRect();
    const d = {
      cx: rect.left + rect.width / 2,
      cy: rect.top + rect.height / 2,
      dia: rect.width,
      slot: null
    };

    if (reduced) {
      this.onOpenProject(project);
      return;
    }

    this._setDiveVars(d);
    this._rotFrozen = true;
    this._spin = { x: 0, y: 0 };
    document.body.classList.remove('is-diving-out');
    document.body.classList.add('is-diving-in');

    // State wechselt jetzt; der Slot des Moduls bekommt .is-active und wird aufgedeckt
    this.onOpenProject(project);
    d.slot = document.querySelector('.module-slot.is-active');
    if (d.slot) {
      d.slot.style.visibility = '';
      d.slot.classList.remove('is-leaving');
      d.slot.classList.add('no-enter-anim');
    }
    this._dive = d;

    // Klasse erst entfernen, wenn die Animationen fertig sind (und nicht schon zurückgeflogen wurde)
    this._whenDiveDone(() => {
      if (this._dive === d) document.body.classList.remove('is-diving-in');
    });
  }

  /** Rückweg: Der Kreis schließt sich auf die Scheibe, der Orbit fliegt zurück. */
  _diveBack() {
    const d = this._dive;
    this._dive = null;
    if (!d) {
      this._rotFrozen = false;
      return;
    }

    this._setDiveVars(d);
    const b = document.body;
    b.classList.remove('is-diving-in');
    b.classList.add('is-diving-out');
    if (d.slot) d.slot.classList.add('is-leaving');

    this._whenDiveDone(() => {
      if (!this._dive) {   // nicht schon wieder hineingeflogen
        b.classList.remove('is-diving-out');
        this._rotFrozen = false;   // Orbit und Erde laufen erst jetzt wieder weiter
        this._widgetsDirty = true;
      }
      if (d.slot && d.slot !== (this._dive && this._dive.slot)) {
        // Verlassenes Modul bleibt noch kurz unsichtbar, bis seine Ausblend-Transition durch ist
        d.slot.style.visibility = 'hidden';
        d.slot.classList.remove('is-leaving', 'no-enter-anim');
        setTimeout(() => { d.slot.style.visibility = ''; }, 950);
      }
    });
  }

  _showToast(text) {
    if (!this._toast) return;
    this._toast.textContent = text;
    this._toast.classList.add('visible');

    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => {
      this._toast.classList.remove('visible');
    }, 2200);
  }


  destroy() {
    clearTimeout(this._toastTimer);
    clearTimeout(this._transitionTimer);
    this._fxTimers.forEach(clearTimeout);
    this._fxTimers = [];
    if (this._rafId) cancelAnimationFrame(this._rafId);
    if (this._earthRafId) cancelAnimationFrame(this._earthRafId);
    if (this._earthResize) window.removeEventListener('resize', this._earthResize);
    if (this._three && this._three.renderer) {
      try { this._three.renderer.dispose(); } catch (_) {}
    }
    if (this._boundMove) window.removeEventListener('mousemove', this._boundMove);
    if (this._boundResize) window.removeEventListener('resize', this._boundResize);
    if (this._boundLeave) document.removeEventListener('mouseleave', this._boundLeave);
    if (this._boundOnPointerMove) window.removeEventListener('pointermove', this._boundOnPointerMove);
    if (this._boundOnPointerUp) {
      window.removeEventListener('pointerup', this._boundOnPointerUp);
      window.removeEventListener('pointercancel', this._boundOnPointerUp);
    }
    if (this._boundOnPointerDown && this._orbit) {
      this._orbit.removeEventListener('pointerdown', this._boundOnPointerDown);
      this._orbit.removeEventListener('click', this._onOrbitClick);
    }
    if (this._onWheelZoom) window.removeEventListener('wheel', this._onWheelZoom);
    if (this._onPinchStart) {
      window.removeEventListener('touchstart', this._onPinchStart);
      window.removeEventListener('touchmove', this._onPinchMove);
      window.removeEventListener('touchend', this._onPinchEnd);
      window.removeEventListener('touchcancel', this._onPinchEnd);
    }
    if (this._onKeyZoom) window.removeEventListener('keydown', this._onKeyZoom);
    if (typeof this._unsubscribeLocation === 'function') this._unsubscribeLocation();
    if (typeof this._disposeIss === 'function') this._disposeIss();
    if (typeof this._unsubscribeView === 'function') {
      this._unsubscribeView();
    }
    this.root.innerHTML = '';
    this._items = [];
  }
}
