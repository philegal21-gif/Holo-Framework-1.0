export const ViewManager = {
  STATES: {
    HOME: 'HOME',
    CAROUSEL_FOCUS: 'CAROUSEL_FOCUS',
    SPHERE_FOCUS: 'SPHERE_FOCUS',
    WATCHTIME_FOCUS: 'WATCHTIME_FOCUS',
    NFL_FOCUS: 'NFL_FOCUS',
    NEURAL_FOCUS: 'NEURAL_FOCUS'
  },

  _state: 'HOME',
  _listeners: new Set(),   // Set statt Array → O(1) delete, keine Duplikate

  getState() {
    return this._state;
  },

  setState(newState) {
    if (!Object.values(this.STATES).includes(newState)) return;
    if (this._state === newState) return;

    const prev = this._state;
    this._state = newState;

    document.body.classList.remove(
      'state-home', 'state-carousel', 'state-sphere', 'state-watchtime', 'state-nfl', 'state-neural'
    );

    // Mapping statt if-Kette – kürzer und einfacher zu erweitern
    const stateClass = {
      HOME: 'state-home',
      CAROUSEL_FOCUS: 'state-carousel',
      SPHERE_FOCUS: 'state-sphere',
      WATCHTIME_FOCUS: 'state-watchtime',
      NFL_FOCUS: 'state-nfl',
      NEURAL_FOCUS: 'state-neural'
    }[newState];

    if (stateClass) document.body.classList.add(stateClass);

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

  goHome()        { this.setState('HOME'); },
  focusCarousel() { this.setState('CAROUSEL_FOCUS'); },
  focusSphere()   { this.setState('SPHERE_FOCUS'); },
  focusWatchtime(){ this.setState('WATCHTIME_FOCUS'); },
  focusNfl()      { this.setState('NFL_FOCUS'); },
  focusNeural()   { this.setState('NEURAL_FOCUS'); }
};