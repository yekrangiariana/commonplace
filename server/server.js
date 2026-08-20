import express from "express";
import { WebSocketServer } from "ws";
import http from "http";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import crypto from "crypto";

import {
  initDb,
  dbRun,
  dbGet,
  dbAll,
  formatRowFromDb,
  formatRowForDb,
} from "./db.js";
import {
  hashPassword,
  verifyPassword,
  createSession,
  validateSession,
  deleteSession,
  changeUserPassword,
  getUserCount,
} from "./auth.js";

// Load environment variables
dotenv.config();
const PORT = process.env.PORT || 8383;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.join(__dirname, "..");

const app = express();
app.use(express.json());

// Enable CORS for development/extension flexibility
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization, apikey");
  if (req.method === "OPTIONS") {
    return res.sendStatus(200);
  }
  next();
});

// Dynamic configuration serving
app.get("/app-settings.json", (req, res) => {
  const settingsPath = path.join(ROOT_DIR, "app-settings.json");
  if (fs.existsSync(settingsPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
      // Force fetchServiceUrl to be relative and point to this server
      data.fetchServiceUrl = "/functions/v1/fetch-article";
      data.supabaseAnonKey = "local-anon-key";
      return res.json(data);
    } catch (e) {
      // Fallback
    }
  }
  res.json({
    fetchServiceUrl: "/functions/v1/fetch-article",
    supabaseAnonKey: "local-anon-key",
    requestTimeoutMs: 25000,
    appVersion: "2.3.7",
  });
});

// Serve static frontend files
app.use(express.static(ROOT_DIR));

// Fallback for SPA routing to index.html
app.get("/", (req, res) => {
  res.sendFile(path.join(ROOT_DIR, "index.html"));
});

// --- Auth Middleware ---
async function authRequired(req, res, next) {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.substring(7) : null;
  const user = await validateSession(token);

  if (!user) {
    return res.status(401).json({ error: "Unauthorized", msg: "Invalid or expired session" });
  }
  req.user = user;
  req.token = token;
  next();
}

async function fetchArticleAuth(req, res, next) {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.substring(7) : null;

  if (token === "local-anon-key" || await validateSession(token)) {
    return next();
  }
  res.status(401).json({ error: "Unauthorized", msg: "Invalid or expired session" });
}

// --- Auth Endpoints ---

// Get current user details
app.get("/auth/v1/user", authRequired, (req, res) => {
  res.json(req.user);
});

// Sign up (master password initialization)
app.post("/auth/v1/signup", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: "Bad Request", msg: "Email and password required" });
  }

  const existingCount = await getUserCount();
  if (existingCount > 0) {
    return res.status(400).json({
      error: "Signup Disabled",
      msg: "Setup already completed. Please log in using your existing password.",
    });
  }

  const userId = crypto.randomUUID();
  const { salt, hash } = hashPassword(password);

  try {
    await dbRun(
      "INSERT INTO users (id, email, password_hash, salt) VALUES (?, ?, ?, ?)",
      [userId, email, hash, salt]
    );

    const token = await createSession(userId);
    res.json({
      access_token: token,
      refresh_token: "refresh-" + token,
      expires_in: 3600 * 24 * 30, // 30 days
      user: { id: userId, email },
    });
  } catch (err) {
    res.status(500).json({ error: "Internal Error", msg: err.message });
  }
});

// Sign in
app.post("/auth/v1/token", async (req, res) => {
  const { email, password } = req.body;
  const grantType = req.query.grant_type;

  if (grantType === "refresh_token") {
    // For single-user local setups, we just echo back success if they have a session
    const authHeader = req.headers.authorization || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.substring(7) : null;
    const user = await validateSession(token);
    if (!user) {
      return res.status(401).json({ error: "Unauthorized", msg: "Invalid token" });
    }
    return res.json({
      access_token: token,
      refresh_token: "refresh-" + token,
      expires_in: 3600 * 24 * 30,
      user,
    });
  }

  if (!email || !password) {
    return res.status(400).json({ error: "Bad Request", msg: "Email and password required" });
  }

  const user = await dbGet("SELECT * FROM users LIMIT 1");
  if (!user || !verifyPassword(password, user.salt, user.password_hash)) {
    return res.status(400).json({ error: "Invalid Credentials", msg: "Incorrect password" });
  }

  try {
    const token = await createSession(user.id);
    res.json({
      access_token: token,
      refresh_token: "refresh-" + token,
      expires_in: 3600 * 24 * 30,
      user: { id: user.id, email: user.email },
    });
  } catch (err) {
    res.status(500).json({ error: "Internal Error", msg: err.message });
  }
});

