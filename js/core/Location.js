/**
 * Standort des Nutzers: Erde-Marker und Wetter hängen daran.
 *
 * Ablauf: zuletzt bekannter Standort (localStorage) oder Berlin sofort,
 * dann fragt start() den Browser nach dem echten Standort. Wird die
 * Freigabe verweigert oder dauert zu lange, bleibt der bisherige Wert.
 *
 * Datenschutz: Koordinaten werden auf 2 Nachkommastellen (~1 km)
 * gerundet, bevor sie Wetter- oder Geocoding-Dienst erreichen.
 */
const FALLBACK = { lat: 52.52, lon: 13.4, name: 'Berlin', isFallback: true };
const STORAGE_KEY = 'holo-location';
const MIN_MOVE_DEG = 0.05;   // kleinere Abweichungen gelten als derselbe Ort

const round2 = (n) => Math.round(n * 100) / 100;

function readCache() {
  try {
    const c = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (c && Number.isFinite(c.lat) && Number.isFinite(c.lon) && c.name) {
      return { lat: c.lat, lon: c.lon, name: String(c.name), isFallback: false };
    }
  } catch (_) {}
  return null;
}

class UserLocation {
  constructor() {
    this._current = readCache() || FALLBACK;
    this._listeners = new Set();
    this._started = false;
  }

  get() {
    return this._current;
  }

  /** cb(location) bei jeder Änderung; liefert die Abmeldefunktion. */
  onChange(cb) {
    this._listeners.add(cb);
    return () => this._listeners.delete(cb);
  }

  start() {
    if (this._started || !navigator.geolocation) return;
    this._started = true;
    navigator.geolocation.getCurrentPosition(
      (pos) => this._resolve(round2(pos.coords.latitude), round2(pos.coords.longitude)),
      () => {},   // verweigert/Timeout: beim letzten Wert bleiben
      { timeout: 8000, maximumAge: 10 * 60 * 1000 }
    );
  }

  async _resolve(lat, lon) {
    const cur = this._current;
    const samePlace = !cur.isFallback &&
      Math.abs(cur.lat - lat) < MIN_MOVE_DEG && Math.abs(cur.lon - lon) < MIN_MOVE_DEG;
    if (samePlace) return;

    const name = await this._reverseGeocode(lat, lon);
    this._current = { lat, lon, name, isFallback: false };
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ lat, lon, name })); } catch (_) {}
    this._listeners.forEach((cb) => cb(this._current));
  }

  async _reverseGeocode(lat, lon) {
    try {
      const url = 'https://api.bigdatacloud.net/data/reverse-geocode-client' +
        `?latitude=${lat}&longitude=${lon}&localityLanguage=de`;
      const r = await fetch(url);
      if (!r.ok) throw new Error(r.status);
      const d = await r.json();
      return d.city || d.locality || d.principalSubdivision || 'Standort';
    } catch (_) {
      return 'Standort';
    }
  }
}

export const userLocation = new UserLocation();
