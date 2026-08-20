import crypto from "crypto";
import { dbRun, dbGet } from "./db.js";

// Hash password with PBKDF2
export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.pbkdf2Sync(password, salt, 10000, 64, "sha512").toString("hex");
  return { salt, hash };
}

// Verify password with stored PBKDF2 salt/hash
export function verifyPassword(password, salt, storedHash) {
  const hash = crypto.pbkdf2Sync(password, salt, 10000, 64, "sha512").toString("hex");
  return hash === storedHash;
}

// Create new session token stored in SQLite database
export async function createSession(userId) {
  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(); // 30 days
  await dbRun("INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)", [token, userId, expiresAt]);
  return token;
}

// Retrieve user for valid session token
export async function validateSession(token) {
  if (!token) return null;
  const session = await dbGet(
    "SELECT * FROM sessions WHERE token = ? AND datetime(expires_at) > datetime('now')",
    [token]
  );
  if (!session) return null;
  const user = await dbGet("SELECT id, email FROM users WHERE id = ?", [session.user_id]);
  return user;
}

// Destroy a session token
export async function deleteSession(token) {
  await dbRun("DELETE FROM sessions WHERE token = ?", [token]);
}

// Change user password and invalidate active sessions
export async function changeUserPassword(userId, newPassword) {
  const { salt, hash } = hashPassword(newPassword);
  await dbRun("UPDATE users SET password_hash = ?, salt = ? WHERE id = ?", [hash, salt, userId]);
  await dbRun("DELETE FROM sessions WHERE user_id = ?", [userId]);
}

// Count total users registered (to detect setup/first-run state)
export async function getUserCount() {
  const row = await dbGet("SELECT COUNT(*) as count FROM users");
  return row ? row.count : 0;
}
