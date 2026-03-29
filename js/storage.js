import { STORAGE_KEY, initializeRuntimeState, touchMeta } from "./state.js";
import {
  collectTagsFromBookmarks,
  dedupeTags,
  normalizeTag,
} from "./taxonomy.js";
import { flattenBlocks, previewText, normalizeUrl } from "./utils.js";

const IDB_DB_NAME = "bookmark-manager-db";
const IDB_DB_VERSION = 5;
const IDB_STORE_NAME = "kv";
const IDB_STATE_KEY = "appState";
const IDB_BOOKMARKS_STORE = "bookmarks";
const IDB_PROJECTS_STORE = "projects";
const IDB_META_STORE = "meta";
const IDB_META_KEY = "appMeta";
const IDB_IMAGE_CACHE_STORE = "imageCache";
const IDB_RSS_FEEDS_STORE = "rssFeeds";
const IDB_RSS_ITEMS_STORE = "rssItems";
const IDB_RSS_READER_CACHE_STORE = "rssReaderCache";
const PERSIST_DEBOUNCE_MS = 120;
const RSS_AUTO_REFRESH_ALLOWED_MINUTES = new Set([1, 5, 10, 15, 30]);

let dbPromise = null;
let persistTimerId = null;
let pendingStateRef = null;
let hasPendingChanges = false;
let isPersistFlushQueued = false;
let lastPersistedSnapshot = null;

export async function hydrateState(state) {
  const parsedState = await readPersistedState();

  initializeRuntimeState(state);

  if (!parsedState) {
    return;
  }

  applyParsedState(state, parsedState);
  lastPersistedSnapshot = cloneStateSnapshot(serializeState(state));
}

export async function clearAllPersistedData() {
  if (persistTimerId !== null) {
    window.clearTimeout(persistTimerId);
    persistTimerId = null;
  }

  hasPendingChanges = false;
  pendingStateRef = null;
  lastPersistedSnapshot = null;

  const existingDb = await dbPromise?.catch(() => null);

  if (existingDb) {
    existingDb.close();
  }

  dbPromise = null;
  window.localStorage.removeItem(STORAGE_KEY);

  if (!("indexedDB" in window)) {
    return;
  }

  // Delete database with timeout protection
  await Promise.race([
    new Promise((resolve) => {
      const request = window.indexedDB.deleteDatabase(IDB_DB_NAME);
      request.onsuccess = () => resolve();
      request.onerror = () => resolve();
      request.onblocked = () => {
        // Database is blocked by another connection
        // This shouldn't happen if called before any connections are opened
        console.warn("Database delete blocked - forcing resolve");
        resolve();
      };
    }),
    // Timeout after 3 seconds to prevent hanging
    new Promise((resolve) => setTimeout(resolve, 3000)),
  ]);
}

export async function estimatePersistedStorageUsage() {
  const result = {
    dbName: IDB_DB_NAME,
    estimatedDbBytes: 0,
    storeBreakdown: [],
    browserUsageBytes: null,
    browserQuotaBytes: null,
    isIndexedDbAvailable: "indexedDB" in window,
  };

  if (navigator.storage?.estimate) {
    try {
      const estimate = await navigator.storage.estimate();
      result.browserUsageBytes = Number.isFinite(estimate?.usage)
        ? Number(estimate.usage)
        : null;
      result.browserQuotaBytes = Number.isFinite(estimate?.quota)
        ? Number(estimate.quota)
        : null;
    } catch {
      // Browser may block or not support detailed estimates.
    }
  }

  if (!("indexedDB" in window)) {
    return result;
  }

  const db = await openDatabase();

  if (!db) {
    return result;
  }

  const storesToMeasure = [
    IDB_BOOKMARKS_STORE,
    IDB_PROJECTS_STORE,
    IDB_META_STORE,
    IDB_RSS_FEEDS_STORE,
    IDB_RSS_ITEMS_STORE,
    IDB_IMAGE_CACHE_STORE,
    IDB_RSS_READER_CACHE_STORE,
    IDB_STORE_NAME,
  ].filter((storeName) => db.objectStoreNames.contains(storeName));

  for (const storeName of storesToMeasure) {
    try {
      const breakdown = await estimateObjectStoreUsage(db, storeName);
      result.storeBreakdown.push(breakdown);
      result.estimatedDbBytes += breakdown.approxBytes;
    } catch {
      result.storeBreakdown.push({
        storeName,
        recordCount: null,
        approxBytes: null,
        error: true,
      });
    }
  }

  return result;
}

function estimateObjectStoreUsage(db, storeName) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction([storeName], "readonly");
    const store = tx.objectStore(storeName);
    const request = store.openCursor();
    let recordCount = 0;
    let approxBytes = 0;

    request.onsuccess = () => {
      const cursor = request.result;

      if (!cursor) {
        return;
      }

      recordCount += 1;
      approxBytes += getApproxValueSizeBytes(cursor.value);
      cursor.continue();
    };

    request.onerror = () => {
      reject(request.error || new Error(`Failed reading store: ${storeName}`));
    };

    tx.oncomplete = () => {
      resolve({
        storeName,
        recordCount,
        approxBytes,
      });
    };

    tx.onerror = () => {
      reject(tx.error || new Error(`Failed transaction for: ${storeName}`));
    };
  });
}

function getApproxValueSizeBytes(value) {
  if (value === null || value === undefined) {
    return 0;
  }

  if (value instanceof Blob) {
    return Number(value.size) || 0;
  }

  try {
    return new TextEncoder().encode(JSON.stringify(value)).length;
  } catch {
    return 0;
  }
}

export function persistState(state) {
  initializeRuntimeState(state);
  state.__persistEpoch = Number(state.__persistEpoch || 0) + 1;
  touchMeta(state);
  pendingStateRef = state;
  hasPendingChanges = true;

  if (persistTimerId !== null) {
    return;
  }

  persistTimerId = window.setTimeout(() => {
    persistTimerId = null;
    queuePersistFlush();
  }, PERSIST_DEBOUNCE_MS);
}

function queuePersistFlush() {
  if (isPersistFlushQueued || !hasPendingChanges || !pendingStateRef) {
    return;
  }

  isPersistFlushQueued = true;
  hasPendingChanges = false;
  const stateRef = pendingStateRef;
  const dirtyScopes = consumeDirtyScopes(stateRef);
  const stateSnapshot = buildPersistSnapshot(
    stateRef,
    dirtyScopes,
    lastPersistedSnapshot,
  );

  Promise.resolve()
    .then(() => writePersistedState(stateSnapshot, dirtyScopes))
    .catch(() => {
      // Keep runtime resilient if storage is unavailable.
    })
    .finally(() => {
      isPersistFlushQueued = false;

      if (hasPendingChanges) {
        // Ensure latest pending state is eventually flushed.
        queuePersistFlush();
      }
    });
}

