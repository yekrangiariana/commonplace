/**
 * Data Transfer Service
 * Handles import/export of bookmarks and projects via clipboard
 */

import { state, touchBookmarks, touchProjects } from "../state.js";
import { persistState } from "../storage.js";
import { getDerivedIndexes } from "../derivedIndexes.js";
import { formatRelativeTime } from "../utils.js";

const EXPORT_VERSION = 1;

// Time filter constants (in milliseconds)
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const TIME_FILTERS = {
  "24h": DAY,
  "3d": 3 * DAY,
  "7d": 7 * DAY,
};

// DOM element references
let dialog = null;
let listEl = null;
let countEl = null;
let selectedIds = new Set();
let currentMode = "export"; // "export" or "import"
let importData = null;
let clipboardReadComplete = false;

/**
 * Initialize the data transfer dialog
 */
export function initDataTransfer() {
  dialog = document.getElementById("data-transfer-dialog");
  if (!dialog) return;

  // Close button
  const closeBtn = dialog.querySelector("[data-close-dialog]");
  closeBtn?.addEventListener("click", closeDialog);

  // Time filter buttons
  dialog.querySelectorAll("[data-time-filter]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const filter = btn.dataset.timeFilter;
      applyTimeFilter(filter);
      updateFilterButtonStates(filter);
    });
  });

  // Select all / none buttons
  dialog.querySelector("[data-select-all]")?.addEventListener("click", () => {
    selectAll();
    updateFilterButtonStates("all");
  });
  dialog.querySelector("[data-select-none]")?.addEventListener("click", selectNone);

  // Export button
  dialog.querySelector("[data-export-action]")?.addEventListener("click", handleExport);

  // Import button (handles both read and import)
  dialog.querySelector("[data-import-action]")?.addEventListener("click", handleImportAction);

  // Close on backdrop click
  dialog.addEventListener("click", (e) => {
    if (e.target === dialog) closeDialog();
  });

  // Close on Escape
  dialog.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeDialog();
  });

  listEl = dialog.querySelector("#data-transfer-list");
  countEl = dialog.querySelector("#data-transfer-count");
}

/**
 * Open the dialog in export mode
 */
export function openExportDialog() {
  currentMode = "export";
  selectedIds.clear();
  importData = null;

  // Show export UI, hide import UI
  dialog.querySelector(".data-transfer-export-view")?.removeAttribute("hidden");
  dialog.querySelector(".data-transfer-import-view")?.setAttribute("hidden", "");
  
  // Show export button, hide import button
  dialog.querySelector("[data-export-action]")?.removeAttribute("hidden");
  dialog.querySelector("[data-import-action]")?.setAttribute("hidden", "");

  // Update header
  dialog.querySelector(".data-transfer-dialog__title").textContent = "Export Bookmarks";

  renderBookmarkList();
  updateSelectionCount();
  updateFilterButtonStates(null);

  dialog.showModal();
}

/**
 * Open the dialog in import mode
 */
export function openImportDialog() {
  currentMode = "import";
  selectedIds.clear();
  importData = null;
  clipboardReadComplete = false;

  // Show import UI, hide export UI
  dialog.querySelector(".data-transfer-export-view")?.setAttribute("hidden", "");
  dialog.querySelector(".data-transfer-import-view")?.removeAttribute("hidden");
  
  // Show import button, hide export button
  dialog.querySelector("[data-export-action]")?.setAttribute("hidden", "");
  dialog.querySelector("[data-import-action]")?.removeAttribute("hidden");
  
  // Reset import button to initial state
  const importBtn = dialog.querySelector("[data-import-action]");
  if (importBtn) {
    importBtn.innerHTML = '<i class="fa-solid fa-clipboard" aria-hidden="true"></i> Read from Clipboard';
  }

  // Update header
  dialog.querySelector(".data-transfer-dialog__title").textContent = "Import Bookmarks";

  // Clear previous import preview
  const previewEl = dialog.querySelector("#data-transfer-import-preview");
  if (previewEl) {
    previewEl.setAttribute("hidden", "");
  }

  const statusEl = dialog.querySelector("#data-transfer-import-status");
  if (statusEl) {
    statusEl.textContent = "";
    statusEl.className = "data-transfer-status";
    statusEl.setAttribute("hidden", "");
  }

  dialog.showModal();
}

