const CACHE_PREFIX = "commonplace-v";
const DEFAULT_VERSION = "2.0.0";

// Fetch app version from settings (once, at SW load time)
const cacheNamePromise = fetch("./app-settings.json", { cache: "no-store" })
  .then((r) => (r.ok ? r.json() : {}))
  .then(
    (settings) => `${CACHE_PREFIX}${settings.appVersion || DEFAULT_VERSION}`,
  )
  .catch(() => `${CACHE_PREFIX}${DEFAULT_VERSION}`);

const PRECACHE_URLS = [
  "./index.html",
  "./css/styles.css",
  "./css/context-menu.css",
  "./css/tts-player.css",
  "./css/mobile-responsive.css",
  "./css/splash.css",
  "./js/main.js",
  "./js/config.js",
  "./js/contextMenu.js",
  "./js/derivedIndexes.js",
  "./js/dom.js",
  "./js/highlighter.js",
  "./js/state.js",
  "./js/storage.js",
  "./js/taxonomy.js",
  "./js/ttsPlayer.js",
  "./js/utils.js",
  "./js/pages/editor.js",
  "./js/pages/libraryPage.js",
  "./js/pages/pagination.js",
  "./js/pages/projectsPage.js",
  "./js/pages/readerPage.js",
  "./js/pages/settingsPage.js",
  "./js/services/articleFetch.js",
  "./js/services/articleParser.js",
  "./js/services/autoTagging.js",
  "./js/services/imageCache.js",
  "./js/services/markdownExport.js",
  "./js/services/rssAutoRefresh.js",
  "./js/services/rssFetch.js",
  "./js/services/tweetFetch.js",
  "./js/experimental/readerToolAutomation.js",
  "./manifest.json",
];

// Install — precache app shell
self.addEventListener("install", (event) => {
  event.waitUntil(
    cacheNamePromise.then((cacheName) =>
      caches
        .open(cacheName)
        .then((cache) => cache.addAll(PRECACHE_URLS))
        .then(() => self.skipWaiting()),
    ),
  );
});

// Activate — purge old caches
self.addEventListener("activate", (event) => {
  event.waitUntil(
    cacheNamePromise.then((cacheName) =>
      caches
        .keys()
        .then((keys) =>
          Promise.all(
            keys
              .filter((key) => key !== cacheName)
              .map((key) => caches.delete(key)),
          ),
        )
        .then(() => self.clients.claim()),
    ),
  );
});

// Fetch — stale-while-revalidate for local assets
self.addEventListener("fetch", (event) => {
  const { request } = event;

  // Let share-target navigations pass through to the page so query params are visible
  if (request.mode === "navigate") {
    event.respondWith(fetch(request).catch(() => caches.match("./index.html")));
    return;
  }

  // Skip external/API requests (let browser handle normally)
  if (!request.url.startsWith(self.location.origin)) {
    return;
  }

  // Always fetch app-settings.json fresh (user config, never cached)
  if (request.url.endsWith("app-settings.json")) {
    return;
  }

  // Stale-while-revalidate for local assets:
  // 1. Return cached version immediately (fast!)
  // 2. Fetch fresh version in background
  // 3. Update cache for next load
  event.respondWith(
    cacheNamePromise.then((cacheName) =>
      caches.open(cacheName).then((cache) =>
        cache.match(request).then((cachedResponse) => {
          const fetchPromise = fetch(request)
            .then((networkResponse) => {
              // Only cache successful responses
              if (networkResponse.ok) {
                cache.put(request, networkResponse.clone());
              }
              return networkResponse;
            })
            .catch(() => cachedResponse); // Offline fallback

          // Return cached immediately, or wait for network if not cached
          return cachedResponse || fetchPromise;
        }),
      ),
    ),
  );
});
