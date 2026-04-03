/**
 * Lightweight Supabase REST client (no SDK dependency).
 * Uses the PostgREST and GoTrue endpoints directly.
 */

import { runtimeConfig } from "../state.js";

const AUTH_TOKEN_KEY = "sb-auth-token";

let cachedSession = null;

function getProjectUrl() {
  const url = runtimeConfig.fetchServiceUrl || "";
  const match = url.match(/^(https:\/\/[^/]+\.supabase\.co)/);
  return match ? match[1] : "";
}

function getAnonKey() {
  return runtimeConfig.supabaseAnonKey || "";
}

// ── Auth helpers ──

function persistSession(session) {
  cachedSession = session;
  if (session) {
    localStorage.setItem(AUTH_TOKEN_KEY, JSON.stringify(session));
  } else {
    localStorage.removeItem(AUTH_TOKEN_KEY);
  }
}

export function restoreSession() {
  if (cachedSession) return cachedSession;
  try {
    const raw = localStorage.getItem(AUTH_TOKEN_KEY);
    if (raw) {
      cachedSession = JSON.parse(raw);
      return cachedSession;
    }
  } catch {
    localStorage.removeItem(AUTH_TOKEN_KEY);
  }
  return null;
}

export function getAccessToken() {
  const session = restoreSession();
  return session?.access_token || null;
}

export function getUserId() {
  const session = restoreSession();
  return session?.user?.id || null;
}

export function isLoggedIn() {
  return Boolean(getAccessToken());
}

