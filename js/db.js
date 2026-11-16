// Everything is stored in this browser with IndexedDB: games, reviews, puzzles and settings.
const DB_NAME = 'post-mortem';
const VERSION = 1;
const STORES = {
  games: { keyPath: 'id', indexes: ['date'] },
  reviews: { keyPath: 'gameId' },
  puzzles: { keyPath: 'id', indexes: ['due', 'gameId'] },
  kv: { keyPath: 'key' },
};

let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const [name, cfg] of Object.entries(STORES)) {
        if (db.objectStoreNames.contains(name)) continue;
        const store = db.createObjectStore(name, { keyPath: cfg.keyPath });
        for (const idx of cfg.indexes ?? []) store.createIndex(idx, idx);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('Close other Post-Mortem tabs and try again.'));
  });
  return dbPromise;
}

const done = (req) =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

async function tx(store, mode, fn) {
  const db = await open();
  const t = db.transaction(store, mode);
  const result = fn(t.objectStore(store));
  await new Promise((resolve, reject) => {
    t.oncomplete = resolve;
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error ?? new Error('Storage transaction aborted'));
  });
  return result instanceof IDBRequest ? result.result : result;
}

export const db = {
  get: (store, key) => tx(store, 'readonly', (s) => s.get(key)),
  all: (store) => tx(store, 'readonly', (s) => s.getAll()),
  keys: (store) => tx(store, 'readonly', (s) => s.getAllKeys()),
  put: (store, value) => tx(store, 'readwrite', (s) => s.put(value)),
  putMany: (store, values) =>
    tx(store, 'readwrite', (s) => {
      for (const v of values) s.put(v);
    }),
  del: (store, key) => tx(store, 'readwrite', (s) => s.delete(key)),
  clear: (store) => tx(store, 'readwrite', (s) => s.clear()),
  count: (store) => tx(store, 'readonly', (s) => s.count()),
  /** Removes every store's contents. */
  async clearAll() {
    for (const name of Object.keys(STORES)) await this.clear(name);
  },
};

// ---------- Settings (kept in the kv store) ----------

const DEFAULT_SETTINGS = {
  username: '',
  monthsBack: 3,
  apiKey: '',
  showEngineArrow: true,
  autoReview: true,
  boardFlipped: false,
};

let settingsCache = null;
const listeners = new Set();

export async function getSettings() {
  if (settingsCache) return settingsCache;
  const row = await db.get('kv', 'settings');
  settingsCache = { ...DEFAULT_SETTINGS, ...(row?.value ?? {}) };
  return settingsCache;
}

export async function saveSettings(patch) {
  const next = { ...(await getSettings()), ...patch };
  settingsCache = next;
  await db.put('kv', { key: 'settings', value: next });
  listeners.forEach((l) => l(next));
  return next;
}

export const onSettings = (fn) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

export async function getKv(key, fallback = null) {
  return (await db.get('kv', key))?.value ?? fallback;
}

export const setKv = (key, value) => db.put('kv', { key, value });

/** Forget cached settings (after clearing all data). */
export const resetSettingsCache = () => {
  settingsCache = null;
};

// ---------- Change notifications so open screens can refresh ----------

const bus = new EventTarget();
/** Kinds: 'games', 'reviews', 'puzzles', 'sync', 'review-queue'. */
export const emit = (kind, detail) => bus.dispatchEvent(new CustomEvent(kind, { detail }));
export const on = (kind, fn) => {
  const handler = (e) => fn(e.detail);
  bus.addEventListener(kind, handler);
  return () => bus.removeEventListener(kind, handler);
};