// Update/change password
app.put("/auth/v1/user", authRequired, async (req, res) => {
  const { password } = req.body;
  if (!password) {
    return res.status(400).json({ error: "Invalid Password", msg: "Password is required" });
  }

  try {
    await changeUserPassword(req.user.id, password);
    // Create new session token for the user so they stay logged in
    const token = await createSession(req.user.id);
    res.json({
      access_token: token,
      msg: "Password updated successfully",
      user: req.user,
    });
  } catch (err) {
    res.status(500).json({ error: "Internal Error", msg: err.message });
  }
});

// Delete all database records (wipe self-hosted database)
app.post("/auth/v1/delete-all-data", authRequired, async (req, res) => {
  try {
    const userId = req.user.id;
    await dbRun("DELETE FROM bookmarks WHERE user_id = ?", [userId]);
    await dbRun("DELETE FROM projects WHERE user_id = ?", [userId]);
    await dbRun("DELETE FROM rss_feeds WHERE user_id = ?", [userId]);
    await dbRun("DELETE FROM user_settings WHERE user_id = ?", [userId]);
    await dbRun("DELETE FROM sessions WHERE user_id = ?", [userId]);
    await dbRun("DELETE FROM users WHERE id = ?", [userId]);
    res.json({ msg: "All database data deleted successfully" });
  } catch (err) {
    res.status(500).json({ error: "Database Error", msg: err.message });
  }
});

// --- REST DB Endpoints ---

const VALID_TABLES = ["bookmarks", "projects", "rss_feeds", "user_settings"];

// Query records (PostgREST style)
app.get("/rest/v1/:table", authRequired, async (req, res) => {
  const { table } = req.params;
  if (!VALID_TABLES.includes(table)) {
    return res.status(404).json({ error: "Not Found" });
  }

  const since = req.query.updated_at ? req.query.updated_at.replace("gt.", "") : null;

  try {
    let sql = `SELECT * FROM ${table} WHERE user_id = ?`;
    const params = [req.user.id];

    if (since) {
      sql += " AND updated_at > ?";
      params.push(decodeURIComponent(since));
    }

    sql += " ORDER BY updated_at ASC";

    const rows = await dbAll(sql, params);
    const formatted = rows.map((r) => formatRowFromDb(table, r));
    res.json(formatted);
  } catch (err) {
    res.status(500).json({ error: "Database Error", msg: err.message });
  }
});

// Upsert records (PostgREST style)
app.post("/rest/v1/:table", authRequired, async (req, res) => {
  const { table } = req.params;
  if (!VALID_TABLES.includes(table)) {
    return res.status(404).json({ error: "Not Found" });
  }

  const rawRows = Array.isArray(req.body) ? req.body : [req.body];
  const upsertedRows = [];

  try {
    for (const rawRow of rawRows) {
      // Force active user ID mapping
      const row = { ...rawRow, user_id: req.user.id };
      const formattedRow = formatRowForDb(table, row);

      const keys = Object.keys(formattedRow);
      const placeholders = keys.map(() => "?").join(", ");
      const conflictKeys = table === "user_settings" ? ["user_id"] : ["id", "user_id"];
      const updateCols = keys.filter((k) => !conflictKeys.includes(k));
      const updateClause = updateCols.map((c) => `${c}=excluded.${c}`).join(", ");

      const sql = `
        INSERT INTO ${table} (${keys.join(", ")})
        VALUES (${placeholders})
        ON CONFLICT(${conflictKeys.join(", ")})
        DO UPDATE SET ${updateClause}
      `;

      const params = Object.values(formattedRow);
      await dbRun(sql, params);

      const parsedRow = formatRowFromDb(table, formattedRow);
      upsertedRows.push(parsedRow);

      // Broadcast changes to active websocket clients
      broadcastChange(table, parsedRow, req.user.id);
    }

    res.status(201).json(upsertedRows);
  } catch (err) {
    res.status(500).json({ error: "Database Error", msg: err.message });
  }
});

