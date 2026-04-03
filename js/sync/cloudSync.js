/**
 * Cloud Sync Service
 * Per-row sync with Supabase. LWW conflict resolution (last write wins per row).
 * Each table (bookmarks, projects, rss_feeds, user_settings) is synced independently.
 */

import {
  isLoggedIn,
  fetchBookmarks,
  upsertBookmarks,
  fetchProjects,
  upsertProjects,
  fetchRssFeeds,
  upsertRssFeeds,
  fetchSettings,
  upsertSettings,
  fetchLegacySyncData,
  signIn,
  signUp,
  logout,
  getSessionEmail,
} from "./supabaseClient.js";
import {
  startRealtime,
  disconnect as disconnectRealtime,
} from "./realtimeSync.js";

const SYNC_DEBOUNCE_MS = 1000;
const SYNC_COOLDOWN_MS = 5000;
const AUTO_PULL_INTERVAL_MS = 30000;
const LAST_PULL_KEY = "commonplace-last-pull-ts";

let syncTimerId = null;
let lastSyncPushedAt = 0;
let syncInFlight = false;
let onSyncStatusChange = null;
let autoPullTimerId = null;
let autoPullHandler = null;

function setSyncStatusCallback(callback) {
  onSyncStatusChange = callback;
}

function notifyStatus(status, message) {
  onSyncStatusChange?.({ status, message });
}

function getLastPullTimestamp() {
  return localStorage.getItem(LAST_PULL_KEY) || null;
}

function setLastPullTimestamp(isoString) {
  localStorage.setItem(LAST_PULL_KEY, isoString);
}

// ── Row ↔ local object mappers ──

function bookmarkFromRow(row) {
  return {
    id: row.id,
    title: row.title || "",
    url: row.url || "",
    description: row.description || "",
    source: row.source || "",
    publishedAt: row.published_at || "",
    previewText: row.preview_text || "",
    imageUrl: row.image_url || "",
    fetchedAt: row.fetched_at || "",
    createdAt: row.created_at || "",
    tweetHtml: row.tweet_html || "",
    blocks: row.blocks || [],
    tags: row.tags || [],
    projectIds: row.project_ids || [],
    highlights: row.highlights || [],
    lastOpenedAt: row.last_opened_at || "",
    _deleted: row._deleted || false,
    _remoteUpdatedAt: row.updated_at,
  };
}

function projectFromRow(row) {
  return {
    id: row.id,
    name: row.name || "",
    description: row.description || "",
    content: row.content || "",
    stage: row.stage || "",
    createdAt: row.created_at || "",
    lastOpenedAt: row.last_opened_at || "",
    _deleted: row._deleted || false,
    _remoteUpdatedAt: row.updated_at,
  };
}

function rssFeedFromRow(row) {
  const feedUrl = row.feed_url || "";
  return {
    id: row.id,
    url: feedUrl,
    feedUrl,
    title: row.title || "",
    folder: row.folder || "",
    items: row.items || [],
    lastFetchedAt: row.last_fetched_at || "",
    _deleted: row._deleted || false,
    _remoteUpdatedAt: row.updated_at,
  };
}

// ── Pull (incremental per-table fetch) ──

