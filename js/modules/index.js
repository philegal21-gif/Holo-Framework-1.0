/**
 * Alle Orbit-Module an einer Stelle.
 *
 * Neues Modul hinzufügen:
 *   1. Klasse in js/modules/ anlegen (constructor(rootEl) bekommt den Mount).
 *   2. Hier eine Definition eintragen – Format siehe js/core/ModuleRegistry.js.
 *   3. In js/data/projects.js einen Eintrag mit target: '<id>' anlegen.
 *
 * Slot, State, Body-Klasse und Stylesheet kommen automatisch.
 */

import { audio } from '../core/AudioEngine.js';
import { bvg } from './BvgModule.js';
import { CarouselModule } from './CarouselModule.js';
import { SphereModule } from './SphereModule.js';
import { WatchtimeModule } from './WatchtimeModule.js';
import { NflModule } from './NflModule.js';

const DEFAULT_FAVORITES = [
  { id: 'fav_yt',   title: 'YouTube',       url: 'https://www.youtube.com' },
  { id: 'fav_ig',   title: 'Instagram',     url: 'https://www.instagram.com' },
  { id: 'fav_fb',   title: 'Facebook',      url: 'https://www.facebook.com' },
  { id: 'fav_gem',  title: 'Gemini',        url: 'https://gemini.google.com' },
  { id: 'fav_gol',  title: 'golem.de',      url: 'https://www.golem.de' },
  { id: 'fav_ka',   title: 'Kleinanzeigen', url: 'https://www.kleinanzeigen.de' },
  { id: 'fav_fmhy', title: 'FMHY',          url: 'https://fmhy.pages.dev/' }
];

export const MODULES = [
  {
    id: 'carousel',
    mount: '#carousel-wrapper',
    create(el) {
      bvg.start();
      return new CarouselModule(el);
    },
    onLeave(carousel) {
      if (carousel.isAutoPlaying) carousel._stopAutoPlay();
    },
    onKeyDown(carousel, e) {
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
    },
    onResize: carousel => carousel.onResize(),
    onVisibilityChange(_, hidden) {
      if (hidden) bvg.stop();
      else bvg.start();
    }
  },
  {
    id: 'sphere',
    mount: '#sphere-wrapper',
    create(el) {
      const sphere = new SphereModule(el, { favorites: DEFAULT_FAVORITES });
      sphere._updateRadius();
      return sphere;
    },
    onEnter: sphere => sphere._updateRadius(),
    onResize: sphere => sphere.onResize(),
    tick: sphere => sphere.tick()
  },
  {
    id: 'watchtime',
    styles: 'css/modules/watchtime.css',
    create: el => new WatchtimeModule(el)
  },
  {
    id: 'nfl',
    styles: 'css/modules/nfl.css',
    create: el => new NflModule(el)
  }
];
