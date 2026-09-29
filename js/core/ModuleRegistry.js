import { ViewManager } from './ViewManager.js';

/**
 * Zentrale Verwaltung aller Orbit-Module.
 *
 * Eine Modul-Definition (siehe js/modules/index.js):
 *
 *   {
 *     id:     'nfl',                 // = project.target in projects.js
 *     mount:  '#nfl-wrapper',        // optional, Standard: '#<id>-mount'
 *     styles: 'css/modules/nfl.css', // optional, wird bei Bedarf nachgeladen
 *     create(el) { return new NflModule(el); },
 *
 *     // Optionale Hooks – bekommen immer zuerst die Instanz:
 *     onEnter(inst, prevState)       // Modul wird aktiv
 *     onLeave(inst, nextState)       // Modul wird verlassen
 *     onKeyDown(inst, event)         // Taste, nur solange aktiv
 *     onResize(inst)                 // Fenstergröße geändert (entprellt)
 *     tick(inst)                     // jeder Animation-Frame
 *     onVisibilityChange(inst, hidden)
 *   }
 *
 * Abgeleitet aus der id:
 *   State      → '<ID>_FOCUS'   (z. B. 'NFL_FOCUS')
 *   Body-Klasse → 'state-<id>'
 *   Slot        → '#<id>-slot' (wird angelegt, falls nicht im HTML vorhanden)
 *
 * Der aktive Slot bekommt die Klasse .is-active – die Ein-/Ausblend-
 * Animation dafür steckt generisch in main.css.
 */

const _modules = new Map();   // id → { def, state, slot, instance }

function _stateOf(id) {
  return `${id.toUpperCase()}_FOCUS`;
}

function _ensureStyles(href) {
  if (!href) return;
  const hrefs = Array.isArray(href) ? href : [href];
  hrefs.forEach(h => {
    if (document.querySelector(`link[rel="stylesheet"][href="${h}"]`)) return;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = h;
    document.head.appendChild(link);
  });
}

function _ensureSlot(id) {
  let slot = document.getElementById(`${id}-slot`);
  if (!slot) {
    slot = document.createElement('div');
    slot.id = `${id}-slot`;
    slot.className = 'module-slot';
    slot.innerHTML = `<div class="module-inner" id="${id}-mount"></div>`;
    document.getElementById('stage').appendChild(slot);
  }
  return slot;
}

function _call(entry, hook, ...args) {
  const fn = entry.def[hook];
  if (typeof fn !== 'function' || !entry.instance) return;
  try { fn(entry.instance, ...args); }
  catch (err) { console.error(`[ModuleRegistry] ${entry.def.id}.${hook}:`, err); }
}

export const ModuleRegistry = {
  /**
   * Registriert Definitionen und meldet ihre States beim ViewManager an.
   */
  register(...defs) {
    defs.flat().forEach(def => {
      if (!def || !def.id || typeof def.create !== 'function') {
        console.warn('[ModuleRegistry] ungültige Definition:', def);
        return;
      }
      if (_modules.has(def.id)) {
        console.warn(`[ModuleRegistry] "${def.id}" ist bereits registriert`);
        return;
      }
      const state = _stateOf(def.id);
      ViewManager.registerState(state, `state-${def.id}`);
      _modules.set(def.id, { def, state, slot: null, instance: null });
    });
    return this;
  },

  /**
   * Legt Slots an, lädt Styles und erzeugt alle Instanzen.
   * Danach laufen Resize, Tick, Tastatur und Sichtbarkeit zentral.
   */
  mountAll() {
    _modules.forEach(entry => {
      const { def } = entry;
      _ensureStyles(def.styles);
      entry.slot = _ensureSlot(def.id);

      const el = document.querySelector(def.mount || `#${def.id}-mount`);
      if (!el) {
        console.error(`[ModuleRegistry] Mount für "${def.id}" nicht gefunden`);
        return;
      }
      try {
        entry.instance = def.create(el) || {};
      } catch (err) {
        console.error(`[ModuleRegistry] "${def.id}" konnte nicht erzeugt werden:`, err);
      }
    });

    this._bindGlobal();
    return this;
  },

  has(id) {
    return _modules.has(id);
  },

  get(id) {
    return _modules.get(id)?.instance ?? null;
  },

  /**
   * Das gerade fokussierte Modul (oder null auf HOME).
   */
  active() {
    const state = ViewManager.getState();
    for (const entry of _modules.values()) {
      if (entry.state === state) return entry;
    }
    return null;
  },

  /**
   * Öffnet ein Modul. Gibt false zurück, wenn die id unbekannt ist.
   */
  open(id) {
    const entry = _modules.get(id);
    if (!entry || !entry.instance) return false;
    ViewManager.setState(entry.state);
    return true;
  },

  _bindGlobal() {
    ViewManager.onChange((next, prev) => {
      _modules.forEach(entry => {
        const isActive = entry.state === next;
        entry.slot?.classList.toggle('is-active', isActive);
        if (entry.state === prev) _call(entry, 'onLeave', next);
        if (isActive) _call(entry, 'onEnter', prev);
      });
    });

    document.addEventListener('keydown', e => {
      if (document.body.classList.contains('modal-open')) return;
      const entry = this.active();
      if (entry) _call(entry, 'onKeyDown', e);
    });

    let resizeTimer = null;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        _modules.forEach(entry => _call(entry, 'onResize'));
      }, 80);
    });

    document.addEventListener('visibilitychange', () => {
      _modules.forEach(entry => _call(entry, 'onVisibilityChange', document.hidden));
    });

    const tickers = [..._modules.values()].filter(e => typeof e.def.tick === 'function');
    if (tickers.length) {
      (function loop() {
        tickers.forEach(entry => _call(entry, 'tick'));
        requestAnimationFrame(loop);
      })();
    }
  }
};
