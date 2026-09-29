import { esc } from '../core/utils.js';
import { audio } from '../core/AudioEngine.js';

export class BvgModule {
  constructor() {
    this.STOP_ID = '900120013';
    this.VALID_LINES = ['M13', '16'];
    this.API_BASE = 'https://v6.vbb.transport.rest';
    this.REFRESH_INTERVAL = 30000;
    this._timer = null;
    this._running = false;
    this._containers = new Set();
    this._lastData = null;
    this._lastUpdate = '';
    this._inflight = null;
  }

  // Parallele Aufrufe teilen sich eine laufende Anfrage (verhindert Doppel-Fetch beim Start)
  fetch() {
    if (!this._inflight) {
      this._inflight = this._fetchDepartures().finally(() => { this._inflight = null; });
    }
    return this._inflight;
  }

  async _fetchDepartures() {
    const url = `${this.API_BASE}/stops/${this.STOP_ID}/departures?duration=60&results=20`;
    const res = await fetch(url);
    if (!res.ok) throw new Error('BVG API error');
    const data = await res.json();
    const departures = (data.departures || []).filter(d =>
      d.line && this.VALID_LINES.includes(d.line.name)
    ).slice(0, 6);
    const now = new Date();
    this._lastUpdate = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
    this._lastData = departures;
    return departures;
  }

  _badgeClass(product) {
    if (!product) return 'other';
    const p = String(product).toLowerCase();
    if (p.includes('tram')) return 'tram';
    if (p.includes('bus')) return 'bus';
    if (p.includes('subway') || p.includes('u-bahn')) return 'subway';
    return 'other';
  }

  _rowHTML(dep) {
    const when = dep.when || dep.plannedWhen;
    const actual = new Date(when);
    const planned = dep.plannedWhen ? new Date(dep.plannedWhen) : actual;
    const diff = Math.round((actual - new Date()) / 60000);
    const delay = Math.round((actual - planned) / 60000);
    const badge = this._badgeClass(dep.line && dep.line.product);
    const lineName = dep.line && dep.line.name ? dep.line.name : '?';
    const direction = dep.direction || '';
    const delayText = delay === 0 ? 'pünktlich' : (delay > 0 ? `+${delay}` : `${delay}`);
    const delayClass = delay > 0 ? 'late' : 'ontime';
    const timeText = diff <= 0 ? 'jetzt' : `${diff}m`;
    return `
      <div class="bvg-item">
        <div class="bvg-badge ${badge}">${esc(lineName)}</div>
        <div class="bvg-dest">${esc(direction)}</div>
        <div class="bvg-time-box">
          <span class="bvg-min">${timeText}</span>
          <span class="bvg-delay ${delayClass}">${delayText}</span>
        </div>
      </div>`;
  }

  _statusHTML(text) {
    return `<div class="bvg-status">${esc(text)}</div>`;
  }

  _renderInto(listEl, updateEl, departures, error) {
    if (error || !departures.length) {
      listEl.innerHTML = this._statusHTML(error ? 'Keine Verbindung' : 'Keine Abfahrten');
    } else {
      listEl.innerHTML = departures.map(d => this._rowHTML(d)).join('');
    }
    if (updateEl) updateEl.textContent = this._lastUpdate ? `Stand: ${this._lastUpdate}` : '--:--';
  }

  registerGroup(listEl, updateEl) {
    const group = { listEl, updateEl };
    this._containers.add(group);
    this._renderGroup(group);
  }

  async _renderGroup(group) {
    try {
      if (!this._lastData) await this.fetch();
      this._renderInto(group.listEl, group.updateEl, this._lastData, false);
    } catch (e) {
      this._renderInto(group.listEl, group.updateEl, null, true);
    }
  }

  async refreshAll() {
    try {
      await this.fetch();
      this._containers.forEach(g => {
        if (document.body.contains(g.listEl)) {
          this._renderInto(g.listEl, g.updateEl, this._lastData, false);
        } else {
          this._containers.delete(g);
        }
      });
    } catch (e) {
      this._containers.forEach(g => {
        if (document.body.contains(g.listEl)) {
          this._renderInto(g.listEl, g.updateEl, null, true);
        }
      });
    }
  }

  start() {
    if (this._running) return;
    this._running = true;
    this.refreshAll();
    this._timer = setInterval(() => {
      if (this._running) this.refreshAll();
    }, this.REFRESH_INTERVAL);
  }

  stop() {
    this._running = false;
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  buildWidgetHTML(idSuffix) {
    return `
      <div class="bvg-widget">
        <div class="bvg-header">
          <div class="bvg-station">
            <span class="bvg-pulse"></span>
            Traveplatz
          </div>
          <i class="fa-solid fa-train-tram bvg-header-icon"></i>
        </div>
        <div class="bvg-list" id="bvg-list-${idSuffix}">
          ${this._statusHTML('Lade Abfahrten…')}
        </div>
        <div class="bvg-footer">
          <div id="bvg-upd-${idSuffix}">--:--</div>
          <div class="bvg-refresh" data-bvg-refresh="1">REFRESH</div>
        </div>
      </div>`;
  }

  bindWidget(rootEl, idSuffix) {
    const listEl = rootEl.querySelector(`#bvg-list-${idSuffix}`);
    const updEl  = rootEl.querySelector(`#bvg-upd-${idSuffix}`);
    const refreshBtn = rootEl.querySelector('[data-bvg-refresh]');
    if (refreshBtn) {
      refreshBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        audio.click();
        this.refreshAll();
      });
    }
    if (listEl && updEl) this.registerGroup(listEl, updEl);
  }
}

export const bvg = new BvgModule();