function consumeDirtyScopes(state) {
  initializeRuntimeState(state);

  const dirtyScopes = {
    bookmarks: Boolean(state.__dirtyBookmarks),
    projects: Boolean(state.__dirtyProjects),
    rss: Boolean(state.__dirtyRss),
    meta: Boolean(state.__dirtyMeta),
  };

  state.__dirtyBookmarks = false;
  state.__dirtyProjects = false;
  state.__dirtyRss = false;
  state.__dirtyMeta = false;

  return dirtyScopes;
}

function buildPersistSnapshot(state, dirtyScopes, previousSnapshot) {
  const metaSnapshot = serializeMetaState(state);

  return {
    ...metaSnapshot,
    bookmarks: dirtyScopes.bookmarks
      ? cloneStateSnapshot(state.bookmarks)
      : previousSnapshot?.bookmarks || [],
    projects: dirtyScopes.projects
      ? cloneStateSnapshot(state.projects)
      : previousSnapshot?.projects || [],
    rssFeeds: dirtyScopes.rss
      ? cloneStateSnapshot(state.rssFeeds)
      : previousSnapshot?.rssFeeds || [],
  };
}

function serializeState(state) {
  return {
    ...serializeMetaState(state),
    bookmarks: state.bookmarks,
    projects: state.projects,
    rssFeeds: state.rssFeeds,
  };
}

function serializeMetaState(state) {
  return {
    savedTags: state.savedTags,
    selectedArticleId: state.selectedArticleId,
    selectedProjectId: state.selectedProjectId,
    selectedProjectSidebarArticleId: state.selectedProjectSidebarArticleId,
    projectShowMarkdown: state.projectShowMarkdown,
    activeTab: state.activeTab,
    libraryTagFilters: state.libraryTagFilters,
    libraryProjectFilters: state.libraryProjectFilters,
    libraryView: state.libraryView,
    librarySort: state.librarySort,
    libraryShowImages: state.libraryShowImages,
    libraryShowTags: state.libraryShowTags,
    projectsStageFilter: state.projectsStageFilter,
    projectsView: state.projectsView,
    projectsSort: state.projectsSort,
    settingsSection: state.settingsSection,
    autoTagEnabled: state.autoTagEnabled,
    autoTagUseDefaultCountries: state.autoTagUseDefaultCountries,
    autoTagCustomRules: state.autoTagCustomRules,
    displayFont: state.displayFont,
    theme: state.theme,
    displayHighlightColor: state.displayHighlightColor,
    splashEnabled: state.splashEnabled,
    ttsVoiceId: state.ttsVoiceId,
    ttsRate: state.ttsRate,
    rssActiveFeedId: state.rssActiveFeedId,
    rssSelectedFeedIds: Array.isArray(state.rssSelectedFeedIds)
      ? state.rssSelectedFeedIds
      : [],
    rssFolderFilter: state.rssFolderFilter,
    rssView: state.rssView,
    rssSort: state.rssSort,
    rssReadFilter: state.rssReadFilter,
    rssRetentionDays: state.rssRetentionDays,
    rssAutoRefreshMinutes: state.rssAutoRefreshMinutes,
  };
}

function buildMetaSnapshot(snapshot) {
  return {
    key: IDB_META_KEY,
    savedTags: snapshot.savedTags || [],
    selectedArticleId: snapshot.selectedArticleId || null,
    selectedProjectId: snapshot.selectedProjectId || null,
    selectedProjectSidebarArticleId:
      snapshot.selectedProjectSidebarArticleId || null,
    projectShowMarkdown: Boolean(snapshot.projectShowMarkdown),
    activeTab:
      snapshot.activeTab === "add"
        ? "library"
        : snapshot.activeTab || "library",
    libraryTagFilters: snapshot.libraryTagFilters || [],
    libraryProjectFilters: snapshot.libraryProjectFilters || [],
    libraryView: snapshot.libraryView || "2",
    librarySort: snapshot.librarySort || "newest",
    libraryShowImages: snapshot.libraryShowImages !== false,
    libraryShowTags: snapshot.libraryShowTags !== false,
    projectsStageFilter: snapshot.projectsStageFilter || null,
    projectsView: snapshot.projectsView || "2",
    projectsSort: snapshot.projectsSort || "newest",
    settingsSection: snapshot.settingsSection || "export",
    autoTagEnabled: snapshot.autoTagEnabled !== false,
    autoTagUseDefaultCountries: snapshot.autoTagUseDefaultCountries !== false,
    autoTagCustomRules: Array.isArray(snapshot.autoTagCustomRules)
      ? snapshot.autoTagCustomRules
      : [],
    displayFont: snapshot.displayFont || "mono",
    theme: snapshot.theme || "light",
    displayHighlightColor: snapshot.displayHighlightColor || "green",
    splashEnabled: snapshot.splashEnabled !== false,
    ttsVoiceId: snapshot.ttsVoiceId || "",
    ttsRate:
      Number.isFinite(Number(snapshot.ttsRate)) && Number(snapshot.ttsRate) > 0
        ? Number(snapshot.ttsRate)
        : 1,
    rssActiveFeedId: snapshot.rssActiveFeedId || null,
    rssSelectedFeedIds: Array.isArray(snapshot.rssSelectedFeedIds)
      ? snapshot.rssSelectedFeedIds.filter((value) => typeof value === "string")
      : [],
    rssFolderFilter: snapshot.rssFolderFilter || "",
    rssView: snapshot.rssView || "2",
    rssSort: snapshot.rssSort || "newest",
    rssReadFilter: normalizeRssReadFilter(snapshot.rssReadFilter),
    rssRetentionDays:
      snapshot.rssRetentionDays === "never"
        ? "never"
        : Number(snapshot.rssRetentionDays) || 7,
    rssAutoRefreshMinutes: normalizeRssAutoRefreshMinutes(
      snapshot.rssAutoRefreshMinutes,
    ),
  };
}

