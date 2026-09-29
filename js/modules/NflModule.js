import { esc } from '../core/utils.js';
import { audio } from '../core/AudioEngine.js';
import { ViewManager } from '../core/ViewManager.js';
import { NFL_GAMES } from '../data/nflSchedule.js';

/**
 * NFL-Spielplan 2026/2027.
 *
 * - 18 Wochen-Reiter, Team-Filter (Mehrfachauswahl), Spielkarten "Heim vs. Gast"
 * - Countdown bis Kickoff, Sortierung live → kommend → beendet
 * - Live-Spielstände von ESPN, Streams von streamfree.top (sofern vorhanden)
 * - PIN-Sperre wie im Original
 * Alle Timer laufen nur, solange die Ansicht offen ist.
 */

const LOGO = (abbr) => `https://static.www.nfl.com/f_auto,h_100,dpr_2.0,q_auto,w_100/league/api/clubs/logos/${abbr}`;
const NFL_LOGO = 'https://upload.wikimedia.org/wikipedia/en/a/a2/National_Football_League_logo.svg';
const ESPN_URL = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard';
const STREAM_API = 'https://streamfree.top/api/v1/streams?category=football';

const SEASON = 2026;
const PIN = '1109';
const PIN_KEY = 'nfl-unlocked';
const WEEKS = 18;
const GAME_LENGTH = 3 * 3600000;       // ohne Live-Daten gilt ein Spiel 3 h nach Kickoff als beendet
const SCORE_INTERVAL = 30000;
const STREAM_INTERVAL = 60000;
const TICK_INTERVAL = 60000;

// ------------------------------------------------------------
// Zeitzone: isoDate ist deutsche Ortszeit. MEZ/MESZ nach EU-Regel
// (letzter Sonntag im März bzw. Oktober) – die Rohdaten hatten
// durchgehend +02:00, ab dem 25.10. gilt aber +01:00.
// ------------------------------------------------------------
function berlinIsDst(y, mo, d, h, mi) {
  const lastSunday = (month) => {
    const last = new Date(Date.UTC(y, month + 1, 0));
    return last.getUTCDate() - last.getUTCDay();
  };
  const t = Date.UTC(y, mo, d, h, mi);
  const start = Date.UTC(y, 2, lastSunday(2), 2, 0);
  const end = Date.UTC(y, 9, lastSunday(9), 3, 0);
  return t >= start && t < end;
}

