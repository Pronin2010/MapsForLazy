const CACHE_NAME = 'orienteering-v4';
const PRECACHE_URLS = [
  '/',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
];

// Transparent 1x1 PNG for offline tile fallback
const TRANSPARENT_PNG = new Response(
  Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQI12NgAAIABQABNjN9GQAAAABJRUEFTkSuQmCC'), c => c.charCodeAt(0)),
  { headers: { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' } }
);

const TILE_HOSTS = [
  'tile.openstreetmap',
  'opentopomap',
  'arcgisonline',
];

function isTileRequest(url) {
  return TILE_HOSTS.some(h => url.hostname.includes(h));
}

function isUnpkgRequest(url) {
  return url.hostname.includes('unpkg.com');
}

// Install event - precache essential resources
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(PRECACHE_URLS);
    })
  );
  self.skipWaiting();
});

// Activate event - clean up old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames
          .filter((name) => name !== CACHE_NAME)
          .map((name) => caches.delete(name))
      );
    })
  );
  self.clients.claim();
});

// Fetch event
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Map tiles - cache first, then network with short timeout, then transparent
  if (isTileRequest(url)) {
    event.respondWith(
      caches.open(CACHE_NAME).then((cache) => {
        return cache.match(event.request).then((cached) => {
          if (cached) return cached;

          // Try network with 3s timeout
          const timeoutPromise = new Promise((resolve) => {
            setTimeout(() => resolve(TRANSPARENT_PNG), 3000);
          });

          const fetchPromise = fetch(event.request, { signal: AbortSignal.timeout(3000) })
            .then((response) => {
              if (response.ok) {
                cache.put(event.request, response.clone());
              }
              return response;
            })
            .catch(() => TRANSPARENT_PNG);

          return Promise.race([fetchPromise, timeoutPromise]);
        });
      })
    );
    return;
  }

  // External unpkg.com resources (marker icons etc) - fail fast offline
  if (isUnpkgRequest(url)) {
    event.respondWith(
      caches.open(CACHE_NAME).then((cache) => {
        return cache.match(event.request).then((cached) => {
          if (cached) return cached;
          return fetch(event.request, { signal: AbortSignal.timeout(2000) })
            .then((response) => {
              if (response.ok) {
                cache.put(event.request, response.clone());
              }
              return response;
            })
            .catch(() => new Response('', { status: 404 }));
        });
      })
    );
    return;
  }

  // App resources - network first, cache fallback
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.ok) {
          const responseClone = response.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseClone);
          });
        }
        return response;
      })
      .catch(() => {
        return caches.match(event.request).then((cached) => {
          return cached || new Response('Offline', { status: 503 });
        });
      })
  );
});
