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
    this.loading = false;
    this.lastUpdate = null;
    this.refreshTimer = null;
    this._boundWidget = null;
    this._refreshBtn = null;
    this._onRefresh = null;
  }

  buildWidgetHTML(mode = 'tile') {
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

  bindWidget(tile, mode = 'tile') {
    this.unbindWidget();

    const widget = tile.querySelector('[data-weather-widget]');

    if (!widget) return;

    this._boundWidget = widget;
    this.load(widget);

    const refresh = widget.querySelector('[data-weather-refresh]');

    if (refresh) {
      this._onRefresh = (e) => {
        e.stopPropagation();
        refresh.classList.add('rotating');
        this.load(widget).finally(() => {
          setTimeout(() => {
            refresh.classList.remove('rotating');
          }, 500);
        });
      };
      refresh.addEventListener('click', this._onRefresh);
      this._refreshBtn = refresh;
    }

    this.refreshTimer = setInterval(() => {
      if (this._boundWidget && document.body.contains(this._boundWidget)) {
        this.load(this._boundWidget);
      }
    }, 10 * 60 * 1000);
  }

  unbindWidget() {
    if (this._refreshBtn && this._onRefresh) {
      this._refreshBtn.removeEventListener('click', this._onRefresh);
    }
    this._refreshBtn = null;
    this._onRefresh = null;
    this._boundWidget = null;
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  async load(widget) {

    if (!widget || this.loading) return;

    this.loading = true;

    widget.classList.add('loading');

    try {

      const response = await fetch(WEATHER_URL, {
        cache: 'no-store'
      });

      if (!response.ok) {
        throw new Error(`Weather API error: ${response.status}`);
      }

      const data = await response.json();

      this.data = data;
      this.lastUpdate = new Date();

      this.render(widget, data);

    } catch (error) {

      console.error('WeatherModule:', error);

      this.renderError(widget);

    } finally {

      this.loading = false;
      widget.classList.remove('loading');

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

      const time = new Date().toLocaleTimeString(
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