/* KAI Remote's service worker. It exists for one reason: an installed app opened on the sofa should show
   the last thing it knew rather than a browser error, and a rebuild should not need a hard refresh. */

const SHELL = 'kai-remote-shell-v1';
const SHELL_FILES = ['/mobile/', '/mobile/manifest.webmanifest'];

/** The page and its shell files, stored without the query so a pairing token never lands in the cache. */
function cacheKeyFor(url) {
  return new URL(url.pathname, url.origin).toString();
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL)
      .then((cache) => cache.addAll(SHELL_FILES))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== SHELL).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  // Another origin, or the gateway's API: never cached. The API is live data behind a token, and a cached
  // answer there would be a stale approval or a stale run list, which is worse than no answer.
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;

  const put = (key, response) => {
    const copy = response.clone();
    void caches.open(SHELL).then((cache) => cache.put(key, copy)).catch(() => undefined);
  };

  // Fingerprinted by the build, so a hit is always the right bytes for that URL.
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(
      caches.match(request).then((hit) => hit ?? fetch(request).then((response) => {
        if (response.ok) put(request, response);
        return response;
      })),
    );
    return;
  }

  // The page itself: read the network first so a rebuilt console is picked up, and fall back to the last
  // copy when the desktop is asleep or off the network entirely.
  const key = cacheKeyFor(url);
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok) put(key, response);
        return response;
      })
      .catch(() => caches.match(key).then((hit) => hit ?? caches.match('/mobile/'))),
  );
});
