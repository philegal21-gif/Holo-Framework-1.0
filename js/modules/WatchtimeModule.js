import { esc } from '../core/utils.js';
import { audio } from '../core/AudioEngine.js';
import { ViewManager } from '../core/ViewManager.js';

/**
 * WATCHTIME — Football-Stream-Player.
 *
 * - Stream-Liste von streamfree.top (wird erst beim ersten Öffnen geladen)
 * - Wiedergabe per Embed-iframe oder eigener URL (.m3u8 via hls.js, .mp4)
 * - Verlässt man die Ansicht, stoppt die Wiedergabe.
 */

const API = {
  streams: 'https://streamfree.top/api/v1/streams?category=football',
  embed: (key) => `https://streamfree.top/embed/football/${encodeURIComponent(key)}`
};
const CACHE_TTL = 25000;
const DEBOUNCE = 220;
const FOOTBALL = '<i class="fa-solid fa-football"></i>';

const fmtTime = new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit' });
const fmtDay = new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: 'short' });

const val = (o, keys, fb = '') => {
  for (const k of keys) if (o && o[k] != null && o[k] !== '') return o[k];
  return fb;
};

const toArray = (payload) => {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.streams)) return payload.streams;
  if (Array.isArray(payload?.data)) return payload.data;
  return [];
};

const normalize = (s) => ({
  ...s,
  name: String(val(s, ['name', 'title'], 'Football-Spiel')),
  league: String(val(s, ['league', 'competition'], 'Football')),
  stream_key: String(val(s, ['stream_key', 'key', 'stream_id'], '')),
  match_timestamp: Number(val(s, ['match_timestamp', 'timestamp', 'start_time'], 0)),
  status: String(val(s, ['status', 'state'], '')).toLowerCase(),
  home_team: String(val(s, ['home_team', 'home', 'team_home'], '')),
  away_team: String(val(s, ['away_team', 'away', 'team_away'], '')),
  home_logo: val(s, ['home_logo', 'home_team_logo'], ''),
  away_logo: val(s, ['away_logo', 'away_team_logo'], ''),
  home_score: val(s, ['home_score', 'score_home'], null),
  away_score: val(s, ['away_score', 'score_away'], null),
  venue: String(val(s, ['venue', 'location'], '')),
  viewers: val(s, ['viewers'], null)
});

const millis = (t) => (t ? (t > 1e12 ? t : t * 1000) : 0);

const timeLabel = (t) => {
  if (!t) return '—';
  const d = new Date(millis(t));
  return Number.isNaN(d.getTime()) ? '—' : fmtTime.format(d);
};

const dateLabel = (t) => {
  if (!t) return 'offen';
  const d = new Date(millis(t));
  if (Number.isNaN(d.getTime())) return 'offen';
  const n = new Date();
  const a = new Date(n.getFullYear(), n.getMonth(), n.getDate());
  const b = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const diff = Math.round((b - a) / 864e5);
  if (diff === 0) return 'Heute';
  if (diff === 1) return 'Morgen';
  if (diff === -1) return 'Gestern';
  return fmtDay.format(d);
};

const statusOf = (s) => {
  if (['live', 'in_progress', 'in-progress', 'playing'].includes(s.status)) return { label: 'LIVE', cls: 'live' };
  if (['upcoming', 'scheduled', 'not_started', 'pending'].includes(s.status)) return { label: 'DEMNÄCHST', cls: 'upcoming' };
  if (['finished', 'completed', 'ended'].includes(s.status)) return { label: 'BEENDET', cls: 'other' };
  const future = s.match_timestamp && millis(s.match_timestamp) > Date.now();
  return future ? { label: 'DEMNÄCHST', cls: 'upcoming' } : { label: 'LIVE', cls: 'live' };
};

const initials = (n) =>
  String(n || '').trim().split(/\s+/).filter(Boolean).slice(0, 2).map(x => x[0]).join('').toUpperCase();

// Kein inline-onerror: der Fallback wird nach dem Rendern per Listener gesetzt
const crestHTML = (url, name) =>
  url
    ? `<div class="wt-crest" data-fallback="${esc(initials(name))}"><img src="${esc(url)}" alt="${esc(name)}" loading="lazy"></div>`
    : `<div class="wt-crest">${esc(initials(name)) || FOOTBALL}</div>`;

