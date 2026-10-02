import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { SavePass } from 'three/addons/postprocessing/SavePass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { ViewManager } from '../core/ViewManager.js';
import { userLocation } from '../core/Location.js';
import { createIss } from './EarthIss.js';
import {
  clamp01, easeInCubic, easeOutCubic, easeInOutSine, smoothstep
} from '../core/utils.js';

/**
 * Die Erde (Three.js): Holo-Kugel mit Land, Küsten, Terminator, Nachtlichtern,
 * Wolken, Standort-Marker und Atmosphäre. Läuft in einem eigenen Render-Loop.
 *
 * Wird vom OrbitMenu aufgerufen und hängt Zustand an dessen Instanz
 * (_three, _earthGroup, _earthResize, _earthFx, _earthReady, …), weil Öffnen,
 * Schließen, Zoom und Startsequenz dort gesteuert werden.
 */

// Neigung der Erdachse zur Kamera (rad): Norden kippt nach vorn, Europa rückt ins Bild
const EARTH_TILT = 0.6;

// Aufbau der Erde beim Start (ms): Linien ziehen sich, Land blendet ein
export const BOOT_EARTH_MS = 2400;

/**
 * Baut die Erde in `container` und startet ihren Render-Loop.
 * @param {import('./OrbitMenu.js').OrbitMenu} orbit  Besitzer des Zustands
 */
