// chess.com public API: games archives and ratings. No password needed.
import { db, emit, getKv, getSettings, setKv } from './db.js';
import { gameFromPgn, terminationFromCodes } from './pgn.js';

const API = 'https://api.chess.com/pub/player';
export const SYNC_EVERY_MS = 10 * 60 * 1000;

async function getJson(url) {
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (res.status === 404) throw new Error('That chess.com username was not found.');
  if (res.status === 429) throw new Error('chess.com is asking us to slow down. Try again in a minute.');
  if (!res.ok) throw new Error(`chess.com replied with an error (${res.status}).`);
  return res.json();
}

/** Ratings per time control from /stats. */
export async function fetchStats(username) {
  const s = await getJson(`${API}/${encodeURIComponent(username.toLowerCase())}/stats`);
  const out = {};
  for (const tc of ['rapid', 'blitz', 'bullet', 'daily']) {
    const d = s[`chess_${tc}`];
    if (!d) continue;
    out[tc] = { rating: d.last?.rating ?? null, best: d.best?.rating ?? null, record: d.record ?? null };
  }
  return out;
}

/** Month archive URLs within the last `months` months (including this one). */
async function archiveUrls(username, months) {
  const { archives = [] } = await getJson(`${API}/${encodeURIComponent(username.toLowerCase())}/games/archives`);
  const now = new Date();
  const cutoff = new Date(now.getFullYear(), now.getMonth() - (months - 1), 1);
  return archives.filter((url) => {
    const m = url.match(/(\d{4})\/(\d{2})$/);
    return m && new Date(+m[1], +m[2] - 1, 1) >= cutoff;
  });
}

/** One chess.com API game -> app game record (or null for variants). */
export function gameFromApi(g, me) {
  if (g.rules !== 'chess' || !g.pgn) return null;
  const game = gameFromPgn(g.pgn, {
    me,
    source: 'chess.com',
    extra: {
      timeClass: g.time_class,
      timeControl: g.time_control,
      rated: !!g.rated,
      date: (g.end_time ?? 0) * 1000 || undefined,
      url: g.url,
    },
  });
  if (!game) return null;
  game.id = `cc:${g.url.split('/').pop()}`;
  game.whiteElo = g.white?.rating ?? game.whiteElo;
  game.blackElo = g.black?.rating ?? game.blackElo;
  game.termination = terminationFromCodes(g.white?.result, g.black?.result) ?? game.termination;
  if (!game.date) game.date = Date.now();
  return game;
}

/** Fetches games for a player (used for opponent scouting too). */
export async function fetchGames(username, months, { onProgress } = {}) {
  const urls = await archiveUrls(username, months);
  const games = [];
  for (let i = 0; i < urls.length; i++) {
    const { games: list = [] } = await getJson(urls[i]);
    for (const g of list) {
      const game = gameFromApi(g, username);
      if (game) games.push(game);
    }
    onProgress?.((i + 1) / urls.length);
  }
  return games;
}

let syncing = null;

/**
 * Downloads new games for the saved username. Past months already fetched are skipped,
 * the current month is always refreshed. Returns { added, total }.
 */
export function syncGames({ force = false, onProgress } = {}) {
  syncing ??= (async () => {
    try {
      const { username, monthsBack } = await getSettings();
      if (!username) return { added: 0, total: 0, skipped: 'no-username' };
      const last = await getKv('lastSync', 0);
      if (!force && Date.now() - last < SYNC_EVERY_MS) return { added: 0, total: 0, skipped: 'recent' };
      emit('sync', { state: 'running' });

      const fetched = new Set(await getKv('fetchedMonths', []));
      const urls = await archiveUrls(username, monthsBack);
      const thisMonth = urls[urls.length - 1];
      const todo = urls.filter((u) => u === thisMonth || !fetched.has(u) || force);
      const known = new Set(await db.keys('games'));
      const fresh = [];
      for (let i = 0; i < todo.length; i++) {
        const { games: list = [] } = await getJson(todo[i]);
        for (const g of list) {
          const game = gameFromApi(g, username);
          if (game && !known.has(game.id)) {
            known.add(game.id);
            fresh.push(game);
          }
        }
        fetched.add(todo[i]);
        onProgress?.((i + 1) / todo.length);
      }
      if (fresh.length) await db.putMany('games', fresh);
      await setKv('fetchedMonths', [...fetched]);
      await setKv('lastSync', Date.now());
      try {
        await setKv('stats', { at: Date.now(), ratings: await fetchStats(username) });
      } catch (e) {
        console.warn('Could not load ratings', e);
      }
      const result = { added: fresh.length, total: known.size, games: fresh };
      emit('sync', { state: 'done', ...result });
      if (fresh.length) emit('games', { added: fresh.length });
      return result;
    } catch (e) {
      emit('sync', { state: 'error', message: e.message });
      throw e;
    } finally {
      syncing = null;
    }
  })();
  return syncing;
}

/** Saves imported games, skipping any already stored. Returns the number added. */
export async function saveImported(games) {
  const known = new Set(await db.keys('games'));
  const fresh = games.filter((g) => !known.has(g.id) && known.add(g.id));
  if (fresh.length) {
    await db.putMany('games', fresh);
    emit('games', { added: fresh.length });
  }
  return fresh;
}
