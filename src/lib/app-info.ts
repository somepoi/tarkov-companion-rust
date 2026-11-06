/**
 * Build-time constants for both the renderer and the About screen. Values come
 * from package.json through vite.config.ts `define`, so there is a single
 * source of truth for the version and the GitHub repository.
 */
export const APP_NAME: string = import.meta.env.VITE_APP_NAME ?? 'Tarkov Companion Rust'
export const APP_VERSION: string = import.meta.env.VITE_APP_VERSION ?? '0.0.0'
/** e.g. https://github.com/owner/repo (no trailing slash). */
export const REPO_URL: string = (import.meta.env.VITE_REPO_URL ?? '').replace(/\/$/, '')
export const RELEASES_URL = REPO_URL ? `${REPO_URL}/releases/latest` : ''

export interface Credit {
  name: string
  url: string
  license: string
  what: string
}

export const CREDITS: Credit[] = [
  { name: 'tarkov.dev', url: 'https://tarkov.dev', license: 'MIT (data and API by the-hideout)', what: 'Quests, items, traders, maps, prices and the map coordinate transforms.' },
  { name: 'tarkov-dev-svg-maps', url: 'https://github.com/the-hideout/tarkov-dev-svg-maps', license: 'CC BY-NC-SA 4.0', what: 'The map drawings (SVG) and photo imagery used for most maps.' },
  { name: 'RE3MR', url: 'https://reemr.se', license: 'CC BY-NC-SA 4.0', what: 'The post-1.1.5 Lighthouse render, sliced into tiles for this app.' },
  { name: 'Jindouz', url: 'https://escapefromtarkov.fandom.com/wiki/Lighthouse', license: 'CC BY-SA 3.0 (EFT Wiki)', what: "His 2D Lighthouse map (September 2026): the layout of the app's updated Lighthouse drawing, placed on the game's own positions and redrawn in the tarkov.dev style." },
  { name: 'Escape from Tarkov Wiki', url: 'https://escapefromtarkov.fandom.com', license: 'CC BY-SA 3.0', what: 'Quest guide pictures, the story chapter walkthroughs with their waiting times, and the endings.' },
  { name: 'TarkovMonitor', url: 'https://github.com/the-hideout/TarkovMonitor', license: 'GPL-3.0 (reference only; no code copied)', what: 'Where the meaning of the game log lines was learned. The parser here is an independent implementation.' },
  { name: 'Tesseract OCR (tesseract.js)', url: 'https://github.com/naptha/tesseract.js', license: 'Apache-2.0', what: 'Reads the item names printed in stash screenshots, offline, for the stash scanner.' },
  { name: 'Tauri and native Rust dependencies', url: `${REPO_URL}/blob/main/THIRD_PARTY_NOTICES_RUST.txt`, license: 'See THIRD_PARTY_NOTICES_RUST.txt for individual licenses and full texts', what: 'The native Windows host, local database, backup and desktop integrations.' },
  { name: 'React, Leaflet, TanStack, Zustand, Tailwind, Geoman, lucide', url: `${REPO_URL}/blob/main/THIRD_PARTY_NOTICES.txt`, license: 'MIT and similar (full texts in THIRD_PARTY_NOTICES.txt)', what: 'The shared interface libraries.' },
]
