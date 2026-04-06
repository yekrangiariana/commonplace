/**
 * Command Actions – Alfred-style action commands for the search palette.
 *
 * These are *verb* commands ("Add article", "Export data", …) as opposed to
 * the navigation commands already in search.js ("Go to Library", etc.).
 *
 * Usage:
 *   1. Call `initCommandActions({ openAddModal, … })` once during app init.
 *   2. Import `ACTION_COMMANDS` in search.js and merge with SEARCH_COMMANDS.
 *   3. Import `executeActionCommand` in search.js to handle selection.
 */

import { state } from "../state.js";

// ── Callbacks supplied by main.js via initCommandActions() ────────────────
let _openAddModal = () => {};
let _openExportDialog = () => {};
let _openImportDialog = () => {};
let _openFocusMode = () => {};
let _setStatus = () => {};

/**
 * Provide callbacks that live in main.js so action commands can trigger
 * app-level operations. Call once during app init.
 */
export function initCommandActions({
  openAddModal,
  openExportDialog,
  openImportDialog,
  openFocusMode,
  setStatus,
}) {
  _openAddModal = openAddModal;
  _openExportDialog = openExportDialog;
  _openImportDialog = openImportDialog;
  _openFocusMode = openFocusMode;
  _setStatus = setStatus;
}

// ── Action Commands Registry ──────────────────────────────────────────────
// Same shape as SEARCH_COMMANDS: { id, type, category, title, keywords, icon }
export const ACTION_COMMANDS = [
  // ── Create / Add ────────────────────────────────────────────────────────
  {
    id: "action:add:article",
    type: "command",
    category: "Add",
    title: "Add article",
    keywords: "add new article save link url bookmark web page",
    icon: "fa-link",
  },
  {
    id: "action:add:project",
    type: "command",
    category: "Add",
    title: "New project",
    keywords: "add new create project workspace writing compose",
    icon: "fa-folder-plus",
  },
  {
    id: "action:add:feed",
    type: "command",
    category: "Add",
    title: "Subscribe to feed",
    keywords: "add new rss feed subscribe source news",
    icon: "fa-rss",
  },
  {
    id: "action:add:tweet",
    type: "command",
    category: "Add",
    title: "Save tweet",
    keywords: "add new tweet x twitter save post",
    icon: "fa-feather",
  },

  // ── Quick actions ───────────────────────────────────────────────────────
  {
    id: "action:focus-mode",
    type: "command",
    category: "Actions",
    title: "Focus mode",
    keywords: "focus mode reading fullscreen distraction free immersive reader",
    icon: "fa-expand",
  },
  {
    id: "action:export-data",
    type: "command",
    category: "Actions",
    title: "Export data",
    keywords: "export data backup download clipboard",
    icon: "fa-download",
  },
  {
    id: "action:import-data",
    type: "command",
    category: "Actions",
    title: "Import data",
    keywords: "import data restore upload clipboard",
    icon: "fa-upload",
  },
  {
    id: "action:copy-highlights",
    type: "command",
    category: "Actions",
    title: "Copy highlights",
    keywords: "copy highlights export quotes annotations clipboard",
    icon: "fa-highlighter",
  },
];

/**
 * Execute an action command by ID. Returns true if the command was handled.
 * @param {string} commandId
 * @returns {boolean}
 */
export async function executeActionCommand(commandId) {
  switch (commandId) {
    // Add / Create
    case "action:add:article":
      _openAddModal("article");
      return true;
    case "action:add:project":
      _openAddModal("project");
      return true;
    case "action:add:feed":
      _openAddModal("feed");
      return true;
    case "action:add:tweet":
      _openAddModal("tweet");
      return true;

    // Quick actions
    case "action:focus-mode":
      _openFocusMode();
      return true;
    case "action:export-data":
      _openExportDialog();
      return true;
    case "action:import-data":
      _openImportDialog();
      return true;
    case "action:copy-highlights":
      // If currently reading an article, copy its highlights directly
      if (state.activeTab === "reader" && state.selectedArticleId) {
        await copyArticleHighlightsById(state.selectedArticleId);
        return true;
      }
      // Otherwise signal the caller to enter picker mode
      return "pick-highlights";

    default:
      return false;
  }
}

// ── Highlight helpers ─────────────────────────────────────────────────────

/**
 * Copy an article's highlights to the clipboard, sorted by position.
 * Exported so search.js can call it from the picker flow.
 * @param {string} articleId
 * @returns {Promise<boolean>} true if highlights were copied
 */
export async function copyArticleHighlightsById(articleId) {
  const article = state.bookmarks.find((b) => b.id === articleId);
  if (!article?.highlights?.length) {
    _setStatus("No highlights to copy for this article.");
    return false;
  }
  const text = article.highlights
    .slice()
    .sort((a, b) => a.start - b.start)
    .map((h) => h.quote)
    .join("\n\n");
  await navigator.clipboard.writeText(text);
  _setStatus("Copied highlights to clipboard.");
  return true;
}

/**
 * Return bookmarks that have at least one highlight, optionally filtered
 * by a search query against their title.
 * @param {string} [query]
 * @returns {Array<{id:string, title:string, count:number, _lowerTitle:string}>}
 */
export function getBookmarksWithHighlights() {
  const out = [];
  for (const b of state.bookmarks) {
    if (b.highlights && b.highlights.length > 0) {
      const title = b.title || "Untitled";
      out.push({
        id: b.id,
        title,
        count: b.highlights.length,
        _lowerTitle: title.toLowerCase(),
      });
    }
  }
  return out;
}
