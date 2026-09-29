const WEATHER_URL =
  'https://api.open-meteo.com/v1/forecast' +
  '?latitude=52.5200' +
  '&longitude=13.4050' +
  '&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m' +
  '&daily=temperature_2m_max,temperature_2m_min' +
  '&timezone=Europe%2FBerlin';

class WeatherModule {

  constructor() {
    this.data = null;
    this.lastUpdate = null;
    this.refreshTimer = null;
    this._inflight = null;
    // Mehrere Widgets (Karussell + Startseite) teilen sich Daten und Timer
    this._widgets = new Map();   // widget → refresh-Handler
  }

  buildWidgetHTML() {
    return `
      <div class="weather-widget" data-weather-widget>

        <div class="weather-header">
          <div class="weather-location">
            <i class="fa-solid fa-location-dot"></i>
            <span>BERLIN</span>
          </div>

          <button
            class="weather-refresh"
            data-weather-refresh
            title="Wetter aktualisieren">
            <i class="fa-solid fa-rotate"></i>
          </button>
        </div>

        <div class="weather-hero">

          <div class="weather-icon" data-weather-icon>
            <i class="fa-solid fa-cloud-sun"></i>
          </div>

          <div class="weather-temperature-block">

            <div class="weather-temperature">
              <span data-weather-temperature>--</span>
              <span class="weather-degree">°</span>
            </div>

            <div class="weather-condition" data-weather-condition>
              Lade Wetterdaten...
            </div>

            <div class="weather-feels">
              Gefühlt <span data-weather-feels>--°</span>
            </div>

          </div>

        </div>

        <div class="weather-stats">

          <div class="weather-stat">
            <i class="fa-solid fa-droplet"></i>
            <div>
              <span class="weather-stat-label">FEUCHTIGKEIT</span>
              <strong data-weather-humidity>--%</strong>
            </div>
          </div>

          <div class="weather-stat">
            <i class="fa-solid fa-wind"></i>
            <div>
              <span class="weather-stat-label">WIND</span>
              <strong data-weather-wind>-- km/h</strong>
            </div>
          </div>

        </div>

        <div class="weather-range">

          <div>
            <span>MAX</span>
            <strong data-weather-max>--°</strong>
          </div>

          <div class="weather-range-line"></div>

          <div>
            <span>MIN</span>
            <strong data-weather-min>--°</strong>
          </div>

        </div>

        <div class="weather-footer">
          <span data-weather-updated>WIRD GELADEN</span>
          <span class="weather-live">
            <i class="fa-solid fa-circle"></i>
            LIVE
          </span>
        </div>

      </div>
    `;
  }

  bindWidget(root) {
    const widget = root.querySelector('[data-weather-widget]');
    if (!widget || this._widgets.has(widget)) return;

    const refresh = widget.querySelector('[data-weather-refresh]');
    const onRefresh = (e) => {
      e.stopPropagation();
      refresh.classList.add('rotating');
      this.loadAll().finally(() => {
        setTimeout(() => refresh.classList.remove('rotating'), 500);
      });
    };
    if (refresh) refresh.addEventListener('click', onRefresh);
    this._widgets.set(widget, onRefresh);

    // Frische Daten direkt übernehmen, sonst laden
    const fresh = this.data && (Date.now() - this.lastUpdate) < 5 * 60 * 1000;
    if (fresh) this.render(widget, this.data);
    else this.loadAll();

    if (!this.refreshTimer) {
      this.refreshTimer = setInterval(() => this.loadAll(), 10 * 60 * 1000);
    }
  }

