/**
 * Cloud Sync Service
 * Handles push/pull blob sync with Supabase, auto-pull polling,
 * sync UI initialisation, and applying remote data to local state.
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

const SYNC_DEBOUNCE_MS = 5000;
const SYNC_COOLDOWN_MS = 30000;
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

// ── Pull ──

export async function pullSync(localState, serializeMetaFn) {
  if (!isLoggedIn()) return null;

  notifyStatus("pulling", "Syncing from cloud…");

  try {
    const remote = await fetchSyncData();

    if (!remote) {
      await pushSyncNow(localState, serializeMetaFn);
      notifyStatus("done", "Initial sync complete");
      return null;
    }

    const remoteTime = new Date(remote.updated_at).getTime();
    const localTime = getLocalSyncTimestamp();

    if (remoteTime > localTime) {
      setLocalSyncTimestamp(remoteTime);
      notifyStatus("done", "Synced from cloud");
      return {
        bookmarks: remote.bookmarks || [],
        projects: remote.projects || [],
        meta: remote.meta || {},
        rssFeeds: remote.rss_feeds || [],
      };
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
  if (elapsed < SYNC_COOLDOWN_MS && lastSyncPushedAt > 0) return;

  syncInFlight = true;
  notifyStatus("pushing", "Saving to cloud…");

  try {
    const meta = serializeMetaFn(localState);

    delete meta.selectedArticleId;
    delete meta.selectedProjectId;
    delete meta.selectedProjectSidebarArticleId;
    delete meta.activeTab;
    delete meta.settingsSection;

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

  autoPullTimerId = setInterval(autoPullHandler, AUTO_PULL_INTERVAL_MS);
  document.addEventListener("visibilitychange", handleVisibilityPull);
}

export function stopAutoPull() {
  if (autoPullTimerId !== null) {
    clearInterval(autoPullTimerId);
    autoPullTimerId = null;
  }
  document.removeEventListener("visibilitychange", handleVisibilityPull);
  autoPullHandler = null;
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
  } = deps;

  if (Array.isArray(remoteData.bookmarks) && remoteData.bookmarks.length > 0) {
    state.bookmarks = remoteData.bookmarks;
    touchBookmarks(state);
  }
  if (Array.isArray(remoteData.projects) && remoteData.projects.length > 0) {
    state.projects = remoteData.projects;
    touchProjects(state);
  }
  if (Array.isArray(remoteData.rssFeeds) && remoteData.rssFeeds.length > 0) {
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
  }
  persistState(state);
  renderAndSyncUrl();
  rebuildIndex(state.bookmarks, state.projects).catch(() => {});
}

// ── Sync UI ──

const AVATAR_KEY = "commonplace-sync-avatar";

/**
 * Initialise the cloud sync settings panel.
 * @param {object} deps - { formatRelativeTime, getState }
 */
export function initSyncUI(deps) {
  const { formatRelativeTime, getState } = deps;

  const loginView = document.getElementById("sync-login-view");
  const accountView = document.getElementById("sync-account-view");
  const authForm = document.getElementById("sync-auth-form");
  const signupBtn = document.getElementById("sync-signup-button");
  const loginStatus = document.getElementById("sync-login-status");
  const emailDisplay = document.getElementById("sync-account-email");
  const lastSyncedEl = document.getElementById("sync-last-synced");
  const logoutBtn = document.getElementById("sync-logout-button");
  const syncStatusEl = document.getElementById("sync-status");
  const avatarImg = document.getElementById("sync-profile-avatar");
  const avatarFallback = document.getElementById(
    "sync-profile-avatar-fallback",
  );
  const avatarInput = document.getElementById("sync-avatar-input");
  const statArticles = document.getElementById("sync-stat-articles");
  const statProjects = document.getElementById("sync-stat-projects");
  const statFeeds = document.getElementById("sync-stat-feeds");

  function getInitials(email) {
    if (!email) return "?";
    const name = email.split("@")[0] || "";
    const parts = name.split(/[._-]/).filter(Boolean);
    if (parts.length >= 2) {
      return (parts[0][0] + parts[1][0]).toUpperCase();
    }
    return name.slice(0, 2).toUpperCase() || "?";
  }

  function loadAvatar() {
    const stored = localStorage.getItem(AVATAR_KEY);
    if (stored) {
      avatarImg.src = stored;
      avatarImg.hidden = false;
      avatarFallback.hidden = true;
    } else {
      avatarImg.hidden = true;
      avatarFallback.hidden = false;
      avatarFallback.textContent = getInitials(getSessionEmail());
    }
  }

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
      loadAvatar();
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

  avatarInput?.addEventListener("change", (e) => {
    const file = e.target.files?.[0];
    if (!file || !file.type.startsWith("image/")) return;

    // Resize to 128x128 to keep localStorage small
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement("canvas");
        canvas.width = 128;
        canvas.height = 128;
        const ctx = canvas.getContext("2d");
        // Center-crop to square
        const size = Math.min(img.width, img.height);
        const sx = (img.width - size) / 2;
        const sy = (img.height - size) / 2;
        ctx.drawImage(img, sx, sy, size, size, 0, 0, 128, 128);
        const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
        localStorage.setItem(AVATAR_KEY, dataUrl);
        loadAvatar();
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
    // Reset input so same file can be re-selected
    avatarInput.value = "";
  });

  logoutBtn?.addEventListener("click", () => {
    logout();
    stopAutoPull();
    updateSyncView();
    if (syncStatusEl) syncStatusEl.textContent = "";
  });

  updateSyncView();
}
