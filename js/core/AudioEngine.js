/**
 * Dezente UI-Sounds, komplett per Web Audio synthetisiert.
 *
 * Alle Sounds laufen über eine gemeinsame Master-Kette
 * (Lautstärke → sanfter Tiefpass → leichter Kompressor), damit nichts
 * spitz oder aufdringlich wird. Jede Stimme hat eine weiche Hüllkurve
 * (Attack + exponentielles Ausklingen) – harte Einsätze erzeugen sonst
 * hörbare Knackser.
 */
export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.enabled = true;
    this._unlocked = false;
    this._out = null;
    this._noise = null;

    // Gesamtlautstärke aller Effekte (0..1)
    this.volume = 0.7;
  }

  unlock() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      try { this.ctx = new AC(); } catch (e) { return; }
      this._buildMaster();
    }
    if (this.ctx.state === 'running') {
      this._unlocked = true;
      return;
    }
    const p = this.ctx.resume();
    if (p && typeof p.then === 'function') {
      p.then(() => { this._unlocked = true; }).catch(() => {});
    }
  }

  _buildMaster() {
    const ctx = this.ctx;

    const master = ctx.createGain();
    master.gain.value = this.volume;

    // Nimmt die Schärfe aus allen Höhen
    const tone = ctx.createBiquadFilter();
    tone.type = 'lowpass';
    tone.frequency.value = 5500;
    tone.Q.value = 0.5;

    // Fängt Spitzen ab, wenn mehrere Sounds gleichzeitig laufen
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -24;
    comp.knee.value = 18;
    comp.ratio.value = 3;
    comp.attack.value = 0.003;
    comp.release.value = 0.2;

    master.connect(tone);
    tone.connect(comp);
    comp.connect(ctx.destination);
    this._out = master;

    // 1 s weißes Rauschen, wird für alle Rausch-Sounds wiederverwendet
    const len = ctx.sampleRate;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    this._noise = buf;
  }

  // Spielt fn, sobald der AudioContext läuft. Wichtig beim allerersten Klick:
  // unlock() läuft dann gerade erst, der Context ist noch "suspended".
  _whenReady(fn) {
    if (!this.enabled || !this.ctx || !this._out) return;
    if (this.ctx.state === 'running') { fn(this.ctx); return; }
    const p = this.ctx.resume();
    if (p && typeof p.then === 'function') {
      p.then(() => { if (this.enabled && this.ctx.state === 'running') fn(this.ctx); }).catch(() => {});
    }
  }

  /** Weiche Hüllkurve: von Stille auf peak in `attack` s, dann Ausklingen in `decay` s. */
  _env(param, t, peak, attack, decay) {
    param.setValueAtTime(0.0001, t);
    param.exponentialRampToValueAtTime(peak, t + attack);
    param.exponentialRampToValueAtTime(0.0001, t + attack + decay);
    return t + attack + decay;
  }

  /** Einzelne Oszillator-Stimme mit Hüllkurve. */
  _voice(ctx, { type = 'sine', freq, freqEnd, peak, attack = 0.004, decay, delay = 0 }) {
    const t = ctx.currentTime + 0.005 + delay;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (freqEnd) osc.frequency.exponentialRampToValueAtTime(freqEnd, t + attack + decay);
    const end = this._env(gain.gain, t, peak, attack, decay);
    osc.connect(gain);
    gain.connect(this._out);
    osc.start(t);
    osc.stop(end + 0.02);
  }

  /** Gefiltertes Rauschen mit Filter-Sweep – für luftige, nicht-tonale Sounds. */
  _air(ctx, { type = 'bandpass', from, to, q = 1, peak, attack, decay, delay = 0 }) {
    const t = ctx.currentTime + 0.005 + delay;
    const src = ctx.createBufferSource();
    src.buffer = this._noise;
    src.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.Q.value = q;
    filter.frequency.setValueAtTime(from, t);
    filter.frequency.exponentialRampToValueAtTime(to, t + attack + decay);
    const gain = ctx.createGain();
    const end = this._env(gain.gain, t, peak, attack, decay);
    src.connect(filter);
    filter.connect(gain);
    gain.connect(this._out);
    src.start(t, Math.random() * 0.5);
    src.stop(end + 0.02);
  }

  // ------------------------------------------------------------
  // UI-SOUNDS
  // ------------------------------------------------------------

  /** Kurzer, gläserner Tick. */
  click() {
    this._whenReady((ctx) => {
      this._voice(ctx, { freq: 1250, freqEnd: 900, peak: 0.018, attack: 0.002, decay: 0.045 });
    });
  }

  /**
   * Kachelwechsel im Karussell: ein leiser, weicher Hauch.
   * Tiefpass statt Bandpass und langsamer Einsatz → kein "Klatschen".
   */
  slide() {
    this._whenReady((ctx) => {
      this._air(ctx, {
        type: 'lowpass', from: 650, to: 1100, q: 0.5,
        peak: 0.011, attack: 0.11, decay: 0.24
      });
      // Hauch von Kontur, damit der Wechsel nicht nur Rauschen ist
      this._voice(ctx, { freq: 740, freqEnd: 820, peak: 0.004, attack: 0.03, decay: 0.16 });
    });
  }

  /** Projekt öffnen: weicher, leicht aufsteigender Hauch. */
  open() {
    this._whenReady((ctx) => {
      this._air(ctx, {
        type: 'lowpass', from: 500, to: 1400, q: 0.5,
        peak: 0.012, attack: 0.14, decay: 0.3
      });
      this._voice(ctx, { freq: 520, freqEnd: 700, peak: 0.004, attack: 0.05, decay: 0.24 });
    });
  }

  /** Projekt schließen: Spiegelbild von open() – sanft absteigend. */
  close() {
    this._whenReady((ctx) => {
      this._air(ctx, {
        type: 'lowpass', from: 1300, to: 450, q: 0.5,
        peak: 0.01, attack: 0.08, decay: 0.28
      });
      this._voice(ctx, { freq: 660, freqEnd: 480, peak: 0.0035, attack: 0.03, decay: 0.22 });
    });
  }

  /** Kaum hörbares Antippen beim Hover. */
  haptic() {
    this._whenReady((ctx) => {
      this._voice(ctx, { freq: 2100, peak: 0.005, attack: 0.002, decay: 0.03 });
    });
  }

  /** Zwei sanfte Töne (Quinte) beim Hinzufügen. */
  addChime() {
    this._whenReady((ctx) => {
      this._voice(ctx, { freq: 660, peak: 0.016, attack: 0.006, decay: 0.32 });
      this._voice(ctx, { freq: 990, peak: 0.012, attack: 0.006, decay: 0.36, delay: 0.06 });
    });
  }

  /** Weicher, leicht fallender Tick beim Löschen. */
  deleteTick() {
    this._whenReady((ctx) => {
      this._voice(ctx, { freq: 540, freqEnd: 380, peak: 0.016, attack: 0.003, decay: 0.08 });
    });
  }

  // ------------------------------------------------------------
  // ORBIT-ÖFFNUNG
  // ------------------------------------------------------------

  /**
   * Aufladen über `dur` Sekunden: ein leises, gleitendes Summen (Grundton + Quinte),
   * das immer schneller flirrt, darunter ein weicher Luft-Anstieg.
   */
  charge(dur = 1.1) {
    this._whenReady((ctx) => {
      const t = ctx.currentTime + 0.01;
      const end = t + dur;

      // Gemeinsamer Bus, dessen Lautstärke ein LFO leicht moduliert → Flirren
      const bus = ctx.createGain();
      bus.gain.setValueAtTime(0.0001, t);
      bus.gain.exponentialRampToValueAtTime(1, end - 0.06);
      bus.gain.exponentialRampToValueAtTime(0.0001, end + 0.06);

      const flutter = ctx.createGain();
      flutter.gain.value = 1;
      const lfo = ctx.createOscillator();
      lfo.type = 'sine';
      lfo.frequency.setValueAtTime(5, t);
      lfo.frequency.exponentialRampToValueAtTime(19, end);
      const lfoDepth = ctx.createGain();
      lfoDepth.gain.setValueAtTime(0.05, t);
      lfoDepth.gain.linearRampToValueAtTime(0.35, end);
      lfo.connect(lfoDepth);
      lfoDepth.connect(flutter.gain);

      bus.connect(flutter);
      flutter.connect(this._out);

      // Grundton + Quinte gleiten eine Oktave nach oben
      [[220, 440, 0.006], [330, 660, 0.004]].forEach(([from, to, peak]) => {
        const osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(from, t);
        osc.frequency.exponentialRampToValueAtTime(to, end);
        const g = ctx.createGain();
        g.gain.value = peak;
        osc.connect(g);
        g.connect(bus);
        osc.start(t);
        osc.stop(end + 0.1);
      });

      // Weicher Luft-Anstieg (Tiefpass, keine Schärfe)
      const src = ctx.createBufferSource();
      src.buffer = this._noise;
      src.loop = true;
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.Q.value = 0.6;
      filter.frequency.setValueAtTime(300, t);
      filter.frequency.exponentialRampToValueAtTime(1800, end);
      const nGain = ctx.createGain();
      nGain.gain.value = 0.011;
      src.connect(filter);
      filter.connect(nGain);
      nGain.connect(bus);
      src.start(t);
      src.stop(end + 0.1);

      lfo.start(t);
      lfo.stop(end + 0.1);
    });
  }

  /**
   * Entladung: kein Knall, sondern ein weiches Aufblühen – spürbarer, leiser
   * Körper, sanfter Luftstoß und ein heller Akkord, der die Spannung auflöst.
   */
  boom() {
    this._whenReady((ctx) => {
      // Warmer, tiefer Körper – eher gefühlt als gehört
      this._voice(ctx, { freq: 92, freqEnd: 78, peak: 0.022, attack: 0.018, decay: 0.55 });
      // Sanfter Luftstoß: langsamerer Einsatz als früher → kein Klatschen
      this._air(ctx, { type: 'lowpass', from: 900, to: 180, q: 0.5, peak: 0.013, attack: 0.03, decay: 0.5 });
      // Feiner Glanz in den Höhen
      this._air(ctx, { from: 2600, to: 4600, q: 0.7, peak: 0.004, attack: 0.05, decay: 0.7, delay: 0.02 });
      // Auflösung: Oktave + Quinte über dem Endton des Aufladens (440 Hz)
      this._voice(ctx, { freq: 880, peak: 0.0045, attack: 0.02, decay: 0.9, delay: 0.03 });
      this._voice(ctx, { freq: 1320, peak: 0.003, attack: 0.02, decay: 1.0, delay: 0.07 });
    });
  }
}

export const audio = new AudioEngine();
