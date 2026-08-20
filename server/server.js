import express from "express";
import { WebSocketServer } from "ws";
import http from "http";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import crypto from "crypto";
import Parser from "rss-parser";

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
import { triggerServerExport } from "./exporter.js";

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

// --- Background RSS Scraper & Scheduler ---
const activeScraperTimers = new Map();

async function runRssScrapingJob(userId) {
  console.log(`Running background RSS scraping job for user ${userId}...`);
  const parser = new Parser({
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    }
  });

  try {
    const config = await dbGet("SELECT rss_retention FROM server_configs WHERE user_id = ?", [userId]);
    const retentionDays = config ? Number(config.rss_retention) : 30;

    const feeds = await dbAll("SELECT * FROM rss_feeds WHERE user_id = ? AND _deleted = 0", [userId]);
    const bookmarkedRows = await dbAll("SELECT url FROM bookmarks WHERE user_id = ? AND _deleted = 0", [userId]);
    const bookmarkedUrls = new Set(bookmarkedRows.map(r => r.url).filter(Boolean));

    const now = new Date();

    for (const feed of feeds) {
      try {
        console.log(`Scraping RSS feed: ${feed.feed_url}`);
        const parsedFeed = await parser.parseURL(feed.feed_url);
        
        let existingItems = [];
        try {
          existingItems = JSON.parse(feed.items || "[]");
        } catch (e) {
          existingItems = [];
        }

        const itemMap = new Map(existingItems.map(item => [item.url || item.id, item]));

        const newItems = (parsedFeed.items || []).map((item, idx) => {
          const itemUrl = item.link || item.guid || "";
          const pubDateStr = item.pubDate || item.isoDate || new Date().toISOString();
          
          let excerpt = item.contentSnippet || item.summary || "";
          if (excerpt) {
            excerpt = excerpt.replace(/<[^>]*>/g, "").substring(0, 200).trim();
          }

          return {
            id: item.guid || item.link || `item-${feed.id}-${Date.now()}-${idx}`,
            url: itemUrl,
            title: item.title || "Untitled Article",
            excerpt: excerpt,
            pubDate: pubDateStr,
            author: item.creator || item.author || "",
            thumbnail: item.enclosure?.url || ""
          };
        });

        for (const item of newItems) {
          itemMap.set(item.url || item.id, item);
        }

        let mergedItems = Array.from(itemMap.values());
        if (retentionDays > 0) {
          const cutoffMs = now.getTime() - (retentionDays * 24 * 3600 * 1000);
          mergedItems = mergedItems.filter(item => {
            if (bookmarkedUrls.has(item.url)) return true;
            let pubTime = 0;
            try {
              pubTime = new Date(item.pubDate).getTime();
            } catch {
              pubTime = now.getTime();
            }
            return pubTime >= cutoffMs;
          });
        }

        mergedItems.sort((a, b) => new Date(b.pubDate).getTime() - new Date(a.pubDate).getTime());

        const itemsJson = JSON.stringify(mergedItems);
        const updateTime = new Date().toISOString();
        
        await dbRun(
          `UPDATE rss_feeds 
           SET items = ?, last_fetched_at = ?, updated_at = ? 
           WHERE id = ? AND user_id = ?`,
          [itemsJson, updateTime, updateTime, feed.id, userId]
        );

        broadcastChange("rss_feeds", {
          id: feed.id,
          user_id: userId,
          feed_url: feed.feed_url,
          title: feed.title || parsedFeed.title,
          folder: feed.folder || "",
          items: mergedItems,
          last_fetched_at: updateTime,
          updated_at: updateTime,
          _deleted: false
        }, userId);

        console.log(`Successfully synced RSS feed ${feed.title || feed.feed_url} (${mergedItems.length} items kept)`);
      } catch (err) {
        console.error(`Failed to scrape RSS feed ${feed.feed_url}:`, err.message);
      }
    }
  } catch (err) {
    console.error("Failed to run RSS scraping job:", err.message);
  }
}

async function rescheduleRssScraper(userId, intervalHours) {
  if (activeScraperTimers.has(userId)) {
    clearInterval(activeScraperTimers.get(userId));
    activeScraperTimers.delete(userId);
  }

  if (intervalHours <= 0) {
    console.log(`Background RSS scraping disabled for user ${userId}`);
    return;
  }

  console.log(`Scheduling background RSS scraping for user ${userId} every ${intervalHours} hours`);
  
  const timer = setInterval(async () => {
    await runRssScrapingJob(userId);
  }, intervalHours * 3600 * 1000);

  activeScraperTimers.set(userId, timer);

  // Run once immediately in the background
  setTimeout(async () => {
    await runRssScrapingJob(userId);
  }, 1000);
}

async function initStartupSchedulers() {
  try {
    const users = await dbAll("SELECT id FROM users");
    for (const user of users) {
      const config = await dbGet("SELECT rss_interval FROM server_configs WHERE user_id = ?", [user.id]);
      const interval = config ? Number(config.rss_interval) : 3;
      await rescheduleRssScraper(user.id, interval);
    }
  } catch (err) {
    console.error("Failed to initialize startup background schedulers:", err);
  }
}

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

// Get server configuration
app.get("/auth/v1/server-config", authRequired, async (req, res) => {
  try {
    const userId = req.user.id;
    const config = await dbGet("SELECT * FROM server_configs WHERE user_id = ?", [userId]);
    if (!config) {
      return res.json({
        export_path: "",
        auto_export: 0,
        rss_interval: 3,
        rss_retention: 30
      });
    }
    res.json({
      export_path: config.export_path || "",
      auto_export: Boolean(config.auto_export),
      rss_interval: Number(config.rss_interval),
      rss_retention: Number(config.rss_retention)
    });
  } catch (err) {
    res.status(500).json({ error: "Database Error", msg: err.message });
  }
});

// Update server configuration
app.post("/auth/v1/server-config", authRequired, async (req, res) => {
  const { export_path, auto_export, rss_interval, rss_retention } = req.body;
  try {
    const userId = req.user.id;
    const autoExportVal = auto_export ? 1 : 0;
    const now = new Date().toISOString();
    
    await dbRun(
      `INSERT OR REPLACE INTO server_configs 
       (user_id, export_path, auto_export, rss_interval, rss_retention, updated_at) 
       VALUES (?, ?, ?, ?, ?, ?)`,
      [userId, export_path || "", autoExportVal, Number(rss_interval), Number(rss_retention), now]
    );

    // Reschedule the RSS background scraping process if the interval changed
    await rescheduleRssScraper(userId, Number(rss_interval));

    res.json({ msg: "Server configuration updated successfully" });
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

      // Server-side filesystem Markdown export trigger
      if (table === "bookmarks" || table === "projects") {
        triggerServerExport(req.user.id, table, parsedRow).catch((err) => {
          console.error("Auto-export failed:", err.message);
        });
      }
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
  await initStartupSchedulers();
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