export async function pullSync(localState) {
  if (!isLoggedIn()) return null;
  if (syncTimerId !== null) return null;

  notifyStatus("pulling", "Syncing from cloud…");

  try {
    const since = getLastPullTimestamp();

    const [remoteBookmarks, remoteProjects, remoteFeeds, remoteSettings] =
      await Promise.all([
        fetchBookmarks(since),
        fetchProjects(since),
        fetchRssFeeds(since),
        fetchSettings(),
      ]);

    let hasChanges = false;
    let latestTimestamp = since;

    function trackTimestamp(ts) {
      if (ts && (!latestTimestamp || ts > latestTimestamp)) {
        latestTimestamp = ts;
      }
    }

    // Apply remote bookmarks (LWW per row)
    let mergedBookmarks = null;
    if (remoteBookmarks.length > 0) {
      const localMap = new Map(
        (localState.bookmarks || []).map((b) => [b.id, b]),
      );
      for (const row of remoteBookmarks) {
        const mapped = bookmarkFromRow(row);
        trackTimestamp(row.updated_at);
        if (mapped._deleted) {
          if (localMap.has(row.id)) {
            localMap.delete(row.id);
            hasChanges = true;
          }
        } else {
          localMap.set(row.id, mapped);
          hasChanges = true;
        }
      }
      mergedBookmarks = Array.from(localMap.values());
    }

    // Apply remote projects (LWW per row)
    let mergedProjects = null;
    if (remoteProjects.length > 0) {
      const localMap = new Map(
        (localState.projects || []).map((p) => [p.id, p]),
      );
      for (const row of remoteProjects) {
        const mapped = projectFromRow(row);
        trackTimestamp(row.updated_at);
        if (mapped._deleted) {
          if (localMap.has(row.id)) {
            localMap.delete(row.id);
            hasChanges = true;
          }
        } else {
          localMap.set(row.id, mapped);
          hasChanges = true;
        }
      }
      mergedProjects = Array.from(localMap.values());
    }

    // Apply remote RSS feeds (LWW per row)
    let mergedFeeds = null;
    if (remoteFeeds.length > 0) {
      const localMap = new Map(
        (localState.rssFeeds || []).map((f) => [f.id, f]),
      );
      for (const row of remoteFeeds) {
        const mapped = rssFeedFromRow(row);
        trackTimestamp(row.updated_at);
        if (mapped._deleted) {
          if (localMap.has(row.id)) {
            localMap.delete(row.id);
            hasChanges = true;
          }
        } else {
          localMap.set(row.id, mapped);
          hasChanges = true;
        }
      }
      mergedFeeds = Array.from(localMap.values());
    }

    // Apply remote settings (LWW - entire settings object)
    let mergedSettings = null;
    if (
      remoteSettings?.settings &&
      typeof remoteSettings.settings === "object"
    ) {
      mergedSettings = remoteSettings.settings;
      trackTimestamp(remoteSettings.updated_at);
      hasChanges = true;
    }

    if (latestTimestamp) {
      setLastPullTimestamp(latestTimestamp);
    }
    setLocalSyncTimestamp(Date.now());

    if (hasChanges) {
      notifyStatus("done", "Synced from cloud");
      return {
        bookmarks: mergedBookmarks,
        projects: mergedProjects,
        rssFeeds: mergedFeeds,
        settings: mergedSettings,
      };
    }

    notifyStatus("done", "Already up to date");
    return null;
  } catch (err) {
    notifyStatus("error", `Sync pull failed: ${err.message}`);
    return null;
  }
}

// ── Push (per-table, only dirty items) ──

export function schedulePushSync(localState, serializeMetaFn) {
  if (!isLoggedIn()) return;

  if (syncTimerId !== null) {
    clearTimeout(syncTimerId);
  }

  syncTimerId = setTimeout(() => {
    syncTimerId = null;
    pushSyncNow(localState, serializeMetaFn).catch(() => {});
  }, SYNC_DEBOUNCE_MS);
}

