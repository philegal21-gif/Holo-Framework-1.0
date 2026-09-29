import { audio } from './core/AudioEngine.js';
import { ViewManager } from './core/ViewManager.js';
import { bvg } from './modules/BvgModule.js';
import { CarouselModule } from './modules/CarouselModule.js';
import { SphereModule } from './modules/SphereModule.js';
import { WatchtimeModule } from './modules/WatchtimeModule.js';
import { NflModule } from './modules/NflModule.js';
import { OrbitMenu } from './components/OrbitMenu.js';
import { StarField } from './core/StarField.js';

const DEFAULT_FAVORITES = [
  { id: 'fav_yt',   title: 'YouTube',       url: 'https://www.youtube.com' },
  { id: 'fav_ig',   title: 'Instagram',     url: 'https://www.instagram.com' },
  { id: 'fav_fb',   title: 'Facebook',      url: 'https://www.facebook.com' },
  { id: 'fav_gem',  title: 'Gemini',        url: 'https://gemini.google.com' },
  { id: 'fav_gol',  title: 'golem.de',      url: 'https://www.golem.de' },
  { id: 'fav_ka',   title: 'Kleinanzeigen', url: 'https://www.kleinanzeigen.de' },
  { id: 'fav_fmhy', title: 'FMHY',          url: 'https://fmhy.pages.dev/' }
];

(function bootstrap() {
   // =========================================================
  // CURSOR
  // =========================================================

  // =========================================================
  // HINTERGRUND
  // =========================================================

  const stars = new StarField(document.getElementById('bg-stars'));

  // Einstellungen merken
  const STAR_PREFS = 'holo-stars';
  try {
    const p = JSON.parse(localStorage.getItem(STAR_PREFS)) || {};
    if (p.fast) stars.toggleSpeed();
    if (p.network === false) stars.toggleConstellations();
  } catch (_) {}

  const btnSpeed = document.getElementById('btn-stars-speed');
  const btnNetwork = document.getElementById('btn-stars-network');

  const syncStarButtons = () => {
    btnSpeed.setAttribute('aria-pressed', String(stars.speed !== 1));
    btnNetwork.setAttribute('aria-pressed', String(stars.showConstellations));
    try {
      localStorage.setItem(STAR_PREFS, JSON.stringify({
        fast: stars.speed !== 1,
        network: stars.showConstellations
      }));
    } catch (_) {}
  };

  btnSpeed.addEventListener('click', () => {
    stars.toggleSpeed();
    syncStarButtons();
    audio.click();
  });
  btnNetwork.addEventListener('click', () => {
    stars.toggleConstellations();
    syncStarButtons();
    audio.click();
  });
  syncStarButtons();

  // =========================================================
  // TON AN/AUS
  // =========================================================

  const AUDIO_PREF = 'holo-audio';
  const btnAudio = document.getElementById('btn-audio');
  try {
    if (localStorage.getItem(AUDIO_PREF) === 'off') audio.enabled = false;
  } catch (_) {}

  const syncAudioButton = () => {
    btnAudio.setAttribute('aria-pressed', String(audio.enabled));
    btnAudio.innerHTML = audio.enabled
      ? '<i class="fa-solid fa-volume-high"></i>'
      : '<i class="fa-solid fa-volume-xmark"></i>';
  };

  btnAudio.addEventListener('click', (e) => {
    e.stopPropagation();
    audio.enabled = !audio.enabled;
    try { localStorage.setItem(AUDIO_PREF, audio.enabled ? 'on' : 'off'); } catch (_) {}
    syncAudioButton();
    if (audio.enabled) {
      audio.unlock();
      audio.click();
    }
  });
  syncAudioButton();

  const cursor = document.getElementById('cursor-flare');
  document.addEventListener('mousemove', e => {
    cursor.style.left = e.clientX + 'px';
    cursor.style.top = e.clientY + 'px';
  });

  // =========================================================
  // MODULES
  // =========================================================

  const carousel = new CarouselModule(document.getElementById('carousel-wrapper'));
  const sphere = new SphereModule(document.getElementById('sphere-wrapper'), {
    favorites: DEFAULT_FAVORITES
  });
  sphere._updateRadius();

  new WatchtimeModule(document.getElementById('watchtime-mount'));
  new NflModule(document.getElementById('nfl-mount'));

  bvg.start();

  // =========================================================
  // ORBIT MENU
  // =========================================================

  const orbitStage = document.getElementById('orbit-stage');

  const orbit = new OrbitMenu(orbitStage, {
    onOpenProject: (project) => {
      if (project.target === 'carousel') {
        ViewManager.focusCarousel();
        audio.open();
      } else if (project.target === 'sphere') {
        ViewManager.focusSphere();
        audio.open();
      } else if (project.target === 'watchtime') {
        ViewManager.focusWatchtime();
        audio.open();
      } else if (project.target === 'nfl') {
        ViewManager.focusNfl();
        audio.open();
      }
    }
  });

  // =========================================================
  // BACK-BUTTON
  // =========================================================

  document.getElementById('btn-back').addEventListener('click', () => {
    ViewManager.goHome();
    audio.close();
  });

  // =========================================================
  // KEYBOARD
  // =========================================================

  document.addEventListener('keydown', e => {
    if (document.body.classList.contains('modal-open')) {
      if (e.key === 'Escape') document.getElementById('modal-cancel-btn').click();
      return;
    }
    if (e.key === 'Escape') {
      if (ViewManager.getState() !== 'HOME') {
        ViewManager.goHome();
        audio.close();
      }
      return;
    }
    if (ViewManager.getState() === 'CAROUSEL_FOCUS') {
      if (['ArrowRight', 'ArrowDown'].includes(e.key)) {
        e.preventDefault();
        carousel.next();
      } else if (['ArrowLeft', 'ArrowUp'].includes(e.key)) {
        e.preventDefault();
        carousel.prev();
      } else if (e.key === ' ') {
        e.preventDefault();
        carousel.toggleAutoPlay();
        audio.click();
      }
    }
  });

  // =========================================================
  // VIEW-CHANGE
  // =========================================================

  ViewManager.onChange((next) => {
    if (next !== 'CAROUSEL_FOCUS' && carousel.isAutoPlaying) {
      carousel._stopAutoPlay();
    }
    if (next === 'SPHERE_FOCUS') {
      sphere._updateRadius();
    }
  });

  // =========================================================
  // RESIZE
  // =========================================================

  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      carousel.onResize();
      sphere.onResize();
    }, 80);
  });

  // =========================================================
  // ANIMATION LOOP
  // =========================================================

  (function loop() {
    sphere.tick();
    requestAnimationFrame(loop);
  })();

  // =========================================================
  // VISIBILITY
  // =========================================================

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      bvg.stop();
    } else {
      bvg.start();
    }
  });

  // =========================================================
  // AUDIO UNLOCK
  // =========================================================

  ['mousedown', 'keydown', 'touchstart', 'wheel'].forEach(evt => {
    document.addEventListener(evt, () => audio.unlock(), {
      once: true,
      passive: true,
      capture: true
    });
  });

  // =========================================================
  // FPS COUNTER
  // =========================================================

  let fc = 0, last = performance.now();
  (function fps() {
    fc++;
    const n = performance.now();
    if (n - last >= 1000) {
      document.getElementById('hud-frame').textContent = fc;
      fc = 0;
      last = n;
    }
    requestAnimationFrame(fps);
  })();

  // =========================================================
  // START
  // =========================================================

  ViewManager.setState('HOME');

  if (window.lucide) lucide.createIcons();
})();