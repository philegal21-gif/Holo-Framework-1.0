import { ViewManager } from '../core/ViewManager.js';
import { weather } from '../modules/WeatherModule.js';

/**
 * Wetter-Label und Uhr als schwebende Holo-Texte auf der Startseite – reiner Text mit
 * feiner Leitlinie, ohne Kasten und ohne Interaktion. Liegt unter #stage,
 * Erde und Orbit ziehen darüber.
 *
 * Aufbau:
 *   .weather-label          → Position, Parallaxe (Maus) + Ein-/Ausblenden
 *     .weather-label-float  → Schwebe-Animation (eigene Ebene, damit sich
 *                             die transforms nicht überschreiben)
 *       [data-weather-widget] → Daten-Anker für WeatherModule
 *
 * Sichtbar nur im State HOME – das Ausblenden steckt in home-tiles.css.
 */
export class HomeTiles {
  constructor(parent = document.body) {
    this._targetX = 0;
    this._targetY = 0;
    this._x = 0;
    this._y = 0;
    this._raf = null;

    this.root = document.createElement('div');
    this.root.id = 'home-tiles';
    this.root.setAttribute('aria-hidden', 'true');
    this.root.innerHTML = `
      <div class="weather-label">
        <div class="weather-label-float">
          <div class="weather-label-body" data-weather-widget>
            <div class="weather-label-main">
              <span class="weather-label-icon" data-weather-icon><i class="fa-solid fa-cloud-sun"></i></span>
              <span class="weather-label-place">BERLIN</span>
              <span class="weather-label-temp"><span data-weather-temperature>--</span>°</span>
            </div>
            <div class="weather-label-condition" data-weather-condition>Lade Wetterdaten...</div>
            <div class="weather-label-line"></div>
          </div>
        </div>
      </div>
      <div class="home-clock">
        <div class="home-clock-float">
          <div class="home-clock-time"><span data-clock-h>--</span><span class="home-clock-colon">:</span><span data-clock-m>--</span></div>
          <div class="home-clock-date" data-clock-date></div>
        </div>
      </div>
    `;
    parent.appendChild(this.root);

    this._startClock();

    weather.bindWidget(this.root.querySelector('.weather-label'));

    this._bindPointer();
  }

  _startClock() {
    const h = this.root.querySelector('[data-clock-h]');
    const m = this.root.querySelector('[data-clock-m]');
    const dateEl = this.root.querySelector('[data-clock-date]');
    const pad = (n) => String(n).padStart(2, '0');

    // ISO-Kalenderwoche (Donnerstag der Woche bestimmt das Jahr)
    const isoWeek = (d) => {
      const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
      t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
      const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
      return Math.ceil(((t - y0) / 86400000 + 1) / 7);
    };

    let last = '';
    const tick = () => {
      const d = new Date();
      const key = `${d.getHours()}:${d.getMinutes()}:${d.getDate()}`;
      if (key === last) return;
      last = key;
      h.textContent = pad(d.getHours());
      m.textContent = pad(d.getMinutes());
      const wd = d.toLocaleDateString('de-DE', { weekday: 'short' }).replace('.', '').toUpperCase();
      dateEl.textContent = `${wd} · ${pad(d.getDate())}.${pad(d.getMonth() + 1)}. · KW ${isoWeek(d)}`;
    };
    tick();
    setInterval(tick, 1000);
  }

  _bindPointer() {
    // Parallaxe: Label driftet leicht gegen die Mausbewegung
    window.addEventListener('mousemove', (e) => {
      if (ViewManager.getState() !== 'HOME') return;
      this._targetX = (e.clientX / window.innerWidth) * 2 - 1;
      this._targetY = (e.clientY / window.innerHeight) * 2 - 1;
      if (!this._raf) this._raf = requestAnimationFrame(() => this._step());
    });
  }

  _step() {
    this._x += (this._targetX - this._x) * 0.08;
    this._y += (this._targetY - this._y) * 0.08;
    this.root.style.setProperty('--px', this._x.toFixed(4));
    this.root.style.setProperty('--py', this._y.toFixed(4));

    const settled = Math.abs(this._targetX - this._x) < 0.001 &&
                    Math.abs(this._targetY - this._y) < 0.001;
    this._raf = settled ? null : requestAnimationFrame(() => this._step());
  }
}