function applyParsedState(state, parsedState) {
  state.bookmarks = Array.isArray(parsedState.bookmarks)
    ? parsedState.bookmarks.map((bookmark) => withCachedPreviewText(bookmark))
    : [];
  state.projects = Array.isArray(parsedState.projects)
    ? parsedState.projects.map((project) => withNormalizedProjectStage(project))
    : [];
  state.savedTags = Array.isArray(parsedState.savedTags)
    ? dedupeTags(parsedState.savedTags.map(normalizeTag))
    : collectTagsFromBookmarks(state.bookmarks);
  state.selectedArticleId =
    parsedState.selectedArticleId || state.bookmarks[0]?.id || null;
  state.selectedProjectId = parsedState.selectedProjectId || null;
  state.selectedProjectSidebarArticleId =
    parsedState.selectedProjectSidebarArticleId || null;
  state.projectShowMarkdown = Boolean(parsedState.projectShowMarkdown);
  state.activeTab =
    parsedState.activeTab === "add"
      ? "library"
      : parsedState.activeTab || "library";
  state.libraryTagFilters = Array.isArray(parsedState.libraryTagFilters)
    ? dedupeTags(parsedState.libraryTagFilters.map(normalizeTag))
    : [];
  state.libraryProjectFilters = Array.isArray(parsedState.libraryProjectFilters)
    ? parsedState.libraryProjectFilters.filter(Boolean)
    : [];
  state.libraryView = ["1", "2", "3"].includes(parsedState.libraryView)
    ? parsedState.libraryView
    : "2";
  state.librarySort = ["newest", "oldest", "latest-opened"].includes(
    parsedState.librarySort,
  )
    ? parsedState.librarySort
    : "newest";
  state.libraryShowImages = parsedState.libraryShowImages !== false;
  state.libraryShowTags = parsedState.libraryShowTags !== false;
  state.projectsStageFilter = ["idea", "research", "done"].includes(
    parsedState.projectsStageFilter,
  )
    ? parsedState.projectsStageFilter
    : null;
  state.projectsView = ["1", "2", "3"].includes(parsedState.projectsView)
    ? parsedState.projectsView
    : "2";
  state.projectsSort = ["newest", "oldest", "latest-opened"].includes(
    parsedState.projectsSort,
  )
    ? parsedState.projectsSort
    : "newest";
  state.settingsSection = [
    "export",
    "projects",
    "tags",
    "display",
    "rss",
  ].includes(
    parsedState.settingsSection === "autotag"
      ? "tags"
      : parsedState.settingsSection,
  )
    ? parsedState.settingsSection === "autotag"
      ? "tags"
      : parsedState.settingsSection
    : "export";
  state.autoTagEnabled = parsedState.autoTagEnabled !== false;
  state.autoTagUseDefaultCountries =
    parsedState.autoTagUseDefaultCountries !== false;
  state.autoTagCustomRules = Array.isArray(parsedState.autoTagCustomRules)
    ? parsedState.autoTagCustomRules
    : [];
  state.displayFont = ["mono", "sans", "serif", "slab"].includes(
    parsedState.displayFont,
  )
    ? parsedState.displayFont
    : "mono";
  state.theme = ["light", "dark"].includes(parsedState.theme)
    ? parsedState.theme
    : "light";
  state.displayHighlightColor = ["green", "red", "orange", "yellow"].includes(
    parsedState.displayHighlightColor,
  )
    ? parsedState.displayHighlightColor
    : "green";
  state.splashEnabled = parsedState.splashEnabled !== false;
  state.ttsVoiceId =
    typeof parsedState.ttsVoiceId === "string" ? parsedState.ttsVoiceId : "";
  state.ttsRate =
    Number.isFinite(Number(parsedState.ttsRate)) &&
    Number(parsedState.ttsRate) >= 0.7 &&
    Number(parsedState.ttsRate) <= 1.3
      ? Number(parsedState.ttsRate)
      : 1;
  state.rssFeeds = Array.isArray(parsedState.rssFeeds)
    ? parsedState.rssFeeds
        .filter((feed) => feed && typeof feed === "object")
        .map((feed) => normalizeRssFeedRecord(feed))
        .filter((feed) => feed.id && feed.url)
    : [];
  reassignDuplicateRssFeedIds(state.rssFeeds);
  state.rssActiveFeedId =
    typeof parsedState.rssActiveFeedId === "string"
      ? parsedState.rssActiveFeedId
      : null;
  state.rssSelectedFeedIds = Array.isArray(parsedState.rssSelectedFeedIds)
    ? [
        ...new Set(
          parsedState.rssSelectedFeedIds.filter(
            (value) => typeof value === "string" && value.trim(),
          ),
        ),
      ]
    : [];
  state.rssFolderFilter =
    typeof parsedState.rssFolderFilter === "string"
      ? parsedState.rssFolderFilter.trim().toLowerCase() === "unfiled"
        ? ""
        : parsedState.rssFolderFilter
      : "";
  state.rssView = ["1", "2", "3"].includes(parsedState.rssView)
    ? parsedState.rssView
    : "2";
  state.rssSort = ["newest", "oldest", "latest-opened"].includes(
    parsedState.rssSort,
  )
    ? parsedState.rssSort
    : "newest";
  state.rssReadFilter = normalizeRssReadFilter(parsedState.rssReadFilter);
  state.rssRetentionDays =
    parsedState.rssRetentionDays === "never"
      ? "never"
      : [7, 14, 30].includes(Number(parsedState.rssRetentionDays))
        ? Number(parsedState.rssRetentionDays)
        : 7;
  state.rssAutoRefreshMinutes = normalizeRssAutoRefreshMinutes(
    parsedState.rssAutoRefreshMinutes,
  );
  state.rssReaderArticle = null;

  pruneRssItemsByRetention(state);

  const availableTagSet = new Set(collectTagsFromBookmarks(state.bookmarks));
  const availableProjectIds = new Set(
    state.projects.map((project) => project.id),
  );

  state.libraryTagFilters = state.libraryTagFilters.filter((tag) =>
    availableTagSet.has(tag),
  );
  state.libraryProjectFilters = state.libraryProjectFilters.filter(
    (projectId) => availableProjectIds.has(projectId),
  );
  if (
    state.projectsStageFilter &&
    !["idea", "research", "done"].includes(state.projectsStageFilter)
  ) {
    state.projectsStageFilter = null;
  }

  if (
    state.selectedProjectId &&
    !availableProjectIds.has(state.selectedProjectId)
  ) {
    state.selectedProjectId = null;
  }

  if (
    state.rssActiveFeedId &&
    !state.rssFeeds.some((feed) => feed.id === state.rssActiveFeedId)
  ) {
    state.rssActiveFeedId = state.rssFeeds[0]?.id || null;
  }

  const availableFeedIds = new Set(state.rssFeeds.map((feed) => feed.id));
  state.rssSelectedFeedIds = state.rssSelectedFeedIds.filter((feedId) =>
    availableFeedIds.has(feedId),
  );

  const folderSet = new Set(
    state.rssFeeds
      .map((feed) => String(feed.folder || "").trim())
      .filter(Boolean),
  );

  if (
    state.rssFolderFilter &&
    state.rssFolderFilter !== "__today__" &&
    !folderSet.has(state.rssFolderFilter)
  ) {
    state.rssFolderFilter = "";
  }
}

