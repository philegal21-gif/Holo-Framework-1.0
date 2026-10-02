import { audio } from './core/AudioEngine.js';
import { ViewManager } from './core/ViewManager.js';
import { ModuleRegistry } from './core/ModuleRegistry.js';
import { MODULES } from './modules/index.js';
import { OrbitMenu } from './components/OrbitMenu.js';
import { BootSequence } from './components/BootSequence.js';
import { userLocation } from './core/Location.js';
import { HomeTiles } from './components/HomeTiles.js';
import { StarField } from './core/StarField.js';
import { BackgroundGlow } from './core/BackgroundGlow.js';
import { VERSION } from './core/version.js';

(function bootstrap() {
  document.getElementById('app-version').textContent = `v${VERSION}`;

   // =========================================================
  // CURSOR
  // =========================================================

  // =========================================================
  // HINTERGRUND
  // =========================================================

  new BackgroundGlow(
    document.getElementById('bg-base'),
    document.getElementById('bg-breath')
  );

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

  const btnAudio = document.getElementById('btn-audio');

  const syncAudioButton = () => {
    btnAudio.setAttribute('aria-pressed', String(audio.enabled));
    btnAudio.innerHTML = audio.enabled
      ? '<i class="fa-solid fa-volume-high"></i>'
      : '<i class="fa-solid fa-volume-xmark"></i>';
  };

  btnAudio.addEventListener('click', (e) => {
    e.stopPropagation();
    audio.enabled = !audio.enabled;
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

  ModuleRegistry.register(MODULES).mountAll();

  // =========================================================
  // ORBIT MENU
  // =========================================================

  const orbitStage = document.getElementById('orbit-stage');

  const orbit = new OrbitMenu(orbitStage, {
    startHidden: true,
    isOpenable: (project) => ModuleRegistry.has(project.target),
    onOpenProject: (project) => {
      if (ModuleRegistry.open(project.target)) audio.open();
    }
  });

  // =========================================================
  // WETTER-LABEL (Startseite)
  // =========================================================

  new HomeTiles();

  new BootSequence(orbit);

  // Standort erst nach dem Aufbau anfragen (Erde-Marker + Wetter)
  userLocation.start();

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
  // START
  // =========================================================

  ViewManager.setState('HOME');

})();