export async function pushSyncNow(localState, serializeMetaFn) {
  if (!isLoggedIn() || syncInFlight) return;

  const elapsed = Date.now() - lastSyncPushedAt;
  if (elapsed < SYNC_COOLDOWN_MS && lastSyncPushedAt > 0) {
    schedulePushSync(localState, serializeMetaFn);
    return;
  }

  syncInFlight = true;
  notifyStatus("pushing", "Saving to cloud…");

  try {
    const promises = [];

    if (localState.__dirtyBookmarks) {
      const dirtyIds = localState.__dirtyBookmarkIds;
      if (dirtyIds?.size) {
        const localMap = new Map(
          (localState.bookmarks || []).map((b) => [b.id, b]),
        );
        const existing = [];
        const deleted = [];
        for (const id of dirtyIds) {
          const item = localMap.get(id);
          if (item) existing.push(item);
          else deleted.push({ id, _deleted: true });
        }
        if (existing.length) promises.push(upsertBookmarks(existing));
        if (deleted.length) promises.push(upsertBookmarks(deleted));
      } else {
        // No specific IDs — push all (e.g. initial sync)
        const items = localState.bookmarks || [];
        if (items.length) promises.push(upsertBookmarks(items));
      }
    }

    if (localState.__dirtyProjects) {
      const dirtyIds = localState.__dirtyProjectIds;
      if (dirtyIds?.size) {
        const localMap = new Map(
          (localState.projects || []).map((p) => [p.id, p]),
        );
        const existing = [];
        const deleted = [];
        for (const id of dirtyIds) {
          const item = localMap.get(id);
          if (item) existing.push(item);
          else deleted.push({ id, _deleted: true });
        }
        if (existing.length) promises.push(upsertProjects(existing));
        if (deleted.length) promises.push(upsertProjects(deleted));
      } else {
        const items = localState.projects || [];
        if (items.length) promises.push(upsertProjects(items));
      }
    }

    if (localState.__dirtyRss) {
      const dirtyIds = localState.__dirtyRssFeedIds;
      if (dirtyIds?.size) {
        const localMap = new Map(
          (localState.rssFeeds || []).map((f) => [f.id, f]),
        );
        const existing = [];
        const deleted = [];
        for (const id of dirtyIds) {
          const item = localMap.get(id);
          if (item) existing.push(item);
          else deleted.push({ id, _deleted: true });
        }
        if (existing.length) promises.push(upsertRssFeeds(existing));
        if (deleted.length) promises.push(upsertRssFeeds(deleted));
      } else {
        const items = localState.rssFeeds || [];
        if (items.length) promises.push(upsertRssFeeds(items));
      }
    }

    if (localState.__dirtyMeta) {
      const meta = serializeMetaFn(localState);
      // Strip ephemeral keys that shouldn't sync
      delete meta.selectedArticleId;
      delete meta.selectedProjectId;
      delete meta.selectedProjectSidebarArticleId;
      delete meta.activeTab;
      delete meta.settingsSection;
      promises.push(upsertSettings(meta));
    }

    if (promises.length) {
      await Promise.all(promises);
    }

    // Clear dirty flags after successful push
    localState.__dirtyBookmarks = false;
    localState.__dirtyProjects = false;
    localState.__dirtyRss = false;
    localState.__dirtyMeta = false;
    localState.__dirtyBookmarkIds = new Set();
    localState.__dirtyProjectIds = new Set();
    localState.__dirtyRssFeedIds = new Set();

    lastSyncPushedAt = Date.now();
    setLocalSyncTimestamp(Date.now());
    notifyStatus("done", "Saved to cloud");
  } catch (err) {
    notifyStatus("error", `Sync push failed: ${err.message}`);
  } finally {
    syncInFlight = false;
  }
}

// ── Force pull (fetch all rows, replace local) ──