function pruneRssItemsByRetention(state) {
  if (state.rssRetentionDays === "never") {
    return;
  }

  const retentionDays = Number(state.rssRetentionDays);

  if (!Number.isFinite(retentionDays) || retentionDays <= 0) {
    return;
  }

  const cutoffMs = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const bookmarkedUrls = new Set(
    (state.bookmarks || [])
      .map((bookmark) => canonicalizeUrlForCompare(bookmark.url))
      .filter(Boolean),
  );

  state.rssFeeds = (state.rssFeeds || []).map((feed) => ({
    ...feed,
    items: (feed.items || []).filter((item) => {
      const canonicalUrl = canonicalizeUrlForCompare(item.url);

      if (canonicalUrl && bookmarkedUrls.has(canonicalUrl)) {
        return true;
      }

      const pubMs = Date.parse(item.pubDate || "");

      if (!Number.isFinite(pubMs)) {
        return true;
      }

      return pubMs >= cutoffMs;
    }),
  }));
}

function canonicalizeUrlForCompare(url) {
  if (!url) {
    return "";
  }

  try {
    const parsed = new URL(normalizeUrl(url));
    const hostname = parsed.hostname.replace(/^www\./i, "").toLowerCase();
    const pathname = parsed.pathname.replace(/\/+$/, "") || "/";
    return `${parsed.protocol}//${hostname}${pathname}`;
  } catch {
    return normalizeUrl(url).toLowerCase();
  }
}

function withCachedPreviewText(bookmark) {
  if (!bookmark || typeof bookmark !== "object") {
    return bookmark;
  }

  const source = typeof bookmark.source === "string" ? bookmark.source : "";
  const publishedAt =
    typeof bookmark.publishedAt === "string" ? bookmark.publishedAt : "";

  const description =
    typeof bookmark.description === "string" ? bookmark.description.trim() : "";

  if (description.length > 0) {
    return { ...bookmark, source, publishedAt, previewText: "" };
  }

  if (
    typeof bookmark.previewText === "string" &&
    bookmark.previewText.trim().length > 0
  ) {
    return { ...bookmark, source, publishedAt };
  }

  return {
    ...bookmark,
    source,
    publishedAt,
    previewText: previewText(flattenBlocks(bookmark.blocks || []), 180),
  };
}

function withNormalizedProjectStage(project) {
  if (!project || typeof project !== "object") {
    return project;
  }

  return {
    ...project,
    stage: ["idea", "research", "done"].includes(project.stage)
      ? project.stage
      : "idea",
  };
}

async function readPersistedState() {
  const db = await openDatabase();

  if (db) {
    try {
      const normalizedState = await readNormalizedState(db);

      if (normalizedState) {
        return normalizedState;
      }

      const legacyKvState = await readLegacyKvState(db);

      if (legacyKvState) {
        await writeNormalizedState(db, legacyKvState);
        return legacyKvState;
      }

      const migrated = tryReadLocalStorageState();

      if (migrated) {
        await writeNormalizedState(db, migrated);
        window.localStorage.removeItem(STORAGE_KEY);
        return migrated;
      }

      return null;
    } catch {
      return tryReadLocalStorageState();
    }
  }

  return tryReadLocalStorageState();
}

async function writePersistedState(stateSnapshot, dirtyScopes) {
  const db = await openDatabase();

  if (db) {
    try {
      await writeNormalizedState(db, stateSnapshot, dirtyScopes);
      return;
    } catch {
      // Fall through to localStorage fallback.
    }
  }

  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(stateSnapshot));
}

function cloneStateSnapshot(snapshot) {
  if (typeof window.structuredClone === "function") {
    return window.structuredClone(snapshot);
  }

  return JSON.parse(JSON.stringify(snapshot));
}

function tryReadLocalStorageState() {
  const storedState = window.localStorage.getItem(STORAGE_KEY);

  if (!storedState) {
    return null;
  }

  try {
    return JSON.parse(storedState);
  } catch {
    window.localStorage.removeItem(STORAGE_KEY);
    return null;
  }
}

function openDatabase() {
  if (dbPromise) {
    return dbPromise;
  }

  if (!("indexedDB" in window)) {
    return Promise.resolve(null);
  }

  dbPromise = new Promise((resolve) => {
    const request = window.indexedDB.open(IDB_DB_NAME, IDB_DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = request.result;
      const tx = request.transaction;

      if (!db.objectStoreNames.contains(IDB_STORE_NAME)) {
        db.createObjectStore(IDB_STORE_NAME);
      }

      if (!db.objectStoreNames.contains(IDB_BOOKMARKS_STORE)) {
        db.createObjectStore(IDB_BOOKMARKS_STORE, { keyPath: "id" });
      }

      if (!db.objectStoreNames.contains(IDB_PROJECTS_STORE)) {
        db.createObjectStore(IDB_PROJECTS_STORE, { keyPath: "id" });
      }

      if (!db.objectStoreNames.contains(IDB_META_STORE)) {
        db.createObjectStore(IDB_META_STORE, { keyPath: "key" });
      }

      if (!db.objectStoreNames.contains(IDB_IMAGE_CACHE_STORE)) {
        db.createObjectStore(IDB_IMAGE_CACHE_STORE, { keyPath: "id" });
      }

      if (!db.objectStoreNames.contains(IDB_RSS_FEEDS_STORE)) {
        db.createObjectStore(IDB_RSS_FEEDS_STORE, { keyPath: "id" });
      }

      if (!db.objectStoreNames.contains(IDB_RSS_ITEMS_STORE)) {
        db.createObjectStore(IDB_RSS_ITEMS_STORE, { keyPath: "key" });
      }

      if (!db.objectStoreNames.contains(IDB_RSS_READER_CACHE_STORE)) {
        db.createObjectStore(IDB_RSS_READER_CACHE_STORE, { keyPath: "slug" });
      }

      if (
        event.oldVersion < 2 &&
        tx &&
        db.objectStoreNames.contains(IDB_STORE_NAME)
      ) {
        migrateLegacyKvStore(tx);
      }

      if (event.oldVersion < 4 && tx) {
        migrateLegacyMetaRssStore(tx);
      }
    };

    request.onsuccess = () => {
      resolve(request.result);
    };

    request.onerror = () => {
      resolve(null);
    };

    request.onblocked = () => {
      resolve(null);
    };
  });

  return dbPromise;
}

function idbGet(db, key) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE_NAME, "readonly");
    const store = tx.objectStore(IDB_STORE_NAME);
    const request = store.get(key);

    request.onsuccess = () => resolve(request.result ?? null);
    request.onerror = () => reject(request.error);
  });
}

