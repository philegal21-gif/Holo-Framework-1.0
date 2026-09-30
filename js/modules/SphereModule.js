import { Mat3, lerp, esc } from '../core/utils.js';
import { audio } from '../core/AudioEngine.js';
import { ViewManager } from '../core/ViewManager.js';

export class SphereModule {
  constructor(rootEl, options = {}) {
    this.root = rootEl;
    this.anchor = rootEl.querySelector('#sphere-anchor');
    this.viewport = rootEl.querySelector('#sphere-viewport');
    this.ringOuter = rootEl.querySelector('#ring-outer');
    this.ringInner = rootEl.querySelector('#ring-inner');
    this.favorites = options.favorites ? [...options.favorites] : [];

    try {
      const saved = JSON.parse(localStorage.getItem('holo-favorites'));
      if (Array.isArray(saved) && saved.every(f => f && typeof f.id === 'string' && typeof f.url === 'string')) {
        this.favorites = saved.map(f => ({ id: f.id, title: String(f.title || ''), url: f.url }));
      }
    } catch (_) {}

    this.matrix = Mat3.identity();
    this.nodes = [];
    this.radius = 220;
    this.fov = 430;
    this.idleSpeed = 0.0025;
    this.isDragging = false;
    this.isHovered = false;
    this.lastX = 0; this.lastY = 0;
    this.velX = 0; this.velY = 0;
    this.targetVelX = 0; this.targetVelY = 0;

    this._build();
    this._bindInput();
    this._bindModal();
  }

