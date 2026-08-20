import sqlite3 from "sqlite3";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_DIR = path.join(__dirname, "..", "data");
const DB_PATH = path.join(DB_DIR, "commonplace.db");

// Ensure data directory exists
if (!fs.existsSync(DB_DIR)) {
  fs.mkdirSync(DB_DIR, { recursive: true });
}

// Initialize database connection
const db = new sqlite3.Database(DB_PATH);

// Helper to run query with promise wrapper
export function dbRun(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

// Helper to get single row
export function dbGet(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

// Helper to get multiple rows
export function dbAll(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

// Format SQLite types to JSON-friendly data
export function formatRowFromDb(table, row) {
  if (!row) return row;
  const parsed = { ...row };
  
  if (row._deleted !== undefined) {
    parsed._deleted = Boolean(row._deleted);
  }

  try {
    if (table === "bookmarks") {
      if (typeof row.blocks === "string") parsed.blocks = JSON.parse(row.blocks || "[]");
      if (typeof row.tags === "string") parsed.tags = JSON.parse(row.tags || "[]");
      if (typeof row.project_ids === "string") parsed.project_ids = JSON.parse(row.project_ids || "[]");
      if (typeof row.highlights === "string") parsed.highlights = JSON.parse(row.highlights || "[]");
    } else if (table === "rss_feeds") {
      if (typeof row.items === "string") parsed.items = JSON.parse(row.items || "[]");
    } else if (table === "user_settings") {
      if (typeof row.settings === "string") parsed.settings = JSON.parse(row.settings || "{}");
    }
  } catch (e) {
    console.error(`Error parsing JSON fields for table ${table}:`, e);
  }

  return parsed;
}

// Format JSON-friendly data to SQLite types
export function formatRowForDb(table, row) {
  const formatted = { ...row };
  
  if (row._deleted !== undefined) {
    formatted._deleted = row._deleted ? 1 : 0;
  }

  if (table === "bookmarks") {
    if (row.blocks !== undefined) formatted.blocks = JSON.stringify(row.blocks || []);
    if (row.tags !== undefined) formatted.tags = JSON.stringify(row.tags || []);
    if (row.project_ids !== undefined) formatted.project_ids = JSON.stringify(row.project_ids || []);
    if (row.highlights !== undefined) formatted.highlights = JSON.stringify(row.highlights || []);
  } else if (table === "rss_feeds") {
    if (row.items !== undefined) formatted.items = JSON.stringify(row.items || []);
  } else if (table === "user_settings") {
    if (row.settings !== undefined) formatted.settings = JSON.stringify(row.settings || {});
  }

  return formatted;
}

// Initialize tables
export async function initDb() {
  // 1. Users Table (Local Auth)
  await dbRun(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      salt TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // 2. User Sessions
  await dbRun(`
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  // 3. Bookmarks
  await dbRun(`
    CREATE TABLE IF NOT EXISTS bookmarks (
      id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      title TEXT,
      url TEXT,
      description TEXT,
      source TEXT,
      published_at TEXT,
      preview_text TEXT,
      image_url TEXT,
      fetched_at TEXT,
      created_at TEXT,
      tweet_html TEXT,
      blocks TEXT,
      tags TEXT,
      project_ids TEXT,
      highlights TEXT,
      last_opened_at TEXT,
      updated_at TEXT,
      _deleted INTEGER DEFAULT 0,
      PRIMARY KEY (id, user_id),
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  // 4. Projects
  await dbRun(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      name TEXT,
      description TEXT,
      content TEXT,
      stage TEXT,
      created_at TEXT,
      last_opened_at TEXT,
      updated_at TEXT,
      _deleted INTEGER DEFAULT 0,
      PRIMARY KEY (id, user_id),
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  // 5. RSS Feeds
  await dbRun(`
    CREATE TABLE IF NOT EXISTS rss_feeds (
      id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      feed_url TEXT,
      title TEXT,
      folder TEXT,
      items TEXT,
      last_fetched_at TEXT,
      updated_at TEXT,
      _deleted INTEGER DEFAULT 0,
      PRIMARY KEY (id, user_id),
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  // 6. User Settings
  await dbRun(`
    CREATE TABLE IF NOT EXISTS user_settings (
      user_id TEXT PRIMARY KEY,
      settings TEXT,
      updated_at TEXT,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  // Indexes for sync lookup performance
  await dbRun(`CREATE INDEX IF NOT EXISTS idx_bookmarks_user_updated ON bookmarks (user_id, updated_at)`);
  await dbRun(`CREATE INDEX IF NOT EXISTS idx_projects_user_updated ON projects (user_id, updated_at)`);
  await dbRun(`CREATE INDEX IF NOT EXISTS idx_rss_feeds_user_updated ON rss_feeds (user_id, updated_at)`);
}
