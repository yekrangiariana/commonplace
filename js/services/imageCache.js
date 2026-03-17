import {
  getCachedImageIds,
  getCachedImagesByIds,
  putImageInCache,
  removeImageFromCache,
} from "../storage.js";

// In-memory map: articleId -> blob URL (session lifetime, LRU-evicted)
const blobUrlCache = new Map();
const inFlightFetches = new Map();

// Max blob URLs kept in memory. Each entry is a cheap handle, but the
// underlying Blob object is what holds RAM. Cap prevents unbounded growth.
const BLOB_URL_CACHE_MAX = 500;
const BLOB_URL_EVICT_COUNT = 100;

// Only background-fetch images for the N most recent uncached articles so
// we don’t spin forever on a library with 100k entries.
const MAX_BACKGROUND_FETCH = 500;

const FETCH_BATCH_SIZE = 3;
const TARGET_WIDTH = 400;
const TARGET_HEIGHT = 300;
const COMPRESS_QUALITY = 0.82;

export function getCachedBlobUrl(articleId) {
  return blobUrlCache.get(articleId) ?? null;
}

/**
 * Lightweight startup: reads only IDB *keys* (no blob data) to discover what
 * is already cached, then queues background network-fetch for uncached articles.
 * Never loads blobs into RAM upfront — that happens lazily per visible page.
 */
export async function initImageCache(bookmarks) {
  let cachedIds;

  try {
    cachedIds = await getCachedImageIds();
  } catch {
    cachedIds = new Set();
  }

  // Only queue recent articles (first MAX_BACKGROUND_FETCH that need fetching)
  const toFetch = bookmarks
    .filter((b) => b.imageUrl && !cachedIds.has(b.id))
    .slice(0, MAX_BACKGROUND_FETCH);

  if (toFetch.length > 0) {
    scheduleBatchFetch(toFetch);
  }
}

/**
 * Loads blob URLs from IDB for the given articles that aren’t already in the
 * in-memory cache. Call after rendering a page and use the returned Map to
 * patch img.src attributes in the DOM without a full re-render.
 *
 * Returns a Map<articleId, blobUrl> of entries that were newly loaded.
 */
export async function ensurePageImagesLoaded(articles) {
  const missing = articles.filter((a) => a.imageUrl && !blobUrlCache.has(a.id));

  if (missing.length === 0) {
    return new Map();
  }

  let entries;

  try {
    entries = await getCachedImagesByIds(missing.map((a) => a.id));
  } catch {
    return new Map();
  }

  const newlyLoaded = new Map();

  for (const entry of entries) {
    if (entry.blob instanceof Blob && !blobUrlCache.has(entry.id)) {
      const url = URL.createObjectURL(entry.blob);
      setBlobUrl(entry.id, url);
      newlyLoaded.set(entry.id, url);
    }
  }

  return newlyLoaded;
}

/**
 * Fetches, compresses, and caches a single article image.
 * Safe to call fire-and-forget.
 */
export async function fetchAndCacheImage(articleId, imageUrl) {
  if (!imageUrl || blobUrlCache.has(articleId)) {
    return;
  }

  if (inFlightFetches.has(articleId)) {
    return inFlightFetches.get(articleId);
  }

  const work = (async () => {
    try {
      const response = await fetch(imageUrl, { mode: "cors" });

      if (!response.ok) {
        return;
      }

      const originalBlob = await response.blob();

      if (!originalBlob.type.startsWith("image/")) {
        return;
      }

      const compressed = await compressImageBlob(
        originalBlob,
        TARGET_WIDTH,
        TARGET_HEIGHT,
        COMPRESS_QUALITY,
      );
      const blobToStore = compressed ?? originalBlob;

      await putImageInCache(articleId, blobToStore);

      if (!blobUrlCache.has(articleId)) {
        setBlobUrl(articleId, URL.createObjectURL(blobToStore));
      }
    } catch {
      // CORS blocked, network error, canvas unavailable — silently skip
    } finally {
      inFlightFetches.delete(articleId);
    }
  })();

  inFlightFetches.set(articleId, work);
  return work;
}

/**
 * Removes an image from both the in-memory cache and IDB.
 * Call when an article is deleted.
 */
export async function evictCachedImage(articleId) {
  const existing = blobUrlCache.get(articleId);

  if (existing) {
    URL.revokeObjectURL(existing);
    blobUrlCache.delete(articleId);
  }

  try {
    await removeImageFromCache(articleId);
  } catch {
    // Storage already unavailable
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function setBlobUrl(articleId, url) {
  // Refresh position in Map for LRU: delete first if present, then re-insert
  if (blobUrlCache.has(articleId)) {
    blobUrlCache.delete(articleId);
  }

  blobUrlCache.set(articleId, url);
  maybeEvictOldBlobUrls();
}

function maybeEvictOldBlobUrls() {
  if (blobUrlCache.size <= BLOB_URL_CACHE_MAX) {
    return;
  }

  // Map preserves insertion order; oldest entries are first
  let evicted = 0;

  for (const [id, url] of blobUrlCache) {
    URL.revokeObjectURL(url);
    blobUrlCache.delete(id);
    evicted++;

    if (evicted >= BLOB_URL_EVICT_COUNT) {
      break;
    }
  }
}

function scheduleBatchFetch(bookmarks) {
  let index = 0;

  function processNextBatch() {
    const batch = bookmarks.slice(index, index + FETCH_BATCH_SIZE);

    if (batch.length === 0) {
      return;
    }

    index += FETCH_BATCH_SIZE;

    Promise.all(
      batch.map((b) => fetchAndCacheImage(b.id, b.imageUrl).catch(() => {})),
    ).then(() => {
      if (index < bookmarks.length) {
        scheduleIdle(processNextBatch);
      }
    });
  }

  scheduleIdle(processNextBatch);
}

function scheduleIdle(fn) {
  if (typeof window.requestIdleCallback === "function") {
    window.requestIdleCallback(fn, { timeout: 8000 });
  } else {
    window.setTimeout(fn, 300);
  }
}

async function compressImageBlob(blob, maxWidth, maxHeight, quality) {
  try {
    const bitmap = await createImageBitmap(blob);
    const { w, h } = scaleDimensions(
      bitmap.width,
      bitmap.height,
      maxWidth,
      maxHeight,
    );

    let canvas;
    let ctx;

    if (typeof OffscreenCanvas !== "undefined") {
      canvas = new OffscreenCanvas(w, h);
      ctx = canvas.getContext("2d");
    } else {
      canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      ctx = canvas.getContext("2d");
    }

    if (!ctx) {
      bitmap.close?.();
      return null;
    }

    ctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close?.();

    let compressed;

    if (typeof canvas.convertToBlob === "function") {
      compressed = await canvas.convertToBlob({
        type: "image/webp",
        quality,
      });
    } else {
      compressed = await new Promise((resolve) => {
        canvas.toBlob(resolve, "image/webp", quality);
      });
    }

    if (!compressed || compressed.size >= blob.size) {
      return null;
    }

    return compressed;
  } catch {
    return null;
  }
}

function scaleDimensions(srcW, srcH, maxW, maxH) {
  if (srcW <= maxW && srcH <= maxH) {
    return { w: srcW, h: srcH };
  }

  const scale = Math.min(maxW / srcW, maxH / srcH);

  return {
    w: Math.round(srcW * scale),
    h: Math.round(srcH * scale),
  };
}
