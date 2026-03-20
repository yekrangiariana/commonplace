import { flattenBlocks } from "../utils.js";

const EXPORT_FOLDER_NAME_DEFAULT = "Commonplace";
const LIBRARY_DIR_NAME = "library";
const PROJECTS_DIR_NAME = "projects";
const MANIFEST_FILE_NAME = ".bookmark-manager-export-index.json";
const MANIFEST_VERSION = 1;
const EXPORT_DB_NAME = "bookmark-manager-db";
const EXPORT_DB_VERSION = 5;  // Must match IDB_DB_VERSION in storage.js
const EXPORT_KV_STORE = "kv";
const EXPORT_HANDLE_KEY = "markdownExportRootHandle";

export function isMarkdownFolderExportSupported() {
  return typeof window.showDirectoryPicker === "function";
}

export async function exportMarkdownToFolder(state, options = {}) {
  if (!isMarkdownFolderExportSupported()) {
    throw new Error("Folder export is only supported in Chromium browsers.");
  }

  const appFolderName = String(
    options.appFolderName || EXPORT_FOLDER_NAME_DEFAULT,
  ).trim();

  if (!appFolderName) {
    throw new Error("App folder name is required.");
  }

  const onProgress =
    typeof options.onProgress === "function" ? options.onProgress : null;

  onProgress?.({ stage: "pick-folder" });

  const parentDir = await window.showDirectoryPicker({ mode: "readwrite" });
  const rootDir = await parentDir.getDirectoryHandle(appFolderName, {
    create: true,
  });

  await saveRootDirectoryHandle(rootDir);

  return exportMarkdownToDirectoryHandle(rootDir, state, { onProgress });
}

export async function exportMarkdownToSavedFolder(state, options = {}) {
  if (!isMarkdownFolderExportSupported()) {
    throw new Error("Folder export is only supported in Chromium browsers.");
  }

  const onProgress =
    typeof options.onProgress === "function" ? options.onProgress : null;
  const requestPermission = options.requestPermission === true;

  const rootDir = await readRootDirectoryHandle();

  if (!rootDir) {
    throw new Error("No export folder linked yet. Pick a folder first.");
  }

  const canWrite = await ensureRootDirectoryWritePermission(rootDir, {
    request: requestPermission,
  });

  if (!canWrite) {
    throw new Error(
      "Folder permission is not granted. Reconnect your export folder.",
    );
  }

  try {
    return await exportMarkdownToDirectoryHandle(rootDir, state, {
      onProgress,
    });
  } catch (error) {
    if (error?.name === "NotFoundError") {
      await clearSavedRootDirectoryHandle();
    }

    throw error;
  }
}

export async function getSavedMarkdownExportStatus(options = {}) {
  const requestPermission = options.requestPermission === true;

  if (!isMarkdownFolderExportSupported()) {
    return {
      isSupported: false,
      hasSavedHandle: false,
      canWrite: false,
      rootFolderName: "",
    };
  }

  const rootDir = await readRootDirectoryHandle();

  if (!rootDir) {
    return {
      isSupported: true,
      hasSavedHandle: false,
      canWrite: false,
      rootFolderName: "",
    };
  }

  const canWrite = await ensureRootDirectoryWritePermission(rootDir, {
    request: requestPermission,
  });

  return {
    isSupported: true,
    hasSavedHandle: true,
    canWrite,
    rootFolderName: rootDir.name || "",
  };
}