/**
 * Close the dialog
 */
function closeDialog() {
  dialog.close();
  selectedIds.clear();
  importData = null;
}

/**
 * Render the list of bookmarks for selection
 */
function renderBookmarkList() {
  if (!listEl) return;

  const bookmarks = [...state.bookmarks].sort(
    (a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0)
  );

  if (bookmarks.length === 0) {
    listEl.innerHTML = `
      <li class="data-transfer-empty">
        <i class="fa-solid fa-inbox" aria-hidden="true"></i>
        <p>No bookmarks to export</p>
      </li>
    `;
    return;
  }

  const { projectNameById } = getDerivedIndexes(state);

  listEl.innerHTML = bookmarks
    .map((bookmark) => {
      const isSelected = selectedIds.has(bookmark.id);
      const projectChips = (bookmark.projectIds || [])
        .map((pid) => projectNameById.get(pid))
        .filter(Boolean)
        .map((name) => `<span class="data-transfer-item__project-chip">${escapeHtml(name)}</span>`)
        .join("");

      const createdAt = bookmark.createdAt ? formatRelativeTime(bookmark.createdAt) : "";
      const source = bookmark.source || extractDomain(bookmark.url) || "";

      return `
        <li class="data-transfer-item ${isSelected ? "is-selected" : ""}" 
            data-bookmark-id="${bookmark.id}">
          <input type="checkbox" 
                 class="data-transfer-item__checkbox" 
                 ${isSelected ? "checked" : ""}
                 aria-label="Select ${escapeHtml(bookmark.title || "Untitled")}">
          <div class="data-transfer-item__content">
            <p class="data-transfer-item__title">${escapeHtml(bookmark.title || "Untitled")}</p>
            <div class="data-transfer-item__meta">
              <span class="data-transfer-item__source">${escapeHtml(source)}</span>
              ${createdAt ? `<span>${createdAt}</span>` : ""}
            </div>
            ${projectChips ? `<div class="data-transfer-item__projects">${projectChips}</div>` : ""}
          </div>
        </li>
      `;
    })
    .join("");

  // Add click handlers
  listEl.querySelectorAll(".data-transfer-item").forEach((item) => {
    item.addEventListener("click", (e) => {
      if (e.target.type === "checkbox") return;
      const id = item.dataset.bookmarkId;
      toggleSelection(id);
    });

    const checkbox = item.querySelector("input[type='checkbox']");
    checkbox?.addEventListener("change", () => {
      const id = item.dataset.bookmarkId;
      toggleSelection(id);
    });
  });
}

/**
 * Toggle selection of a bookmark
 */
function toggleSelection(id) {
  if (selectedIds.has(id)) {
    selectedIds.delete(id);
  } else {
    selectedIds.add(id);
  }
  updateItemUI(id);
  updateSelectionCount();
  updateFilterButtonStates(null);
}

/**
 * Update the UI for a single item
 */
function updateItemUI(id) {
  const item = listEl?.querySelector(`[data-bookmark-id="${id}"]`);
  if (!item) return;

  const isSelected = selectedIds.has(id);
  item.classList.toggle("is-selected", isSelected);
  const checkbox = item.querySelector("input[type='checkbox']");
  if (checkbox) checkbox.checked = isSelected;
}

/**
 * Update the selection count display
 */
function updateSelectionCount() {
  if (!countEl) return;
  const total = state.bookmarks.length;
  const selected = selectedIds.size;
  countEl.innerHTML = `<strong>${selected}</strong> of ${total} selected`;
}

