export const ViewManager = {
  // Wird von der ModuleRegistry um die Modul-States erweitert
  // (z. B. NFL_FOCUS → 'state-nfl').
  STATES: {
    HOME: 'HOME'
  },

  _classes: { HOME: 'state-home' },
  _state: 'HOME',
  _listeners: new Set(),   // Set statt Array → O(1) delete, keine Duplikate

  /**
   * Meldet einen neuen View-State samt Body-Klasse an.
   */
  registerState(state, bodyClass) {
    this.STATES[state] = state;
    this._classes[state] = bodyClass;
  },

  getState() {
    return this._state;
  },

  setState(newState) {
    if (!(newState in this._classes)) return;
    if (this._state === newState) return;

    const prev = this._state;
    this._state = newState;

    document.body.classList.remove(...Object.values(this._classes));
    document.body.classList.add(this._classes[newState]);

    // Snapshot der Listener, damit ein unsubscribe() während des Loops
    // die Iteration nicht durcheinanderbringt.
    [...this._listeners].forEach(fn => {
      try { fn(newState, prev); }
      catch (err) { console.error('[ViewManager] listener error:', err); }
    });
  },

  /**
   * Registriert einen Listener.
   * @returns {Function} unsubscribe-Funktion zum Abmelden.
   */
  onChange(fn) {
    if (typeof fn !== 'function') {
      console.warn('[ViewManager] onChange needs a function');
      return () => {};
    }
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  },

  /**
   * Optional: alle Listener entfernen (z. B. beim Hot-Reload oder Testen).
   */
  clearListeners() {
    this._listeners.clear();
  },

  goHome() { this.setState('HOME'); }
};