export async function forcePull() {
  if (!isLoggedIn()) return null;

  notifyStatus("pulling", "Pulling from cloud…");

  try {
    const [remoteBookmarks, remoteProjects, remoteFeeds, remoteSettings] =
      await Promise.all([
        fetchBookmarks(null),
        fetchProjects(null),
        fetchRssFeeds(null),
        fetchSettings(),
      ]);

    let latestTimestamp = null;
    function trackTs(ts) {
      if (ts && (!latestTimestamp || ts > latestTimestamp))
        latestTimestamp = ts;
    }

    const bookmarks = remoteBookmarks
      .filter((r) => !r._deleted)
      .map((r) => {
        trackTs(r.updated_at);
        return bookmarkFromRow(r);
      });

    const projects = remoteProjects
      .filter((r) => !r._deleted)
      .map((r) => {
        trackTs(r.updated_at);
        return projectFromRow(r);
      });

    const rssFeeds = remoteFeeds
      .filter((r) => !r._deleted)
      .map((r) => {
        trackTs(r.updated_at);
        return rssFeedFromRow(r);
      });

    const settings =
      remoteSettings?.settings && typeof remoteSettings.settings === "object"
        ? remoteSettings.settings
        : null;
    if (remoteSettings?.updated_at) trackTs(remoteSettings.updated_at);

    if (latestTimestamp) setLastPullTimestamp(latestTimestamp);
    setLocalSyncTimestamp(Date.now());
    notifyStatus("done", "Replaced local data with cloud data");

    return { bookmarks, projects, rssFeeds, settings };
  } catch (err) {
    notifyStatus("error", `Force pull failed: ${err.message}`);
    return null;
  }
}

// ── Force push (upsert all local rows to cloud) ──

export async function forcePush(localState, serializeMetaFn) {
  if (!isLoggedIn() || syncInFlight) return;

  syncInFlight = true;
  notifyStatus("pushing", "Pushing to cloud…");

  try {
    const meta = serializeMetaFn(localState);
    delete meta.selectedArticleId;
    delete meta.selectedProjectId;
    delete meta.selectedProjectSidebarArticleId;
    delete meta.activeTab;
    delete meta.settingsSection;

    const promises = [];
    if (localState.bookmarks?.length)
      promises.push(upsertBookmarks(localState.bookmarks));
    if (localState.projects?.length)
      promises.push(upsertProjects(localState.projects));
    if (localState.rssFeeds?.length)
      promises.push(upsertRssFeeds(localState.rssFeeds));
    promises.push(upsertSettings(meta));

    await Promise.all(promises);

    lastSyncPushedAt = Date.now();
    setLocalSyncTimestamp(Date.now());
    notifyStatus("done", "Replaced cloud data with local data");
  } catch (err) {
    notifyStatus("error", `Force push failed: ${err.message}`);
  } finally {
    syncInFlight = false;
  }
}

// ── Local timestamp tracking ──

const SYNC_TS_KEY = "commonplace-last-sync-ts";

function getLocalSyncTimestamp() {
  return Number(localStorage.getItem(SYNC_TS_KEY)) || 0;
}

function setLocalSyncTimestamp(ts) {
  localStorage.setItem(SYNC_TS_KEY, String(ts));
}

export function getLastSyncTime() {
  const ts = getLocalSyncTimestamp();
  return ts > 0 ? new Date(ts) : null;
}

// ── Auto-pull (periodic background sync) ──

export function startAutoPull(localState, serializeMetaFn, onNewData) {
  stopAutoPull();
  if (!isLoggedIn()) return;

  autoPullHandler = async () => {
    if (syncInFlight || !isLoggedIn()) return;
    try {
      const remoteData = await pullSync(localState);
      if (remoteData) {
        onNewData(remoteData);
      }
    } catch {
      // Silent fail — next interval will retry
    }
  };

  // Polling is a fallback — realtime WebSocket is the primary notification
  autoPullTimerId = setInterval(autoPullHandler, AUTO_PULL_INTERVAL_MS);
  document.addEventListener("visibilitychange", handleVisibilityPull);

  // Start Realtime WebSocket — triggers an immediate pull when another device pushes
  startRealtime(() => {
    autoPullHandler();
  });
}

export function stopAutoPull() {
  if (autoPullTimerId !== null) {
    clearInterval(autoPullTimerId);
    autoPullTimerId = null;
  }
  document.removeEventListener("visibilitychange", handleVisibilityPull);
  autoPullHandler = null;
  disconnectRealtime();
}

function handleVisibilityPull() {
  if (document.visibilityState === "visible" && autoPullHandler) {
    autoPullHandler();
  }
}

// ── Apply remote data to local state ──

