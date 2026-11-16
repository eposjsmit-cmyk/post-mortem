// App start-up: tabs, routing, auto-sync and background reviews.
import { syncGames } from './chesscom.js';
import { db, getSettings, on } from './db.js';
import { puzzleCounts } from './puzzles.js';
import { enqueue } from './reviewer.js';
import { $, clear, h, timeAgo, toast } from './ui.js';
import { getKv } from './db.js';

const ICONS = {
  home: 'M3 11l9-7 9 7M5 10v10h14V10',
  games: 'M4 5h16M4 12h16M4 19h10',
  puzzles: 'M10 3h4v3a2 2 0 1 0 4 0V3h3v7h-3a2 2 0 1 0 0 4h3v7h-7v-3a2 2 0 1 0-4 0v3H3v-7h3a2 2 0 1 0 0-4H3V3z',
  openings: 'M6 3v12a3 3 0 1 0 3 3V9a3 3 0 1 1 3 3h3a3 3 0 1 0 3-3',
  prep: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM21 21l-5-5',
  play: 'M9 4h6l-1 4h3l-2 5H9l-2-5h3zM7 20h10M8 16h8l1 4H7z',
};

export const TABS = [
  { id: 'home', label: 'Home' },
  { id: 'games', label: 'Games' },
  { id: 'puzzles', label: 'Puzzles' },
  { id: 'openings', label: 'Openings' },
  { id: 'prep', label: 'Prep' },
  { id: 'play', label: 'Play' },
];

const VIEWS = {
  home: () => import('./views/home.js'),
  games: () => import('./views/games.js'),
  review: () => import('./views/review.js'),
  puzzles: () => import('./views/puzzles.js'),
  openings: () => import('./views/openings.js'),
  prep: () => import('./views/prep.js'),
  play: () => import('./views/play.js'),
  settings: () => import('./views/settings.js'),
};

const tabOf = (route) => (route === 'review' ? 'games' : route);

function icon(d) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '22');
  svg.setAttribute('height', '22');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = `<path d="${d}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`;
  return svg;
}

function renderTabs() {
  const nav = $('.tabs');
  clear(nav);
  for (const t of TABS) {
    nav.append(h(`a.tab#tab-${t.id}`, { href: `#/${t.id}` }, icon(ICONS[t.id]), h('span', t.label), t.id === 'puzzles' ? h('span.badge', { hidden: true }) : null));
  }
}

/** Parses "#/review/abc?ply=4" -> { route: 'review', arg: 'abc', params: { ply: '4' } }. */
export function parseHash(hash = location.hash) {
  const [path, query = ''] = hash.replace(/^#\/?/, '').split('?');
  const [route = 'home', ...rest] = path.split('/');
  return { route: route || 'home', arg: rest.map(decodeURIComponent).join('/') || null, params: Object.fromEntries(new URLSearchParams(query)) };
}

export const go = (hash) => {
  location.hash = hash;
};

let cleanup = null;
let renderId = 0;

async function route() {
  const { route: r, arg, params } = parseHash();
  const name = VIEWS[r] ? r : 'home';
  const id = ++renderId;
  try {
    cleanup?.();
  } catch (e) {
    console.error(e);
  }
  cleanup = null;
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.id === `tab-${tabOf(name)}`));
  document.querySelectorAll('.tab').forEach((t) => (t.id === `tab-${tabOf(name)}` ? t.setAttribute('aria-current', 'page') : t.removeAttribute('aria-current')));
  const view = $('#view');
  view.dataset.route = name;
  clear(view).append(h('p.loading.muted', 'Loading…'));
  const mod = await VIEWS[name]();
  if (id !== renderId) return;
  clear(view);
  window.scrollTo(0, 0);
  try {
    cleanup = (await mod.render(view, { arg, params })) ?? null;
  } catch (e) {
    console.error(e);
    view.append(h('div.card', h('h2', 'Something went wrong'), h('p', e.message)));
  }
}

async function updateBadge() {
  const counts = puzzleCounts(await db.all('puzzles'));
  const badge = $('#tab-puzzles .badge');
  if (!badge) return;
  badge.hidden = counts.due === 0;
  badge.textContent = counts.due > 99 ? '99+' : String(counts.due);
  badge.setAttribute('aria-label', `${counts.due} puzzles due`);
}

async function updateSyncStatus(detail) {
  const el = $('.sync-status');
  if (detail?.state === 'running') el.textContent = 'Syncing…';
  else if (detail?.state === 'error') el.textContent = 'Sync failed';
  else {
    const last = await getKv('lastSync', 0);
    el.textContent = last ? `Synced ${timeAgo(last)}` : '';
  }
}

/** Sync if it's been more than 10 minutes, then review a few of the new games in the background. */
export async function autoSync({ force = false } = {}) {
  const settings = await getSettings();
  if (!settings.username) return null;
  try {
    const result = await syncGames({ force });
    if (result.added) toast(`${result.added} new game${result.added === 1 ? '' : 's'} from chess.com`);
    if (settings.autoReview && result.games?.length) {
      const newest = [...result.games].sort((a, b) => b.date - a.date).slice(0, 3);
      enqueue(newest);
    }
    return result;
  } catch (e) {
    toast(e.message, { kind: 'error' });
    return null;
  }
}

async function start() {
  renderTabs();
  window.addEventListener('hashchange', route);
  if (!location.hash) history.replaceState(null, '', '#/home');
  await route();
  updateBadge();
  updateSyncStatus();
  on('puzzles', updateBadge);
  on('reviews', updateBadge);
  on('sync', updateSyncStatus);
  setInterval(() => {
    updateBadge();
    updateSyncStatus();
  }, 60000);
  autoSync();
  // Coming back to the app after a while counts as "opening" it.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') autoSync();
  });
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

start();