  /**
   * Ohne Argument werden alle Widgets gelöst.
   */
  unbindWidget(root) {
    const targets = root
      ? [root.matches?.('[data-weather-widget]') ? root : root.querySelector('[data-weather-widget]')]
      : [...this._widgets.keys()];

    targets.forEach(widget => {
      const onRefresh = this._widgets.get(widget);
      if (!onRefresh) return;
      widget.querySelector('[data-weather-refresh]')?.removeEventListener('click', onRefresh);
      this._widgets.delete(widget);
    });

    if (!this._widgets.size && this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  // Parallele Aufrufe teilen sich eine laufende Anfrage
  loadAll() {
    if (!this._inflight) {
      this._inflight = this._loadAll().finally(() => { this._inflight = null; });
    }
    return this._inflight;
  }

  async _loadAll() {
    for (const widget of this._widgets.keys()) {
      if (!document.body.contains(widget)) this.unbindWidget(widget);
    }
    if (!this._widgets.size) return;

    // Widgets, die während der Anfrage gebunden werden, hängen sich an
    // diese an – deshalb die Liste immer frisch aus _widgets lesen.
    const each = fn => [...this._widgets.keys()].forEach(fn);

    each(w => w.classList.add('loading'));
    try {
      const response = await fetch(WEATHER_URL, { cache: 'no-store' });
      if (!response.ok) {
        throw new Error(`Weather API error: ${response.status}`);
      }
      this.data = await response.json();
      this.lastUpdate = Date.now();
      each(w => this.render(w, this.data));
    } catch (error) {
      console.error('WeatherModule:', error);
      each(w => this.renderError(w));
    } finally {
      each(w => w.classList.remove('loading'));
    }
  }

  render(widget, data) {

    const current = data.current;
    const daily = data.daily;

    const temperature = Math.round(current.temperature_2m);
    const feels = Math.round(current.apparent_temperature);
    const humidity = Math.round(current.relative_humidity_2m);
    const wind = Math.round(current.wind_speed_10m);

    const max = Math.round(daily.temperature_2m_max[0]);
    const min = Math.round(daily.temperature_2m_min[0]);

    const condition = this.getCondition(current.weather_code);
    const icon = this.getIcon(current.weather_code);

    const temperatureEl =
      widget.querySelector('[data-weather-temperature]');

    const feelsEl =
      widget.querySelector('[data-weather-feels]');

    const humidityEl =
      widget.querySelector('[data-weather-humidity]');

    const windEl =
      widget.querySelector('[data-weather-wind]');

    const maxEl =
      widget.querySelector('[data-weather-max]');

    const minEl =
      widget.querySelector('[data-weather-min]');

    const conditionEl =
      widget.querySelector('[data-weather-condition]');

    const iconEl =
      widget.querySelector('[data-weather-icon]');

    const updatedEl =
      widget.querySelector('[data-weather-updated]');

    if (temperatureEl)
      temperatureEl.textContent = temperature;

    if (feelsEl)
      feelsEl.textContent = `${feels}°`;

    if (humidityEl)
      humidityEl.textContent = `${humidity}%`;

    if (windEl)
      windEl.textContent = `${wind} km/h`;

    if (maxEl)
      maxEl.textContent = `${max}°`;

    if (minEl)
      minEl.textContent = `${min}°`;

    if (conditionEl)
      conditionEl.textContent = condition;

    if (iconEl)
      iconEl.innerHTML = `<i class="${icon}"></i>`;

    if (updatedEl) {

      const time = new Date(this.lastUpdate ?? Date.now()).toLocaleTimeString(
        'de-DE',
        {
          hour: '2-digit',
          minute: '2-digit'
        }
      );

      updatedEl.textContent = `AKTUALISIERT ${time}`;
    }

    widget.classList.remove('weather-error');
  }

  renderError(widget) {

    const condition =
      widget.querySelector('[data-weather-condition]');

    const updated =
      widget.querySelector('[data-weather-updated]');

    const icon =
      widget.querySelector('[data-weather-icon]');

    if (condition)
      condition.textContent = 'Wetterdaten nicht verfügbar';

    if (updated)
      updated.textContent = 'VERBINDUNGSFEHLER';

    if (icon)
      icon.innerHTML =
        '<i class="fa-solid fa-triangle-exclamation"></i>';

    widget.classList.add('weather-error');
  }

  getCondition(code) {

    const conditions = {

      0: 'Klarer Himmel',

      1: 'Überwiegend klar',
      2: 'Teilweise bewölkt',
      3: 'Bedeckt',

      45: 'Neblig',
      48: 'Reifnebel',

      51: 'Leichter Nieselregen',
      53: 'Nieselregen',
      55: 'Starker Nieselregen',

      56: 'Leichter gefrierender Regen',
      57: 'Gefrierender Regen',

      61: 'Leichter Regen',
      63: 'Regen',
      65: 'Starker Regen',

      66: 'Leichter gefrierender Regen',
      67: 'Starker gefrierender Regen',

      71: 'Leichter Schneefall',
      73: 'Schneefall',
      75: 'Starker Schneefall',

      77: 'Schneekörner',

      80: 'Leichte Regenschauer',
      81: 'Regenschauer',
      82: 'Starke Regenschauer',

      85: 'Leichte Schneeschauer',
      86: 'Starke Schneeschauer',

      95: 'Gewitter',

      96: 'Gewitter mit Hagel',
      99: 'Starkes Gewitter mit Hagel'
    };

    return conditions[code] || 'Unbekannt';
  }

  getIcon(code) {

    if (code === 0)
      return 'fa-solid fa-sun';

    if ([1, 2].includes(code))
      return 'fa-solid fa-cloud-sun';

    if (code === 3)
      return 'fa-solid fa-cloud';

    if ([45, 48].includes(code))
      return 'fa-solid fa-smog';

    if ([51, 53, 55, 56, 57].includes(code))
      return 'fa-solid fa-cloud-rain';

    if ([61, 63, 65, 66, 67, 80, 81, 82].includes(code))
      return 'fa-solid fa-cloud-showers-heavy';

    if ([71, 73, 75, 77, 85, 86].includes(code))
      return 'fa-solid fa-snowflake';

    if ([95, 96, 99].includes(code))
      return 'fa-solid fa-cloud-bolt';

    return 'fa-solid fa-cloud';
  }
}

export const weather = new WeatherModule();