export function buildEarth(orbit, container) {
  const width = container.clientWidth || 460;
  const height = container.clientHeight || 460;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 1000);
  orbit._earthCamera = camera;
  orbit._earthCameraBaseZ = 15;

  camera.position.set(0, 0, 15);
  camera.lookAt(0, 0, 0);

  const renderer = new THREE.WebGLRenderer({
    alpha: true,
    antialias: true,
    premultipliedAlpha: false,
    powerPreference: 'high-performance',
    stencil: false
  });
  const basePixelRatio = Math.min(window.devicePixelRatio || 1, 2);
  renderer.setPixelRatio(basePixelRatio);
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

  // ============================================================
  // BLOOM + TONE MAPPING
  // Pipeline: Szene → (Kopie der Szene) → Bloom → Schlusspass.
  // Der Canvas ist durchsichtig; deshalb wird das reine Leuchten (Bloom minus
  // Szene) getrennt und im Schlusspass auf Schwarz gerechnet:
  //   P = Szene.rgb * Szene.alpha + weiches(Leuchten)   (premultipliziert auf Schwarz)
  //   alpha = max(Szene.alpha, max(Leuchten))     → Leuchten bleibt auch über
  //                                                  durchsichtigen Stellen sichtbar
  // Wo kein Leuchten ist, kommt exakt die alte Szene heraus.
  // Qualität: ?quality=high|low erzwingt an/aus; sonst schaltet eine Messung
  // den Bloom bei zu langsamen Frames ab.
  // ============================================================
  const qualityParam = (location.search.match(/[?&]quality=(high|low)/) || [])[1];
  // Touch-Geräte (Handy/Tablet): Bloom nur auf Wunsch, dort flackerte er an hellen Punkten
  const touchDevice = window.matchMedia('(pointer: coarse)').matches;
  orbit._bloomOn = qualityParam ? qualityParam === 'high' : !touchDevice;
  const autoQuality = !qualityParam && !touchDevice;

  const pr0 = renderer.getPixelRatio();
  // 8 Bit wie der normale Canvas: Überlagerungen (leuchtende Linien) werden bei jedem
  // Schritt bei 1 abgeschnitten, das Bild bleibt so identisch zum Pfad ohne Bloom
  const composerRT = new THREE.WebGLRenderTarget(width * pr0, height * pr0, {
    type: THREE.UnsignedByteType,
    samples: 4
  });
  const composer = new EffectComposer(renderer, composerRT);
  composer.setPixelRatio(pr0);
  composer.setSize(width, height);

  const scenePass = new RenderPass(null, camera);   // Szene wird unten gesetzt
  const savePass = new SavePass(new THREE.WebGLRenderTarget(width * pr0, height * pr0, {
    type: THREE.UnsignedByteType
  }));
  const bloomPass = new UnrealBloomPass(new THREE.Vector2(width, height), 0.7, 0.55, 0.78);
  const finalPass = new ShaderPass({
    uniforms: { tDiffuse: { value: null }, tScene: { value: null } },
    vertexShader: `
      varying vec2 vUv;
      void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
    `,
    fragmentShader: `
      uniform sampler2D tDiffuse;
      uniform sampler2D tScene;
      varying vec2 vUv;
      void main() {
        vec4 s = texture2D(tScene, vUv);
        vec3 glow = max(texture2D(tDiffuse, vUv).rgb - s.rgb, 0.0);

        // Weiche Schulter nur auf das Leuchten: starkes Leuchten läuft sanft aus.
        glow = 1.0 - exp(-glow * 1.4);

        // Der Canvas zeigt die Szene-Farben unverändert (ohne Leuchten kommt exakt
        // s.rgb / s.alpha heraus); das Leuchten wird über Alpha additiv dazugemischt.
        float a = max(s.a, max(glow.r, max(glow.g, glow.b)));
        vec3 p = s.rgb * s.a + glow;
        gl_FragColor = vec4(p / max(a, 1e-4), a);
      }
    `
  });
  // Render-Target-Texturen dürfen nicht über den Konstruktor (cloneUniforms) übergeben werden
  finalPass.uniforms.tScene.value = savePass.renderTarget.texture;
  composer.addPass(scenePass);
  composer.addPass(savePass);
  composer.addPass(bloomPass);
  composer.addPass(finalPass);

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
    // Dunkles Land mit Hauch Petrol; Kanten und Küsten tragen die Farbe
    grad.addColorStop(0.0, 'rgba(7, 32, 38, 0.86)');
    grad.addColorStop(0.5, 'rgba(5, 26, 31, 0.86)');
    grad.addColorStop(1.0, 'rgba(3, 20, 25, 0.86)');
    ctx.fillStyle = grad;
    ctx.fill('nonzero');

    ctx.save();
    ctx.clip('nonzero');

    // Holo-Schraffur auf dem Land
    ctx.strokeStyle = 'rgba(140, 196, 206, 0.035)';
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
    ctx.strokeStyle = 'rgba(92, 170, 182, 0.6)';
    ctx.lineWidth = 2.5;
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
        vec3 col = mix(vec3(0.04, 0.07, 0.10), vec3(0.86, 0.94, 1.0) * (0.22 + 0.85 * max(ndl, 0.0)), day);
        // Nachts dünner, tagsüber deckend
        float alpha = dens * mix(0.05, 0.36, day) * uFade;
        gl_FragColor = vec4(col, alpha);
      }
    `,
    transparent: true,
    depthWrite: false
  });
  const cloudMesh = new THREE.Mesh(new THREE.SphereGeometry(5.05, 96, 96), cloudMat);
  cloudMesh.renderOrder = 0.6;
  earthGroup.add(cloudMesh);

  // ============================================================
  // HÖHENLINIEN
  // Isolinien aus der Höhenkarte, nur an Land (Meer = 0). Die Stufen sind
  // zu niedrigen Höhen hin enger (Potenz), damit auch Flachland Linien bekommt.
  // ============================================================
  const contourMat = new THREE.ShaderMaterial({
    uniforms: { uHeight: { value: null }, uFade: { value: 1 } },
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
      uniform sampler2D uHeight;
      uniform float uFade;
      varying vec2 vUv;
      varying vec3 vNormal;
      void main() {
        float h = texture2D(uHeight, vUv).r;
        float level = pow(h, 0.65) * 16.0;
        float dist = abs(fract(level - 0.5) - 0.5) / max(fwidth(level), 1e-4);
        float line = 1.0 - smoothstep(0.0, 1.2, dist);
        float land = smoothstep(0.02, 0.06, h);
        float facing = clamp(dot(normalize(vNormal), vec3(0.0, 0.0, 1.0)), 0.0, 1.0);
        float fade = 0.2 + 0.8 * smoothstep(0.0, 0.5, facing);
        gl_FragColor = vec4(0.35, 0.78, 0.85, line * land * fade * 0.11 * uFade);
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending
  });
  const contourMesh = new THREE.Mesh(new THREE.SphereGeometry(5.025, 128, 128), contourMat);
  contourMesh.renderOrder = 0.55;
  earthGroup.add(contourMesh);

  // Texturen laden; die Startsequenz wartet darauf (orbit._earthReady)
  orbit._earthReady = Promise.all([
    loadTex('earth-lights.png'),
    loadTex('earth-clouds.jpg'),
    loadTex('earth-height.png')
  ]).then(([lightsTex, cloudsTex, heightTex]) => {
    contourMat.uniforms.uHeight.value = heightTex;
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
  orbit._unsubscribeLocation = userLocation.onChange(placeHome);

  // ISS: Live-Position mit Bahnspur
  const iss = createIss(earthGroup, latLonToVec3);
  orbit._disposeIss = () => iss.dispose();

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
  const MAX_BUFFER_PX = 3000;   // längste Seite des Zeichenpuffers
  const resize = () => {
    const w = container.clientWidth || 460;
    const h = container.clientHeight || 460;
    // Beim Hineinzoomen schon in der Auflösung der Zielgröße rendern: das CSS-Skalieren
    // bleibt scharf und beim Einrasten springt nichts mehr nach.
    const grow = Math.max(1, orbit._zoomTarget / orbit._zoomBase);
    const pr = Math.min(basePixelRatio * grow, MAX_BUFFER_PX / Math.max(w, h));
    renderer.setPixelRatio(pr);
    composer.setPixelRatio(pr);
    renderer.setSize(w, h, false);
    composer.setSize(w, h);
    savePass.renderTarget.setSize(w * pr, h * pr);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  orbit._earthResize = resize;
  window.addEventListener('resize', resize);

  // ============================================================
  // EXPAND-EFFEKTE
  // Liefert pro Frame die Effektwerte für Aufladen & Entladung.
  // orbit._earthFx = { start, release } wird von expand() gesetzt.
  // ============================================================
  const FX_IDLE = { tremble: 0, scale: 1, glow: 0, atmo: 1, boost: 1, zoom: 0, spin: 0 };
  const CHARGE_SCALE = 0.955;

  const computeFx = (now) => {
    const fx = orbit._earthFx;
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
      orbit._earthFx = null;
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
  let slowFrames = 0;
  let pixelGrow = 1;   // Auflösungsfaktor, auf den der Puffer schon vergrößert wurde
  let lastSunUpdate = start;

  const tick = (now) => {
    orbit._earthRafId = requestAnimationFrame(tick);

    // 2 ms Toleranz, sonst werden durch RAF-Jitter Frames verworfen
    const zooming = Math.abs(orbit._zoomTarget - orbit._zoom) > 0.0005;
    const interval = (orbit._earthFx || zooming) ? 1000 / 60 : 1000 / 30;
    if (now - lastEarthFrame < interval - 2) return;
    lastEarthFrame = now;

    // Außerhalb von HOME ist die Erde unsichtbar – GPU nicht belasten
    if (ViewManager.getState() !== 'HOME') {
      lastNow = now;
      return;
    }

    const t = (now - start) / 1000;
    const rawMs = now - lastNow;
    const dt = Math.min(0.05, rawMs / 1000);
    lastNow = now;

    // Automatische Qualität: bleiben die Frames dauerhaft deutlich über dem Soll
    // (30 fps ≈ 33 ms), wird der Bloom abgeschaltet
    if (autoQuality && orbit._bloomOn && !orbit._earthFx) {
      slowFrames = rawMs > 55 ? slowFrames + 1 : Math.max(0, slowFrames - 2);
      if (slowFrames > 60) {
        orbit._bloomOn = false;
        console.info('[Erde] Bloom wegen niedriger Bildrate abgeschaltet (?quality=high erzwingt ihn)');
      }
    }

    // Zoom: weich auf den Zielwert, danach Auflösung nachziehen
    if (zooming) {
      orbit._zoom += (orbit._zoomTarget - orbit._zoom) * (1 - Math.exp(-dt * 10));
      if (Math.abs(orbit._zoomTarget - orbit._zoom) < 0.0005) orbit._zoom = orbit._zoomTarget;
      orbit._earthEl.style.transform = `scale(${(orbit._zoom / orbit._zoomBase).toFixed(4)})`;
      // Zielauflösung vorab einstellen (nur wachsend, damit schnelles Zoomen nicht ständig neu anlegt)
      if (orbit._zoomTarget / orbit._zoomBase > pixelGrow * 1.05) {
        pixelGrow = orbit._zoomTarget / orbit._zoomBase;
        resize();
      }
      orbit._zoomIdleAt = now;
    } else if (orbit._zoom !== orbit._zoomBase && now - orbit._zoomIdleAt > 200) {
      orbit._commitZoom();
      pixelGrow = 1;
    }

    const fx = computeFx(now);

    const baseZ = orbit._earthCameraBaseZ - fx.zoom;
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
    const boot = orbit._bootValue(now);
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
    contourMat.uniforms.uFade.value = fade;
    atmoMat.uniforms.uIntensity.value *= fade;

    // Linien sind immer 1 px dünn: beim Herauszoomen rücken sie dichter zusammen und
    // addieren sich zu hell, darum mit der Zoomstufe dimmen (ab Zoom 1 unverändert)
    const lineDim = Math.min(1, Math.max(0.25, Math.pow(orbit._zoom, 1.6)));
    glowMat.opacity = (0.3 + fx.glow) * lineDim;
    baseMat.opacity = Math.min(1, 0.7 + fx.glow * 0.4) * (0.35 + 0.65 * lineDim);

    if (!orbit._rotFrozen) {
      earthGroup.rotation.y += dt * (0.12 + fx.spin);
      cloudMesh.rotation.y += dt * 0.006;   // Wolken driften langsam gegen die Erde
    }

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

    iss.update(boot);

    if (orbit._bloomOn) {
      scenePass.scene = scene;
      composer.render();
    } else {
      renderer.render(scene, camera);
    }
  };

  orbit._earthFx = null;
  orbit._earthRafId = requestAnimationFrame(tick);

  orbit._three = { scene, camera, renderer };
  orbit._earthGroup = earthGroup;
}
