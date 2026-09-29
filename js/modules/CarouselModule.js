import { esc } from '../core/utils.js';
import { audio } from '../core/AudioEngine.js';
import { ViewManager } from '../core/ViewManager.js';
import { bvg } from './BvgModule.js';
import { weather } from './WeatherModule.js';

export class CarouselModule {
  constructor(rootEl, options = {}) {
    this.root = rootEl;
    this.track = rootEl.querySelector('.carousel-track') || rootEl.querySelector('#carousel-track');
    this.dotsContainer = options.dotsContainer || document.getElementById('dots-container');
    this.autoplayBar = options.autoplayBar || document.getElementById('autoplay-bar');
    this.autoplayProgress = options.autoplayProgress || document.getElementById('autoplay-progress');

    this.slides = options.slides || [
      { id: 'TRAVEPLATZ', type: 'bvg' },
      { id: 'WEATHER', type: 'weather' },
      { id: 'SLIDE_03' },
      { id: 'SLIDE_04' },
      { id: 'SLIDE_05' }
    ];

    // Gesamtgröße des Karussells (1 = ursprüngliche Größe). Skaliert Radien und
    // Kacheln gemeinsam, damit die Form gleich bleibt.
    this.size = options.size ?? 0.75;

    this.total = this.slides.length;
    this.currentIndex = 0;
    this.isAutoPlaying = false;
    this.autoPlayRAF = null;
    this.autoPlayStart = 0;
    this.autoPlayDuration = 5000;
    this.tiltX = 0;
    this.tiltY = 0;
    this.isDragging = false;
    this.dragStartX = 0;
    this.dragDelta = 0;
    this.suppressClick = false;
    this._tiltRAF = null;
    this._tiles = [];
    this._dots = [];
    this._wheelT = null;
    this._bvgTile = null;
    this._weatherTile = null;
    this._focusEnteredAt = performance.now();
    this._destroyed = false;

    // Zentrale Abort-Steuerung für alle globalen Listener
    this._abort = new AbortController();
    const { signal } = this._abort;

    // State-Listener separat speichern, damit wir ihn beim Destroy abmelden können
    this._onViewChange = (next) => {
      if (next === 'CAROUSEL_FOCUS') this._focusEnteredAt = performance.now();
    };
    this._unsubscribeView = ViewManager.onChange(this._onViewChange);

    this._build();
    this._bindCarousel(signal);
  }

  _build() {
    this.track.innerHTML = '';
    this.dotsContainer.innerHTML = '';
    this._tiles = [];
    this._dots = [];
    this._bvgTile = null;
    this._weatherTile = null;

    const fragment = document.createDocumentFragment();
    const dotsFragment = document.createDocumentFragment();

    this.slides.forEach((slide, i) => {
      const tile = document.createElement('div');
      tile.className = 'holo-tile';
      tile.dataset.index = i;

      const isBvg = slide.type === 'bvg';
      const isWeather = slide.type === 'weather';

      if (isBvg) {
        tile.dataset.type = 'bvg';
        tile.innerHTML = `
          <div class="tile-inner tile-bvg">
            ${bvg.buildWidgetHTML('tile')}
          </div>`;
        this._bvgTile = tile;
      } else if (isWeather) {
        tile.dataset.type = 'weather';
        tile.innerHTML = `
          <div class="tile-inner tile-weather">
            ${weather.buildWidgetHTML('tile')}
          </div>`;
        this._weatherTile = tile;
      } else {
        tile.innerHTML = `
          <div class="tile-inner">
            <div class="tile-placeholder">${esc(slide.id)}</div>
          </div>`;
      }

      this._attachTileHandlers(tile);
      fragment.appendChild(tile);

      const dot = document.createElement('div');
      dot.className = 'dot' + (i === 0 ? ' active' : '');
      dot.dataset.index = i;
      dot.addEventListener('click', () => {
        this.goTo(parseInt(dot.dataset.index, 10));
      });
      dotsFragment.appendChild(dot);
    });

    this.track.appendChild(fragment);
    this.dotsContainer.appendChild(dotsFragment);

    this._tiles = Array.from(this.track.querySelectorAll('.holo-tile'));
    this._dots = Array.from(this.dotsContainer.querySelectorAll('.dot'));

    if (this._bvgTile) {
      bvg.bindWidget(this._bvgTile, 'tile');
    }
    if (this._weatherTile) {
      weather.bindWidget(this._weatherTile, 'tile');
    }

    this.update();
  }