  static fibonacciSphere(total) {
    const points = [];
    const goldenAngle = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < total; i++) {
      const y = total === 1 ? 0 : 1 - (i / (total - 1)) * 2;
      const r = Math.sqrt(Math.max(0, 1 - y * y));
      const theta = goldenAngle * i;
      points.push([Math.cos(theta) * r, y, Math.sin(theta) * r]);
    }
    return points;
  }

  static extractDomain(url) {
    try {
      let clean = url.trim();
      if (!/^https?:\/\//i.test(clean)) clean = 'https://' + clean;
      return new URL(clean).hostname.replace(/^www\./, '');
    } catch (e) {
      return url.replace(/^https?:\/\//, '').split('/')[0];
    }
  }

  static formatUrl(url) {
    let clean = url.trim();
    if (!/^https?:\/\//i.test(clean)) clean = 'https://' + clean;
    return clean;
  }

  static faviconUrl(domain) {
    return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=64`;
  }

  _build() {
    this.isHovered = false;
    this.anchor.innerHTML = '';
    this.nodes = [];
    const total = this.favorites.length;
    if (!total) return;

    const positions = SphereModule.fibonacciSphere(total);

    this.favorites.forEach((fav, i) => {
      const basePos = positions[i];
      const domain = SphereModule.extractDomain(fav.url);
      const faviconSrc = SphereModule.faviconUrl(domain);
      const displayName = fav.title || domain;

      const card = document.createElement('div');
      card.className = 'sphere-card';
      card.dataset.id = fav.id;
      card.innerHTML = `
        <div class="sphere-capsule">
          <div class="sphere-favicon-wrap">
            <img src="${faviconSrc}" alt="${esc(displayName)}" onerror="this.style.display='none'; this.nextElementSibling.style.display='block';" />
            <i class="fa-solid fa-globe"></i>
          </div>
          <div class="sphere-meta">
            <span class="sphere-title">${esc(displayName)}</span>
            <span class="sphere-domain">${esc(domain)}</span>
          </div>
          <button class="delete-node-btn" title="Favorit entfernen" data-del-id="${esc(fav.id)}">
            <i class="fa-solid fa-xmark"></i>
          </button>
        </div>`;

      this.anchor.appendChild(card);
      this.nodes.push({ element: card, fav, basePos });

      card.addEventListener('mouseenter', () => {
        this.isHovered = true;
        if (ViewManager.getState() === 'SPHERE_FOCUS') audio.haptic();
      });
      card.addEventListener('mouseleave', () => { this.isHovered = false; });

      card.addEventListener('click', e => {
        if (ViewManager.getState() !== 'SPHERE_FOCUS') return;
        const delBtn = e.target.closest('.delete-node-btn');
        if (delBtn) {
          e.stopPropagation();
          this._removeFavorite(fav.id);
          return;
        }
        audio.haptic();
        window.open(SphereModule.formatUrl(fav.url), '_blank', 'noopener,noreferrer');
      });
    });
  }

  _saveFavorites() {
    try {
      localStorage.setItem('holo-favorites', JSON.stringify(this.favorites));
    } catch (_) {}
  }

  _removeFavorite(id) {
    audio.deleteTick();
    this.favorites = this.favorites.filter(f => f.id !== id);
    this._saveFavorites();
    this._build();
  }

  _addFavorite(title, url) {
    this.favorites.push({ id: 'fav_' + Date.now(), title, url });
    audio.addChime();
    this._saveFavorites();
    this._build();
  }

  _updateRadius() {
    const minDim = Math.min(this.root.offsetWidth, this.root.offsetHeight);
    this.radius = Math.max(120, Math.min(280, minDim * 0.32));
    if (this.ringOuter) {
      const s = this.radius * 2.6;
      this.ringOuter.style.width = s + 'px';
      this.ringOuter.style.height = s + 'px';
    }
    if (this.ringInner) {
      const s = this.radius * 1.9;
      this.ringInner.style.width = s + 'px';
      this.ringInner.style.height = s + 'px';
    }
  }

  tick() {
    const st = ViewManager.getState();
    // Nur in der Sphere-Ansicht rechnen – in allen anderen ist sie unsichtbar
    if (st !== 'SPHERE_FOCUS') return;

    if (this.isDragging) {
      this.targetVelX *= 0.9;
      this.targetVelY *= 0.9;
      this.velX = lerp(this.velX, this.targetVelX, 0.35);
      this.velY = lerp(this.velY, this.targetVelY, 0.35);
    } else if (this.isHovered) {
      this.velX *= 0.88;
      this.velY *= 0.88;
    } else {
      this.velX *= 0.94;
      this.velY *= 0.94;
      const spd = Math.hypot(this.velX, this.velY);
      if (spd < 0.003) {
        this.velY = lerp(this.velY, this.idleSpeed, 0.03);
        this.velX = lerp(this.velX, this.idleSpeed * 0.2, 0.03);
      }
    }

    const rotMag = Math.hypot(this.velX, this.velY);
    if (rotMag > 0.00001) {
      const axis = [this.velX / rotMag, this.velY / rotMag, 0];
      this.matrix = Mat3.multiply(Mat3.fromAxisAngle(axis, rotMag), this.matrix);
    }

    this._project();
  }

  _project() {
    const R = this.radius, fov = this.fov;
    const inFocus = ViewManager.getState() === 'SPHERE_FOCUS';

    this.nodes.forEach(node => {
      const rotated = Mat3.transformPoint(this.matrix, [
        node.basePos[0] * R,
        node.basePos[1] * R,
        node.basePos[2] * R
      ]);
      const x = rotated[0], y = rotated[1], z = rotated[2];
      const depth01 = (z + R) / (R * 2);
      const scale = (fov / (fov - z)) * 0.88;
      const blur = Math.max(0, (1 - depth01) * 2.4);
      const opacity = 0.42 + depth01 * 0.58;

      node.element.style.transform = `translate3d(calc(${x.toFixed(2)}px - 50%), calc(${y.toFixed(2)}px - 50%), 0) scale(${scale.toFixed(3)})`;
      node.element.style.zIndex = String(Math.round(depth01 * 2500));
      node.element.style.opacity = opacity.toFixed(3);
      node.element.style.filter = (blur > 0.4) ? `blur(${blur.toFixed(2)}px)` : 'none';
      node.element.style.pointerEvents = (inFocus && depth01 > 0.15) ? 'auto' : 'none';
    });
  }

  _bindInput() {
    const down = (e) => {
      if (ViewManager.getState() !== 'SPHERE_FOCUS') return;
      if (e.target.closest('.delete-node-btn') || e.target.closest('.sphere-card')) return;
      this.isDragging = true;
      const x = e.clientX || (e.touches && e.touches[0].clientX) || 0;
      const y = e.clientY || (e.touches && e.touches[0].clientY) || 0;
      this.lastX = x;
      this.lastY = y;
      this.targetVelX = 0;
      this.targetVelY = 0;
    };

    const move = (e) => {
      if (!this.isDragging) return;
      const x = e.clientX || (e.touches && e.touches[0].clientX) || 0;
      const y = e.clientY || (e.touches && e.touches[0].clientY) || 0;
      this.targetVelX = (y - this.lastY) * 0.0040;
      this.targetVelY = (x - this.lastX) * 0.0040;
      this.lastX = x;
      this.lastY = y;
    };

    const up = () => { this.isDragging = false; };

    this.viewport.addEventListener('mousedown', down);
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    this.viewport.addEventListener('touchstart', e => {
      if (e.touches.length === 1) down(e);
    }, { passive: true });
    window.addEventListener('touchmove', e => {
      if (e.touches.length === 1 && this.isDragging) move(e);
    }, { passive: true });
    window.addEventListener('touchend', up);
  }

  _bindModal() {
    const modal = document.getElementById('add-modal');
    const form = document.getElementById('add-url-form');
    const inputUrl = document.getElementById('input-url');
    const inputTitle = document.getElementById('input-title');
    const previewFavicon = document.getElementById('preview-favicon');
    const previewFallback = document.getElementById('preview-fallback-icon');
    const previewTitle = document.getElementById('preview-title');
    const previewDomain = document.getElementById('preview-domain');

    const updatePreview = (val) => {
      if (!val) {
        previewTitle.textContent = 'Domain Name';
        previewDomain.textContent = 'https://domain.com';
        previewFavicon.style.display = 'none';
        previewFallback.style.display = 'block';
        return;
      }
      const domain = SphereModule.extractDomain(val);
      const customTitle = inputTitle.value.trim();
      previewTitle.textContent = customTitle || domain;
      previewDomain.textContent = SphereModule.formatUrl(val);
      if (domain.includes('.')) {
        previewFavicon.src = SphereModule.faviconUrl(domain);
        previewFavicon.style.display = 'block';
        previewFallback.style.display = 'none';
      } else {
        previewFavicon.style.display = 'none';
        previewFallback.style.display = 'block';
      }
    };

    inputUrl.addEventListener('input', e => updatePreview(e.target.value));
    inputTitle.addEventListener('input', () => updatePreview(inputUrl.value));

    const openModal = () => {
      audio.haptic();
      modal.classList.add('open');
      document.body.classList.add('modal-open');
      document.getElementById('cursor-flare').style.opacity = '0';
      setTimeout(() => inputUrl.focus(), 250);
    };

    const closeModal = () => {
      modal.classList.remove('open');
      document.body.classList.remove('modal-open');
      document.getElementById('cursor-flare').style.opacity = '1';
      form.reset();
      updatePreview('');
    };

    document.getElementById('btn-add-favorite').addEventListener('click', e => {
      e.stopPropagation();
      openModal();
    });
    document.getElementById('modal-close-btn').addEventListener('click', closeModal);
    document.getElementById('modal-cancel-btn').addEventListener('click', closeModal);
    modal.addEventListener('click', e => {
      if (e.target === modal) closeModal();
    });

    form.addEventListener('submit', e => {
      e.preventDefault();
      const raw = inputUrl.value.trim();
      if (!raw) return;
      const formatted = SphereModule.formatUrl(raw);
      const domain = SphereModule.extractDomain(formatted);
      const title = inputTitle.value.trim() || domain;
      this._addFavorite(title, formatted);
      closeModal();
    });
  }

  onResize() {
    this._updateRadius();
  }
}