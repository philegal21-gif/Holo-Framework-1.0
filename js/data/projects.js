/**
 * Zentrale Projektliste für das Orbit-Menü.
 *
 * target:
 *   'carousel'   → öffnet das Carousel-Modul
 *   'sphere'     → öffnet das Sphere-Modul
 *   'watchtime'  → öffnet den Football-Stream-Player
 *   'nfl'        → öffnet den NFL-Spielplan (apps/nfl)
 *   'placeholder'→ zeigt "Coming soon"-Hinweis
 *   'empty'      → leerer Slot mit "+", nicht klickbar
 */

export const PROJECTS = [
  {
    id: 'carousel',
    name: 'Carousel',
    subtitle: 'BVG · Wetter · mehr',
    icon: 'fa-solid fa-layer-group',
    target: 'carousel'
  },
  {
    id: 'sphere',
    name: 'Sphere',
    subtitle: '3D-Umgebung',
    icon: 'fa-solid fa-globe',
    target: 'sphere'
  },
  {
    id: 'nfl',
    name: 'NFL',
    subtitle: 'Spielplan',
    icon: 'fa-solid fa-calendar-days',
    target: 'nfl'
  },
  {
    id: 'watchtime',
    name: 'Watchtime',
    subtitle: 'Football Streams',
    icon: 'fa-solid fa-football',
    target: 'watchtime'
  },
  {
    id: 'favorites',
    name: 'Favoriten',
    subtitle: 'Gemischt',
    icon: 'fa-solid fa-star',
    target: 'placeholder'
  },
  {
    id: 'neural',
    name: 'Neural',
    subtitle: 'inaktiv',
    icon: 'fa-solid fa-brain',
    target: 'placeholder'
  },
  {
    id: 'notes',
    name: 'Notizen',
    subtitle: 'Platzhalter',
    icon: 'fa-solid fa-note-sticky',
    target: 'placeholder'
  },
  {
    id: 'add',
    name: 'Neu',
    subtitle: 'Platz frei',
    icon: 'fa-solid fa-plus',
    target: 'empty'
  }
];