const GAMES = NFL_GAMES.map((g, i) => {
  const game = { ...g, id: i, kickoff: NaN, timezone: '' };
  const m = g.isoDate && g.isoDate.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (m) {
    const dst = berlinIsDst(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
    game.timezone = dst ? 'MESZ' : 'MEZ';
    game.kickoff = Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00${dst ? '+02:00' : '+01:00'}`);
  }
  return game;
});

// Teams (für den Filter) aus den Daten ableiten
const TEAMS = (() => {
  const map = new Map();
  GAMES.forEach(g => {
    map.set(g.home, g.homeAbbr);
    map.set(g.away, g.awayAbbr);
  });
  return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([name, abbr]) => ({ name, abbr }));
})();

// Für das Stream-Matching: voller Name + Spitzname (z. B. "Eagles")
const aliasesFor = (team) => {
  const nick = team.split(' ').pop();
  const list = [team, nick];
  if (nick === '49ers') list.push('niners');
  return list.map(a => a.toLowerCase().replace(/[^a-z0-9]/g, ''));
};
const normalize = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const teamIn = (text, team) => aliasesFor(team).some(a => text.includes(a));

const streamQuality = (url) => {
  const m = String(url).match(/(2160|1440|1080|720|540|480|360)p?/i);
  return m ? Number(m[1]) : 0;
};
const streamLabel = (url, i) => {
  const q = streamQuality(url);
  let name = q ? `${q}p` : `Quelle ${i + 1}`;
  if (/backup|mirror/i.test(url)) name += ' – Backup-Server';
  else if (i > 0 && !q) name += ' – Alternative';
  return name;
};

/** Enthält die Woche noch ein Spiel, das aussteht oder läuft? */
const weekPending = (w, now) =>
  GAMES.some(g => g.week === w && (!Number.isFinite(g.kickoff) || g.kickoff + GAME_LENGTH > now));

export class NflModule {
  constructor(rootEl) {
    this.root = rootEl;
    this.week = 1;
    this.activeTeams = new Set();
    this.scores = new Map();    // game.id → { home, away, badge }
    this._scoresDone = new Set(); // Wochen, deren Spiele alle final sind
    this.streams = new Map();   // game.id → stream
    this.pinEntry = '';
    this._timers = [];
    this._built = false;

    ViewManager.onChange((next) => {
      if (next === 'NFL_FOCUS') this._onEnter();
      else this._onLeave();
    });
  }

  // ------------------------------------------------------------
  // ANSICHT BETRETEN / VERLASSEN
  // ------------------------------------------------------------

  _onEnter() {
    if (!this._built) {
      this._build();
      this._bind();
      this._built = true;
      // Aktuelle Woche = erste mit ausstehendem oder laufendem Spiel
      const now = Date.now();
      let w = 1;
      while (w < WEEKS && !weekPending(w, now)) w++;
      this._selectWeek(w, false);
    } else {
      this._render();
      this._fetchScores();
    }

    this._fetchStreams();
    this._timers = [
      setInterval(() => this._render(), TICK_INTERVAL),
      setInterval(() => this._fetchScores(), SCORE_INTERVAL),
      setInterval(() => this._fetchStreams(), STREAM_INTERVAL)
    ];
  }

  _onLeave() {
    this._timers.forEach(clearInterval);
    this._timers = [];
    if (this._built) this._closeStream();
  }

  // ------------------------------------------------------------
  // AUFBAU
  // ------------------------------------------------------------

  _build() {
    const tabs = Array.from({ length: WEEKS }, (_, i) =>
      `<button class="nfl-tab" data-week="${i + 1}">Woche ${i + 1}</button>`).join('');

    const filters = [
      `<button class="nfl-filter-btn is-active" data-team="all" title="Alle Teams"><img src="${NFL_LOGO}" alt="NFL"></button>`,
      ...TEAMS.map(t =>
        `<button class="nfl-filter-btn" data-team="${esc(t.name)}" title="${esc(t.name)}"><img src="${LOGO(t.abbr)}" alt="${esc(t.abbr)}" loading="lazy"></button>`)
    ].join('');

    const keys = [1, 2, 3, 4, 5, 6, 7, 8, 9].map(n =>
      `<button class="nfl-pin-key" data-key="${n}">${n}</button>`).join('');

    this.root.innerHTML = `
      <div class="nfl-root">
        <div class="nfl-scroll" data-el="scroll">
          <div class="nfl-app">
            <header class="nfl-header">
              <img class="nfl-header-logo" src="${NFL_LOGO}" alt="">
              <div class="nfl-header-text">
                <h1>NFL Spielplan</h1>
                <div class="nfl-subtitle">Saison 2026 / 2027</div>
              </div>
              <img class="nfl-header-logo" src="${NFL_LOGO}" alt="">
            </header>
            <nav class="nfl-tabs" data-el="tabs" aria-label="Spielwochen">${tabs}</nav>
            <div class="nfl-filter" data-el="filter" aria-label="Team-Filter">${filters}</div>
            <div class="nfl-week" data-el="games"></div>
          </div>
        </div>

        <button class="nfl-scrolltop" data-el="scrollTop" title="Nach oben" aria-label="Nach oben">
          <i class="fa-solid fa-arrow-up"></i>
        </button>

        <div class="nfl-modal" data-el="modal" aria-hidden="true">
          <section class="nfl-modal-panel" role="dialog" aria-modal="true" aria-label="Live-Stream">
            <div class="nfl-modal-bar">
              <div class="nfl-modal-title" data-el="modalTitle">Stream live</div>
              <select data-el="quality" aria-label="Streamqualität"></select>
              <button class="nfl-modal-close" data-el="modalClose" aria-label="Schließen"><i class="fa-solid fa-xmark"></i></button>
            </div>
            <div class="nfl-modal-frame">
              <iframe data-el="frame" title="Live-Stream" allow="fullscreen; picture-in-picture" allowfullscreen></iframe>
            </div>
            <div class="nfl-modal-foot">Wiedergabe über externen Anbieter. Bei Problemen eine andere Quelle auswählen.</div>
          </section>
        </div>

        <div class="nfl-pin" data-el="pin" ${this._isUnlocked() ? 'hidden' : ''}>
          <div class="nfl-pin-panel">
            <div class="nfl-pin-icon"><i class="fa-solid fa-football"></i></div>
            <div class="nfl-pin-title">NFL Spielplan<small>PIN eingeben</small></div>
            <div class="nfl-pin-dots" data-el="pinDots">
              <span class="nfl-pin-dot"></span><span class="nfl-pin-dot"></span>
              <span class="nfl-pin-dot"></span><span class="nfl-pin-dot"></span>
            </div>
            <div class="nfl-pin-pad">${keys}<button class="nfl-pin-key zero" data-key="0">0</button></div>
          </div>
        </div>
      </div>`;

    this.el = {};
    this.root.querySelectorAll('[data-el]').forEach(n => { this.el[n.dataset.el] = n; });
  }

  _bind() {
    const e = this.el;

    // Wochen-Reiter
    this._dragScroll(e.tabs, (target) => {
      const tab = target.closest('.nfl-tab');
      if (tab) this._selectWeek(Number(tab.dataset.week), true);
    });

    // Team-Filter
    this._dragScroll(e.filter, (target) => {
      const btn = target.closest('.nfl-filter-btn');
      if (btn) this._toggleTeam(btn.dataset.team);
    });

    // Nach oben
    e.scroll.addEventListener('scroll', () => {
      e.scrollTop.classList.toggle('is-visible', e.scroll.scrollTop > 300);
    }, { passive: true });
    e.scrollTop.addEventListener('click', () => {
      e.scroll.scrollTo({ top: 0, behavior: 'smooth' });
    });

    // Stream-Buttons (Delegation, da Karten neu gerendert werden)
    e.games.addEventListener('click', (ev) => {
      const btn = ev.target.closest('.nfl-stream-btn');
      if (!btn) return;
      const game = GAMES[Number(btn.dataset.game)];
      const stream = this.streams.get(game.id);
      if (stream) this._openStream(game, stream);
    });

    // Stream-Player
    e.quality.addEventListener('change', () => {
      if (e.quality.value) e.frame.src = e.quality.value;
    });
    e.modalClose.addEventListener('click', () => this._closeStream());
    e.modal.addEventListener('click', (ev) => { if (ev.target === e.modal) this._closeStream(); });
    // Cursor-Flare kann dem iframe nicht folgen → dort ausblenden
    const flare = document.getElementById('cursor-flare');
    e.frame.addEventListener('mouseenter', () => flare?.style.setProperty('opacity', '0'));
    e.frame.addEventListener('mouseleave', () => flare?.style.removeProperty('opacity'));

    // PIN
    e.pin.addEventListener('click', (ev) => {
      const key = ev.target.closest('.nfl-pin-key');
      if (key) this._pinType(key.dataset.key);
    });

    // Tastatur: Escape schließt zuerst den Player; Ziffern für die PIN.
    // capture → vor dem globalen Handler, der sonst zur Übersicht springt.
    window.addEventListener('keydown', (ev) => {
      if (ViewManager.getState() !== 'NFL_FOCUS') return;
      if (ev.key === 'Escape' && e.modal.classList.contains('is-open')) {
        ev.stopPropagation();
        this._closeStream();
        return;
      }
      if (!e.pin.hidden && /^[0-9]$/.test(ev.key)) {
        ev.stopPropagation();
        this._pinType(ev.key);
      }
    }, true);
  }

  /**
   * Horizontal per Maus ziehbar (mit Schwung) und per Mausrad scrollbar.
   * Nach einem Zieh-Vorgang wird der Klick unterdrückt.
   */
  _dragScroll(el, onClick) {
    let down = false, dragged = false, startX = 0, startLeft = 0, lastX = 0, vel = 0, raf = null;

    const momentum = () => {
      if (Math.abs(vel) < 0.5) return;
      el.scrollLeft -= vel;
      vel *= 0.92;
      raf = requestAnimationFrame(momentum);
    };

    el.addEventListener('pointerdown', (ev) => {
      if (ev.pointerType !== 'mouse' || ev.button !== 0) return;
      down = true;
      dragged = false;
      vel = 0;
      cancelAnimationFrame(raf);
      startX = lastX = ev.clientX;
      startLeft = el.scrollLeft;
    });

    window.addEventListener('pointermove', (ev) => {
      if (!down) return;
      const walk = ev.clientX - startX;
      if (Math.abs(walk) > 5) {
        dragged = true;
        el.classList.add('is-dragging');
        el.scrollLeft = startLeft - walk;
        vel = ev.clientX - lastX;
        lastX = ev.clientX;
      }
    });

    window.addEventListener('pointerup', () => {
      if (!down) return;
      down = false;
      el.classList.remove('is-dragging');
      if (dragged) raf = requestAnimationFrame(momentum);
    });

    el.addEventListener('click', (ev) => {
      if (dragged) { dragged = false; return; }
      onClick(ev.target);
    });

    // Mausrad → horizontal
    el.addEventListener('wheel', (ev) => {
      if (Math.abs(ev.deltaY) <= Math.abs(ev.deltaX)) return;
      ev.preventDefault();
      el.scrollLeft += ev.deltaY;
    }, { passive: false });
  }

  // ------------------------------------------------------------
  // AUSWAHL
  // ------------------------------------------------------------

  _selectWeek(week, withSound) {
    this.week = week;
    this.el.tabs.querySelectorAll('.nfl-tab').forEach(t => {
      t.classList.toggle('is-active', Number(t.dataset.week) === week);
    });
    const active = this.el.tabs.querySelector('.nfl-tab.is-active');
    active?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
    if (withSound) audio.slide();

    // Einblend-Animation neu starten
    const g = this.el.games;
    g.style.animation = 'none';
    void g.offsetWidth;
    g.style.animation = '';

    this._render();
    this._fetchScores();
  }

  _toggleTeam(team) {
    audio.click();
    if (team === 'all') {
      this.activeTeams.clear();
    } else if (this.activeTeams.has(team)) {
      this.activeTeams.delete(team);
    } else {
      this.activeTeams.add(team);
    }
    this.el.filter.querySelectorAll('.nfl-filter-btn').forEach(b => {
      const t = b.dataset.team;
      b.classList.toggle('is-active', t === 'all' ? this.activeTeams.size === 0 : this.activeTeams.has(t));
    });
    this._render();
  }

  // ------------------------------------------------------------
  // RENDERING
  // ------------------------------------------------------------

  _status(g, now) {
    if (!Number.isFinite(g.kickoff) || g.kickoff > now) return 'upcoming';
    const badge = this.scores.get(g.id)?.badge;
    if (badge?.cls === 'final') return 'over';
    if (badge?.cls === 'live') return 'live';
    return now - g.kickoff <= GAME_LENGTH ? 'live' : 'over';
  }

  _render() {
    if (!this._built) return;
    const now = Date.now();
    const rank = { live: 0, upcoming: 1, over: 2 };

    const games = GAMES
      .filter(g => g.week === this.week)
      .filter(g => this.activeTeams.size === 0 || this.activeTeams.has(g.home) || this.activeTeams.has(g.away))
      .map(g => ({ g, status: this._status(g, now) }))
      // live zuerst, dann kommende (früheste zuerst), beendete zuletzt (neueste zuerst)
      .sort((a, b) => {
        const r = rank[a.status] - rank[b.status];
        if (r) return r;
        const ka = Number.isFinite(a.g.kickoff) ? a.g.kickoff : Infinity;
        const kb = Number.isFinite(b.g.kickoff) ? b.g.kickoff : Infinity;
        return a.status === 'over' ? kb - ka : ka - kb;
      });

    if (!games.length) {
      this.el.games.innerHTML =
        '<div class="nfl-empty">In dieser Woche spielt keines der ausgewählten Teams.</div>';
      return;
    }

    this.el.games.innerHTML = games.map(({ g, status }) => this._cardHTML(g, status, now)).join('');
  }

  _countdownHTML(g, status, now) {
    if (!Number.isFinite(g.kickoff)) return '';
    if (status === 'upcoming') {
      const diff = g.kickoff - now;
      const d = Math.floor(diff / 86400000);
      const h = Math.floor((diff / 3600000) % 24);
      const m = Math.floor((diff / 60000) % 60);
      return `<div class="nfl-countdown"><i class="fa-regular fa-hourglass-half"></i>Kickoff in ${d}d ${h}h ${m}m</div>`;
    }
    if (status === 'live') {
      return '<div class="nfl-countdown is-live"><i class="fa-solid fa-circle"></i>Spiel läuft</div>';
    }
    return '<div class="nfl-countdown is-over"><i class="fa-solid fa-flag-checkered"></i>Beendet</div>';
  }

  _cardHTML(g, status, now) {
    const date = g.time
      ? `${esc(g.date)} · ${esc(g.time)} Uhr (${g.timezone})`
      : `${esc(g.date)} · Zeit noch offen`;

    const score = this.scores.get(g.id);
    const started = Number.isFinite(g.kickoff) && g.kickoff <= now;
    // Ohne Live-Daten kein erfundenes 0:0, sondern Platzhalter
    const center = started
      ? `<div class="nfl-center${score ? '' : ' is-pending'}" ${score ? '' : 'title="Spielstand wird geladen / nicht verfügbar"'}>
           <span class="nfl-score">${score ? esc(score.home) : '–'}</span>
           <span class="nfl-vs">:</span>
           <span class="nfl-score">${score ? esc(score.away) : '–'}</span>
         </div>`
      : '<div class="nfl-center"><span class="nfl-vs">vs.</span></div>';

    const badge = score?.badge
      ? `<span class="nfl-badge ${score.badge.cls}">${esc(score.badge.text)}</span>` : '';

    const location = g.locationWiki
      ? `<a href="${esc(g.locationWiki)}" target="_blank" rel="noopener noreferrer">${esc(g.location)}</a>`
      : esc(g.location);

    const stream = this.streams.has(g.id)
      ? `<button class="nfl-stream-btn" data-game="${g.id}" aria-label="Live-Stream öffnen: ${esc(g.home)} gegen ${esc(g.away)}">
           <i class="fa-solid fa-circle-play"></i> STREAM LIVE
         </button>` : '';

    const team = (name, abbr, role) => `
      <div class="nfl-team">
        <img src="${LOGO(abbr)}" alt="${esc(name)} Logo" loading="lazy">
        <span class="nfl-team-name">${esc(name)}</span>
        <span class="nfl-team-role">${role}</span>
      </div>`;

    return `
      <article class="nfl-card${g.highlight ? ' is-highlight' : ''}">
        <div class="nfl-date">${date}</div>
        ${this._countdownHTML(g, status, now)}
        ${badge}
        <div class="nfl-matchup">
          ${team(g.home, g.homeAbbr, 'Heim')}
          ${center}
          ${team(g.away, g.awayAbbr, 'Gast')}
        </div>
        <div class="nfl-location"><i class="fa-solid fa-location-dot"></i>${location}</div>
        <div class="nfl-tv"><i class="fa-solid fa-tv"></i>${esc(g.tv)}</div>
        ${stream}
      </article>`;
  }

  // ------------------------------------------------------------
  // LIVE-SPIELSTÄNDE (ESPN)
  // ------------------------------------------------------------

  /**
   * Holt die Spielstände der gerade gewählten Woche. Ohne week-Parameter
   * liefert ESPN nur die aktuelle Woche – vergangene Wochen blieben leer.
   * Abgeschlossene Wochen werden nur einmal geladen.
   */
  async _fetchScores() {
    const week = this.week;
    if (this._scoresDone.has(week)) return;
    const now = Date.now();
    const weekGames = GAMES.filter(g => g.week === week);
    // Woche hat noch nicht begonnen → nichts zu holen
    if (!weekGames.some(g => Number.isFinite(g.kickoff) && g.kickoff <= now)) return;

    try {
      const res = await fetch(`${ESPN_URL}?seasontype=2&week=${week}&dates=${SEASON}`, { cache: 'no-store' });
      if (!res.ok) {
        console.warn(`[NFL] Spielstände nicht abrufbar (HTTP ${res.status})`);
        return;
      }
      const data = await res.json();
      (data.events || []).forEach(ev => this._applyScore(ev));
      if (weekGames.every(g => this.scores.get(g.id)?.badge?.cls === 'final')) {
        this._scoresDone.add(week);
      }
      if (this.week === week) this._render();
    } catch (err) {
      console.warn('[NFL] Spielstände nicht erreichbar:', err);
    }
  }

  _applyScore(event) {
    const comp = event.competitions?.[0];
    const teams = comp?.competitors || [];
    if (teams.length !== 2) return;
    const byName = new Map(teams.map(t => [t.team?.displayName, t]));

    const eventTime = Date.parse(event.date);
    // Beide Teams UND ungefähr der Anstoß müssen passen – sonst bekämen
    // frühere Spiele derselben Teams diesen Spielstand. Heim/Gast wird nicht
    // verglichen: bei Neutral-Site-Spielen (London, Melbourne …) weicht ESPN ab.
    const game = GAMES.find(g =>
      byName.has(g.home) && byName.has(g.away) &&
      (!Number.isFinite(eventTime) || !Number.isFinite(g.kickoff) || Math.abs(eventTime - g.kickoff) < 36 * 3600000));
    if (!game) return;
    const home = byName.get(game.home);
    const away = byName.get(game.away);

    const st = event.status?.type?.name;
    let badge = null;
    if (st === 'STATUS_FINAL') badge = { text: 'Abgeschlossen', cls: 'final' };
    else if (st === 'STATUS_IN_PROGRESS') badge = { text: `Live · Q${event.status.period || ''} ${event.status.displayClock || ''}`, cls: 'live' };
    else if (st === 'STATUS_HALFTIME') badge = { text: 'Halbzeit', cls: 'live' };

    this.scores.set(game.id, {
      home: home.score ?? '0',
      away: away.score ?? '0',
      badge
    });
  }

  // ------------------------------------------------------------
  // STREAMS
  // ------------------------------------------------------------

  async _fetchStreams() {
    try {
      const res = await fetch(STREAM_API, { cache: 'no-store' });
      if (!res.ok) return;
      const data = await res.json();
      const streams = (Array.isArray(data.streams) ? data.streams : [])
        .filter(s => String(s.category || '').toLowerCase() === 'football');

      this.streams.clear();
      GAMES.forEach(g => {
        const match = streams.find(s => {
          const text = normalize([s.name, s.stream_key].join(' '));
          return teamIn(text, g.home) && teamIn(text, g.away);
        });
        if (match) this.streams.set(g.id, match);
      });
      this._render();
    } catch (err) {
      console.warn('[NFL] Streamliste nicht erreichbar:', err);
    }
  }

  _openStream(game, stream) {
    let sources = (Array.isArray(stream.sources) ? stream.sources : [])
      .filter(s => typeof s === 'string' && /^https:\/\/[^/]+\/embed\//i.test(s));
    if (!sources.length && stream.stream_key) {
      sources = [`https://streamfree.top/embed/${encodeURIComponent(stream.category || 'football')}/${encodeURIComponent(stream.stream_key)}`];
    }
    if (!sources.length) return;
    sources.sort((a, b) => streamQuality(b) - streamQuality(a));

    const { quality, modal, frame, modalTitle } = this.el;
    quality.replaceChildren(...sources.map((src, i) => {
      const opt = document.createElement('option');
      opt.value = src;
      opt.textContent = streamLabel(src, i);
      return opt;
    }));
    modalTitle.textContent = `${game.home} vs. ${game.away} · Stream live`;
    modal.classList.add('is-open');
    modal.setAttribute('aria-hidden', 'false');
    frame.src = sources[0];
    audio.open();
  }

  _closeStream() {
    const { modal, frame, quality } = this.el;
    if (!modal.classList.contains('is-open')) return;
    frame.removeAttribute('src');
    modal.classList.remove('is-open');
    modal.setAttribute('aria-hidden', 'true');
    quality.replaceChildren();
    document.getElementById('cursor-flare')?.style.removeProperty('opacity');
  }

  // ------------------------------------------------------------
  // PIN
  // ------------------------------------------------------------

  _isUnlocked() {
    try { return sessionStorage.getItem(PIN_KEY) === '1'; } catch (_) { return false; }
  }

  _pinType(digit) {
    if (this.pinEntry.length >= 4) return;
    this.pinEntry += digit;
    audio.click();

    const dots = this.el.pinDots.children;
    dots[this.pinEntry.length - 1]?.classList.add('is-filled');
    if (this.pinEntry.length < 4) return;

    if (this.pinEntry === PIN) {
      try { sessionStorage.setItem(PIN_KEY, '1'); } catch (_) {}
      audio.addChime();
      setTimeout(() => { this.el.pin.hidden = true; }, 150);
      return;
    }

    [...dots].forEach(d => { d.classList.remove('is-filled'); d.classList.add('is-error'); });
    audio.deleteTick();
    setTimeout(() => {
      [...dots].forEach(d => d.classList.remove('is-error'));
      this.pinEntry = '';
    }, 700);
  }
}