function idbSet(db, key, value) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE_NAME, "readwrite");
    const store = tx.objectStore(IDB_STORE_NAME);
    const request = store.put(value, key);

    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

function readNormalizedState(db) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(
      [
        IDB_BOOKMARKS_STORE,
        IDB_PROJECTS_STORE,
        IDB_META_STORE,
        IDB_RSS_FEEDS_STORE,
        IDB_RSS_ITEMS_STORE,
      ],
      "readonly",
    );
    const bookmarksRequest = tx.objectStore(IDB_BOOKMARKS_STORE).getAll();
    const projectsRequest = tx.objectStore(IDB_PROJECTS_STORE).getAll();
    const metaRequest = tx.objectStore(IDB_META_STORE).get(IDB_META_KEY);
    const rssFeedsRequest = tx.objectStore(IDB_RSS_FEEDS_STORE).getAll();
    const rssItemsRequest = tx.objectStore(IDB_RSS_ITEMS_STORE).getAll();

    tx.oncomplete = () => {
      const bookmarks = Array.isArray(bookmarksRequest.result)
        ? bookmarksRequest.result
        : [];
      const projects = Array.isArray(projectsRequest.result)
        ? projectsRequest.result
        : [];
      const meta = metaRequest.result;
      const rssFeedRecords = Array.isArray(rssFeedsRequest.result)
        ? rssFeedsRequest.result
        : [];
      const rssItemRecords = Array.isArray(rssItemsRequest.result)
        ? rssItemsRequest.result
        : [];

      const rssFeeds =
        rssFeedRecords.length > 0 || rssItemRecords.length > 0
          ? buildRssFeedsFromStoreRecords(rssFeedRecords, rssItemRecords)
          : Array.isArray(meta?.rssFeeds)
            ? meta.rssFeeds.map((feed) => normalizeRssFeedRecord(feed))
            : [];

      if (
        !meta &&
        bookmarks.length === 0 &&
        projects.length === 0 &&
        rssFeeds.length === 0
      ) {
        resolve(null);
        return;
      }

      resolve({
        bookmarks,
        projects: projects.map((project) =>
          withNormalizedProjectStage(project),
        ),
        savedTags: Array.isArray(meta?.savedTags) ? meta.savedTags : [],
        selectedArticleId: meta?.selectedArticleId || null,
        selectedProjectId: meta?.selectedProjectId || null,
        selectedProjectSidebarArticleId:
          meta?.selectedProjectSidebarArticleId || null,
        projectShowMarkdown: Boolean(meta?.projectShowMarkdown),
        activeTab:
          meta?.activeTab === "add" ? "library" : meta?.activeTab || "library",
        libraryTagFilters: Array.isArray(meta?.libraryTagFilters)
          ? meta.libraryTagFilters
          : [],
        libraryProjectFilters: Array.isArray(meta?.libraryProjectFilters)
          ? meta.libraryProjectFilters
          : [],
        libraryView: meta?.libraryView || "2",
        librarySort: meta?.librarySort || "newest",
        libraryShowImages: meta?.libraryShowImages !== false,
        libraryShowTags: meta?.libraryShowTags !== false,
        projectsStageFilter: ["idea", "research", "done"].includes(
          meta?.projectsStageFilter,
        )
          ? meta.projectsStageFilter
          : null,
        projectsView: meta?.projectsView || "2",
        projectsSort: meta?.projectsSort || "newest",
        settingsSection: meta?.settingsSection || "export",
        autoTagEnabled: meta?.autoTagEnabled !== false,
        autoTagUseDefaultCountries: meta?.autoTagUseDefaultCountries !== false,
        autoTagCustomRules: Array.isArray(meta?.autoTagCustomRules)
          ? meta.autoTagCustomRules
          : [],
        displayFont: meta?.displayFont || "mono",
        theme: meta?.theme || "light",
        displayHighlightColor: meta?.displayHighlightColor || "green",
        splashEnabled: meta?.splashEnabled !== false,
        ttsVoiceId: meta?.ttsVoiceId || "",
        ttsRate:
          Number.isFinite(Number(meta?.ttsRate)) && Number(meta?.ttsRate) > 0
            ? Number(meta.ttsRate)
            : 1,
        rssFeeds,
        rssActiveFeedId: meta?.rssActiveFeedId || null,
        rssFolderFilter: meta?.rssFolderFilter || "",
        rssView: meta?.rssView || "2",
        rssSort: meta?.rssSort || "newest",
        rssReadFilter: normalizeRssReadFilter(meta?.rssReadFilter),
        rssRetentionDays:
          meta?.rssRetentionDays === "never"
            ? "never"
            : Number(meta?.rssRetentionDays) || 7,
        rssAutoRefreshMinutes: normalizeRssAutoRefreshMinutes(
          meta?.rssAutoRefreshMinutes,
        ),
      });
    };

    tx.onerror = () =>
      reject(tx.error || new Error("IndexedDB read transaction failed"));
  });
}

