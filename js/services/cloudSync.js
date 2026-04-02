/**
 * Cloud Sync Service
 * Handles push/pull sync with Supabase using per-item conflict resolution,
 * tombstone-based deletion tracking, and field-level bookmark merge.
 */

import {
  isLoggedIn,
  fetchSyncData,
  upsertSyncData,
  signIn,
  signUp,
  logout,
  getSessionEmail,
} from "./supabaseClient.js";
import {
  startRealtime,
  disconnect as disconnectRealtime,
} from "./realtimeSync.js";
import { mergeAll, stampSyncFields } from "./syncMerge.js";

const SYNC_DEBOUNCE_MS = 1000;
const SYNC_COOLDOWN_MS = 5000;
const AUTO_PULL_INTERVAL_MS = 30000;

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

// ── Pull (smart merge with remote) ──

export async function pullSync(localState, serializeMetaFn) {
  if (!isLoggedIn()) return null;

  // If a local push is pending, skip — let the push complete first to avoid
  // merging against stale local intent. Next poll/realtime will retry.
  if (syncTimerId !== null) {
    return null;
  }

  notifyStatus("pulling", "Syncing from cloud…");

  try {
    const remote = await fetchSyncData();

    if (!remote) {
      await pushSyncNow(localState, serializeMetaFn);
      notifyStatus("done", "Initial sync complete");
      return null;
    }

    // Build local and remote data objects for merge
    const localMeta = serializeMetaFn(localState);
    const localData = {
      bookmarks: localState.bookmarks || [],
      projects: localState.projects || [],
      rssFeeds: localState.rssFeeds || [],
      meta: localMeta,
    };
    const remoteData = {
      bookmarks: remote.bookmarks || [],
      projects: remote.projects || [],
      rssFeeds: remote.rss_feeds || [],
      meta: remote.meta || {},
    };

    // Smart merge with conflict resolution
    const merged = mergeAll(localData, remoteData);

    // Check if anything actually changed versus local (content-aware)
    function itemsChanged(localItems, mergedItems) {
      if (localItems.length !== mergedItems.length) return true;
      const localMap = new Map(localItems.map((i) => [i.id, i]));
      return mergedItems.some((m) => {
        const l = localMap.get(m.id);
        return !l || (m._sv || 0) !== (l._sv || 0);
      });
    }

    const bookmarksChanged = itemsChanged(
      localState.bookmarks || [],
      merged.bookmarks,
    );
    const projectsChanged = itemsChanged(
      localState.projects || [],
      merged.projects,
    );
    const feedsChanged = itemsChanged(
      localState.rssFeeds || [],
      merged.rssFeeds,
    );

    // Also detect meta/settings changes
    const metaChanged =
      JSON.stringify(merged.meta._metaTimestamps || {}) !==
      JSON.stringify(localState._metaTimestamps || {});

    const hasChanges =
      bookmarksChanged || projectsChanged || feedsChanged || metaChanged;

    setLocalSyncTimestamp(Date.now());

    if (hasChanges) {
      notifyStatus("done", "Synced from cloud");
      return {
        bookmarks: merged.bookmarks,
        projects: merged.projects,
        meta: merged.meta,
        rssFeeds: merged.rssFeeds,
      };
    }

    // Even if items didn't change, update tombstones in local state
    if (merged.meta._tombstones) {
      localState._tombstones = merged.meta._tombstones;
    }

    notifyStatus("done", "Already up to date");
    return null;
  } catch (err) {
    notifyStatus("error", `Sync pull failed: ${err.message}`);
    return null;
  }
}

// ── Push ──

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
    // Schedule a retry after the cooldown expires instead of silently dropping
    schedulePushSync(localState, serializeMetaFn);
    return;
  }

  syncInFlight = true;
  notifyStatus("pushing", "Saving to cloud…");

  try {
    const meta = serializeMetaFn(localState);

    delete meta.selectedArticleId;
    delete meta.selectedProjectId;
    delete meta.selectedProjectSidebarArticleId;
    delete meta.activeTab;
    delete meta.settingsSection;

    // Ensure sync fields exist on items that predate sync (migration)
    stampSyncFields(localState.bookmarks || []);
    stampSyncFields(localState.projects || []);
    stampSyncFields(localState.rssFeeds || []);

    await upsertSyncData({
      bookmarks: localState.bookmarks,
      projects: localState.projects,
      meta,
      rss_feeds: localState.rssFeeds,
    });

    lastSyncPushedAt = Date.now();
    setLocalSyncTimestamp(Date.now());
    notifyStatus("done", "Saved to cloud");
  } catch (err) {
    notifyStatus("error", `Sync push failed: ${err.message}`);
  } finally {
    syncInFlight = false;
  }
}

// ── Force pull (ignores timestamps — always overwrites local) ──

export async function forcePull() {
  if (!isLoggedIn()) return null;

  notifyStatus("pulling", "Pulling from cloud…");

  try {
    const remote = await fetchSyncData();

    if (!remote) {
      notifyStatus("error", "No cloud data found");
      return null;
    }

    setLocalSyncTimestamp(new Date(remote.updated_at).getTime());
    notifyStatus("done", "Replaced local data with cloud data");
    return {
      bookmarks: remote.bookmarks || [],
      projects: remote.projects || [],
      meta: remote.meta || {},
      rssFeeds: remote.rss_feeds || [],
    };
  } catch (err) {
    notifyStatus("error", `Force pull failed: ${err.message}`);
    return null;
  }
}

