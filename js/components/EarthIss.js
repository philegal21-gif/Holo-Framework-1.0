import * as THREE from 'three';
import { smoothstep } from '../core/utils.js';

/**
 * Live-Position der ISS auf der Erde: leuchtender Punkt plus die zuletzt
 * geflogene Bahn. Position kommt alle 5 s von wheretheiss.at; dazwischen wird
 * mit der letzten Geschwindigkeit weitergerechnet, damit der Punkt gleitet.
 * Fällt die Abfrage länger aus, blendet sich die ISS aus.
 */

const API = 'https://api.wheretheiss.at/v1/satellites/25544';
const POLL_MS = 5000;
const MAX_TRAIL = 120;         // Bahnspur: Verlauf der letzten ~45 Minuten + Live-Punkte
const MAX_VERTS = 2400;        // Linienstützpunkte nach dem Runden der Bögen
const RADIUS = 5.2;            // über der Oberfläche (5.0), sonst im Land verschwindend
const MAX_AGE_S = 90;          // so lange ohne neue Messung bleibt die ISS sichtbar (danach aus)
const EXTRAPOLATE_S = 30;      // so lange wird linear weitergerechnet, danach Position halten

/**
 * @param {THREE.Group} earthGroup  Gruppe, die mit der Erde mitdreht
 * @param {(lat:number, lon:number, r:number) => THREE.Vector3} latLonToVec3
 */
