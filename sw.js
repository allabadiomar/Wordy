// Offline support. Network-first: online you always get the newest files; offline you get the saved copy.
const CACHE = 'wordy-v14';
const SHELL = ['./', 'index.html', 'style.css', 'app.js', 'logic.js', 'vocab.js', 'analysis.js', 'parts.js', 'partsmode.js', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png'];
const fresh = u => fetch(new Request(u, { cache: 'reload' }));   // bypass the browser's own HTTP cache (GitHub Pages sets 10 min)
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => Promise.all(SHELL.map(u => fresh(u).then(r => { if (!r.ok) throw new Error(u); return c.put(u, r); })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return; // never touch the Gemini API calls
  e.respondWith(
    fetch(new Request(e.request, { cache: 'no-cache' }))
      .then(r => { if (r.ok) { const cp = r.clone(); caches.open(CACHE).then(c => c.put(e.request, cp)); } return r; })
      .catch(() => caches.match(e.request, { ignoreSearch: true }).then(hit => hit || caches.match('index.html')))
  );
});