function writeNormalizedState(
  db,
  snapshot,
  dirtyScopes = { bookmarks: true, projects: true, rss: true, meta: true },
) {
  return new Promise((resolve, reject) => {
    const previous = lastPersistedSnapshot;
    const tx = db.transaction(
      [
        IDB_BOOKMARKS_STORE,
        IDB_PROJECTS_STORE,
        IDB_META_STORE,
        IDB_RSS_FEEDS_STORE,
        IDB_RSS_ITEMS_STORE,
      ],
      "readwrite",
    );
    const bookmarksStore = tx.objectStore(IDB_BOOKMARKS_STORE);
    const projectsStore = tx.objectStore(IDB_PROJECTS_STORE);
    const metaStore = tx.objectStore(IDB_META_STORE);
    const rssFeedsStore = tx.objectStore(IDB_RSS_FEEDS_STORE);
    const rssItemsStore = tx.objectStore(IDB_RSS_ITEMS_STORE);

    if (!previous) {
      (snapshot.bookmarks || []).forEach((bookmark) => {
        bookmarksStore.put(bookmark);
      });

      (snapshot.projects || []).forEach((project) => {
        projectsStore.put(project);
      });

      metaStore.put(buildMetaSnapshot(snapshot));
      const initialRssFeeds = (snapshot.rssFeeds || []).map((feed) =>
        normalizeRssFeedRecord(feed),
      );

      initialRssFeeds.forEach((feed) => {
        rssFeedsStore.put(buildRssFeedStoreRecord(feed));
      });

      flattenRssItemRecords(initialRssFeeds).forEach((itemRecord) => {
        rssItemsStore.put(itemRecord);
      });
    } else {
      if (dirtyScopes.bookmarks) {
        const currentBookmarksById = new Map(
          (snapshot.bookmarks || []).map((bookmark) => [bookmark.id, bookmark]),
        );
        const previousBookmarksById = new Map(
          (previous.bookmarks || []).map((bookmark) => [bookmark.id, bookmark]),
        );

        currentBookmarksById.forEach((bookmark, id) => {
          const previousBookmark = previousBookmarksById.get(id);

          if (!previousBookmark || !isSameRecord(previousBookmark, bookmark)) {
            bookmarksStore.put(bookmark);
          }
        });

        previousBookmarksById.forEach((_, id) => {
          if (!currentBookmarksById.has(id)) {
            bookmarksStore.delete(id);
          }
        });
      }

      if (dirtyScopes.projects) {
        const currentProjectsById = new Map(
          (snapshot.projects || []).map((project) => [project.id, project]),
        );
        const previousProjectsById = new Map(
          (previous.projects || []).map((project) => [project.id, project]),
        );

        currentProjectsById.forEach((project, id) => {
          const previousProject = previousProjectsById.get(id);

          if (!previousProject || !isSameRecord(previousProject, project)) {
            projectsStore.put(project);
          }
        });

        previousProjectsById.forEach((_, id) => {
          if (!currentProjectsById.has(id)) {
            projectsStore.delete(id);
          }
        });
      }

      const currentMeta = buildMetaSnapshot(snapshot);
      const previousMeta = buildMetaSnapshot(previous);

      if (dirtyScopes.meta && !isSameRecord(previousMeta, currentMeta)) {
        metaStore.put(currentMeta);
      }

      if (dirtyScopes.rss) {
        const currentRssFeeds = (snapshot.rssFeeds || []).map((feed) =>
          normalizeRssFeedRecord(feed),
        );
        const previousRssFeeds = (previous.rssFeeds || []).map((feed) =>
          normalizeRssFeedRecord(feed),
        );
        const currentRssById = new Map(
          currentRssFeeds.map((feed) => [feed.id, feed]),
        );
        const previousRssById = new Map(
          previousRssFeeds.map((feed) => [feed.id, feed]),
        );

        currentRssById.forEach((feed, id) => {
          const previousFeed = previousRssById.get(id);
          const nextRecord = buildRssFeedStoreRecord(feed);
          const prevRecord = previousFeed
            ? buildRssFeedStoreRecord(previousFeed)
            : null;

          if (!prevRecord || !isSameRecord(prevRecord, nextRecord)) {
            rssFeedsStore.put(nextRecord);
          }
        });

        previousRssById.forEach((_, id) => {
          if (!currentRssById.has(id)) {
            rssFeedsStore.delete(id);
          }
        });

        const currentItemRecords = flattenRssItemRecords(currentRssFeeds);
        const previousItemRecords = flattenRssItemRecords(previousRssFeeds);
        const currentItemByKey = new Map(
          currentItemRecords.map((item) => [item.key, item]),
        );
        const previousItemByKey = new Map(
          previousItemRecords.map((item) => [item.key, item]),
        );

        currentItemByKey.forEach((item, key) => {
          const previousItem = previousItemByKey.get(key);

          if (!previousItem || !isSameRecord(previousItem, item)) {
            rssItemsStore.put(item);
          }
        });

        previousItemByKey.forEach((_, key) => {
          if (!currentItemByKey.has(key)) {
            rssItemsStore.delete(key);
          }
        });
      }
    }

    tx.oncomplete = () => {
      lastPersistedSnapshot = cloneStateSnapshot(snapshot);
      resolve();
    };
    tx.onerror = () =>
      reject(tx.error || new Error("IndexedDB write transaction failed"));
  });
}

function normalizeRssFeedRecord(feed) {
  const normalizedItems = Array.isArray(feed.items)
    ? feed.items
        .filter((item) => item && typeof item === "object")
        .map((item) => normalizeRssItemRecord(item))
        .filter((item) => item.url)
    : [];

  return {
    id: String(feed.id || ""),
    url: String(feed.url || ""),
    title: String(feed.title || ""),
    folder:
      String(feed.folder || "")
        .trim()
        .toLowerCase() === "unfiled"
        ? ""
        : String(feed.folder || "").trim(),
    lastFetchedAt: String(feed.lastFetchedAt || ""),
    lastFetchItemCount: Number.isFinite(Number(feed.lastFetchItemCount))
      ? Number(feed.lastFetchItemCount)
      : normalizedItems.length,
    lastFetchNewItemCount: Number.isFinite(Number(feed.lastFetchNewItemCount))
      ? Number(feed.lastFetchNewItemCount)
      : 0,
    itemsVersion: Number.isFinite(Number(feed.itemsVersion))
      ? Number(feed.itemsVersion)
      : 0,
    items: normalizedItems,
  };
}

function reassignDuplicateRssFeedIds(rssFeeds) {
  if (!Array.isArray(rssFeeds) || rssFeeds.length <= 1) {
    return;
  }

  const seen = new Set();

  for (const feed of rssFeeds) {
    if (!feed || typeof feed !== "object") {
      continue;
    }

    let candidateId = String(feed.id || "").trim();

    if (!candidateId || seen.has(candidateId)) {
      const base = candidateId || "feed";
      let suffix = 1;
      do {
        candidateId = `${base}-${suffix++}`;
      } while (seen.has(candidateId));
    }

    feed.id = candidateId;
    seen.add(candidateId);
  }
}

function normalizeRssItemRecord(item) {
  const url = String(item.url || "");

  return {
    id: String(item.id || ""),
    url,
    canonicalUrl:
      String(item.canonicalUrl || "") || canonicalizeUrlForCompare(url),
    title: String(item.title || "Untitled"),
    excerpt: String(item.excerpt || ""),
    pubDate: String(item.pubDate || ""),
    author: String(item.author || ""),
    thumbnail: String(item.thumbnail || ""),
    lastOpenedAt: String(item.lastOpenedAt || ""),
  };
}

function buildRssFeedStoreRecord(feed) {
  return {
    id: feed.id,
    url: feed.url,
    title: feed.title,
    folder: feed.folder,
    lastFetchedAt: feed.lastFetchedAt,
    lastFetchItemCount: Number.isFinite(Number(feed.lastFetchItemCount))
      ? Number(feed.lastFetchItemCount)
      : 0,
    lastFetchNewItemCount: Number.isFinite(Number(feed.lastFetchNewItemCount))
      ? Number(feed.lastFetchNewItemCount)
      : 0,
    itemsVersion: Number.isFinite(Number(feed.itemsVersion))
      ? Number(feed.itemsVersion)
      : 0,
  };
}