/**
 * Apply remote sync payload into local app state.
 * Fields that are `null` in remoteData are skipped (not changed on this pull).
 * @param {object} remoteData - { bookmarks, projects, rssFeeds, settings }
 * @param {object} deps
 */
export function applyRemoteSyncData(remoteData, deps) {
  const {
    state,
    touchBookmarks,
    touchProjects,
    touchRss,
    persistState,
    renderAndSyncUrl,
    rebuildIndex,
    applyDisplayPreferences,
  } = deps;

  if (Array.isArray(remoteData.bookmarks)) {
    state.bookmarks = remoteData.bookmarks;
    touchBookmarks(state);
  }
  if (Array.isArray(remoteData.projects)) {
    state.projects = remoteData.projects;
    touchProjects(state);
  }
  if (Array.isArray(remoteData.rssFeeds)) {
    state.rssFeeds = remoteData.rssFeeds;
    touchRss(state);
  }
  if (remoteData.settings && typeof remoteData.settings === "object") {
    const s = remoteData.settings;
    if (s.savedTags) state.savedTags = s.savedTags;
    if (s.displayFont) state.displayFont = s.displayFont;
    if (s.theme) state.theme = s.theme;
    if (s.displayHighlightColor)
      state.displayHighlightColor = s.displayHighlightColor;
    if (s.splashEnabled !== undefined) state.splashEnabled = s.splashEnabled;
    if (s.autoTagEnabled !== undefined) state.autoTagEnabled = s.autoTagEnabled;
    if (s.autoTagUseDefaultCountries !== undefined)
      state.autoTagUseDefaultCountries = s.autoTagUseDefaultCountries;
    if (s.autoTagCustomRules) state.autoTagCustomRules = s.autoTagCustomRules;
    if (s.libraryView) state.libraryView = s.libraryView;
    if (s.librarySort) state.librarySort = s.librarySort;
    if (s.libraryShowImages !== undefined)
      state.libraryShowImages = s.libraryShowImages;
    if (s.libraryShowTags !== undefined)
      state.libraryShowTags = s.libraryShowTags;
    if (s.rssRetentionDays !== undefined)
      state.rssRetentionDays = s.rssRetentionDays;
    if (s.rssAutoRefreshMinutes !== undefined)
      state.rssAutoRefreshMinutes = s.rssAutoRefreshMinutes;
    if (s.ttsVoiceId !== undefined) state.ttsVoiceId = s.ttsVoiceId;
    if (s.ttsRate !== undefined) state.ttsRate = s.ttsRate;
  }

  // Clear dirty flags so the persist below doesn't trigger a push-back
  // to the cloud (touch* bumped versions for derived indexes, but this
  // data already came FROM the cloud — no need to push it back).
  state.__dirtyBookmarks = false;
  state.__dirtyProjects = false;
  state.__dirtyRss = false;
  state.__dirtyMeta = false;
  state.__dirtyBookmarkIds = new Set();
  state.__dirtyProjectIds = new Set();
  state.__dirtyRssFeedIds = new Set();

  persistState(state);
  if (applyDisplayPreferences) applyDisplayPreferences();
  renderAndSyncUrl();
  rebuildIndex(state.bookmarks, state.projects).catch(() => {});
}

// ── Sync UI ──

/**
 * Initialise the cloud sync settings panel.
 * @param {object} deps - { formatRelativeTime, getState, getSyncDeps, serializeMetaState, applyRemote }
 */