/**
 * Apply a time-based filter
 */
function applyTimeFilter(filterKey) {
  const ms = TIME_FILTERS[filterKey];
  if (!ms) return;

  const cutoff = Date.now() - ms;

  selectedIds.clear();
  state.bookmarks.forEach((bookmark) => {
    const created = new Date(bookmark.createdAt || 0).getTime();
    if (created >= cutoff) {
      selectedIds.add(bookmark.id);
    }
  });

  // Update all item UIs
  listEl?.querySelectorAll(".data-transfer-item").forEach((item) => {
    const id = item.dataset.bookmarkId;
    const isSelected = selectedIds.has(id);
    item.classList.toggle("is-selected", isSelected);
    const checkbox = item.querySelector("input[type='checkbox']");
    if (checkbox) checkbox.checked = isSelected;
  });

  updateSelectionCount();
}

/**
 * Update filter button active states
 */
function updateFilterButtonStates(activeFilter) {
  dialog.querySelectorAll("[data-time-filter]").forEach((btn) => {
    btn.classList.toggle("is-active", btn.dataset.timeFilter === activeFilter);
  });
}

/**
 * Select all bookmarks
 */
function selectAll() {
  state.bookmarks.forEach((b) => selectedIds.add(b.id));
  listEl?.querySelectorAll(".data-transfer-item").forEach((item) => {
    item.classList.add("is-selected");
    const checkbox = item.querySelector("input[type='checkbox']");
    if (checkbox) checkbox.checked = true;
  });
  updateSelectionCount();
  updateFilterButtonStates(null);
}

/**
 * Deselect all bookmarks
 */
function selectNone() {
  selectedIds.clear();
  listEl?.querySelectorAll(".data-transfer-item").forEach((item) => {
    item.classList.remove("is-selected");
    const checkbox = item.querySelector("input[type='checkbox']");
    if (checkbox) checkbox.checked = false;
  });
  updateSelectionCount();
  updateFilterButtonStates(null);
}

/**
 * Handle export action - copy to clipboard
 */
async function handleExport() {
  if (selectedIds.size === 0) {
    showExportStatus("Please select at least one bookmark", "error");
    return;
  }

  const exportPayload = buildExportPayload();
  const json = JSON.stringify(exportPayload, null, 2);

  try {
    await navigator.clipboard.writeText(json);
    showExportStatus(`Copied ${selectedIds.size} bookmarks to clipboard`, "success");
    
    // Auto-close after success
    setTimeout(() => closeDialog(), 1500);
  } catch (err) {
    console.error("Failed to copy to clipboard:", err);
    showExportStatus("Failed to copy to clipboard", "error");
  }
}

/**
 * Build the export payload with selected bookmarks and their projects
 */
function buildExportPayload() {
  const selectedBookmarks = state.bookmarks.filter((b) => selectedIds.has(b.id));

  // Collect all project IDs referenced by selected bookmarks
  const projectIds = new Set();
  selectedBookmarks.forEach((bookmark) => {
    (bookmark.projectIds || []).forEach((pid) => projectIds.add(pid));
  });

  // Get the full project objects
  const relatedProjects = state.projects.filter((p) => projectIds.has(p.id));

  return {
    version: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    bookmarks: selectedBookmarks,
    projects: relatedProjects,
  };
}

/**
 * Show export status message
 */
function showExportStatus(message, type) {
  const statusEl = dialog.querySelector("#data-transfer-export-status");
  if (!statusEl) return;

  statusEl.textContent = message;
  statusEl.className = `data-transfer-status data-transfer-status--${type}`;
  statusEl.removeAttribute("hidden");

  if (type === "error") {
    setTimeout(() => statusEl.setAttribute("hidden", ""), 3000);
  }
}

/**
 * Handle import from clipboard
 */