async function exportMarkdownToDirectoryHandle(rootDir, state, options = {}) {
  const onProgress =
    typeof options.onProgress === "function" ? options.onProgress : null;

  const libraryDir = await rootDir.getDirectoryHandle(LIBRARY_DIR_NAME, {
    create: true,
  });
  const projectsDir = await rootDir.getDirectoryHandle(PROJECTS_DIR_NAME, {
    create: true,
  });

  const previousManifest = await readManifest(rootDir);

  const desiredLibrary = buildLibraryExportMap(state);
  const desiredProjects = buildProjectsExportMap(state);

  onProgress?.({
    stage: "sync-library",
    total: Object.keys(desiredLibrary).length,
    completed: 0,
  });

  const libraryResult = await syncRecordSet({
    directoryHandle: libraryDir,
    desiredRecords: desiredLibrary,
    previousRecords: previousManifest.library,
    onProgress: (payload) => {
      onProgress?.({ stage: "sync-library", ...payload });
    },
  });

  onProgress?.({
    stage: "sync-projects",
    total: Object.keys(desiredProjects).length,
    completed: 0,
  });

  const projectsResult = await syncRecordSet({
    directoryHandle: projectsDir,
    desiredRecords: desiredProjects,
    previousRecords: previousManifest.projects,
    onProgress: (payload) => {
      onProgress?.({ stage: "sync-projects", ...payload });
    },
  });

  const nextManifest = {
    version: MANIFEST_VERSION,
    exportedAt: new Date().toISOString(),
    library: libraryResult.nextManifest,
    projects: projectsResult.nextManifest,
  };

  await writeManifest(rootDir, nextManifest);

  return {
    rootFolderName: rootDir.name,
    manifestFileName: MANIFEST_FILE_NAME,
    library: {
      total: Object.keys(desiredLibrary).length,
      written: libraryResult.written,
      skipped: libraryResult.skipped,
      deleted: libraryResult.deleted,
    },
    projects: {
      total: Object.keys(desiredProjects).length,
      written: projectsResult.written,
      skipped: projectsResult.skipped,
      deleted: projectsResult.deleted,
    },
  };
}

function buildLibraryExportMap(state) {
  const records = {};

  (state.bookmarks || []).forEach((bookmark) => {
    const frontmatter = {
      type: "library",
      id: String(bookmark.id || ""),
      title: String(bookmark.title || "Untitled"),
      url: String(bookmark.url || ""),
      source: String(bookmark.source || ""),
      publishedAt: String(bookmark.publishedAt || ""),
      createdAt: String(bookmark.createdAt || ""),
      updatedAt: String(bookmark.updatedAt || ""),
      lastOpenedAt: String(bookmark.lastOpenedAt || ""),
      imageUrl: String(bookmark.imageUrl || ""),
      tags: normalizeStringArray(bookmark.tags),
      projectIds: normalizeStringArray(bookmark.projectIds),
      highlights: normalizeHighlights(bookmark.highlights),
    };

    const bodyText = buildBookmarkBodyText(bookmark);
    const content = buildMarkdownWithFrontmatter(frontmatter, bodyText);
    const fileName = `${sanitizeFileName(frontmatter.id || "article")}-${sanitizeFileName(slugify(frontmatter.title) || "article")}.md`;

    records[frontmatter.id] = {
      fileName,
      hash: hashString(content),
      content,
      updatedAt: frontmatter.updatedAt,
    };
  });

  return records;
}

function buildProjectsExportMap(state) {
  const records = {};

  (state.projects || []).forEach((project) => {
    const frontmatter = {
      type: "project",
      id: String(project.id || ""),
      name: String(project.name || "Untitled project"),
      stage: String(project.stage || "idea"),
      articleIds: normalizeStringArray(project.articleIds),
      createdAt: String(project.createdAt || ""),
      updatedAt: String(project.updatedAt || ""),
      lastOpenedAt: String(project.lastOpenedAt || ""),
    };

    const bodyText = String(
      project.content || project.description || "",
    ).trim();
    const content = buildMarkdownWithFrontmatter(frontmatter, bodyText);
    const fileName = `${sanitizeFileName(frontmatter.id || "project")}-${sanitizeFileName(slugify(frontmatter.name) || "project")}.md`;

    records[frontmatter.id] = {
      fileName,
      hash: hashString(content),
      content,
      updatedAt: frontmatter.updatedAt,
    };
  });

  return records;
}