  _attachTileHandlers(tile) {
    let pointerInfo = null;

    tile.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 && e.pointerType === 'mouse') return;
      pointerInfo = {
        x: e.clientX,
        y: e.clientY,
        time: performance.now(),
        state: ViewManager.getState(),
        target: e.target
      };
    });

    tile.addEventListener('pointerup', (e) => {
      if (!pointerInfo) return;
      const dx = Math.abs(e.clientX - pointerInfo.x);
      const dy = Math.abs(e.clientY - pointerInfo.y);
      const dt = performance.now() - pointerInfo.time;
      const target = pointerInfo.target;
      const startState = pointerInfo.state;
      pointerInfo = null;

      if (dx > 6 || dy > 6 || dt > 900) return;
      if (target && target.closest &&
          target.closest('[data-bvg-refresh], [data-weather-refresh]')) return;

      const idx = parseInt(tile.dataset.index, 10);

      if (ViewManager.getState() !== 'CAROUSEL_FOCUS') return;
      if (this.suppressClick) return;
      if (startState === 'HOME') return;
      if ((performance.now() - this._focusEnteredAt) < 400) return;

      if (idx !== this.currentIndex) {
        this.goTo(idx);
      }
    });

    tile.addEventListener('pointercancel', () => { pointerInfo = null; });

    tile.addEventListener('mouseenter', () => {
      if (ViewManager.getState() === 'CAROUSEL_FOCUS') {
        document.getElementById('cursor-flare')?.classList.add('hover');
      }
    });
    tile.addEventListener('mouseleave', () => {
      document.getElementById('cursor-flare')?.classList.remove('hover');
    });
  }

  update() {
    if (this._destroyed || !this._tiles.length) return;
    const w = window.innerWidth;
    const h = window.innerHeight;
    const s = this.size;
    const radiusX = Math.min(w * 0.42, 540) * s;
    const radiusY = Math.min(h * 0.16, 150) * s;
    const radiusZ = Math.min(w * 0.3, 400) * s;
    const T = this.total;

    this._tiles.forEach((tile, i) => {
      let offset = ((i - this.currentIndex + T) % T);
      if (offset > T / 2) offset -= T;
      const angle = (offset / T) * Math.PI * 2;
      const x = Math.sin(angle) * radiusX;
      const y = Math.cos(angle) * radiusY * 0.3;
      const z = Math.cos(angle) * radiusZ;
      const isActive = (i === this.currentIndex);
      const scale = (isActive ? 1.32 : 0.7 + 0.2 * Math.cos(angle)) * s;
      const opacity = isActive ? 1 : 0.32 + 0.48 * Math.max(0, Math.cos(angle));
      const blur = isActive ? 0 : Math.min(2.8, Math.abs(offset) * 0.55);
      const rotY = angle * 26 + this.tiltX * 6;
      const rotX = this.tiltY * 5;

      tile.style.transform = `translate3d(${x.toFixed(2)}px, ${y.toFixed(2)}px, ${z.toFixed(2)}px) rotateX(${rotX.toFixed(2)}deg) rotateY(${rotY.toFixed(2)}deg) scale(${scale.toFixed(3)})`;
      tile.style.opacity = opacity.toFixed(3);
      // Immer blur() setzen (auch 0) verhindert Safari-Flackern beim Wechsel none ↔ blur
      tile.style.filter = `blur(${blur.toFixed(2)}px)`;
      // zIndex darf nie negativ werden, sonst verschwindet das Tile hinter Body/Canvas
      tile.style.zIndex = isActive ? 100 : Math.max(1, Math.round(50 + z / 4));
      tile.classList.toggle('active', isActive);
    });

    this._dots.forEach((d, i) => d.classList.toggle('active', i === this.currentIndex));
  }

  goTo(index) {
    if (this._destroyed) return;
    if (ViewManager.getState() === 'HOME') return;
    const T = this.total;
    const nextIdx = ((index % T) + T) % T;
    if (nextIdx === this.currentIndex) return;
    this.currentIndex = nextIdx;
    this.update();
    audio.slide();
    this._resetAutoPlay();
  }

  next() { this.goTo(this.currentIndex + 1); }
  prev() { this.goTo(this.currentIndex - 1); }

  startAutoPlay() {
    if (this._destroyed) return;
    this._stopAutoPlay();
    this.isAutoPlaying = true;
    this.autoPlayStart = performance.now();
    if (this.autoplayProgress) this.autoplayProgress.classList.add('visible');

    const tick = (now) => {
      if (!this.isAutoPlaying || this._destroyed) return;

      // Wenn wir nicht im Fokus-State sind, Autoplay sauber stoppen
      if (ViewManager.getState() !== 'CAROUSEL_FOCUS') {
        this._stopAutoPlay();
        return;
      }

      const p = Math.min(1, (now - this.autoPlayStart) / this.autoPlayDuration);
      if (this.autoplayBar) this.autoplayBar.style.width = (p * 100) + '%';
      if (p >= 1) {
        this.next();
        this.autoPlayStart = performance.now();
      }
      this.autoPlayRAF = requestAnimationFrame(tick);
    };
    this.autoPlayRAF = requestAnimationFrame(tick);
  }

  _stopAutoPlay() {
    this.isAutoPlaying = false;
    if (this.autoPlayRAF) cancelAnimationFrame(this.autoPlayRAF);
    this.autoPlayRAF = null;
    if (this.autoplayProgress) this.autoplayProgress.classList.remove('visible');
    if (this.autoplayBar) this.autoplayBar.style.width = '0%';
  }

  toggleAutoPlay() {
    if (this.isAutoPlaying) this._stopAutoPlay();
    else this.startAutoPlay();
  }

  _resetAutoPlay() {
    if (this.isAutoPlaying) this.autoPlayStart = performance.now();
  }

  _bindCarousel(signal) {
    const trackEl = this.track;

    trackEl.addEventListener('wheel', (e) => {
      if (ViewManager.getState() !== 'CAROUSEL_FOCUS') return;
      e.preventDefault();
      const deltaY = e.deltaY;
      clearTimeout(this._wheelT);
      this._wheelT = setTimeout(() => {
        deltaY > 0 ? this.next() : this.prev();
      }, 60);
    }, { passive: false, signal });

    trackEl.addEventListener('mousedown', (e) => {
      if (ViewManager.getState() !== 'CAROUSEL_FOCUS' || e.button !== 0) return;
      this.isDragging = true;
      this.dragStartX = e.clientX;
      this.dragDelta = 0;
    }, { signal });

    window.addEventListener('mousemove', (e) => {
      if (!this.isDragging) return;
      this.dragDelta = e.clientX - this.dragStartX;
    }, { signal });

    window.addEventListener('mouseup', () => {
      if (!this.isDragging) return;
      this.isDragging = false;
      if (Math.abs(this.dragDelta) > 55) {
        this.suppressClick = true;
        this.dragDelta < 0 ? this.next() : this.prev();
        setTimeout(() => { this.suppressClick = false; }, 200);
      }
      this.dragDelta = 0;
    }, { signal });

    let touchStartX = 0, touchDelta = 0;
    trackEl.addEventListener('touchstart', (e) => {
      if (ViewManager.getState() !== 'CAROUSEL_FOCUS') return;
      touchStartX = e.touches[0].clientX;
      touchDelta = 0;
    }, { passive: true, signal });

    trackEl.addEventListener('touchmove', (e) => {
      if (ViewManager.getState() !== 'CAROUSEL_FOCUS') return;
      touchDelta = e.touches[0].clientX - touchStartX;
    }, { passive: true, signal });

    trackEl.addEventListener('touchend', () => {
      if (ViewManager.getState() !== 'CAROUSEL_FOCUS') return;
      if (Math.abs(touchDelta) > 45) {
        // suppressClick auch bei Touch setzen, sonst feuert evtl. ein nachgelagerter click
        this.suppressClick = true;
        touchDelta < 0 ? this.next() : this.prev();
        setTimeout(() => { this.suppressClick = false; }, 200);
      }
      touchStartX = 0;
      touchDelta = 0;
    }, { passive: true, signal });

    // Tilt nur auf Desktop – auf Touch-Geräten gibt es kein mousemove
    document.addEventListener('mousemove', (e) => {
      if (this._destroyed) return;
      if (ViewManager.getState() !== 'CAROUSEL_FOCUS') return;
      const cx = window.innerWidth / 2;
      const cy = window.innerHeight / 2;
      this.tiltX = (e.clientX - cx) / cx;
      this.tiltY = (e.clientY - cy) / cy;
      if (!this._tiltRAF) {
        this._tiltRAF = requestAnimationFrame(() => {
          this.update();
          this._tiltRAF = null;
        });
      }
    }, { signal });
  }

  onResize() {
    this.update();
  }

  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;

    // 1. Alle globalen Listener abräumen
    this._abort.abort();

    // 2. State-Subscription abmelden (ViewManager sollte eine Unsubscribe-Fn zurückgeben)
    if (typeof this._unsubscribeView === 'function') {
      this._unsubscribeView();
    }

    // 3. Laufende Timer/RAF stoppen
    this._stopAutoPlay();
    if (this._tiltRAF) cancelAnimationFrame(this._tiltRAF);
    this._tiltRAF = null;
    clearTimeout(this._wheelT);

    if (typeof weather.unbindWidget === 'function') {
      weather.unbindWidget();
    }

    this.track.innerHTML = '';
    this.dotsContainer.innerHTML = '';
    this._tiles = [];
    this._dots = [];
    this._bvgTile = null;
    this._weatherTile = null;
  }
}