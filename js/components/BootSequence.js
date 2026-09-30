import { ViewManager } from '../core/ViewManager.js';

/**
 * Startsequenz der Startseite:
 *   0.0 s  Sternenhimmel allein, Erde baut sich aus Linien auf
 *   1.6 s  Oberfläche (Titel, Uhr, Wetter, Buttons) blendet ein
 *   2.5 s  Orbit-Icons fliegen aus der Erde ...
 *   danach ... und werden nach kurzer Pause wieder eingesogen
 *
 * Ein Klick oder Tastendruck überspringt den Rest. Bei
 * prefers-reduced-motion entfällt die Sequenz komplett.
 */
const T = {
  ui: 1600,         // Oberfläche einblenden
  open: 2500,       // Orbit-Icons rausfliegen lassen
  hold: 1700,       // so lange bleiben sie draußen
  retryHold: 800    // Wartezeit, falls der Nutzer gerade am Menü ist
};

export class BootSequence {
  static isReduced() {
    return !!(window.matchMedia &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  constructor(orbit) {
    this.orbit = orbit;
    this._timers = [];
    this._done = false;

    if (BootSequence.isReduced()) {
      this._finishUi();
      return;
    }

    this._skip = () => this.skip();
    ['pointerdown', 'keydown', 'wheel'].forEach((evt) =>
      window.addEventListener(evt, this._skip, { capture: true, passive: true, once: true }));

    orbit.playStartup();
    this._at(T.ui, () => this._finishUi());
    this._at(T.open, () => this._openOrbit());
  }

  _at(ms, fn) {
    this._timers.push(setTimeout(fn, ms));
  }

  _finishUi() {
    document.body.classList.remove('is-booting');
    document.body.classList.add('is-booted');
  }

  _openOrbit() {
    if (this._done || ViewManager.getState() !== 'HOME') return;
    this.orbit.expand();
    this._waitIdle(() => this._at(T.hold, () => this._closeOrbit()));
  }

  _waitIdle(fn) {
    const poll = () => {
      if (this._done) return;
      if (this.orbit.isBusy) { this._timers.push(setTimeout(poll, 100)); return; }
      fn();
    };
    this._timers.push(setTimeout(poll, 300));
  }

  _closeOrbit() {
    if (this._done) return;
    if (ViewManager.getState() !== 'HOME' || !this.orbit.isExpanded) return this._end();
    // Nutzer hält das Menü gerade fest → kurz warten, dann nachfassen
    if (this.orbit.isInUse || this.orbit.isBusy) {
      this._at(T.retryHold, () => this._closeOrbit());
      return;
    }
    this.orbit.collapse();
    this._end();
  }

  _end() {
    this._done = true;
    this._cleanup();
  }

  /** Nutzer greift ein: Erde sofort fertig, Oberfläche sichtbar, kein automatisches Öffnen/Schließen. */
  skip() {
    if (this._done) return;
    this._done = true;
    this._cleanup();
    this.orbit.skipStartup();
    this._finishUi();
  }

  _cleanup() {
    this._timers.forEach(clearTimeout);
    this._timers = [];
    ['pointerdown', 'keydown', 'wheel'].forEach((evt) =>
      window.removeEventListener(evt, this._skip, { capture: true }));
  }
}
