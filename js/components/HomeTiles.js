import { ViewManager } from '../core/ViewManager.js';
import { weather } from '../modules/WeatherModule.js';

/**
 * Dezente Glas-Kacheln hinter der Erde (Wetter) – reine Anzeige,
 * ohne Interaktion. Liegen unter #stage, Erde und Orbit ziehen darüber.
 *
 * Aufbau je Kachel:
 *   .glass-tile          → Position, Parallaxe (Maus) + Ein-/Ausblenden
 *     .glass-tile-float  → Schwebe-Animation (eigene Ebene, damit sich
 *                          die transforms nicht überschreiben)
 *       .glass-tile-body → Glas-Fläche
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
      ${this._tileHTML('weather', weather.buildWidgetHTML())}
    `;
    parent.appendChild(this.root);

    weather.bindWidget(this.root.querySelector('.glass-tile--weather'));

    this._bindPointer();
  }

  _tileHTML(type, content) {
    return `
      <section class="glass-tile glass-tile--${type}">
        <div class="glass-tile-float">
          <div class="glass-tile-body">${content}</div>
        </div>
      </section>`;
  }

  _bindPointer() {
    // Parallaxe: Kacheln driften leicht gegen die Mausbewegung
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