const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export class WatchtimeModule {
  constructor(rootEl) {
    this.root = rootEl;
    this.streams = [];
    this.selectedKey = null;
    this.requestSeq = 0;
    this.cache = { at: 0, data: null };
    this.hls = null;
    this._loadedOnce = false;
    this._clockTimer = null;
    this._toastTimer = null;

    this._build();
    this._bind();

    ViewManager.onChange((next) => {
      if (next === 'WATCHTIME_FOCUS') this._onEnter();
      else this._onLeave();
    });
  }

  // ------------------------------------------------------------
  // AUFBAU
  // ------------------------------------------------------------

  _build() {
    this.root.innerHTML = `
      <div class="wt-root">
        <div class="wt-bg" aria-hidden="true"></div>
        <div class="wt-field-lines" aria-hidden="true"></div>
        <div class="wt-yard-numbers" aria-hidden="true">
          <span>10</span><span>20</span><span>30</span><span>40</span><span>50</span><span>40</span><span>30</span><span>20</span><span>10</span>
        </div>

        <div class="wt-scroll" data-el="scroll">
          <div class="wt-app">
            <header class="wt-topbar">
              <div class="wt-brand">
                <div class="wt-logo">${FOOTBALL}</div>
                <div>
                  <div class="wt-brandname">WATCH<span>TIME</span></div>
                  <div class="wt-tagline">Football Streams · Live & eigene URLs</div>
                </div>
              </div>
              <label class="wt-search">
                <i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i>
                <input data-el="search" type="search" placeholder="Spiele, Teams, Ligen suchen…" autocomplete="off">
              </label>
              <div class="wt-topactions">
                <div class="wt-liveflag"><span class="wt-dot"></span> LIVE</div>
                <time class="wt-clock" data-el="clock">--:--</time>
                <button class="wt-iconbtn" data-el="addBtn" title="Stream-URL hinzufügen" aria-label="Stream-URL hinzufügen">
                  <i class="fa-solid fa-plus"></i>
                </button>
                <button class="wt-iconbtn" data-el="refreshBtn" title="Aktualisieren" aria-label="Aktualisieren">
                  <i class="fa-solid fa-rotate"></i>
                </button>
              </div>
            </header>

            <div class="wt-main">
              <section aria-label="Player">
                <div class="wt-featured">
                  <div class="wt-player" data-el="shell">
                    <div class="wt-stadium" aria-hidden="true"><div class="wt-pitch"></div><div class="wt-lights"></div></div>
                    <iframe class="wt-media" data-el="frame" title="Football-Stream"
                            allow="autoplay; fullscreen; picture-in-picture; encrypted-media"
                            allowfullscreen referrerpolicy="no-referrer"></iframe>
                    <video class="wt-media" data-el="video" controls playsinline></video>
                    <div class="wt-placeholder" data-el="placeholder">
                      <div class="wt-leaguepill" data-el="heroLeague">FOOTBALL · LIVE STREAMS</div>
                      <div class="wt-teams">
                        <div class="wt-hero-team">
                          <div class="wt-hero-crest" data-el="heroHomeCrest">${FOOTBALL}</div>
                          <strong data-el="heroHome">Spiel wählen</strong>
                        </div>
                        <div class="wt-vs">VS</div>
                        <div class="wt-hero-team">
                          <div class="wt-hero-crest" data-el="heroAwayCrest">${FOOTBALL}</div>
                          <strong data-el="heroAway">Live Football</strong>
                        </div>
                      </div>
                      <div class="wt-hero-status"><span class="wt-dot"></span><span data-el="heroStatus">BEREIT</span></div>
                      <div class="wt-hero-time" data-el="heroTime">Stream unten auswählen oder eigene URL hinzufügen</div>
                    </div>
                    <div class="wt-playerlabel"><span class="wt-dot"></span><span data-el="playerStatus">BEREIT</span></div>
                    <div class="wt-playerlabel right" data-el="playerCategory">HD</div>
                    <div class="wt-caption" data-el="caption"></div>
                  </div>
                  <div class="wt-playerfooter">
                    <div class="wt-selected" data-el="selected"><strong>Kein Stream ausgewählt</strong> · Spiel wählen oder eigene URL hinzufügen</div>
                    <button class="wt-action" data-el="fullscreenBtn"><i class="fa-solid fa-expand"></i> Vollbild</button>
                  </div>
                </div>
              </section>

              <section aria-label="Streams">
                <div class="wt-sectionhead">
                  <div class="wt-sectiontitle">
                    <h2>Football Live</h2>
                    <p><b>●</b> <span data-el="count">0 Streams verfügbar</span></p>
                  </div>
                  <button class="wt-action" data-el="listRefresh"><i class="fa-solid fa-rotate"></i> Aktualisieren</button>
                </div>
                <div class="wt-grid" data-el="grid"></div>
              </section>

              <footer class="wt-footer">
                <span>Watchtime</span>
                <span>Football · Live Streams · Eigene URLs</span>
              </footer>
            </div>
          </div>
        </div>

        <div class="wt-modal-backdrop" data-el="modal" aria-hidden="true">
          <div class="wt-modal" role="dialog" aria-modal="true" aria-label="Stream-URL hinzufügen">
            <div class="wt-modal-head">
              <div class="wt-modal-title">
                <span class="wt-icon"><i class="fa-solid fa-link"></i></span>
                <span>Stream-URL hinzufügen</span>
              </div>
              <button class="wt-modal-close" data-el="modalClose" aria-label="Schließen"><i class="fa-solid fa-xmark"></i></button>
            </div>
            <form class="wt-modal-body" data-el="form">
              <div class="wt-field">
                <label for="wt-name">Stream-Name (optional)</label>
                <input id="wt-name" data-el="nameInput" type="text" placeholder="z. B. Eagles vs Cowboys" autocomplete="off">
              </div>
              <div class="wt-field">
                <label for="wt-url">Stream-URL <span class="wt-required">*</span></label>
                <input id="wt-url" data-el="urlInput" type="url" placeholder="https://example.com/stream.m3u8" autocomplete="off" required>
                <div class="wt-field-hint">
                  Unterstützt <code>.m3u8</code> (HLS), <code>.mp4</code> (Video) und direkte Stream-URLs.
                </div>
              </div>
            </form>
            <div class="wt-modal-foot">
              <button class="wt-btn-secondary" data-el="modalCancel" type="button">Abbrechen</button>
              <button class="wt-btn-primary" type="submit" data-el="modalSave">Abspielen</button>
            </div>
          </div>
        </div>

        <div class="wt-toast" data-el="toast" role="status" aria-live="polite"></div>
      </div>`;

    this.el = {};
    this.root.querySelectorAll('[data-el]').forEach(n => { this.el[n.dataset.el] = n; });
    this._renderState('Noch nicht geladen', 'Die Streams werden beim Öffnen geladen.', 'empty');
  }

  _bind() {
    const e = this.el;

    let searchT = null;
    e.search.addEventListener('input', () => {
      clearTimeout(searchT);
      searchT = setTimeout(() => this._renderStreams(), DEBOUNCE);
    });

    e.refreshBtn.addEventListener('click', () => { audio.click(); this.load(true); });
    e.listRefresh.addEventListener('click', () => { audio.click(); this.load(true); });
    e.addBtn.addEventListener('click', () => { audio.click(); this._openModal(); });
    e.fullscreenBtn.addEventListener('click', () => this._toggleFullscreen());

    e.modalClose.addEventListener('click', () => this._closeModal());
    e.modalCancel.addEventListener('click', () => this._closeModal());
    e.modal.addEventListener('click', (ev) => { if (ev.target === e.modal) this._closeModal(); });
    // Der Submit-Button liegt außerhalb des <form> – per Klick auslösen
    e.modalSave.addEventListener('click', () => e.form.requestSubmit());
    // Ohne Submit-Button im Formular löst Enter bei zwei Feldern nichts aus
    e.form.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        e.form.requestSubmit();
      }
    });
    e.form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      this._submitCustomUrl();
    });

    // Escape schließt zuerst das Modal – vor dem globalen Handler (der sonst
    // zurück zur Übersicht springen würde).
    window.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Escape' || !e.modal.classList.contains('is-open')) return;
      ev.stopPropagation();
      this._closeModal();
    }, true);
  }

  // ------------------------------------------------------------
  // ANSICHT BETRETEN / VERLASSEN
  // ------------------------------------------------------------

  _onEnter() {
    this._tickClock();
    clearInterval(this._clockTimer);
    this._clockTimer = setInterval(() => this._tickClock(), 30000);

    if (!this._loadedOnce) {
      this._loadedOnce = true;
      this.load();
    }
  }

  _onLeave() {
    clearInterval(this._clockTimer);
    this._clockTimer = null;
    this._closeModal();
    // Wiedergabe beenden, sonst läuft der Ton im Hintergrund weiter
    if (this._isPlaying()) this._resetPlayer();
  }

  _tickClock() {
    this.el.clock.textContent = fmtTime.format(new Date());
  }

  // ------------------------------------------------------------
  // DATEN
  // ------------------------------------------------------------

  async _fetchStreams(force) {
    if (!force && this.cache.data && Date.now() - this.cache.at < CACHE_TTL) return this.cache.data;
    const r = await fetch(API.streams, { headers: { Accept: 'application/json' }, cache: 'no-store' });
    if (!r.ok) {
      const err = new Error('HTTP_' + r.status);
      err.status = r.status;
      throw err;
    }
    const data = await r.json();
    this.cache = { at: Date.now(), data };
    return data;
  }

  async load(force = false) {
    const seq = ++this.requestSeq;
    this._renderState('Lade Football-Streams', 'Live-Spiele werden abgerufen…', 'loading');
    try {
      const payload = await this._fetchStreams(force);
      if (seq !== this.requestSeq) return;
      this.streams = toArray(payload).map(normalize);
      this._renderStreams();
    } catch (err) {
      if (seq !== this.requestSeq) return;
      console.error('[Watchtime]', err);
      this.streams = [];
      this.el.count.textContent = '0 Streams verfügbar';
      const notFound = err.status === 404;
      this._renderState(
        notFound ? 'Keine Streams gefunden' : 'Streams nicht erreichbar',
        notFound ? 'Gerade laufen keine Football-Streams. Schau später wieder vorbei.'
                 : 'Der Stream-Dienst antwortet nicht. Bitte erneut versuchen.',
        'error',
        true
      );
    }
  }

  // ------------------------------------------------------------
  // RENDERING
  // ------------------------------------------------------------

  _renderState(title, msg, type = 'empty', retry = false) {
    const icon = type === 'loading'
      ? '<div class="wt-spinner"></div>'
      : `<div class="wt-stateicon">${FOOTBALL}</div>`;
    this.el.grid.innerHTML = `
      <div class="wt-state">
        ${icon}
        <h3>${esc(title)}</h3>
        <p>${esc(msg)}</p>
        ${retry ? '<button class="wt-action" data-retry><i class="fa-solid fa-rotate"></i> Erneut versuchen</button>' : ''}
      </div>`;
    this.el.grid.querySelector('[data-retry]')?.addEventListener('click', () => this.load(true));
  }

  _renderStreams() {
    const q = this.el.search.value.trim().toLowerCase();
    const list = this.streams.filter(s =>
      [s.name, s.league, s.home_team, s.away_team, s.venue].join(' ').toLowerCase().includes(q)
    );

    this.el.count.textContent = `${list.length} ${list.length === 1 ? 'Stream' : 'Streams'} verfügbar`;

    if (!list.length) {
      this._renderState(
        q ? 'Keine passenden Spiele' : 'Gerade keine Football-Streams',
        q ? 'Versuch es mit einem anderen Team oder Suchbegriff.'
          : 'Spiele erscheinen, sobald sie live sind. Oder füge mit + eine eigene Stream-URL hinzu.',
        'empty'
      );
      return;
    }

    const grid = this.el.grid;
    grid.innerHTML = '';
    const frag = document.createDocumentFragment();

    list.forEach(s => {
      const st = statusOf(s);
      const home = s.home_team || s.name;
      const away = s.away_team || 'Live Football';
      const score = s.home_score != null && s.away_score != null
        ? `<div class="wt-score">${esc(s.home_score)} : ${esc(s.away_score)}</div>` : '';
      const viewers = s.viewers != null ? ` · ${esc(s.viewers)} schauen zu` : '';

      const card = document.createElement('article');
      card.className = 'wt-card' + (this.selectedKey && s.stream_key === this.selectedKey ? ' is-selected' : '');
      card.tabIndex = 0;
      card.setAttribute('role', 'button');
      card.setAttribute('aria-label', `${s.name} abspielen`);
      card.innerHTML = `
        <div class="wt-cardtop">
          <span class="wt-league">${FOOTBALL}${esc(s.league)}</span>
          <span class="wt-badge ${st.cls}">${st.label}</span>
        </div>
        <div class="wt-match">
          <div class="wt-team">${crestHTML(s.home_logo, home)}<span class="wt-teamname">${esc(home)}</span></div>
          <div class="wt-center">
            <div class="wt-time">${esc(timeLabel(s.match_timestamp))}</div>
            <div class="wt-date">${esc(dateLabel(s.match_timestamp))}</div>
            ${score}
          </div>
          <div class="wt-team">${crestHTML(s.away_logo, away)}<span class="wt-teamname">${esc(away)}</span></div>
        </div>
        <div class="wt-cardbottom">
          <span>${esc(s.venue || s.name)}${viewers}</span>
          <i class="fa-solid fa-chevron-right wt-arrow"></i>
        </div>`;

      // Kaputte Logos → Initialen
      card.querySelectorAll('.wt-crest[data-fallback] img').forEach(img => {
        img.addEventListener('error', () => {
          const crest = img.parentElement;
          crest.textContent = crest.dataset.fallback;
          if (!crest.textContent) crest.innerHTML = FOOTBALL;
        }, { once: true });
      });

      const open = () => this._selectStream(s, card);
      card.addEventListener('click', open);
      card.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); open(); }
      });

      this._attachTilt(card);
      frag.appendChild(card);
    });

    grid.appendChild(frag);
  }

  _attachTilt(card) {
    if (reducedMotion() || !window.matchMedia('(hover: hover) and (pointer: fine)').matches) return;
    card.addEventListener('pointermove', (ev) => {
      const r = card.getBoundingClientRect();
      const x = (ev.clientX - r.left) / r.width;
      const y = (ev.clientY - r.top) / r.height;
      card.style.transform =
        `perspective(1000px) rotateX(${(0.5 - y) * 6}deg) rotateY(${(x - 0.5) * 6}deg) translateY(-6px) scale(1.02)`;
    });
    card.addEventListener('pointerleave', () => { card.style.transform = ''; });
  }

  // ------------------------------------------------------------
  // WIEDERGABE
  // ------------------------------------------------------------

  _isPlaying() {
    return this.el.frame.classList.contains('is-active') || this.el.video.classList.contains('is-active');
  }

  _stopAllMedia() {
    const { frame, video } = this.el;
    frame.removeAttribute('src');
    frame.classList.remove('is-active');

    try { video.pause(); } catch (_) {}
    video.removeAttribute('src');
    video.load();
    video.classList.remove('is-active');

    if (this.hls) {
      try { this.hls.destroy(); } catch (_) {}
      this.hls = null;
    }
    this.el.shell.classList.remove('is-playing');
  }

  /** Zurück in den Ausgangszustand (Platzhalter sichtbar, nichts ausgewählt). */
  _resetPlayer() {
    this._stopAllMedia();
    this.selectedKey = null;
    this.el.grid.querySelectorAll('.wt-card.is-selected').forEach(c => c.classList.remove('is-selected'));
    this.el.placeholder.hidden = false;
    this._setText({
      playerStatus: 'BEREIT',
      playerCategory: 'HD',
      heroLeague: 'FOOTBALL · LIVE STREAMS',
      heroHome: 'Spiel wählen',
      heroAway: 'Live Football',
      heroStatus: 'BEREIT',
      heroTime: 'Stream unten auswählen oder eigene URL hinzufügen'
    });
    this.el.heroHomeCrest.innerHTML = FOOTBALL;
    this.el.heroAwayCrest.innerHTML = FOOTBALL;
    this.el.caption.innerHTML = '';
    this.el.selected.innerHTML = '<strong>Kein Stream ausgewählt</strong> · Spiel wählen oder eigene URL hinzufügen';
  }

  _setText(map) {
    for (const k in map) this.el[k].textContent = map[k];
  }

  _playEmbed(key) {
    this._stopAllMedia();
    this.el.frame.src = API.embed(key);
    this.el.frame.classList.add('is-active');
    this.el.placeholder.hidden = true;
    this.el.shell.classList.add('is-playing');
  }

  _playDirect(url, name) {
    this._stopAllMedia();
    const { video } = this.el;
    video.classList.add('is-active');
    this.el.placeholder.hidden = true;
    this.el.shell.classList.add('is-playing');

    const isHls = /\.m3u8(\?|$)/i.test(url);
    const Hls = window.Hls;

    if (isHls && Hls && Hls.isSupported()) {
      this.hls = new Hls({ lowLatencyMode: true, enableWorker: true });
      this.hls.loadSource(url);
      this.hls.attachMedia(video);
      this.hls.on(Hls.Events.MANIFEST_PARSED, () => { video.play().catch(() => {}); });
      this.hls.on(Hls.Events.ERROR, (_ev, data) => {
        if (data.fatal) {
          console.error('[Watchtime HLS]', data);
          this._toast('HLS-Stream-Fehler: ' + (data.details || 'unbekannt'), true);
        }
      });
    } else {
      // Safari spielt HLS nativ, alles andere direkt
      video.src = url;
      video.play().catch(() => {});
    }

    this.selectedKey = null;
    this.el.grid.querySelectorAll('.wt-card.is-selected').forEach(c => c.classList.remove('is-selected'));

    const title = name || 'Eigener Stream';
    this._setText({
      playerStatus: 'EIGENE URL',
      playerCategory: isHls ? 'HLS' : 'MP4',
      heroLeague: 'EIGENER STREAM',
      heroHome: title,
      heroAway: 'Live',
      heroStatus: 'BEREIT',
      heroTime: 'Eigene URL'
    });
    this.el.heroHomeCrest.innerHTML = '<i class="fa-solid fa-satellite-dish"></i>';
    this.el.heroAwayCrest.textContent = isHls ? 'HLS' : 'MP4';
    this.el.caption.innerHTML = `<div><h3>${esc(title)}</h3><p>${esc(url)}</p></div>`;
    this.el.selected.innerHTML = `<strong>${esc(title)}</strong> · Eigene URL`;
  }

  _selectStream(s, card) {
    if (!s.stream_key) {
      this.el.selected.innerHTML = '<strong>Kein Stream-Schlüssel</strong> · Für dieses Spiel gibt es keine abspielbare Quelle.';
      return;
    }
    audio.click();
    this.selectedKey = s.stream_key;
    this.el.grid.querySelectorAll('.wt-card.is-selected').forEach(c => c.classList.remove('is-selected'));
    card?.classList.add('is-selected');

    this._playEmbed(s.stream_key);

    this._setText({
      playerStatus: 'STREAMING',
      playerCategory: 'HD',
      heroLeague: `${s.league} · LIVE`,
      heroHome: s.home_team || s.name,
      heroAway: s.away_team || 'Live Football',
      heroStatus: statusOf(s).label,
      heroTime: `${dateLabel(s.match_timestamp)} · ${timeLabel(s.match_timestamp)}`
    });
    if (s.home_team) this.el.heroHomeCrest.textContent = initials(s.home_team);
    else this.el.heroHomeCrest.innerHTML = FOOTBALL;
    if (s.away_team) this.el.heroAwayCrest.textContent = initials(s.away_team);
    else this.el.heroAwayCrest.innerHTML = FOOTBALL;

    this.el.caption.innerHTML =
      `<div><h3>${esc(s.name)}</h3><p>${esc(s.league)}${s.venue ? ' · ' + esc(s.venue) : ''}</p></div>`;
    this.el.selected.innerHTML = `<strong>${esc(s.name)}</strong> · ${esc(s.league)}`;

    this.el.shell.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'center' });
  }

  async _toggleFullscreen() {
    const { frame, video, shell } = this.el;
    const target = frame.classList.contains('is-active') ? frame
                 : video.classList.contains('is-active') ? video
                 : shell;
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else if (target.requestFullscreen) await target.requestFullscreen();
    } catch (err) {
      console.warn('[Watchtime] Vollbild nicht verfügbar', err);
    }
  }

  // ------------------------------------------------------------
  // MODAL & TOAST
  // ------------------------------------------------------------

  _openModal() {
    this.el.modal.classList.add('is-open');
    this.el.modal.setAttribute('aria-hidden', 'false');
    document.getElementById('cursor-flare')?.style.setProperty('opacity', '0');
    setTimeout(() => this.el.urlInput.focus(), 50);
  }

  _closeModal() {
    if (!this.el.modal.classList.contains('is-open')) return;
    this.el.modal.classList.remove('is-open');
    this.el.modal.setAttribute('aria-hidden', 'true');
    document.getElementById('cursor-flare')?.style.removeProperty('opacity');
    this.el.form.reset();
  }

  _submitCustomUrl() {
    const url = this.el.urlInput.value.trim();
    const name = this.el.nameInput.value.trim();
    if (!url) {
      this._toast('Bitte eine Stream-URL eingeben', true);
      return;
    }
    if (!/^https?:\/\//i.test(url)) {
      this._toast('Die URL muss mit http:// oder https:// beginnen', true);
      return;
    }
    this._playDirect(url, name);
    this._closeModal();
    audio.addChime();
    this._toast('Stream geladen');
  }

  _toast(msg, isError = false) {
    const t = this.el.toast;
    t.textContent = msg;
    t.classList.toggle('error', isError);
    t.classList.add('is-visible');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => t.classList.remove('is-visible'), 2600);
  }
}