async function handleImportAction() {
  // If clipboard already read, perform the import
  if (clipboardReadComplete && importData) {
    return executeImport();
  }

  // Otherwise, read from clipboard
  const previewEl = dialog.querySelector("#data-transfer-import-preview");

  try {
    const text = await navigator.clipboard.readText();
    
    if (!text.trim()) {
      showImportStatus("Clipboard is empty", "error");
      return;
    }

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      showImportStatus("Clipboard does not contain valid JSON", "error");
      return;
    }

    // Validate structure
    if (!parsed.bookmarks || !Array.isArray(parsed.bookmarks)) {
      showImportStatus("Invalid export format: missing bookmarks array", "error");
      return;
    }

    importData = parsed;
    clipboardReadComplete = true;

    // Show preview
    const bookmarkCount = parsed.bookmarks.length;
    const projectCount = (parsed.projects || []).length;
    const exportDate = parsed.exportedAt
      ? formatRelativeTime(parsed.exportedAt)
      : "Unknown";

    if (previewEl) {
      previewEl.removeAttribute("hidden");
      previewEl.querySelector(".data-transfer-import-preview__stats").innerHTML = `
        <strong>${bookmarkCount}</strong> bookmark${bookmarkCount !== 1 ? "s" : ""}<br>
        <strong>${projectCount}</strong> project${projectCount !== 1 ? "s" : ""}<br>
        Exported: ${exportDate}
      `;
    }

    // Change button to "Import"
    const importBtn = dialog.querySelector("[data-import-action]");
    if (importBtn) {
      importBtn.innerHTML = '<i class="fa-solid fa-download" aria-hidden="true"></i> Import';
    }

    showImportStatus("Ready to import", "success");
  } catch (err) {
    console.error("Failed to read clipboard:", err);
    showImportStatus("Failed to read clipboard. Make sure you've granted permission.", "error");
  }
}

/**
 * Execute the import (merge logic)
 */
