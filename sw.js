const CACHE_NAME = "commonplace-v2";

const PRECACHE_URLS = [
  "./index.html",
  "./css/styles.css",
  "./css/context-menu.css",
  "./css/tts-player.css",
  "./css/mobile-responsive.css",
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
  "./js/experimental/readerToolAutomation.js",
  "./manifest.json",
];

// Install — precache app shell
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting()),
  );
});

// Activate — purge old caches
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== CACHE_NAME)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

// Fetch — network-first for navigations and API calls, cache-first for assets
self.addEventListener("fetch", (event) => {
  const { request } = event;

  // Let share-target navigations pass through to the page so query params are visible
  if (request.mode === "navigate") {
    event.respondWith(fetch(request).catch(() => caches.match("./index.html")));
    return;
  }

  // Network-first for external/API requests
  if (!request.url.startsWith(self.location.origin)) {
    return;
  }

  // Cache-first for local assets
  event.respondWith(
    caches.match(request).then((cached) => cached || fetch(request)),
  );
});