async function authRequest(endpoint, body) {
  const base = getProjectUrl();
  if (!base) throw new Error("Supabase URL not configured");

  const res = await fetch(`${base}/auth/v1/${endpoint}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: getAnonKey(),
    },
    body: JSON.stringify(body),
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(
      data.error_description || data.msg || data.error || "Auth request failed",
    );
  }
  return data;
}

/**
 * Sign up with email + password. Returns the session (auto-confirmed)
 * or the user object (if email confirmation is enabled on the project).
 */
export async function signUp(email, password) {
  const data = await authRequest("signup", { email, password });
  // If Supabase returns a session directly (auto-confirm enabled), persist it
  if (data.access_token) {
    persistSession({
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_in: data.expires_in,
      expires_at: Math.floor(Date.now() / 1000) + (data.expires_in || 3600),
      token_type: data.token_type || "bearer",
      user: data.user,
    });
  }
  return data;
}

/**
 * Sign in with email + password.
 */
export async function signIn(email, password) {
  const data = await authRequest("token?grant_type=password", {
    email,
    password,
  });
  persistSession({
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_in: data.expires_in,
    expires_at: Math.floor(Date.now() / 1000) + (data.expires_in || 3600),
    token_type: data.token_type || "bearer",
    user: data.user,
  });
  return data;
}

/**
 * Exchange token hash from the magic link redirect for a session.
 * Call this on page load if the URL contains a Supabase auth hash fragment.
 */
export async function handleAuthRedirect() {
  const hash = window.location.hash;
  if (!hash || !hash.includes("access_token")) return false;

  const params = new URLSearchParams(hash.substring(1));
  const accessToken = params.get("access_token");
  const refreshToken = params.get("refresh_token");
  const expiresIn = Number(params.get("expires_in")) || 3600;
  const tokenType = params.get("token_type") || "bearer";

  if (!accessToken) return false;

  // Fetch user info
  const base = getProjectUrl();
  const userRes = await fetch(`${base}/auth/v1/user`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      apikey: getAnonKey(),
    },
  });

  const user = userRes.ok ? await userRes.json() : { id: null, email: null };

  const session = {
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_in: expiresIn,
    expires_at: Math.floor(Date.now() / 1000) + expiresIn,
    token_type: tokenType,
    user,
  };

  persistSession(session);

  // Clean the hash from the URL
  window.history.replaceState(
    null,
    "",
    window.location.pathname + window.location.search,
  );
  return true;
}

/**
 * Refresh the access token using the stored refresh token.
 */
export async function refreshAccessToken() {
  const session = restoreSession();
  if (!session?.refresh_token) {
    logout();
    return false;
  }

  try {
    const data = await authRequest("token?grant_type=refresh_token", {
      refresh_token: session.refresh_token,
    });

    persistSession({
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_in: data.expires_in,
      expires_at: Math.floor(Date.now() / 1000) + (data.expires_in || 3600),
      token_type: data.token_type || "bearer",
      user: data.user || session.user,
    });
    return true;
  } catch (err) {
    // Only logout on definitive auth rejection (invalid/revoked token).
    // Transient network errors should not wipe the session.
    const msg = (err?.message || "").toLowerCase();
    if (
      msg.includes("invalid") ||
      msg.includes("revoked") ||
      msg.includes("expired")
    ) {
      logout();
    }
    return false;
  }
}

export function logout() {
  persistSession(null);
}

export function getSessionEmail() {
  const session = restoreSession();
  return session?.user?.email || null;
}

// ── Database helpers ──

async function authedHeaders() {
  let session = restoreSession();

  // Auto-refresh if token is close to expiry (within 60s)
  if (
    session?.expires_at &&
    session.expires_at - Math.floor(Date.now() / 1000) < 60
  ) {
    await refreshAccessToken();
    session = restoreSession();
  }

  if (!session?.access_token) {
    throw new Error("Not authenticated");
  }

  return {
    apikey: getAnonKey(),
    Authorization: `Bearer ${session.access_token}`,
    "Content-Type": "application/json",
    Prefer: "return=representation",
  };
}

// ── Per-table CRUD (bookmarks, projects, rss_feeds, user_settings) ──

async function restGet(table, query, retried = false) {
  const base = getProjectUrl();
  if (!base) return null;
  const headers = await authedHeaders();
  const res = await fetch(`${base}/rest/v1/${table}?${query}`, { headers });
  if (!res.ok) {
    if (res.status === 401 && !retried) {
      const ok = await refreshAccessToken();
      if (ok) return restGet(table, query, true);
    }
    throw new Error(`GET ${table} failed: ${res.status}`);
  }
  return res.json();
}

async function restUpsert(table, rows, retried = false) {
  const base = getProjectUrl();
  if (!base) throw new Error("Supabase URL not configured");
  const headers = await authedHeaders();
  headers.Prefer = "resolution=merge-duplicates,return=representation";
  const res = await fetch(`${base}/rest/v1/${table}`, {
    method: "POST",
    headers,
    body: JSON.stringify(rows),
  });
  if (!res.ok) {
    if (res.status === 401 && !retried) {
      const ok = await refreshAccessToken();
      if (ok) return restUpsert(table, rows, true);
    }
    throw new Error(`UPSERT ${table} failed: ${res.status}`);
  }
  return res.json();
}

/**
 * Fetch bookmarks changed since `since` (ISO string). Pass null for all.
 */
export async function fetchBookmarks(since) {
  const userId = getUserId();
  if (!userId) return [];
  let q = `user_id=eq.${userId}&select=*`;
  if (since) q += `&updated_at=gt.${encodeURIComponent(since)}`;
  q += "&order=updated_at.asc";
  return (await restGet("bookmarks", q)) || [];
}

/**
 * Upsert one or more bookmarks to the cloud.
 */
export async function upsertBookmarks(items) {
  const userId = getUserId();
  if (!userId || !items.length) return [];
  const rows = items.map((b) => ({
    id: b.id,
    user_id: userId,
    title: b.title || null,
    url: b.url || null,
    description: b.description || null,
    source: b.source || null,
    published_at: b.publishedAt || null,
    preview_text: b.previewText || null,
    image_url: b.imageUrl || null,
    fetched_at: b.fetchedAt || null,
    created_at: b.createdAt || null,
    tweet_html: b.tweetHtml || null,
    blocks: b.blocks || [],
    tags: b.tags || [],
    project_ids: b.projectIds || [],
    highlights: b.highlights || [],
    last_opened_at: b.lastOpenedAt || null,
    _deleted: b._deleted || false,
  }));
  return restUpsert("bookmarks", rows);
}

/**
 * Soft-delete a bookmark.
 */
export async function deleteBookmark(id) {
  return upsertBookmarks([{ id, _deleted: true }]);
}

/**
 * Fetch projects changed since `since`.
 */
export async function fetchProjects(since) {
  const userId = getUserId();
  if (!userId) return [];
  let q = `user_id=eq.${userId}&select=*`;
  if (since) q += `&updated_at=gt.${encodeURIComponent(since)}`;
  q += "&order=updated_at.asc";
  return (await restGet("projects", q)) || [];
}

/**
 * Upsert one or more projects.
 */
export async function upsertProjects(items) {
  const userId = getUserId();
  if (!userId || !items.length) return [];
  const rows = items.map((p) => ({
    id: p.id,
    user_id: userId,
    name: p.name || null,
    description: p.description || null,
    content: p.content || null,
    stage: p.stage || null,
    created_at: p.createdAt || null,
    last_opened_at: p.lastOpenedAt || null,
    _deleted: p._deleted || false,
  }));
  return restUpsert("projects", rows);
}

/**
 * Soft-delete a project.
 */
export async function deleteProject(id) {
  return upsertProjects([{ id, _deleted: true }]);
}

/**
 * Fetch RSS feeds changed since `since`.
 */
export async function fetchRssFeeds(since) {
  const userId = getUserId();
  if (!userId) return [];
  let q = `user_id=eq.${userId}&select=*`;
  if (since) q += `&updated_at=gt.${encodeURIComponent(since)}`;
  q += "&order=updated_at.asc";
  return (await restGet("rss_feeds", q)) || [];
}

/**
 * Upsert one or more RSS feeds.
 */
export async function upsertRssFeeds(items) {
  const userId = getUserId();
  if (!userId || !items.length) return [];
  const rows = items.map((f) => ({
    id: f.id,
    user_id: userId,
    feed_url: f.feedUrl || f.url || null,
    title: f.title || null,
    folder: f.folder || null,
    items: f.items || [],
    last_fetched_at: f.lastFetchedAt || null,
    _deleted: f._deleted || false,
  }));
  return restUpsert("rss_feeds", rows);
}

/**
 * Soft-delete an RSS feed.
 */
export async function deleteRssFeed(id) {
  return upsertRssFeeds([{ id, _deleted: true }]);
}

/**
 * Fetch the user's settings row.
 */
export async function fetchSettings() {
  const userId = getUserId();
  if (!userId) return null;
  const rows = await restGet("user_settings", `user_id=eq.${userId}&select=*`);
  return rows?.length ? rows[0] : null;
}

/**
 * Upsert the user's settings.
 */
export async function upsertSettings(settings) {
  const userId = getUserId();
  if (!userId) throw new Error("Not authenticated");
  const rows = await restUpsert("user_settings", [
    { user_id: userId, settings },
  ]);
  return rows?.[0] || null;
}

/**
 * Fetch the old sync_data row (for one-time migration).
 */
export async function fetchLegacySyncData() {
  const userId = getUserId();
  if (!userId) return null;
  try {
    const rows = await restGet(
      "sync_data",
      `user_id=eq.${userId}&select=bookmarks,projects,meta,rss_feeds,updated_at`,
    );
    return rows?.length ? rows[0] : null;
  } catch {
    return null;
  }
}