// ── Force push (ignores cooldown — always overwrites cloud) ──

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

    stampSyncFields(localState.bookmarks || []);
    stampSyncFields(localState.projects || []);
    stampSyncFields(localState.rssFeeds || []);

    await upsertSyncData({
      bookmarks: localState.bookmarks,
      projects: localState.projects,
      meta,
      rss_feeds: localState.rssFeeds,
    });

    lastSyncPushedAt = Date.now();
    setLocalSyncTimestamp(Date.now());
    notifyStatus("done", "Replaced cloud data with local data");
  } catch (err) {
    notifyStatus("error", `Force push failed: ${err.message}`);
  } finally {
    syncInFlight = false;
  }
}

// ── Merge (union local + remote, respects tombstones) ──

export async function mergeSync(localState, serializeMetaFn) {
  if (!isLoggedIn() || syncInFlight) return null;

  syncInFlight = true;
  notifyStatus("pulling", "Merging with cloud…");

  try {
    const remote = await fetchSyncData();

    if (!remote) {
      syncInFlight = false;
      await forcePush(localState, serializeMetaFn);
      return null;
    }

    const localMeta = serializeMetaFn(localState);
    const localData = {
      bookmarks: localState.bookmarks || [],
      projects: localState.projects || [],
      rssFeeds: localState.rssFeeds || [],
      meta: localMeta,
    };
    const remoteData = {
      bookmarks: remote.bookmarks || [],
      projects: remote.projects || [],
      rssFeeds: remote.rss_feeds || [],
      meta: remote.meta || {},
    };

    const merged = mergeAll(localData, remoteData);

    // Push merged result to cloud
    await upsertSyncData({
      bookmarks: merged.bookmarks,
      projects: merged.projects,
      meta: merged.meta,
      rss_feeds: merged.rssFeeds,
    });

    lastSyncPushedAt = Date.now();
    setLocalSyncTimestamp(Date.now());
    notifyStatus("done", "Merge complete");

    return {
      bookmarks: merged.bookmarks,
      projects: merged.projects,
      meta: merged.meta,
      rssFeeds: merged.rssFeeds,
    };
  } catch (err) {
    notifyStatus("error", `Merge failed: ${err.message}`);
    return null;
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
      const remoteData = await pullSync(localState, serializeMetaFn);
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
 * Merge remote sync payload into local app state.
 * @param {object} remoteData - { bookmarks, projects, rssFeeds, meta }
 * @param {object} deps - { state, touchBookmarks, touchProjects, touchRss, persistState, renderAndSyncUrl, rebuildIndex }
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
  if (remoteData.meta && typeof remoteData.meta === "object") {
    const m = remoteData.meta;
    if (m.savedTags) state.savedTags = m.savedTags;
    if (m.displayFont) state.displayFont = m.displayFont;
    if (m.theme) state.theme = m.theme;
    if (m.displayHighlightColor)
      state.displayHighlightColor = m.displayHighlightColor;
    if (m.splashEnabled !== undefined) state.splashEnabled = m.splashEnabled;
    if (m.autoTagEnabled !== undefined) state.autoTagEnabled = m.autoTagEnabled;
    if (m.autoTagUseDefaultCountries !== undefined)
      state.autoTagUseDefaultCountries = m.autoTagUseDefaultCountries;
    if (m.autoTagCustomRules) state.autoTagCustomRules = m.autoTagCustomRules;
    if (m.libraryView) state.libraryView = m.libraryView;
    if (m.librarySort) state.librarySort = m.librarySort;
    if (m.libraryShowImages !== undefined)
      state.libraryShowImages = m.libraryShowImages;
    if (m.libraryShowTags !== undefined)
      state.libraryShowTags = m.libraryShowTags;
    if (m.rssRetentionDays !== undefined)
      state.rssRetentionDays = m.rssRetentionDays;
    if (m.rssAutoRefreshMinutes !== undefined)
      state.rssAutoRefreshMinutes = m.rssAutoRefreshMinutes;
    if (m.ttsVoiceId !== undefined) state.ttsVoiceId = m.ttsVoiceId;
    if (m.ttsRate !== undefined) state.ttsRate = m.ttsRate;
    // Apply merged tombstones and meta timestamps
    if (m._tombstones) state._tombstones = m._tombstones;
    if (m._metaTimestamps) state._metaTimestamps = m._metaTimestamps;
  }
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
  const statArticles = document.getElementById("sync-stat-articles");
  const statProjects = document.getElementById("sync-stat-projects");
  const statFeeds = document.getElementById("sync-stat-feeds");
  const forcePullBtn = document.getElementById("sync-force-pull-button");
  const forcePushBtn = document.getElementById("sync-force-push-button");
  const mergeBtn = document.getElementById("sync-merge-button");

  function updateStats() {
    const state = getState();
    if (statArticles) statArticles.textContent = state.bookmarks?.length || 0;
    if (statProjects) statProjects.textContent = state.projects?.length || 0;
    if (statFeeds) statFeeds.textContent = state.rssFeeds?.length || 0;
  }

  function updateSyncView() {
    if (isLoggedIn()) {
      loginView.hidden = true;
      accountView.hidden = false;
      emailDisplay.textContent = getSessionEmail() || "Signed in";
      const lastSync = getLastSyncTime();
      lastSyncedEl.textContent = lastSync
        ? `Last synced ${formatRelativeTime(lastSync)}`
        : "Not synced yet";
      updateStats();
    } else {
      loginView.hidden = false;
      accountView.hidden = true;
    }
  }

  setSyncStatusCallback(({ status, message }) => {
    if (syncStatusEl) {
      syncStatusEl.textContent = message || "";
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

  mergeBtn?.addEventListener("click", async () => {
    mergeBtn.disabled = true;
    try {
      const merged = await mergeSync(getState(), serializeMetaState);
      if (merged) {
        applyRemote(merged);
        updateSyncView();
      }
    } finally {
      mergeBtn.disabled = false;
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
