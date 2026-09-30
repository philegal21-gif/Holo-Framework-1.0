import * as THREE from 'three';
import { PROJECTS } from '../data/projects.js';
import { ViewManager } from '../core/ViewManager.js';
import { audio } from '../core/AudioEngine.js';
import { Mat3 } from '../core/utils.js';
import { userLocation } from '../core/Location.js';
import { PLANET_STYLE, makePlanetTexture } from './planets.js';

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

const clamp01 = (v) => Math.max(0, Math.min(1, v));
const easeInCubic = (t) => t * t * t;
const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
const easeInOutSine = (t) => -(Math.cos(Math.PI * t) - 1) / 2;
const easeOutBack = (t, s = 1.2) => 1 + (s + 1) * Math.pow(t - 1, 3) + s * Math.pow(t - 1, 2);
const rand = (min, max) => min + Math.random() * (max - min);
// 0 bei x = edge0, 1 bei x = edge1, weich dazwischen (edge0 > edge1 erlaubt)
const smoothstep = (edge0, edge1, x) => {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
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

// Neigung der Erdachse zur Kamera (rad): Norden kippt nach vorn, Europa rückt ins Bild
const EARTH_TILT = 0.6;

// Zoom der Erde (Mausrad, Pinch, +/-): Faktor auf die Grundgröße
const ZOOM_MIN = 0.7;
const ZOOM_MAX = 2.6;

// Aufbau der Erde beim Start (ms): Linien ziehen sich, Land blendet ein
const BOOT_EARTH_MS = 2400;

export class OrbitMenu {
  constructor(rootEl, options = {}) {
    this.root = rootEl;
    this.onOpenProject = options.onOpenProject || (() => {});
    this.isOpenable = options.isOpenable || (() => false);

    const reducedMotion = !!(window.matchMedia &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches);
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

      const planet = PLANET_STYLE[project.id] || PLANET_STYLE.add;
      item.style.setProperty('--ps', planet.size);
      item.style.setProperty('--spin', planet.spin + 's');
      item.style.setProperty('--rim', planet.rim);
      item.style.setProperty('--base', planet.base);

      item.innerHTML = `
        <div class="orbit-planet-wrap">
          ${planet.ring ? '<div class="orbit-ring orbit-ring-back"></div>' : ''}
          <div class="orbit-planet"></div>
          ${planet.ring ? '<div class="orbit-ring orbit-ring-front"></div>' : ''}
        </div>
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

    // Planeten-Texturen erst nach dem ersten Paint erzeugen (kurze Rechenzeit),
    // bis dahin zeigen die Kugeln ihre Grundfarbe
    setTimeout(() => {
      this._items.forEach(({ el, project }) => {
        const st = PLANET_STYLE[project.id];
        if (!st || !st.kind) return;
        const url = makePlanetTexture(st.kind, st.seed);
        if (url) el.style.setProperty('--tex', `url(${url})`);
      });
    }, 0);

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
    return { mag: item.mag, hx: item.hx, hy: item.hy, dx, dy };
  }

  /** Nur Kugeln vor der Erde reagieren auf die Maus. */
  _canMagnet(p) {
    const R = (this._radiusMin + this._radiusMax) / 2;
    return p.z > -R * 0.1;
  }

  /* ============================================================
     THREE.JS ERDE — transparent, nur Konturen
     ============================================================ */
  _buildEarth(container) {
    const width = container.clientWidth || 460;
    const height = container.clientHeight || 460;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 1000);
    this._earthCamera = camera;
    this._earthCameraBaseZ = 15;

    camera.position.set(0, 0, 15);
    camera.lookAt(0, 0, 0);

    const renderer = new THREE.WebGLRenderer({
      alpha: true,
      antialias: true,
      premultipliedAlpha: false,
      powerPreference: 'high-performance',
      stencil: false
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(width, height, false);
    renderer.setClearColor(0x000000, 0);
    renderer.setClearAlpha(0);
    // setSize(..., false) setzt keine CSS-Größe – ohne diese Styles wäre das
    // Canvas bei devicePixelRatio 2 doppelt so groß wie der Container.
    const canvas = renderer.domElement;
    canvas.style.display = 'block';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.margin = '0';
    canvas.style.position = 'absolute';
    canvas.style.left = '0';
    canvas.style.top = '0';
    container.appendChild(canvas);

    const earthGroup = new THREE.Group();
    // Euler XYZ: erst Drehung um die eigene Y-Achse, dann Kippen um X → geneigte Achse
    earthGroup.rotation.x = EARTH_TILT;
    scene.add(earthGroup);

    // ============================================================
    // UNSICHTBARE KUGEL
    // Nur Tiefenmaske: Rückseite der Konturen wird verdeckt, die Kugel
    // selbst zeichnet keine Farbe. Alle anderen Materialien sind unlit,
    // daher braucht die Szene kein Licht.
    // ============================================================
    const earthGeo = new THREE.SphereGeometry(5, 32, 32);
    const earthMat = new THREE.MeshBasicMaterial({ colorWrite: false });
    const earthMesh = new THREE.Mesh(earthGeo, earthMat);
    earthMesh.renderOrder = -1;
    earthGroup.add(earthMesh);

    // ============================================================
    // LAT/LON → 3D-VEKTOR
    // ============================================================
    const latLonToVec3 = (lat, lon, radius) => {
      const phi = (90 - lat) * (Math.PI / 180);
      const theta = (lon + 180) * (Math.PI / 180);
      const x = -(radius * Math.sin(phi) * Math.cos(theta));
      const z = radius * Math.sin(phi) * Math.sin(theta);
      const y = radius * Math.cos(phi);
      return new THREE.Vector3(x, y, z);
    };

    // ============================================================
    // GEOJSON → LINE-SEGMENTS
    // Wandelt Landmassen-Polygone in Linien um.
    // ============================================================
    const geojsonToLineSegments = (geojson, radius) => {
      const positions = [];

      const addCoords = (coords) => {
        if (!coords || coords.length < 2) return;
        for (let i = 0; i < coords.length - 1; i++) {
          const a = coords[i];
          const b = coords[i + 1];
          if (!a || !b || a.length < 2 || b.length < 2) continue;
          const p1 = latLonToVec3(a[1], a[0], radius);
          const p2 = latLonToVec3(b[1], b[0], radius);
          positions.push(p1.x, p1.y, p1.z);
          positions.push(p2.x, p2.y, p2.z);
        }
      };

      const processGeom = (geom) => {
        if (!geom) return;
        if (geom.type === 'LineString') {
          addCoords(geom.coordinates);
        } else if (geom.type === 'MultiLineString' || geom.type === 'Polygon') {
          if (Array.isArray(geom.coordinates)) {
            geom.coordinates.forEach(addCoords);
          }
        } else if (geom.type === 'MultiPolygon') {
          if (Array.isArray(geom.coordinates)) {
            geom.coordinates.forEach(poly => {
              if (Array.isArray(poly)) poly.forEach(addCoords);
            });
          }
        } else if (geom.type === 'GeometryCollection') {
          if (Array.isArray(geom.geometries)) geom.geometries.forEach(processGeom);
        }
      };

      if (geojson.type === 'FeatureCollection' && Array.isArray(geojson.features)) {
        geojson.features.forEach(f => f && processGeom(f.geometry));
      } else if (geojson.type === 'Feature') {
        processGeom(geojson.geometry);
      } else if (geojson.type) {
        processGeom(geojson);
      } else if (Array.isArray(geojson)) {
        geojson.forEach(addCoords);
      }

      const geom = new THREE.BufferGeometry();
      if (positions.length > 0) {
        geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      }
      return geom;
    };

    // ============================================================
    // FALLBACK-KONTINENTE
    // Werden sofort gerendert, während die echten Daten laden.
    // ============================================================
    const CONTINENTS = [
      [[-168,65],[-165,60],[-140,60],[-130,50],[-125,48],[-120,34],[-105,20],[-90,16],[-80,8],[-77,8],[-80,25],[-97,26],[-97,30],[-80,30],[-81,25],[-70,42],[-65,45],[-60,46],[-64,50],[-80,52],[-80,65],[-95,68],[-120,70],[-140,70],[-168,65]],
      [[-77,8],[-80,0],[-80,-10],[-75,-15],[-70,-30],[-75,-45],[-70,-55],[-65,-55],[-60,-40],[-40,-22],[-35,-5],[-50,0],[-60,10],[-77,8]],
      [[-10,36],[-9,43],[-2,43],[3,43],[5,48],[10,54],[25,58],[30,70],[40,70],[60,60],[50,50],[40,45],[30,46],[25,40],[15,38],[20,37],[22,40],[15,40],[12,44],[0,38],[-10,36]],
      [[-17,15],[-17,21],[-5,36],[10,37],[25,31],[33,27],[43,12],[51,11],[42,0],[40,-10],[33,-28],[20,-35],[15,-30],[12,-15],[8,5],[-5,5],[-17,15]],
      [[60,60],[70,73],[100,78],[140,70],[170,65],[160,55],[140,50],[130,43],[120,30],[108,12],[100,10],[100,20],[88,22],[78,8],[72,20],[60,25],[50,30],[40,45],[50,50],[60,60]],
      [[114,-22],[114,-34],[138,-35],[150,-37],[153,-28],[142,-11],[130,-12],[128,-15],[114,-22]],
      [[-180,-75],[-120,-75],[-60,-65],[0,-70],[60,-68],[120,-72],[180,-75]],
      [[-55,60],[-40,65],[-20,70],[-20,80],[-50,82],[-70,75],[-55,60]],
      [[-5,50],[-3,58],[0,52],[-5,50]],
      [[130,32],[136,35],[141,41],[140,36],[130,32]]
    ];

    // ============================================================
    // LANDFLÄCHEN
    // Land wird in eine equirektangulare Canvas-Textur gezeichnet
    // (u = (lon+180)/360, v = (90-lat)/180 – passt zu SphereGeometry
    // und latLonToVec3). Meere bleiben alpha = 0 → transparent.
    // ============================================================
    const LAND_W = 2048;
    const LAND_H = 1024;
    const landCanvas = document.createElement('canvas');
    landCanvas.width = LAND_W;
    landCanvas.height = LAND_H;
    const landCtx = landCanvas.getContext('2d');

    const traceRing = (ring, offsetLon) => {
      if (!ring || ring.length < 3) return;
      // Sprünge über den Antimeridian auflösen, sonst entstehen Streifen quer über die Karte
      const pts = [];
      let shift = 0;
      for (let i = 0; i < ring.length; i++) {
        const lon = ring[i][0];
        const lat = ring[i][1];
        if (i > 0) {
          const d = lon - ring[i - 1][0];
          if (d > 180) shift -= 360;
          else if (d < -180) shift += 360;
        }
        pts.push([lon + shift, lat]);
      }
      // Ring umschließt einen Pol (Antarktis) → über den Pol schließen
      const first = pts[0];
      const last = pts[pts.length - 1];
      if (Math.abs(last[0] - first[0]) > 180) {
        const meanLat = pts.reduce((s, p) => s + p[1], 0) / pts.length;
        const poleLat = meanLat < 0 ? -90 : 90;
        pts.push([last[0], poleLat], [first[0], poleLat]);
      }
      pts.forEach(([lon, lat], i) => {
        const x = ((lon + offsetLon + 180) / 360) * LAND_W;
        const y = ((90 - lat) / 180) * LAND_H;
        if (i === 0) landCtx.moveTo(x, y);
        else landCtx.lineTo(x, y);
      });
      landCtx.closePath();
    };

    const landTex = new THREE.CanvasTexture(landCanvas);
    landTex.anisotropy = renderer.capabilities.getMaxAnisotropy();

    // polygons: Array von Polygonen, jedes ein Array von Ringen (Außenring + Löcher)
    const drawLand = (polygons) => {
      const ctx = landCtx;
      ctx.clearRect(0, 0, LAND_W, LAND_H);
      ctx.beginPath();
      // Kopien bei ±360° fangen Polygone ab, die über den Kartenrand ragen
      polygons.forEach(rings => rings.forEach(ring => {
        traceRing(ring, -360);
        traceRing(ring, 0);
        traceRing(ring, 360);
      }));

      // Grundfüllung: von Nord nach Süd leicht verlaufend
      const grad = ctx.createLinearGradient(0, 0, 0, LAND_H);
      grad.addColorStop(0.0, 'rgba(0, 110, 125, 0.62)');
      grad.addColorStop(0.5, 'rgba(0, 95, 108, 0.55)');
      grad.addColorStop(1.0, 'rgba(0, 73, 83, 0.50)');
      ctx.fillStyle = grad;
      ctx.fill('nonzero');

      ctx.save();
      ctx.clip('nonzero');

      // Holo-Schraffur auf dem Land
      ctx.strokeStyle = 'rgba(140, 196, 206, 0.07)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let y = 0; y < LAND_H; y += 6) {
        ctx.moveTo(0, y + 0.5);
        ctx.lineTo(LAND_W, y + 0.5);
      }
      ctx.stroke();

      // Weiche, helle Innenkante entlang der Küsten
      ctx.beginPath();
      polygons.forEach(rings => rings.forEach(ring => traceRing(ring, 0)));
      ctx.strokeStyle = 'rgba(92, 160, 171, 0.45)';
      ctx.lineWidth = 3;
      ctx.stroke();

      ctx.restore();
      landTex.needsUpdate = true;
    };

    const landMat = new THREE.ShaderMaterial({
      uniforms: {
        landMap: { value: landTex },
        uBoost: { value: 1 },  // > 1 = Land "lädt sich auf" (Expand-Animation)
        uFade: { value: 1 }    // Startaufbau: 0 = unsichtbar
      },
      vertexShader: `
        varying vec2 vUv;
        varying vec3 vNormal;
        void main() {
          vUv = uv;
          vNormal = normalize(normalMatrix * normal);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform sampler2D landMap;
        uniform float uBoost;
        uniform float uFade;
        varying vec2 vUv;
        varying vec3 vNormal;
        void main() {
          vec4 c = texture2D(landMap, vUv);
          // Zur Bildmitte hin heller, zum Rand hin dunkler/transparenter → Plastizität
          float facing = clamp(dot(normalize(vNormal), vec3(0.0, 0.0, 1.0)), 0.0, 1.0);
          float light = 0.55 + 0.45 * facing;
          float alpha = c.a * (0.5 + 0.5 * facing) * (0.85 + 0.15 * uBoost) * uFade;
          gl_FragColor = vec4(c.rgb * light * uBoost, min(alpha, 1.0));
        }
      `,
      transparent: true,
      depthWrite: false
    });
    const landMesh = new THREE.Mesh(new THREE.SphereGeometry(5.02, 64, 64), landMat);
    landMesh.renderOrder = 0;
    earthGroup.add(landMesh);

    drawLand(CONTINENTS.map(ring => [ring]));

    // ============================================================
    // KONTUR-MATERIALIEN
    // Zwei Layer:
    //   baseMat → dunkleres Grün, gibt Tiefe
    //   glowMat → helleres Grün, additiv, dezenter Schimmer
    // ============================================================
    const baseMat = new THREE.LineBasicMaterial({
      color: 0x4f97a3,
      transparent: true,
      opacity: 0.7
    });
    const glowMat = new THREE.LineBasicMaterial({
      color: 0x7fb8c2,
      transparent: true,
      opacity: 0.3,
      blending: THREE.AdditiveBlending
    });

    const baseGeo = geojsonToLineSegments(CONTINENTS, 5.04);
    const glowGeo = geojsonToLineSegments(CONTINENTS, 5.06);

    const baseLines = new THREE.LineSegments(baseGeo, baseMat);
    const glowLines = new THREE.LineSegments(glowGeo, glowMat);
    // Linien nach der Landfläche zeichnen
    baseLines.renderOrder = 1;
    glowLines.renderOrder = 1;
    earthGroup.add(baseLines);
    earthGroup.add(glowLines);

    // ============================================================
    // ECHTE DATEN NACHLADEN
    // Von world-atlas (Natural Earth, 110m Auflösung)
    //   mode 'mesh'    → Grenzlinien
    //   mode 'feature' → Flächen
    // ============================================================
    const loadTopo = async (file, mode) => {
      const urls = [
        `https://cdn.jsdelivr.net/npm/world-atlas@2/${file}`,
        `https://unpkg.com/world-atlas@2/${file}`
      ];
      for (const url of urls) {
        try {
          const resp = await fetch(url);
          if (!resp.ok) continue;
          const topology = await resp.json();
          let geojson = null;
          if (typeof window.topojson !== 'undefined' && topology.objects) {
            const key = Object.keys(topology.objects)[0];
            const fn = mode === 'mesh' ? window.topojson.mesh : window.topojson.feature;
            if (fn) geojson = fn(topology, topology.objects[key]);
          } else if (topology.type === 'FeatureCollection' || topology.type === 'Feature') {
            geojson = topology;
          }
          if (geojson) return geojson;
        } catch (_) {}
      }
      return null;
    };

    const geojsonToPolygons = (gj) => {
      const out = [];
      const add = (g) => {
        if (!g) return;
        if (g.type === 'Polygon') out.push(g.coordinates);
        else if (g.type === 'MultiPolygon') g.coordinates.forEach(p => out.push(p));
        else if (g.type === 'GeometryCollection') g.geometries.forEach(add);
      };
      if (gj.type === 'FeatureCollection') gj.features.forEach(f => f && add(f.geometry));
      else if (gj.type === 'Feature') add(gj.geometry);
      else add(gj);
      return out;
    };

    loadTopo('land-110m.json', 'feature').then(geojson => {
      if (!geojson) return;
      const polygons = geojsonToPolygons(geojson);
      if (polygons.length) drawLand(polygons);
    });

    loadTopo('countries-110m.json', 'mesh').then(geojson => {
      if (!geojson) return;
      const nb = geojsonToLineSegments(geojson, 5.04);
      const ng = geojsonToLineSegments(geojson, 5.06);
      if (nb.attributes.position && nb.attributes.position.count > 0) {
        baseLines.geometry.dispose();
        glowLines.geometry.dispose();
        baseLines.geometry = nb;
        glowLines.geometry = ng;
      }
    });

    // ============================================================
    // TAG/NACHT-TERMINATOR
    // Dunkle Halbkugel + feiner Lichtsaum an der Tag/Nacht-Grenze.
    // uSun = Richtung zum Subsolarpunkt im Erd-Koordinatensystem
    // (dreht mit der Erde mit), wird minütlich aus der Uhrzeit berechnet.
    // ============================================================
    const sunDir = new THREE.Vector3(1, 0, 0);
    const updateSun = () => {
      const now = new Date();
      const dayOfYear = Math.floor((now - Date.UTC(now.getUTCFullYear(), 0, 0)) / 86400000);
      const utcH = now.getUTCHours() + now.getUTCMinutes() / 60 + now.getUTCSeconds() / 3600;
      const B = (2 * Math.PI / 365) * (dayOfYear - 81);
      const eqTimeMin = 9.87 * Math.sin(2 * B) - 7.53 * Math.cos(B) - 1.5 * Math.sin(B);
      const decl = -23.44 * Math.cos((2 * Math.PI / 365) * (dayOfYear + 10));
      const lon = (12 - utcH - eqTimeMin / 60) * 15;
      sunDir.copy(latLonToVec3(decl, lon, 1)).normalize();
    };
    updateSun();

    const nightMat = new THREE.ShaderMaterial({
      uniforms: { uSun: { value: sunDir }, uAmount: { value: 1 } },
      vertexShader: `
        varying vec3 vObj;
        void main() {
          vObj = normalize(position);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform vec3 uSun;
        uniform float uAmount;
        varying vec3 vObj;
        void main() {
          float d = dot(normalize(vObj), normalize(uSun));
          float night = smoothstep(0.10, -0.22, d);
          float rim = exp(-pow(d / 0.035, 2.0));
          vec3 col = mix(vec3(0.0, 0.03, 0.05), vec3(0.36, 0.63, 0.67), rim * 0.5);
          float a = (night * 0.5 + rim * 0.22) * uAmount;
          gl_FragColor = vec4(col, a);
        }
      `,
      transparent: true,
      depthWrite: false
    });
    const nightMesh = new THREE.Mesh(new THREE.SphereGeometry(5.03, 64, 64), nightMat);
    nightMesh.renderOrder = 0.5;
    earthGroup.add(nightMesh);

    // ============================================================
    // TEXTUREN (assets/, Quellen in assets/CREDITS.md)
    // ============================================================
    const texLoader = new THREE.TextureLoader();
    const maxAniso = renderer.capabilities.getMaxAnisotropy();
    const loadTex = (file) => texLoader
      .loadAsync(new URL(`../../assets/${file}`, import.meta.url).href)
      .then((t) => { t.anisotropy = maxAniso; return t; });

    // Gemeinsamer Vertex-Shader: Normale, Blickrichtung und Sonne im Weltraum
    const SURFACE_VERT = `
      uniform vec3 uSun;
      varying vec2 vUv;
      varying vec3 vN;
      varying vec3 vView;
      varying vec3 vSun;
      void main() {
        vUv = uv;
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vN = normalize(mat3(modelMatrix) * normal);
        vView = cameraPosition - wp.xyz;
        vSun = mat3(modelMatrix) * uSun;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `;

    // ============================================================
    // NACHTLICHTER
    // Echte Lichter aus der NASA-Karte "Black Marble" (Alphakanal =
    // Helligkeit, siehe assets/CREDITS.md). Nur auf der Nachtseite sichtbar.
    // ============================================================
    const lightsMat = new THREE.ShaderMaterial({
      uniforms: {
        uSun: { value: sunDir },
        uLights: { value: null },
        uAmount: { value: 1 }
      },
      vertexShader: `
        varying vec3 vObj;
        varying vec3 vNormal;
        varying vec2 vUv;
        void main() {
          vUv = uv;
          vObj = normalize(position);
          vNormal = normalize(normalMatrix * normal);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform vec3 uSun;
        uniform sampler2D uLights;
        uniform float uAmount;
        varying vec3 vObj;
        varying vec3 vNormal;
        varying vec2 vUv;
        void main() {
          float d = dot(normalize(vObj), normalize(uSun));
          float night = smoothstep(0.0, -0.2, d);
          float facing = clamp(dot(normalize(vNormal), vec3(0.0, 0.0, 1.0)), 0.0, 1.0);
          float fade = 0.3 + 0.7 * smoothstep(0.0, 0.45, facing);
          // scharfe Punkte + weicher Stadtschein (unscharfe Mip-Stufe)
          float sharp = texture2D(uLights, vUv).a;
          float glow = texture2D(uLights, vUv, 3.0).a;
          // Natriumlicht: schwache Punkte orange, helle Kerne warmweiß
          vec3 amber = vec3(1.0, 0.56, 0.18);
          vec3 warm = vec3(1.0, 0.88, 0.62);
          vec3 col = mix(amber, warm, smoothstep(0.25, 0.9, sharp));
          float l = (sharp * 1.45 + glow * 1.6) * night * fade * uAmount;
          gl_FragColor = vec4(col, min(l, 1.0));
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending
    });
    const lightsMesh = new THREE.Mesh(new THREE.SphereGeometry(5.035, 64, 64), lightsMat);
    lightsMesh.renderOrder = 0.6;
    earthGroup.add(lightsMesh);

    // ============================================================
    // WOLKEN
    // Dünne Hülle über der Oberfläche. Tagseite weiß und beleuchtet,
    // Nachtseite kaum sichtbar, leichter Drift gegenüber der Erde.
    // ============================================================
    const cloudMat = new THREE.ShaderMaterial({
      uniforms: {
        uClouds: { value: null },
        uSun: { value: sunDir },
        uFade: { value: 1 }
      },
      vertexShader: SURFACE_VERT,
      fragmentShader: `
        uniform sampler2D uClouds;
        uniform float uFade;
        varying vec2 vUv;
        varying vec3 vN;
        varying vec3 vView;
        varying vec3 vSun;
        void main() {
          vec3 N = normalize(vN);
          float ndl = dot(N, normalize(vSun));
          float dens = texture2D(uClouds, vUv).r;
          dens = smoothstep(0.12, 0.95, dens);

          float day = smoothstep(-0.12, 0.25, ndl);
          vec3 col = mix(vec3(0.05, 0.07, 0.11), vec3(1.0) * (0.22 + 0.85 * max(ndl, 0.0)), day);
          // Nachts dünner, tagsüber deckend
          float alpha = dens * mix(0.10, 0.50, day) * uFade;
          gl_FragColor = vec4(col, alpha);
        }
      `,
      transparent: true,
      depthWrite: false
    });
    const cloudMesh = new THREE.Mesh(new THREE.SphereGeometry(5.05, 96, 96), cloudMat);
    cloudMesh.renderOrder = 0.6;
    earthGroup.add(cloudMesh);

    // Texturen laden; die Startsequenz wartet darauf (this._earthReady)
    this._earthReady = Promise.all([
      loadTex('earth-lights.png'),
      loadTex('earth-clouds.jpg')
    ]).then(([lightsTex, cloudsTex]) => {
      lightsMat.uniforms.uLights.value = lightsTex;
      cloudMat.uniforms.uClouds.value = cloudsTex;
    }).catch((err) => console.warn('OrbitMenu: Erd-Texturen nicht geladen', err));

    // ============================================================
    // STANDORT-MARKER — Punkt mit auslaufendem Puls-Ring
    // Sitzt auf dem Nutzerstandort (Fallback Berlin), wandert bei Änderung.
    // ============================================================
    const homeGeo = new THREE.BufferGeometry();
    homeGeo.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0], 3));
    // Runder, weich auslaufender Punkt statt Quadrat
    const dotCanvas = document.createElement('canvas');
    dotCanvas.width = dotCanvas.height = 64;
    const dotCtx = dotCanvas.getContext('2d');
    const dotGrad = dotCtx.createRadialGradient(32, 32, 0, 32, 32, 32);
    dotGrad.addColorStop(0, 'rgba(255,255,255,1)');
    dotGrad.addColorStop(0.35, 'rgba(255,255,255,0.85)');
    dotGrad.addColorStop(1, 'rgba(255,255,255,0)');
    dotCtx.fillStyle = dotGrad;
    dotCtx.fillRect(0, 0, 64, 64);

    const homeMat = new THREE.PointsMaterial({
      map: new THREE.CanvasTexture(dotCanvas),
      color: 0xe6f4f6,
      size: 0.14,
      sizeAttenuation: true,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    });
    const homePoint = new THREE.Points(homeGeo, homeMat);
    homePoint.renderOrder = 3;
    earthGroup.add(homePoint);

    const pulseMat = new THREE.MeshBasicMaterial({
      color: 0x8cc4ce,
      transparent: true,
      opacity: 0,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    });
    const pulseRing = new THREE.Mesh(new THREE.RingGeometry(0.085, 0.1, 48), pulseMat);
    pulseRing.renderOrder = 3;
    earthGroup.add(pulseRing);

    const placeHome = ({ lat, lon }) => {
      const n = latLonToVec3(lat, lon, 1).normalize();
      const hp = n.clone().multiplyScalar(5.09);
      homeGeo.setAttribute('position', new THREE.Float32BufferAttribute([hp.x, hp.y, hp.z], 3));
      homeGeo.computeBoundingSphere();
      pulseRing.position.copy(n).multiplyScalar(5.085);
      pulseRing.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
    };
    placeHome(userLocation.get());
    this._unsubscribeLocation = userLocation.onChange(placeHome);

    // ============================================================
    // ATMOSPHÄRE
    // Dünner Rand-Glow. BackSide, AdditiveBlending → nur der Rand
    // leuchtet, die Mitte bleibt transparent.
    // ============================================================
    const atmoGeo = new THREE.SphereGeometry(5.12, 32, 32);
    const atmoMat = new THREE.ShaderMaterial({
      uniforms: { uIntensity: { value: 1 } },
      vertexShader: `
        varying vec3 vNormal;
        void main() {
          vNormal = normalize(normalMatrix * normal);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform float uIntensity;
        varying vec3 vNormal;
        void main() {
          float intensity = pow(0.7 - dot(vNormal, vec3(0, 0, 1.0)), 2.6);
          gl_FragColor = vec4(0.0, 0.36, 0.42, 1.0) * intensity * 2.6 * uIntensity;
        }
      `,
      blending: THREE.AdditiveBlending,
      side: THREE.BackSide,
      transparent: true,
      depthWrite: false
    });
    const atmoMesh = new THREE.Mesh(atmoGeo, atmoMat);
    atmoMesh.renderOrder = 999;
    scene.add(atmoMesh);

    // ============================================================
    // RESIZE
    // ============================================================
    const resize = () => {
      const w = container.clientWidth || 460;
      const h = container.clientHeight || 460;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    this._earthResize = resize;
    window.addEventListener('resize', resize);

    // ============================================================
    // EXPAND-EFFEKTE
    // Liefert pro Frame die Effektwerte für Aufladen & Entladung.
    // this._earthFx = { start, release } wird von expand() gesetzt.
    // ============================================================
    const FX_IDLE = { tremble: 0, scale: 1, glow: 0, atmo: 1, boost: 1, zoom: 0, spin: 0 };
    const CHARGE_SCALE = 0.955;

    const computeFx = (now) => {
      const fx = this._earthFx;
      if (!fx) return FX_IDLE;

      if (now < fx.release) {
        // Aufladen: alles steigt beschleunigt an
        const c = clamp01((now - fx.start) / (fx.release - fx.start));
        const ci = easeInCubic(c);
        const cs = easeInOutSine(c);
        return {
          tremble: 0.004 * ci,
          scale: 1 - (1 - CHARGE_SCALE) * cs,
          glow: 0.55 * ci,
          atmo: 1 + 1.4 * ci,
          boost: 1 + 0.45 * ci,
          zoom: 0.55 * cs,
          spin: 0.9 * ci
        };
      }

      // Entladung: kurzer Stoß, danach gedämpftes Ausschwingen
      const r = now - fx.release;
      if (r > 2200) {
        this._earthFx = null;
        return FX_IDLE;
      }
      // amp < 1 → schwächerer Stoß ohne Aufladen (Einsammeln der Widgets)
      const a = fx.amp ?? 1;
      const from = a < 1 ? 1 : CHARGE_SCALE;
      const spring = 1 + 0.075 * a * Math.exp(-r / 230) * Math.cos(r * 0.016);
      const attack = easeOutCubic(clamp01(r / 70));
      return {
        tremble: 0.03 * a * Math.exp(-r / 170),
        scale: from + (spring - from) * attack,
        glow: 0.7 * a * Math.exp(-r / 450),
        atmo: 1 + 2.4 * a * Math.exp(-r / 320),
        boost: 1 + 0.9 * a * Math.exp(-r / 380),
        zoom: 0.55 * a * Math.exp(-r / 200),
        spin: 0.9 * a * Math.exp(-r / 600)
      };
    };

    // ============================================================
    // RENDER-LOOP — 30 fps im Ruhezustand, 60 fps während der Animation
    // ============================================================
    const start = performance.now();
    let lastNow = start;
    let lastEarthFrame = 0;
    let lastSunUpdate = start;

    const tick = (now) => {
      this._earthRafId = requestAnimationFrame(tick);

      // 2 ms Toleranz, sonst werden durch RAF-Jitter Frames verworfen
      const zooming = Math.abs(this._zoomTarget - this._zoom) > 0.0005;
      const interval = (this._earthFx || zooming) ? 1000 / 60 : 1000 / 30;
      if (now - lastEarthFrame < interval - 2) return;
      lastEarthFrame = now;

      // Außerhalb von HOME ist die Erde unsichtbar – GPU nicht belasten
      if (ViewManager.getState() !== 'HOME') {
        lastNow = now;
        return;
      }

      const t = (now - start) / 1000;
      const dt = Math.min(0.05, (now - lastNow) / 1000);
      lastNow = now;

      // Zoom: weich auf den Zielwert, danach Auflösung nachziehen
      if (zooming) {
        this._zoom += (this._zoomTarget - this._zoom) * (1 - Math.exp(-dt * 10));
        if (Math.abs(this._zoomTarget - this._zoom) < 0.0005) this._zoom = this._zoomTarget;
        this._earthEl.style.transform = `scale(${(this._zoom / this._zoomBase).toFixed(4)})`;
        this._zoomIdleAt = now;
      } else if (this._zoom !== this._zoomBase && now - this._zoomIdleAt > 200) {
        this._commitZoom();
      }

      const fx = computeFx(now);

      const baseZ = this._earthCameraBaseZ - fx.zoom;
      if (fx.tremble > 0.0005) {
        // Zittern über die Kamera – bewegt Erde, Linien und Atmosphäre gemeinsam
        const jx = (Math.random() - 0.5) * 2 * fx.tremble;
        const jy = (Math.random() - 0.5) * 2 * fx.tremble;
        camera.position.set(jx, jy, baseZ);
        camera.lookAt(jx * 0.6, jy * 0.6, 0);
      } else if (camera.position.x !== 0 || camera.position.y !== 0 || camera.position.z !== baseZ) {
        // x/y mitprüfen, damit nach dem Zittern kein Versatz stehen bleibt
        camera.position.set(0, 0, baseZ);
        camera.lookAt(0, 0, 0);
      }

      earthGroup.scale.setScalar(fx.scale);
      atmoMesh.scale.setScalar(fx.scale);
      atmoMat.uniforms.uIntensity.value = fx.atmo;
      landMat.uniforms.uBoost.value = fx.boost;

      // Startaufbau: Linien ziehen sich, Land/Atmosphäre/Städte blenden danach ein
      const boot = this._bootValue(now);
      const lineT = easeInOutSine(boot);
      const fade = smoothstep(0.3, 1, boot);
      [baseLines, glowLines].forEach((l) => {
        const cnt = l.geometry.attributes.position ? l.geometry.attributes.position.count : 0;
        l.geometry.setDrawRange(0, lineT >= 1 ? Infinity : Math.floor(cnt * lineT / 2) * 2);
      });
      landMat.uniforms.uFade.value = fade;
      nightMat.uniforms.uAmount.value = smoothstep(0.5, 1, boot);
      lightsMat.uniforms.uAmount.value = smoothstep(0.6, 1, boot);
      cloudMat.uniforms.uFade.value = fade;
      atmoMat.uniforms.uIntensity.value *= fade;

      glowMat.opacity = 0.3 + fx.glow;
      baseMat.opacity = Math.min(1, 0.7 + fx.glow * 0.4);

      earthGroup.rotation.y += dt * (0.12 + fx.spin);
      cloudMesh.rotation.y += dt * 0.006;   // Wolken driften langsam gegen die Erde

      // Sonnenstand nur minütlich neu berechnen
      if (now - lastSunUpdate > 60000) {
        lastSunUpdate = now;
        updateSun();
      }

      // Standort: Punkt atmet, Ring läuft alle 3 s aus
      homeMat.size = (0.13 + Math.sin(t * 2.4) * 0.03) * smoothstep(0.75, 1, boot);
      const ph = (t % 3) / 3;
      pulseRing.scale.setScalar(1 + ph * 4);
      pulseMat.opacity = (1 - ph) * (1 - ph) * 0.8 * smoothstep(0.75, 1, boot);

      renderer.render(scene, camera);
    };

    this._earthFx = null;
    this._earthRafId = requestAnimationFrame(tick);

    this._three = { scene, camera, renderer };
    this._earthGroup = earthGroup;
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

    const reduced = !!(window.matchMedia &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches);
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

    const reduced = !!(window.matchMedia &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches);
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
      '.orbit-spark, .orbit-trail-dot, .orbit-warp-burst, .orbit-fx'
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

      const t = (now - start) / 1000;
      const dt = Math.min(50, now - lastNow);
      lastNow = now;

      const isHome = ViewManager.getState() === 'HOME';

      if (isHome && this._expanded && !this._transitioning) {
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
      if (pxDelta > 0.01 || pyDelta > 0.01) {
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

    const itemEntry = this._items.find(i => i.el === btn);
    if (itemEntry) itemEntry.warping = true;

    const rect = btn.getBoundingClientRect();
    const startLeft = rect.left;
    const startTop = rect.top;
    const w = rect.width;
    const h = rect.height;
    const centerX = startLeft + w / 2;
    const centerY = startTop + h / 2;

    const vpCx = window.innerWidth / 2;
    const vpCy = window.innerHeight / 2;

    btn.style.position = 'fixed';
    btn.style.left = startLeft + 'px';
    btn.style.top = startTop + 'px';
    btn.style.width = w + 'px';
    btn.style.height = h + 'px';
    btn.style.marginLeft = '0';
    btn.style.marginTop = '0';
    btn.style.transform = 'translate3d(0, 0, 0) scale(1)';
    btn.style.zIndex = '9999';
    btn.style.pointerEvents = 'none';

    void btn.offsetWidth;

    btn.classList.add('is-warping');
    btn.classList.add('is-shrinking');

    setTimeout(() => {
      btn.style.opacity = '0';
      btn.style.visibility = 'hidden';

      const spark = document.createElement('div');
      spark.className = 'orbit-spark';
      spark.style.left = centerX + 'px';
      spark.style.top = centerY + 'px';
      document.body.appendChild(spark);

      const trailDots = [];
      const spawnTrailDot = () => {
        const sLeft = parseFloat(spark.style.left) || centerX;
        const sTop  = parseFloat(spark.style.top) || centerY;

        const dot = document.createElement('div');
        dot.className = 'orbit-trail-dot';
        dot.style.left = sLeft + 'px';
        dot.style.top  = sTop + 'px';
        document.body.appendChild(dot);
        trailDots.push(dot);

        setTimeout(() => {
          dot.remove();
          const idx = trailDots.indexOf(dot);
          if (idx >= 0) trailDots.splice(idx, 1);
        }, 700);
      };

      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          spark.classList.add('is-flying');
          spark.style.left = vpCx + 'px';
          spark.style.top  = vpCy + 'px';
          spark.style.transform = 'scale(0.55)';
        });
      });

      const trailInterval = setInterval(spawnTrailDot, 22);

      setTimeout(() => {
        clearInterval(trailInterval);
        spawnTrailDot();
        spark.classList.add('is-arrived');

        const core = this.root.querySelector('.orbit-core');
        if (core) {
          core.classList.add('is-pulsing');
          setTimeout(() => core.classList.remove('is-pulsing'), 900);
        }

        const burst = document.createElement('div');
        burst.className = 'orbit-warp-burst';
        document.body.appendChild(burst);
        setTimeout(() => burst.remove(), 1200);

        this.onOpenProject(project);

        setTimeout(() => {
          spark.remove();
          trailDots.forEach(d => d.remove());
          trailDots.length = 0;

          btn.classList.remove('is-warping', 'is-shrinking');
          btn.style.position = '';
          btn.style.left = '';
          btn.style.top = '';
          btn.style.width = '';
          btn.style.height = '';
          btn.style.marginLeft = '';
          btn.style.marginTop = '';
          btn.style.transform = '';
          btn.style.zIndex = '';
          btn.style.pointerEvents = '';
          btn.style.opacity = '';
          btn.style.visibility = '';

          if (itemEntry) itemEntry.warping = false;
          this._widgetsDirty = true;
        }, 400);
      }, 420);
    }, 320);
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

  show() { this.root.style.opacity = '1'; this.root.style.pointerEvents = 'auto'; }
  hide() { this.root.style.opacity = '0'; this.root.style.pointerEvents = 'none'; }

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
    if (typeof this._unsubscribeView === 'function') {
      this._unsubscribeView();
    }
    this.root.innerHTML = '';
    this._items = [];
  }
}