function executeImport() {
  if (!importData) {
    showImportStatus("No data to import", "error");
    return;
  }
  
  let addedBookmarks = 0;
  let updatedBookmarks = 0;
  let addedProjects = 0;

  // Build lookup maps for existing data
  const existingProjectIds = new Set(state.projects.map((p) => p.id));
  const existingProjectNames = new Map(state.projects.map((p) => [p.name.toLowerCase(), p.id]));
  const existingBookmarksByUrl = new Map();
  state.bookmarks.forEach((b) => {
    existingBookmarksByUrl.set(normalizeUrlForComparison(b.url), b);
  });

  // Import projects first (and build ID mapping for renamed projects)
  const projectIdMapping = new Map(); // maps imported project ID to actual ID
  
  (importData.projects || []).forEach((project) => {
    // If project ID already exists, just map it
    if (existingProjectIds.has(project.id)) {
      projectIdMapping.set(project.id, project.id);
      return;
    }
    
    // If project name exists (case insensitive), map to existing project
    const existingIdByName = existingProjectNames.get(project.name.toLowerCase());
    if (existingIdByName) {
      projectIdMapping.set(project.id, existingIdByName);
      return;
    }

    // New project - add it
    state.projects.push({ ...project });
    existingProjectIds.add(project.id);
    existingProjectNames.set(project.name.toLowerCase(), project.id);
    projectIdMapping.set(project.id, project.id);
    addedProjects++;
  });

  // Import bookmarks
  (importData.bookmarks || []).forEach((importedBookmark) => {
    const normalizedUrl = normalizeUrlForComparison(importedBookmark.url);
    const existingBookmark = existingBookmarksByUrl.get(normalizedUrl);

    if (existingBookmark) {
      // Merge into existing bookmark
      let updated = false;

      // Merge highlights (add new ones by ID)
      if (importedBookmark.highlights?.length) {
        const existingHighlightIds = new Set((existingBookmark.highlights || []).map((h) => h.id));
        const newHighlights = importedBookmark.highlights.filter((h) => !existingHighlightIds.has(h.id));
        if (newHighlights.length > 0) {
          existingBookmark.highlights = [...(existingBookmark.highlights || []), ...newHighlights];
          updated = true;
        }
      }

      // Merge project associations (map IDs and add new ones)
      if (importedBookmark.projectIds?.length) {
        const existingProjIds = new Set(existingBookmark.projectIds || []);
        const mappedProjectIds = importedBookmark.projectIds
          .map((pid) => projectIdMapping.get(pid) || pid)
          .filter((pid) => !existingProjIds.has(pid));
        if (mappedProjectIds.length > 0) {
          existingBookmark.projectIds = [...(existingBookmark.projectIds || []), ...mappedProjectIds];
          updated = true;
        }
      }

      // Merge tags (add new ones)
      if (importedBookmark.tags?.length) {
        const existingTags = new Set((existingBookmark.tags || []).map((t) => t.toLowerCase()));
        const newTags = importedBookmark.tags.filter((t) => !existingTags.has(t.toLowerCase()));
        if (newTags.length > 0) {
          existingBookmark.tags = [...(existingBookmark.tags || []), ...newTags];
          updated = true;
        }
      }

      if (updated) {
        updatedBookmarks++;
      }
    } else {
      // New bookmark - add it with mapped project IDs
      const newBookmark = { ...importedBookmark };
      
      // Remap project IDs to existing projects if needed
      if (newBookmark.projectIds?.length) {
        newBookmark.projectIds = newBookmark.projectIds.map((pid) => projectIdMapping.get(pid) || pid);
      }

      // Generate new ID if collision
      const existingIds = new Set(state.bookmarks.map((b) => b.id));
      if (existingIds.has(newBookmark.id)) {
        newBookmark.id = `article-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
      }

      state.bookmarks.push(newBookmark);
      existingBookmarksByUrl.set(normalizedUrl, newBookmark);
      addedBookmarks++;
    }
  });

  // Mark state as dirty and persist
  if (addedBookmarks > 0 || updatedBookmarks > 0) touchBookmarks(state);
  if (addedProjects > 0) touchProjects(state);
  persistState(state);

  // Show success message
  const parts = [];
  if (addedBookmarks > 0) {
    parts.push(`${addedBookmarks} new bookmark${addedBookmarks !== 1 ? "s" : ""}`);
  }
  if (updatedBookmarks > 0) {
    parts.push(`${updatedBookmarks} updated`);
  }
  if (addedProjects > 0) {
    parts.push(`${addedProjects} project${addedProjects !== 1 ? "s" : ""}`);
  }
  const message = parts.length > 0 ? `Imported: ${parts.join(", ")}` : "Nothing new to import";

  showImportStatus(message, "success");
  importData = null;
  clipboardReadComplete = false;

  // Dispatch event to refresh UI
  window.dispatchEvent(new CustomEvent("dataTransferImportComplete"));

  // Auto-close after success
  setTimeout(() => closeDialog(), 2000);
}

/**
 * Show import status message
 */
function showImportStatus(message, type) {
  const statusEl = dialog.querySelector("#data-transfer-import-status");
  if (!statusEl) return;

  statusEl.textContent = message;
  statusEl.className = `data-transfer-status data-transfer-status--${type}`;
  statusEl.removeAttribute("hidden");
}

/**
 * Normalize URL for comparison (remove trailing slashes, protocol variations)
 */
function normalizeUrlForComparison(url) {
  if (!url) return "";
  try {
    const u = new URL(url);
    return `${u.hostname}${u.pathname.replace(/\/$/, "")}${u.search}`;
  } catch {
    return url.toLowerCase().replace(/\/$/, "");
  }
}

/**
 * Extract domain from URL
 */
function extractDomain(url) {
  if (!url) return "";
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/**
 * Escape HTML entities
 */
function escapeHtml(text) {
  if (!text) return "";
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