// --- Fetch Proxy / Scraper Helper ---
app.post("/functions/v1/fetch-article", fetchArticleAuth, async (req, res) => {
  const { url } = req.body;
  if (!url) {
    return res.status(400).json({ error: "Bad Request", message: "url parameter is required" });
  }

  try {
    const fetchResponse = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      },
    });

    const text = await fetchResponse.text();

    if (!fetchResponse.ok) {
      return res.status(fetchResponse.status).json({
        error: "Fetch Error",
        message: `Target URL returned status ${fetchResponse.status}`,
      });
    }

    res.json({ html: text });
  } catch (err) {
    res.status(500).json({ error: "Fetch Failed", message: err.message });
  }
});

// Create Server
const server = http.createServer(app);

// --- Realtime WebSocket Service ---
const wss = new WebSocketServer({ noServer: true });

// Map to track active client connections
const clients = new Map(); // ws -> { userId, subscribedTables: Set }

server.on("upgrade", (request, socket, head) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  if (url.pathname === "/realtime/v1/websocket") {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  } else {
    socket.destroy();
  }
});

wss.on("connection", (ws) => {
  clients.set(ws, { userId: null, subscribedTables: new Set() });

  ws.on("message", async (messageStr) => {
    try {
      const msg = JSON.parse(messageStr);
      const client = clients.get(ws);

      // Phoenix websocket Join event
      if (msg.event === "phx_join" && msg.topic === "realtime:sync-changes") {
        const token = msg.payload?.apikey || "";
        const user = await validateSession(token);

        if (user) {
          client.userId = user.id;
          // Extract table subscriptions from filters
          const changes = msg.payload?.config?.postgres_changes || [];
          changes.forEach((c) => {
            if (c.table) client.subscribedTables.add(c.table);
          });

          ws.send(
            JSON.stringify({
              topic: "realtime:sync-changes",
              event: "phx_reply",
              payload: { response: {}, status: "ok" },
              ref: msg.ref,
              join_ref: msg.ref,
            })
          );
        } else {
          ws.send(
            JSON.stringify({
              topic: "realtime:sync-changes",
              event: "phx_reply",
              payload: { response: { reason: "Unauthorized" }, status: "error" },
              ref: msg.ref,
              join_ref: null,
            })
          );
        }
      }

      // Phoenix Heartbeat
      if (msg.event === "heartbeat" && msg.topic === "phoenix") {
        ws.send(
          JSON.stringify({
            topic: "phoenix",
            event: "phx_reply",
            payload: { response: {}, status: "ok" },
            ref: msg.ref,
            join_ref: null,
          })
        );
      }
    } catch (e) {
      console.error("WS Message Error:", e);
    }
  });

  ws.on("close", () => {
    clients.delete(ws);
  });
});

// Broadcast changes to active listeners
function broadcastChange(table, data, userId) {
  const payload = {
    topic: "realtime:sync-changes",
    event: "postgres_changes",
    payload: {
      data: {
        schema: "public",
        table,
        commit_timestamp: new Date().toISOString(),
        eventType: data._deleted ? "DELETE" : "UPDATE",
        new: data,
        old: { id: data.id },
      },
    },
    ref: null,
    join_ref: null,
  };

  const payloadStr = JSON.stringify(payload);

  for (const [ws, client] of clients.entries()) {
    if (
      ws.readyState === ws.OPEN &&
      client.userId === userId &&
      client.subscribedTables.has(table)
    ) {
      ws.send(payloadStr);
    }
  }
}

// Start Server
async function start() {
  await initDb();
  server.listen(PORT, () => {
    console.log(`===================================================`);
    console.log(`Commonplace Self-Hosted Server running on port ${PORT}`);
    console.log(`Open http://localhost:${PORT} in your browser`);
    console.log(`===================================================`);
  });
}

start().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