function buildBookmarkBodyText(bookmark) {
  const blocks = Array.isArray(bookmark.blocks) ? bookmark.blocks : [];
  const blockText =
    blocks.length > 0
      ? flattenBlocks(
          blocks.map((block) => ({ text: String(block?.text || "") })),
        )
      : "";
  const description = String(bookmark.description || "").trim();

  return String(blockText || description || "").trim();
}

function normalizeStringArray(values) {
  return [
    ...new Set(
      (Array.isArray(values) ? values : [])
        .map((value) => String(value || "").trim())
        .filter(Boolean),
    ),
  ];
}

function normalizeHighlights(highlights) {
  return (Array.isArray(highlights) ? highlights : [])
    .map((highlight) => ({
      id: String(highlight?.id || ""),
      start: Number.isFinite(Number(highlight?.start))
        ? Number(highlight.start)
        : 0,
      end: Number.isFinite(Number(highlight?.end)) ? Number(highlight.end) : 0,
      quote: String(highlight?.quote || ""),
      createdAt: String(highlight?.createdAt || ""),
    }))
    .filter((highlight) => highlight.quote && highlight.end > highlight.start);
}

function buildMarkdownWithFrontmatter(frontmatter, body) {
  const lines = ["---"];

  Object.entries(frontmatter).forEach(([key, value]) => {
    lines.push(`${key}: ${toYamlValue(value)}`);
  });

  lines.push("---", "", body || "");

  return lines.join("\n");
}

function toYamlValue(value) {
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : "0";
  }

  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }

  if (Array.isArray(value) || (value && typeof value === "object")) {
    return yamlSingleQuoted(JSON.stringify(value));
  }

  return yamlSingleQuoted(String(value || ""));
}

function yamlSingleQuoted(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function sanitizeFileName(value) {
  return String(value || "")
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 90);
}

function hashString(value) {
  let hash = 2166136261;

  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash +=
      (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }

  return (hash >>> 0).toString(16).padStart(8, "0");
}

async function syncRecordSet(options) {
  const directoryHandle = options.directoryHandle;
  const desiredRecords = options.desiredRecords || {};
  const previousRecords = options.previousRecords || {};
  const onProgress =
    typeof options.onProgress === "function" ? options.onProgress : null;

  const nextManifest = {};
  let written = 0;
  let skipped = 0;
  let deleted = 0;
  let completed = 0;

  const desiredEntries = Object.entries(desiredRecords);

  for (const [id, current] of desiredEntries) {
    const previous = previousRecords[id] || null;
    const isUnchanged =
      previous &&
      previous.hash === current.hash &&
      previous.fileName === current.fileName;

    if (isUnchanged) {
      skipped += 1;
    } else {
      await writeTextFile(directoryHandle, current.fileName, current.content);
      written += 1;

      if (previous?.fileName && previous.fileName !== current.fileName) {
        await safeRemoveFile(directoryHandle, previous.fileName);
      }
    }

    nextManifest[id] = {
      fileName: current.fileName,
      hash: current.hash,
      updatedAt: current.updatedAt || "",
    };

    completed += 1;

    if (completed % 100 === 0) {
      onProgress?.({ completed, total: desiredEntries.length });
      await yieldToBrowser();
    }
  }

  const staleIds = Object.keys(previousRecords).filter(
    (id) => !Object.prototype.hasOwnProperty.call(desiredRecords, id),
  );

  for (const id of staleIds) {
    const previous = previousRecords[id];

    if (previous?.fileName) {
      await safeRemoveFile(directoryHandle, previous.fileName);
      deleted += 1;
    }
  }

  onProgress?.({
    completed: desiredEntries.length,
    total: desiredEntries.length,
  });

  return {
    nextManifest,
    written,
    skipped,
    deleted,
  };
}

