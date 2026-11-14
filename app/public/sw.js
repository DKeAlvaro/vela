// Service worker: caches the app shell so Vela opens without a network (and is installable).
// API calls always go to the network; nothing personal is cached here.
const V = 'vela-shell-v3-noaudio';
const SHELL = ['/', '/index.html', '/css/app.css', '/js/app.js', '/js/api.js', '/js/store.js', '/js/pipeline.js', '/js/watches.js',
  '/js/frames.js', '/js/voice.js', '/js/listen.js', '/js/faces.js', '/js/devices/VelaDevice.js', '/js/devices/PhoneDevice.js',
  '/fonts/fraunces-normal.woff2', '/fonts/atkinson-hyperlegible-next-normal.woff2', '/manifest.webmanifest', '/icons/icon-192.png'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(V).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== V).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  // Never touch audio or partial requests: caching a 206 range response threw and killed playback.
  if (e.request.method !== 'GET' || u.origin !== location.origin || e.request.headers.has('range')
    || u.pathname.startsWith('/api/') || u.pathname === '/log' || u.pathname.startsWith('/files/')
    || u.pathname.startsWith('/voice/') || /\.(mp3|wav)$/.test(u.pathname)) return;
  // Network first (so updates land at once), cache as the offline fallback.
  e.respondWith(fetch(e.request).then((r) => {
    if (r.status === 200 && !u.pathname.startsWith('/vendor/')) { const copy = r.clone(); caches.open(V).then((c) => c.put(e.request, copy)).catch(() => {}); }
    return r;
  }).catch(() => caches.match(e.request, { ignoreSearch: true }).then((m) => m || caches.match('/index.html'))));
});