export function initSyncUI(deps) {
  const {
    formatRelativeTime,
    getState,
    getSyncDeps,
    serializeMetaState,
    applyRemote,
  } = deps;

  const loginView = document.getElementById("sync-login-view");
  const accountView = document.getElementById("sync-account-view");
  const authForm = document.getElementById("sync-auth-form");
  const signupBtn = document.getElementById("sync-signup-button");
  const loginStatus = document.getElementById("sync-login-status");
  const emailDisplay = document.getElementById("sync-account-email");
  const lastSyncedEl = document.getElementById("sync-last-synced");
  const logoutBtn = document.getElementById("sync-logout-button");
  const syncStatusEl = document.getElementById("sync-status");
  const forcePullBtn = document.getElementById("sync-force-pull-button");
  const forcePushBtn = document.getElementById("sync-force-push-button");
  const titlebarStatus = document.getElementById("sync-titlebar-status");

  function updateSyncView() {
    if (isLoggedIn()) {
      loginView.hidden = true;
      accountView.hidden = false;
      emailDisplay.textContent = getSessionEmail() || "Signed in";
      const lastSync = getLastSyncTime();
      lastSyncedEl.textContent = lastSync
        ? `Last synced ${formatRelativeTime(lastSync)}`
        : "Not synced yet";
      if (titlebarStatus) titlebarStatus.textContent = "● Connected";
    } else {
      loginView.hidden = false;
      accountView.hidden = true;
      if (titlebarStatus) titlebarStatus.textContent = "";
    }
  }

  setSyncStatusCallback(({ status, message }) => {
    if (syncStatusEl) {
      syncStatusEl.textContent = message || "";
    }
    if (titlebarStatus) {
      if (status === "syncing") titlebarStatus.textContent = "⟳ Syncing…";
      else if (status === "error") titlebarStatus.textContent = "● Error";
      else if (status === "done") titlebarStatus.textContent = "● Connected";
    }
    if (status === "done" || status === "error") {
      updateSyncView();
    }
  });

  async function handleAuth(isSignUp) {
    const emailInput = document.getElementById("sync-email-input");
    const passwordInput = document.getElementById("sync-password-input");
    const email = emailInput?.value?.trim();
    const password = passwordInput?.value;
    if (!email || !password) return;

    loginStatus.textContent = isSignUp ? "Creating account…" : "Signing in…";
    try {
      if (isSignUp) {
        await signUp(email, password);
      } else {
        await signIn(email, password);
      }
      loginStatus.textContent = "";

      // Full sync after login: pull remote → merge → push local-only items
      const localState = getState();
      try {
        localStorage.removeItem(LAST_PULL_KEY);
        const remoteData = await pullSync(localState);
        if (remoteData) {
          applyRemote(remoteData);
        }
        // Push all local data so local-only items reach the cloud
        await forcePush(getState(), serializeMetaState);
      } catch {
        /* sync failure after login is non-critical */
      }
      // Start background sync (polling + realtime)
      startAutoPull(getState(), serializeMetaState, (data) =>
        applyRemote(data),
      );

      updateSyncView();
    } catch (err) {
      loginStatus.textContent = `Error: ${err.message}`;
    }
  }

  authForm?.addEventListener("submit", (e) => {
    e.preventDefault();
    handleAuth(false);
  });

  signupBtn?.addEventListener("click", () => {
    if (!authForm?.reportValidity()) return;
    handleAuth(true);
  });

  forcePullBtn?.addEventListener("click", async () => {
    if (
      !confirm(
        "Replace all local data with cloud data? Any unsynced local changes will be lost.",
      )
    )
      return;
    forcePullBtn.disabled = true;
    try {
      const remoteData = await forcePull();
      if (remoteData) {
        applyRemote(remoteData);
        updateSyncView();
      }
    } finally {
      forcePullBtn.disabled = false;
    }
  });

  forcePushBtn?.addEventListener("click", async () => {
    if (
      !confirm(
        "Replace all cloud data with local data? Any unsynced changes on other devices will be lost.",
      )
    )
      return;
    forcePushBtn.disabled = true;
    try {
      await forcePush(getState(), serializeMetaState);
      updateSyncView();
    } finally {
      forcePushBtn.disabled = false;
    }
  });

  logoutBtn?.addEventListener("click", () => {
    logout();
    stopAutoPull();
    updateSyncView();
    if (syncStatusEl) syncStatusEl.textContent = "";
  });

  updateSyncView();
}
