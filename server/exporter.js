import fs from "fs";
import path from "path";
import { dbGet } from "./db.js";

// Helper utilities matching client-side formatting exactly
function slugify(val) {
  return String(val || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function sanitizeFileName(val) {
  return String(val || "")
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 90);
}

function toYamlValue(value) {
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value) || (value && typeof value === "object")) {
    return `'${JSON.stringify(value).replaceAll("'", "''")}'`;
  }
  return `'${String(value || "").replaceAll("'", "''")}'`;
}

function buildMarkdown(frontmatter, body) {
  const lines = ["---"];
  for (const [key, value] of Object.entries(frontmatter)) {
    lines.push(`${key}: ${toYamlValue(value)}`);
  }
  lines.push("---", "", body || "");
  return lines.join("\n");
}

/**
 * Automatically export a single item (bookmark or project) to the configured local server directory
 */
export async function triggerServerExport(userId, table, item) {
  try {
    // 1. Check server configuration
    const config = await dbGet("SELECT export_path, auto_export FROM server_configs WHERE user_id = ?", [userId]);
    if (!config || !config.auto_export || !config.export_path) {
      return;
    }

    const baseDir = config.export_path.trim();
    if (!fs.existsSync(baseDir)) {
      console.warn(`Export directory does not exist: ${baseDir}. Skipping auto-export.`);
      return;
    }

    // Determine subfolder (library/ or projects/)
    const subfolderName = table === "bookmarks" ? "library" : "projects";
    const targetDir = path.join(baseDir, subfolderName);
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }

    // Determine filename
    let fileName = "";
    if (table === "bookmarks") {
      const title = item.title || "Untitled";
      fileName = `${sanitizeFileName(item.id || "article")}-${sanitizeFileName(slugify(title) || "article")}.md`;
    } else if (table === "projects") {
      const name = item.name || "Untitled project";
      fileName = `${sanitizeFileName(item.id || "project")}-${sanitizeFileName(slugify(name) || "project")}.md`;
    }

    const filePath = path.join(targetDir, fileName);

    // 2. Handle Deletion
    if (item._deleted) {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        console.log(`Deleted exported Markdown file: ${filePath}`);
      }
      return;
    }

    // 3. Format Content
    let content = "";
    if (table === "bookmarks") {
      // Parse highlights/tags/project_ids if they are strings
      const tags = typeof item.tags === "string" ? JSON.parse(item.tags || "[]") : (item.tags || []);
      const projectIds = typeof item.project_ids === "string" ? JSON.parse(item.project_ids || "[]") : (item.project_ids || []);
      const highlights = typeof item.highlights === "string" ? JSON.parse(item.highlights || "[]") : (item.highlights || []);

      const frontmatter = {
        type: "library",
        id: String(item.id || ""),
        title: String(item.title || "Untitled"),
        url: String(item.url || ""),
        source: String(item.source || ""),
        publishedAt: String(item.published_at || ""),
        createdAt: String(item.created_at || ""),
        updatedAt: String(item.updated_at || ""),
        lastOpenedAt: String(item.last_opened_at || ""),
        imageUrl: String(item.image_url || ""),
        tags,
        projectIds,
        highlights,
      };

      const bodyText = String(item.description || "").trim();
      content = buildMarkdown(frontmatter, bodyText);
    } else if (table === "projects") {
      const articleIds = typeof item.article_ids === "string" ? JSON.parse(item.article_ids || "[]") : (item.article_ids || []);
      
      const frontmatter = {
        type: "project",
        id: String(item.id || ""),
        name: String(item.name || "Untitled project"),
        stage: String(item.stage || "idea"),
        articleIds,
        createdAt: String(item.created_at || ""),
        updatedAt: String(item.updated_at || ""),
        lastOpenedAt: String(item.last_opened_at || ""),
      };

      const bodyText = String(item.content || item.description || "").trim();
      content = buildMarkdown(frontmatter, bodyText);
    }

    // Write file to filesystem
    fs.writeFileSync(filePath, content, "utf8");
    console.log(`Auto-exported Markdown note: ${filePath}`);
  } catch (err) {
    console.error(`Failed to export item to server filesystem:`, err.message);
  }
}
