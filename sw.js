// Offline support: try the network first and fall back to the cached copy.
// The chess engine, board and app files are cached as they are used.
// Keep in step with js/version.js.
const CACHE = 'post-mortem-1.3.0';
const SHELL = [
  './',
  './index.html',
  './css/app.css',
  './manifest.webmanifest',
  './icons/icon.svg',
  './vendor/chessground/chessground.base.css',
  './vendor/chessground/chessground.brown.css',
  './vendor/chessground/chessground.cburnett.css',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  // Only this site's own files; chess.com and Anthropic requests always go to the network.
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  e.respondWith(
    // "no-cache" asks the server whether the file changed every time, so updates arrive straight away.
    fetch(req, { cache: 'no-cache' })
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(async () => (await caches.match(req)) ?? (req.mode === 'navigate' ? caches.match('./index.html') : Response.error())),
  );
});