function buildRssItemStoreRecord(feedId, item, index = 0) {
  const normalized = normalizeRssItemRecord(item);
  const stableId = normalized.canonicalUrl || normalized.id || `${index}`;
  const key = `${feedId}::${stableId}`;

  return {
    key,
    feedId,
    id: normalized.id,
    url: normalized.url,
    canonicalUrl: normalized.canonicalUrl,
    title: normalized.title,
    excerpt: normalized.excerpt,
    pubDate: normalized.pubDate,
    author: normalized.author,
    thumbnail: normalized.thumbnail,
    lastOpenedAt: normalized.lastOpenedAt,
  };
}

function flattenRssItemRecords(feeds) {
  return feeds.flatMap((feed) =>
    (feed.items || []).map((item, index) =>
      buildRssItemStoreRecord(feed.id, item, index),
    ),
  );
}

function buildRssFeedsFromStoreRecords(feedRecords, itemRecords) {
  const itemsByFeedId = new Map();

  (itemRecords || []).forEach((item) => {
    const feedId = String(item.feedId || "");

    if (!feedId) {
      return;
    }

    if (!itemsByFeedId.has(feedId)) {
      itemsByFeedId.set(feedId, []);
    }

    itemsByFeedId.get(feedId).push(normalizeRssItemRecord(item));
  });

  return (feedRecords || [])
    .map((feed) =>
      normalizeRssFeedRecord({
        ...feed,
        items: itemsByFeedId.get(String(feed.id || "")) || [],
      }),
    )
    .filter((feed) => feed.id && feed.url);
}