async function writeTextFile(directoryHandle, fileName, text) {
  const fileHandle = await directoryHandle.getFileHandle(fileName, {
    create: true,
  });
  const writable = await fileHandle.createWritable();

  await writable.write(text);
  await writable.close();
}

async function safeRemoveFile(directoryHandle, fileName) {
  try {
    await directoryHandle.removeEntry(fileName);
  } catch {
    // Ignore missing files.
  }
}

async function readManifest(rootDir) {
  try {
    const fileHandle = await rootDir.getFileHandle(MANIFEST_FILE_NAME);
    const file = await fileHandle.getFile();
    const text = await file.text();
    const parsed = JSON.parse(text);

    return {
      version: Number(parsed?.version) || MANIFEST_VERSION,
      exportedAt: String(parsed?.exportedAt || ""),
      library:
        parsed?.library && typeof parsed.library === "object"
          ? parsed.library
          : {},
      projects:
        parsed?.projects && typeof parsed.projects === "object"
          ? parsed.projects
          : {},
    };
  } catch {
    return {
      version: MANIFEST_VERSION,
      exportedAt: "",
      library: {},
      projects: {},
    };
  }
}

async function writeManifest(rootDir, manifest) {
  await writeTextFile(
    rootDir,
    MANIFEST_FILE_NAME,
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
}

function yieldToBrowser() {
  return new Promise((resolve) => {
    window.setTimeout(resolve, 0);
  });
}

async function openExportDatabase() {
  if (!("indexedDB" in window)) {
    return null;
  }

  return new Promise((resolve) => {
    const request = window.indexedDB.open(EXPORT_DB_NAME, EXPORT_DB_VERSION);

    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
    request.onupgradeneeded = (event) => {
      const db = event.target.result;

      if (!db.objectStoreNames.contains(EXPORT_KV_STORE)) {
        db.createObjectStore(EXPORT_KV_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
  });
}

async function saveRootDirectoryHandle(rootDir) {
  const db = await openExportDatabase();

  if (!db || !db.objectStoreNames.contains(EXPORT_KV_STORE)) {
    return;
  }

  await new Promise((resolve) => {
    const tx = db.transaction([EXPORT_KV_STORE], "readwrite");
    tx.objectStore(EXPORT_KV_STORE).put(rootDir, EXPORT_HANDLE_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
    tx.onabort = () => resolve();
  });
}

async function readRootDirectoryHandle() {
  const db = await openExportDatabase();

  if (!db || !db.objectStoreNames.contains(EXPORT_KV_STORE)) {
    return null;
  }

  return new Promise((resolve) => {
    const tx = db.transaction([EXPORT_KV_STORE], "readonly");
    const request = tx.objectStore(EXPORT_KV_STORE).get(EXPORT_HANDLE_KEY);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => resolve(null);
    tx.onabort = () => resolve(null);
  });
}

async function clearSavedRootDirectoryHandle() {
  const db = await openExportDatabase();

  if (!db || !db.objectStoreNames.contains(EXPORT_KV_STORE)) {
    return;
  }

  await new Promise((resolve) => {
    const tx = db.transaction([EXPORT_KV_STORE], "readwrite");
    tx.objectStore(EXPORT_KV_STORE).delete(EXPORT_HANDLE_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
    tx.onabort = () => resolve();
  });
}

async function ensureRootDirectoryWritePermission(rootDir, options = {}) {
  if (!rootDir) {
    return false;
  }

  if (typeof rootDir.queryPermission !== "function") {
    return true;
  }

  const request = options.request === true;
  const permissionOptions = { mode: "readwrite" };
  const current = await rootDir.queryPermission(permissionOptions);

  if (current === "granted") {
    return true;
  }

  if (!request || typeof rootDir.requestPermission !== "function") {
    return false;
  }

  const next = await rootDir.requestPermission(permissionOptions);
  return next === "granted";
}