export function createIss(earthGroup, latLonToVec3) {
  const dotCanvas = document.createElement('canvas');
  dotCanvas.width = dotCanvas.height = 64;
  const ctx = dotCanvas.getContext('2d');
  const grad = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.3, 'rgba(255,255,255,0.8)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 64, 64);

  const dotGeo = new THREE.BufferGeometry();
  dotGeo.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0], 3));
  const dotMat = new THREE.PointsMaterial({
    map: new THREE.CanvasTexture(dotCanvas),
    color: 0xfff2d8,
    size: 0.3,
    sizeAttenuation: true,
    transparent: true,
    opacity: 0,
    blending: THREE.AdditiveBlending,
    depthWrite: false
  });
  const dot = new THREE.Points(dotGeo, dotMat);
  dot.renderOrder = 4;
  dot.frustumCulled = false;
  earthGroup.add(dot);

  const trailGeo = new THREE.BufferGeometry();
  const trailPos = new Float32Array(MAX_VERTS * 3);
  trailGeo.setAttribute('position', new THREE.BufferAttribute(trailPos, 3));
  trailGeo.setDrawRange(0, 0);
  const trailMat = new THREE.LineBasicMaterial({
    color: 0xffe0b0,
    transparent: true,
    opacity: 0,
    blending: THREE.AdditiveBlending,
    depthWrite: false
  });
  const trail = new THREE.Line(trailGeo, trailMat);
  trail.renderOrder = 4;
  trail.frustumCulled = false;
  earthGroup.add(trail);

  const tmp = new THREE.Vector3();

  /** letzte zwei Messungen: { lat, lon, t } */
  let prev = null;
  let last = null;
  const points = [];            // Bahn als Vector3 (neueste zuletzt)
  let timer = 0;
  let stopped = false;
  const info = { lat: 0, lon: 0, alt: 0, vel: 0, ok: false };

  const push = (lat, lon, tSec) => {
    prev = last;
    // recv = Ankunftszeit auf diesem Gerät: Alter nie gegen die API-Uhr messen,
    // eine abweichende Geräteuhr würde die ISS sonst als "veraltet" ausblenden
    last = { lat, lon, t: tSec, recv: Date.now() / 1000 };
    points.push(latLonToVec3(lat, lon, RADIUS));
    writeTrail();
  };

  // Zwischen zwei Messpunkten entlang des Kugelbogens (statt gerader Sehne) auffüllen,
  // damit die Bahn rund wird
  const writeTrail = () => {
    if (points.length > MAX_TRAIL) points.splice(0, points.length - MAX_TRAIL);
    let n = 0;
    const put = (v) => {
      if (n >= MAX_VERTS) return;
      trailPos[n * 3] = v.x;
      trailPos[n * 3 + 1] = v.y;
      trailPos[n * 3 + 2] = v.z;
      n++;
    };
    for (let i = 0; i < points.length; i++) {
      if (i > 0) {
        const a = points[i - 1].clone().normalize();
        const b = points[i].clone().normalize();
        const ang = Math.acos(Math.min(1, Math.max(-1, a.dot(b))));
        const steps = Math.ceil(ang / 0.02);
        for (let k = 1; k < steps; k++) {
          const sinA = Math.sin(ang);
          const wa = Math.sin((1 - k / steps) * ang) / sinA;
          const wb = Math.sin((k / steps) * ang) / sinA;
          put(tmp.copy(a).multiplyScalar(wa).addScaledVector(b, wb).multiplyScalar(RADIUS));
        }
      }
      put(points[i]);
    }
    trailGeo.attributes.position.needsUpdate = true;
    trailGeo.setDrawRange(0, n);
  };


  // Beim Start die letzten 45 Minuten nachladen (10 Punkte, ein Request)
  const seedTrail = async () => {
    const now = Math.floor(Date.now() / 1000);
    const stamps = Array.from({ length: 10 }, (_, i) => now - (10 - i) * 270);
    try {
      const res = await fetch(`${API}/positions?timestamps=${stamps.join(',')}&units=kilometers`);
      if (!res.ok) return;
      const list = await res.json();
      for (const d of list) {
        if (typeof d.latitude === 'number') points.push(latLonToVec3(d.latitude, d.longitude, RADIUS));
      }
    } catch {
      // ohne Verlauf geht es auch: die Spur wächst dann live
    }
  };

  const poll = async () => {
    if (stopped) return;
    if (!document.hidden) {
      try {
        const res = await fetch(API, { cache: 'no-store' });
        if (!res.ok) throw new Error(res.status);
        const d = await res.json();
        if (typeof d.latitude === 'number' && typeof d.longitude === 'number') {
          push(d.latitude, d.longitude, d.timestamp || Date.now() / 1000);
          info.lat = d.latitude;
          info.lon = d.longitude;
          info.alt = d.altitude;
          info.vel = d.velocity;
          info.ok = true;
        }
      } catch {
        // offline / API weg: weiter mit extrapolierter Position, später ausblenden
      }
    }
    timer = setTimeout(poll, POLL_MS);
  };
  seedTrail().then(() => { writeTrail(); poll(); });

  return {
    info,
    /** Pro Frame: Punkt bewegen und ein-/ausblenden. */
    update(boot) {
      const age = last ? Date.now() / 1000 - last.recv : Infinity;
      const live = info.ok && age < MAX_AGE_S;
      let facing = 0;

      if (last) {
        // Zwischen zwei Abfragen entlang der letzten Bewegung weiterrechnen
        let lat = last.lat;
        let lon = last.lon;
        if (prev && last.t > prev.t) {
          const k = Math.min(age, EXTRAPOLATE_S) / (last.t - prev.t);
          let dLon = last.lon - prev.lon;
          if (dLon > 180) dLon -= 360;
          if (dLon < -180) dLon += 360;
          lat = last.lat + (last.lat - prev.lat) * k;
          lon = last.lon + dLon * k;
        }
        tmp.copy(latLonToVec3(lat, lon, RADIUS));
        dotGeo.attributes.position.setXYZ(0, tmp.x, tmp.y, tmp.z);
        dotGeo.attributes.position.needsUpdate = true;
        // Am Erdrand ausblenden: halb verdeckt ergäbe der Punkt eine grelle Sichel
        tmp.applyMatrix4(earthGroup.matrixWorld);
        facing = smoothstep(0.12, 0.4, tmp.z / RADIUS);
      }

      const target = live ? smoothstep(0.8, 1, boot) * facing : 0;
      dotMat.opacity += (target - dotMat.opacity) * 0.15;
      trailMat.opacity = dotMat.opacity * 0.55;
      dot.visible = trail.visible = dotMat.opacity > 0.01;
      dotMat.size = 0.3 + Math.sin(Date.now() / 400) * 0.03;
    },
    dispose() {
      stopped = true;
      clearTimeout(timer);
      earthGroup.remove(dot, trail);
      dotGeo.dispose(); dotMat.map.dispose(); dotMat.dispose();
      trailGeo.dispose(); trailMat.dispose();
    }
  };
}