function isSameRecord(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Returns the Set of article IDs that have a cached image in IDB.
 * Uses getAllKeys() — returns only string keys, no blob data. Fast even at 100k scale.
 */
export async function getCachedImageIds() {
  const db = await openDatabase();

  if (!db) {
    return new Set();
  }

  return new Promise((resolve) => {
    const tx = db.transaction(IDB_IMAGE_CACHE_STORE, "readonly");
    const req = tx.objectStore(IDB_IMAGE_CACHE_STORE).getAllKeys();

    req.onsuccess = () =>
      resolve(new Set(Array.isArray(req.result) ? req.result : []));
    req.onerror = () => resolve(new Set());
  });
}

/**
 * Reads cached image entries for a specific set of article IDs.
 * Opens a single transaction and issues individual gets — no full table scan.
 */
export async function getCachedImagesByIds(ids) {
  if (!ids || ids.length === 0) {
    return [];
  }

  const db = await openDatabase();

  if (!db) {
    return [];
  }

  return new Promise((resolve) => {
    const tx = db.transaction(IDB_IMAGE_CACHE_STORE, "readonly");
    const store = tx.objectStore(IDB_IMAGE_CACHE_STORE);
    const results = [];

    for (const id of ids) {
      const req = store.get(id);

      req.onsuccess = () => {
        if (req.result) {
          results.push(req.result);
        }
      };
    }

    tx.oncomplete = () => resolve(results);
    tx.onerror = () => resolve([]);
  });
}

export async function putImageInCache(articleId, blob) {
  const db = await openDatabase();

  if (!db) {
    return;
  }

  return new Promise((resolve) => {
    const tx = db.transaction(IDB_IMAGE_CACHE_STORE, "readwrite");

    tx.objectStore(IDB_IMAGE_CACHE_STORE).put({ id: articleId, blob });
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

export async function removeImageFromCache(articleId) {
  const db = await openDatabase();

  if (!db) {
    return;
  }

  return new Promise((resolve) => {
    const tx = db.transaction(IDB_IMAGE_CACHE_STORE, "readwrite");

    tx.objectStore(IDB_IMAGE_CACHE_STORE).delete(articleId);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

/**
 * Store an RSS reader article in the cache by its URL slug.
 * Used to restore transient RSS articles after page refresh.
 */
export async function putRssReaderCache(slug, article) {
  const db = await openDatabase();

  if (!db || !slug || !article) {
    return;
  }

  // Guard: ensure the store exists
  if (!db.objectStoreNames.contains(IDB_RSS_READER_CACHE_STORE)) {
    return;
  }

  return new Promise((resolve) => {
    let tx;
    try {
      tx = db.transaction(IDB_RSS_READER_CACHE_STORE, "readwrite");
    } catch {
      resolve();
      return;
    }

    tx.objectStore(IDB_RSS_READER_CACHE_STORE).put({ slug, article });
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

/**
 * Retrieve a cached RSS reader article by its URL slug.
 * Returns the article object or null if not found.
 */
export async function getRssReaderCache(slug) {
  const db = await openDatabase();

  if (!db || !slug) {
    return null;
  }

  // Guard: ensure the store exists
  if (!db.objectStoreNames.contains(IDB_RSS_READER_CACHE_STORE)) {
    return null;
  }

  return new Promise((resolve) => {
    let tx;
    try {
      tx = db.transaction(IDB_RSS_READER_CACHE_STORE, "readonly");
    } catch {
      resolve(null);
      return;
    }
    const request = tx.objectStore(IDB_RSS_READER_CACHE_STORE).get(slug);

    request.onsuccess = () => resolve(request.result?.article ?? null);
    request.onerror = () => resolve(null);
  });
}

/**
 * Delete a cached RSS reader article by its URL slug.
 * Called when an RSS article is saved to the library.
 */
export async function deleteRssReaderCache(slug) {
  const db = await openDatabase();

  if (!db || !slug) {
    return;
  }

  // Guard: ensure the store exists
  if (!db.objectStoreNames.contains(IDB_RSS_READER_CACHE_STORE)) {
    return;
  }

  return new Promise((resolve) => {
    let tx;
    try {
      tx = db.transaction(IDB_RSS_READER_CACHE_STORE, "readwrite");
    } catch {
      resolve();
      return;
    }

    tx.objectStore(IDB_RSS_READER_CACHE_STORE).delete(slug);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

/**
 * Prune RSS reader cache entries older than the retention period.
 * Preserves entries whose URLs match saved bookmarks.
 * Should be called during app initialization.
 */
export async function pruneRssReaderCacheByRetention(state) {
  if (state.rssRetentionDays === "never") {
    return 0;
  }

  const retentionDays = Number(state.rssRetentionDays);

  if (!Number.isFinite(retentionDays) || retentionDays <= 0) {
    return 0;
  }

  const db = await openDatabase();

  if (!db) {
    return 0;
  }

  // Guard: ensure the store exists before trying to access it
  if (!db.objectStoreNames.contains(IDB_RSS_READER_CACHE_STORE)) {
    return 0;
  }

  const cutoffMs = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const bookmarkedUrls = new Set(
    (state.bookmarks || [])
      .map((bookmark) => canonicalizeUrlForCompare(bookmark.url))
      .filter(Boolean),
  );

  return new Promise((resolve) => {
    let tx;
    try {
      tx = db.transaction(IDB_RSS_READER_CACHE_STORE, "readwrite");
    } catch {
      resolve(0);
      return;
    }
    const store = tx.objectStore(IDB_RSS_READER_CACHE_STORE);
    const request = store.openCursor();
    let removedCount = 0;

    request.onsuccess = (event) => {
      const cursor = event.target.result;

      if (!cursor) {
        return;
      }

      const entry = cursor.value;
      const article = entry?.article;

      if (article) {
        const canonicalUrl = canonicalizeUrlForCompare(article.url);

        // Keep if URL matches a saved bookmark
        if (canonicalUrl && bookmarkedUrls.has(canonicalUrl)) {
          cursor.continue();
          return;
        }

        // Check fetchedAt or createdAt timestamp
        const fetchedMs = Date.parse(
          article.fetchedAt || article.createdAt || "",
        );

        if (Number.isFinite(fetchedMs) && fetchedMs < cutoffMs) {
          cursor.delete();
          removedCount++;
        }
      }

      cursor.continue();
    };

    tx.oncomplete = () => resolve(removedCount);
    tx.onerror = () => resolve(0);
  });
}

async function readLegacyKvState(db) {
  if (!db.objectStoreNames.contains(IDB_STORE_NAME)) {
    return null;
  }

  const legacy = await idbGet(db, IDB_STATE_KEY);
  return legacy && typeof legacy === "object" ? legacy : null;
}

function migrateLegacyMetaRssStore(tx) {
  if (
    !tx.objectStoreNames.contains(IDB_META_STORE) ||
    !tx.objectStoreNames.contains(IDB_RSS_FEEDS_STORE) ||
    !tx.objectStoreNames.contains(IDB_RSS_ITEMS_STORE)
  ) {
    return;
  }

  const metaStore = tx.objectStore(IDB_META_STORE);
  const rssFeedsStore = tx.objectStore(IDB_RSS_FEEDS_STORE);
  const rssItemsStore = tx.objectStore(IDB_RSS_ITEMS_STORE);
  const request = metaStore.get(IDB_META_KEY);

  request.onsuccess = () => {
    const meta = request.result;

    if (!meta || !Array.isArray(meta.rssFeeds) || meta.rssFeeds.length === 0) {
      return;
    }

    const normalizedFeeds = meta.rssFeeds
      .map((feed) => normalizeRssFeedRecord(feed))
      .filter((feed) => feed.id && feed.url);

    normalizedFeeds.forEach((feed) => {
      rssFeedsStore.put(buildRssFeedStoreRecord(feed));
    });

    flattenRssItemRecords(normalizedFeeds).forEach((itemRecord) => {
      rssItemsStore.put(itemRecord);
    });

    const { rssFeeds, ...nextMeta } = meta;
    metaStore.put(nextMeta);
  };
}

function migrateLegacyKvStore(tx) {
  const legacyStore = tx.objectStore(IDB_STORE_NAME);
  const bookmarksStore = tx.objectStore(IDB_BOOKMARKS_STORE);
  const projectsStore = tx.objectStore(IDB_PROJECTS_STORE);
  const metaStore = tx.objectStore(IDB_META_STORE);
  const request = legacyStore.get(IDB_STATE_KEY);

  request.onsuccess = () => {
    const legacyState = request.result;

    if (!legacyState || typeof legacyState !== "object") {
      return;
    }

    bookmarksStore.clear();
    projectsStore.clear();

    (legacyState.bookmarks || []).forEach((bookmark) => {
      bookmarksStore.put(bookmark);
    });

    (legacyState.projects || []).forEach((project) => {
      projectsStore.put(project);
    });

    metaStore.put({
      key: IDB_META_KEY,
      savedTags: legacyState.savedTags || [],
      selectedArticleId: legacyState.selectedArticleId || null,
      selectedProjectId: legacyState.selectedProjectId || null,
      selectedProjectSidebarArticleId:
        legacyState.selectedProjectSidebarArticleId || null,
      projectShowMarkdown: Boolean(legacyState.projectShowMarkdown),
      activeTab:
        legacyState.activeTab === "add"
          ? "library"
          : legacyState.activeTab || "library",
      libraryTagFilters: legacyState.libraryTagFilters || [],
      libraryProjectFilters: legacyState.libraryProjectFilters || [],
      libraryView: legacyState.libraryView || "2",
      librarySort: legacyState.librarySort || "newest",
      libraryShowImages: legacyState.libraryShowImages !== false,
      libraryShowTags: legacyState.libraryShowTags !== false,
      projectsStageFilter: null,
      projectsView: legacyState.projectsView || "2",
      projectsSort: legacyState.projectsSort || "newest",
      settingsSection: legacyState.settingsSection || "export",
      autoTagEnabled: legacyState.autoTagEnabled !== false,
      autoTagUseDefaultCountries:
        legacyState.autoTagUseDefaultCountries !== false,
      autoTagCustomRules: Array.isArray(legacyState.autoTagCustomRules)
        ? legacyState.autoTagCustomRules
        : [],
      displayFont: legacyState.displayFont || "mono",
      theme: legacyState.theme || "light",
      displayHighlightColor: legacyState.displayHighlightColor || "green",
      ttsVoiceId: legacyState.ttsVoiceId || "",
      ttsRate:
        Number.isFinite(Number(legacyState.ttsRate)) &&
        Number(legacyState.ttsRate) > 0
          ? Number(legacyState.ttsRate)
          : 1,
      rssActiveFeedId: legacyState.rssActiveFeedId || null,
      rssFolderFilter: legacyState.rssFolderFilter || "",
      rssView: legacyState.rssView || "2",
      rssSort: legacyState.rssSort || "newest",
      rssReadFilter: normalizeRssReadFilter(legacyState.rssReadFilter),
      rssRetentionDays:
        legacyState.rssRetentionDays === "never"
          ? "never"
          : Number(legacyState.rssRetentionDays) || 7,
      rssAutoRefreshMinutes: normalizeRssAutoRefreshMinutes(
        legacyState.rssAutoRefreshMinutes,
      ),
      rssFeeds: Array.isArray(legacyState.rssFeeds) ? legacyState.rssFeeds : [],
    });

    legacyStore.delete(IDB_STATE_KEY);
  };
}

function normalizeRssAutoRefreshMinutes(value) {
  if (value === "off") {
    return "off";
  }

  const minutes = Number(value);

  if (RSS_AUTO_REFRESH_ALLOWED_MINUTES.has(minutes)) {
    return minutes;
  }

  return "off";
}

function normalizeRssReadFilter(value) {
  return ["all", "unread", "read"].includes(value) ? value : "all";
}
