/**
 * Lightweight Supabase REST client (no SDK dependency).
 * Uses the PostgREST and GoTrue endpoints directly.
 */

import { runtimeConfig } from "../state.js";
import { updateClockOffset } from "../syncClock.js";

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
  } catch {
    logout();
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

/**
 * Fetch the user's sync_data row. Returns null if not found.
 */
export async function fetchSyncData() {
  const base = getProjectUrl();
  const userId = getUserId();
  if (!base || !userId) return null;

  const headers = await authedHeaders();
  const res = await fetch(
    `${base}/rest/v1/sync_data?user_id=eq.${userId}&select=bookmarks,projects,meta,rss_feeds,updated_at`,
    { headers },
  );

  if (!res.ok) {
    if (res.status === 401) {
      const refreshed = await refreshAccessToken();
      if (refreshed) return fetchSyncData();
    }
    throw new Error(`Fetch sync data failed: ${res.status}`);
  }

  const rows = await res.json();
  updateClockOffset(res.headers.get("Date"));
  return rows.length > 0 ? rows[0] : null;
}

/**
 * Upsert the user's sync_data row.
 */
export async function upsertSyncData(payload) {
  const base = getProjectUrl();
  const userId = getUserId();
  if (!base || !userId) throw new Error("Not authenticated");

  const headers = await authedHeaders();
  headers.Prefer = "resolution=merge-duplicates,return=representation";

  const body = {
    user_id: userId,
    ...payload,
    updated_at: new Date().toISOString(),
  };

  const res = await fetch(`${base}/rest/v1/sync_data`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    if (res.status === 401) {
      const refreshed = await refreshAccessToken();
      if (refreshed) return upsertSyncData(payload);
    }
    throw new Error(`Upsert sync data failed: ${res.status}`);
  }

  updateClockOffset(res.headers.get("Date"));
  return (await res.json())[0];
}
