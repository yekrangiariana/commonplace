/**
 * Lightweight Supabase Realtime client (no SDK).
 * Uses the Phoenix WebSocket protocol v1.0.0 to listen for
 * Postgres changes on bookmarks, projects, rss_feeds, user_settings.
 *
 * SETUP REQUIRED (run once in Supabase SQL editor):
 *   ALTER PUBLICATION supabase_realtime ADD TABLE bookmarks, projects, rss_feeds, user_settings;
 */

import { getAccessToken, getUserId } from "./supabaseClient.js";
import { runtimeConfig } from "../state.js";

const HEARTBEAT_INTERVAL_MS = 25_000;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

let ws = null;
let heartbeatTimer = null;
let reconnectTimer = null;
let reconnectDelay = RECONNECT_BASE_MS;
let refCounter = 0;
let joinRef = null;
let onChange = null;
let intentionalClose = false;

function getRealtimeUrl() {
  const url = runtimeConfig.fetchServiceUrl || "";
  const match = url.match(/^https:\/\/([^/]+\.supabase\.co)/);
  if (!match) return "";
  const anonKey = runtimeConfig.supabaseAnonKey || "";
  return `wss://${match[1]}/realtime/v1/websocket?apikey=${encodeURIComponent(anonKey)}&vsn=1.0.0`;
}

function nextRef() {
  return String(++refCounter);
}

function send(msg) {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function startHeartbeat() {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    send({
      topic: "phoenix",
      event: "heartbeat",
      payload: {},
      ref: nextRef(),
      join_ref: null,
    });
  }, HEARTBEAT_INTERVAL_MS);
}

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

function scheduleReconnect() {
  if (intentionalClose) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, reconnectDelay);
  // Exponential backoff with jitter, capped
  reconnectDelay = Math.min(
    reconnectDelay * 2 + Math.random() * 500,
    RECONNECT_MAX_MS,
  );
}

function joinChannel() {
  const userId = getUserId();
  const token = getAccessToken();
  joinRef = nextRef();

  const pgFilter = `user_id=eq.${userId}`;
  const tables = ["bookmarks", "projects", "rss_feeds", "user_settings"];
  const events = ["INSERT", "UPDATE", "DELETE"];

  const postgres_changes = tables.flatMap((table) =>
    events.map((event) => ({
      event,
      schema: "public",
      table,
      filter: pgFilter,
    })),
  );

  send({
    topic: "realtime:sync-changes",
    event: "phx_join",
    payload: {
      config: {
        broadcast: { ack: false, self: false },
        presence: { enabled: false },
        postgres_changes,
        private: false,
      },
      access_token: token,
    },
    ref: joinRef,
    join_ref: joinRef,
  });
}

function handleMessage(data) {
  let msg;
  try {
    msg = JSON.parse(data);
  } catch {
    return;
  }

  const { event, payload } = msg;

  if (event === "phx_reply" && payload?.status === "ok") {
    // Joined successfully — reset reconnect delay
    reconnectDelay = RECONNECT_BASE_MS;
    return;
  }

  if (event === "postgres_changes") {
    const type = payload?.data?.type;
    if (type === "INSERT" || type === "UPDATE" || type === "DELETE") {
      onChange?.();
    }
  }

  if (event === "phx_error" || event === "phx_close") {
    ws?.close();
  }
}

function connect() {
  const url = getRealtimeUrl();
  const userId = getUserId();
  if (!url || !userId) return;

  intentionalClose = false;

  try {
    ws = new WebSocket(url);
  } catch {
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    startHeartbeat();
    joinChannel();
  };

  ws.onmessage = (e) => {
    handleMessage(e.data);
  };

  ws.onclose = () => {
    stopHeartbeat();
    ws = null;
    scheduleReconnect();
  };

  ws.onerror = () => {
    // onclose will fire after onerror
  };
}

/**
 * Start listening for real-time sync_data changes.
 * @param {function} callback - Called (with no args) when another device pushes data.
 */
export function startRealtime(callback) {
  onChange = callback;
  disconnect();
  intentionalClose = false;
  reconnectDelay = RECONNECT_BASE_MS;
  connect();
}

/**
 * Refresh the access token on the open channel (call after token refresh).
 */
export function refreshRealtimeToken() {
  const token = getAccessToken();
  if (token && ws?.readyState === WebSocket.OPEN) {
    send({
      topic: "realtime:sync-changes",
      event: "access_token",
      payload: { access_token: token },
      ref: nextRef(),
      join_ref: joinRef,
    });
  }
}

/**
 * Disconnect and stop all timers.
 */
export function disconnect() {
  intentionalClose = true;
  stopHeartbeat();
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (ws) {
    ws.onclose = null; // prevent reconnect
    ws.close();
    ws = null;
  }
}

export function isRealtimeConnected() {
  return ws?.readyState === WebSocket.OPEN;
}
