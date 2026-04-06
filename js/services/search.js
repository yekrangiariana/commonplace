/**
 * Search Service - FlexSearch index, command palette, and search UI.
 * Provides unified search across bookmarks, projects, and commands.
 */

import { dom } from "../dom.js";
import { state } from "../state.js";
import { escapeHtml } from "../utils.js";
import { persistState } from "../storage.js";
import { renderSettings } from "../pages/settingsPage.js";
import { renderProjects } from "../pages/projectsPage.js";
import {
  ACTION_COMMANDS,
  executeActionCommand,
  getBookmarksWithHighlights,
  copyArticleHighlightsById,
} from "./commandActions.js";

// ── FlexSearch index state ────────────────────────────────────────────────
let flexSearchIndex = null;
let isIndexReady = false;
// Store documents for retrieval since FlexSearch Index only returns IDs
let documentStore = new Map();

// ── Search UI state ───────────────────────────────────────────────────────
let searchDebounceTimer = null;
let searchFocusedIndex = -1;
let isSearchExpanded = false;
let isMobileSearchOpen = false;
// Sub-search mode: null = normal palette, "pick-highlights" = article picker
let _searchMode = null;
// Cached list of bookmarks-with-highlights, built once on picker entry
let _pickerCache = null;

// ── Callbacks supplied by main.js via initSearchUI() ──────────────────────
let _switchTab = () => {};
let _pushUrlFromState = () => {};
let _markArticleAsOpened = () => {};
let _scrollReaderToTop = () => {};
let _resetReaderContext = () => {};

// ── Command Palette Registry ──────────────────────────────────────────────
// Each command: { id, type:"command", title, keywords, icon }
// `keywords` is a flat string used for fuzzy matching against the query.
// To add new commands, push entries onto SEARCH_COMMANDS.
export const SEARCH_COMMANDS = [
  // ── Page navigation ─────────────────────────────────────────────────────
  {
    id: "cmd:page:explore",
    type: "command",
    category: "Pages",
    title: "Explore",
    keywords: "explore rss feeds news",
    icon: "fa-compass",
  },
  {
    id: "cmd:page:library",
    type: "command",
    category: "Pages",
    title: "Library",
    keywords: "library bookmarks articles saved",
    icon: "fa-book",
  },
  {
    id: "cmd:page:projects",
    type: "command",
    category: "Pages",
    title: "Projects",
    keywords: "projects writing workspace folders",
    icon: "fa-folder",
  },
  {
    id: "cmd:page:settings",
    type: "command",
    category: "Pages",
    title: "Settings",
    keywords: "settings preferences options configuration",
    icon: "fa-gear",
  },
  // ── Settings sections ───────────────────────────────────────────────────
  {
    id: "cmd:settings:display",
    type: "command",
    category: "Settings",
    title: "Display",
    keywords:
      "settings display appearance theme dark light system accent font reading splash",
    icon: "fa-display",
  },
  {
    id: "cmd:settings:export",
    type: "command",
    category: "Settings",
    title: "Data",
    keywords: "settings data export import backup cloud sync sign in account",
    icon: "fa-hard-drive",
  },
  {
    id: "cmd:settings:projects",
    type: "command",
    category: "Settings",
    title: "Project settings",
    keywords: "settings projects manage stages new project",
    icon: "fa-folder-tree",
  },
  {
    id: "cmd:settings:tags",
    type: "command",
    category: "Settings",
    title: "Tags",
    keywords: "settings tags auto tagging saved custom rules country",
    icon: "fa-tags",
  },
  {
    id: "cmd:settings:rss",
    type: "command",
    category: "Settings",
    title: "RSS settings",
    keywords: "settings rss feeds retention auto refresh",
    icon: "fa-rss",
  },
  {
    id: "cmd:settings:about",
    type: "command",
    category: "Settings",
    title: "About",
    keywords: "settings about version info",
    icon: "fa-circle-info",
  },
];

/**
 * Initialize FlexSearch index - loads from IndexedDB or rebuilds from data
 * @param {Array} bookmarks - Array of bookmark objects
 * @param {Array} projects - Array of project objects
 */
export async function initSearchIndex(bookmarks = [], projects = []) {
  // FlexSearch is loaded via CDN in index.html
  if (typeof FlexSearch === "undefined") {
    console.warn("FlexSearch not loaded - search disabled");
    return;
  }

  // Always rebuild fresh on init to ensure consistency
  await rebuildIndex(bookmarks, projects);
}

/**
 * Rebuild the entire search index from scratch
 */
export async function rebuildIndex(bookmarks = [], projects = []) {
  if (typeof FlexSearch === "undefined") {
    return;
  }

  // Clear document store
  documentStore.clear();

  // Use simpler Index for more reliable results
  flexSearchIndex = new FlexSearch.Index({
    tokenize: "forward",
    resolution: 9,
    cache: 100,
  });

  // Index bookmarks
  for (const bookmark of bookmarks) {
    const doc = bookmarkToSearchDoc(bookmark);
    const searchText = `${doc.title} ${doc.content} ${doc.tags}`;
    flexSearchIndex.add(doc.id, searchText);
    documentStore.set(doc.id, doc);
  }

  // Index projects
  for (const project of projects) {
    const doc = projectToSearchDoc(project);
    const searchText = `${doc.title} ${doc.content}`;
    flexSearchIndex.add(doc.id, searchText);
    documentStore.set(doc.id, doc);
  }

  isIndexReady = true;
  console.log(
    `Search index built: ${bookmarks.length} bookmarks, ${projects.length} projects`,
  );
}

/**
 * Flatten blocks to text (inline to avoid circular import)
 */
function flattenBlocksToText(blocks) {
  if (!Array.isArray(blocks)) return "";
  return blocks.map((block) => block?.text || "").join(" ");
}

/**
 * Convert bookmark to search document
 * Indexes: title, description, body content, tags, highlights
 */
function bookmarkToSearchDoc(bookmark) {
  const tags = (bookmark.tags || []).join(" ");

  // Get full body content from blocks
  const bodyText = flattenBlocksToText(bookmark.blocks);

  // Get highlight texts
  const highlightTexts = (bookmark.highlights || [])
    .map((h) => h.text || "")
    .join(" ");

  // Combine all searchable content
  const content = [bookmark.description || "", bodyText, highlightTexts]
    .filter(Boolean)
    .join(" ");

  return {
    id: bookmark.id,
    type: "bookmark",
    title: bookmark.title || "",
    content,
    tags,
    preview: bookmark.previewText || bookmark.description || "",
  };
}

/**
 * Convert project to search document
 * Indexes: name, description, and markdown content body
 */
function projectToSearchDoc(project) {
  // Project content is the markdown body
  const bodyContent = project.content || "";

  const content = [project.description || "", bodyContent]
    .filter(Boolean)
    .join(" ");

  return {
    id: project.id,
    type: "project",
    title: project.name || "",
    content,
    preview: project.description || project.name || "",
  };
}

/**
 * Add or update a bookmark in the search index
 */
export function updateBookmarkInIndex(bookmark) {
  if (!flexSearchIndex || !isIndexReady) {
    return;
  }

  const doc = bookmarkToSearchDoc(bookmark);
  const searchText = `${doc.title} ${doc.content} ${doc.tags}`;

  // Remove old entry if exists
  try {
    flexSearchIndex.remove(doc.id);
  } catch {
    // May not exist
  }

  // Add new entry
  flexSearchIndex.add(doc.id, searchText);
  documentStore.set(doc.id, doc);
}

/**
 * Add or update a project in the search index
 */
export function updateProjectInIndex(project) {
  if (!flexSearchIndex || !isIndexReady) {
    return;
  }

  const doc = projectToSearchDoc(project);
  const searchText = `${doc.title} ${doc.content}`;

  // Remove old entry if exists
  try {
    flexSearchIndex.remove(doc.id);
  } catch {
    // May not exist
  }

  // Add new entry
  flexSearchIndex.add(doc.id, searchText);
  documentStore.set(doc.id, doc);
}

/**
 * Remove a document from the search index
 */
export function removeFromIndex(id) {
  if (!flexSearchIndex || !isIndexReady) {
    return;
  }

  try {
    flexSearchIndex.remove(id);
    documentStore.delete(id);
  } catch {
    // Document may not exist
  }
}

/**
 * Search the index
 * @param {string} query - Search query
 * @param {Object} options - Search options
 * @param {number} options.limit - Max results (default 50)
 * @param {string} options.type - Filter by type: 'bookmark', 'project', or null for all
 * @returns {Array} Array of { id, type, title, preview } objects
 */
export function search(query, options = {}) {
  if (!flexSearchIndex || !isIndexReady || !query?.trim()) {
    return [];
  }

  const { limit = 50, type = null } = options;
  const trimmedQuery = query.trim();

  try {
    // Search returns array of matching IDs
    const matchingIds = flexSearchIndex.search(trimmedQuery, {
      limit: limit * 2,
    });

    // Look up documents from our store
    let results = [];
    for (const id of matchingIds) {
      const doc = documentStore.get(id);
      if (doc) {
        results.push({
          id: doc.id,
          type: doc.type,
          title: doc.title,
          preview: doc.preview,
        });
      }
    }

    // Filter by type if specified
    if (type) {
      results = results.filter((doc) => doc.type === type);
    }

    return results.slice(0, limit);
  } catch (err) {
    console.error("Search error:", err);
    return [];
  }
}

/**
 * Check if search index is ready
 */
export function isSearchReady() {
  return isIndexReady;
}

/**
 * Get indexed document count (for debugging)
 */
export function getIndexedDocumentCount() {
  return documentStore.size;
}

// ═══════════════════════════════════════════════════════════════════════════
// Search UI  –  command palette, desktop dropdown, mobile overlay
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Provide callbacks that live in main.js so the search UI can trigger
 * navigation, persistence, etc. Call once during app init.
 */
export function initSearchUI({
  switchTab,
  pushUrlFromState,
  markArticleAsOpened,
  scrollReaderToTop,
  resetReaderContext,
}) {
  _switchTab = switchTab;
  _pushUrlFromState = pushUrlFromState;
  _markArticleAsOpened = markArticleAsOpened;
  _scrollReaderToTop = scrollReaderToTop;
  _resetReaderContext = resetReaderContext;
}

/**
 * Attach all search-related DOM event listeners.
 * Call once from bindEvents() in main.js.
 */
export function bindSearchEvents() {
  // Desktop search
  dom.searchToggle?.addEventListener("click", toggleDesktopSearch);
  dom.searchInput?.addEventListener("input", handleSearchInput);
  dom.searchInput?.addEventListener("keydown", handleSearchKeydown);
  dom.searchInput?.addEventListener("focus", () => {
    if (isSearchExpanded) {
      showSearchResults();
    }
  });
  dom.searchClear?.addEventListener("click", clearDesktopSearch);
  dom.searchResults?.addEventListener("click", handleSearchResultClick);
  dom.searchBackdrop?.addEventListener("click", closeDesktopSearch);

  // Mobile search
  dom.searchOverlayBack?.addEventListener("click", closeMobileSearch);
  dom.searchOverlayInput?.addEventListener("input", handleMobileSearchInput);
  dom.searchOverlayInput?.addEventListener(
    "keydown",
    handleMobileSearchKeydown,
  );
  dom.searchOverlayClear?.addEventListener("click", clearMobileSearch);
  dom.searchOverlayResults?.addEventListener("click", handleSearchResultClick);
}

/** @returns {boolean} Whether the desktop search dropdown is open. */
export function getSearchExpanded() {
  return isSearchExpanded;
}

/** @returns {boolean} Whether the mobile search overlay is open. */
export function getMobileSearchOpen() {
  return isMobileSearchOpen;
}

// ── Desktop search ────────────────────────────────────────────────────────

function toggleDesktopSearch() {
  if (isSearchExpanded) {
    closeDesktopSearch();
  } else {
    openDesktopSearch();
  }
}

export function openDesktopSearch() {
  isSearchExpanded = true;
  dom.searchContainer?.classList.add("is-visible");
  dom.searchToggle?.classList.add("is-active");
  dom.searchInput?.focus();
  showSearchResults();
  debouncedSearch("", dom.searchResultsList);
}

export function closeDesktopSearch() {
  isSearchExpanded = false;
  searchFocusedIndex = -1;
  _searchMode = null;
  _pickerCache = null;
  dom.searchContainer?.classList.remove("is-visible");
  dom.searchToggle?.classList.remove("is-active");
  dom.searchResults?.classList.remove("is-visible");
  dom.searchInput.value = "";
  if (dom.searchInput) dom.searchInput.placeholder = "Search or jump to...";
  dom.searchClear?.classList.remove("is-visible");
  // Reset to empty state
  if (dom.searchResultsList) {
    dom.searchResultsList.innerHTML = "";
  }
  dom.searchResults?.classList.add("is-empty");
  const emptyEl = dom.searchResults?.querySelector(".search-dropdown__empty");
  if (emptyEl) {
    emptyEl.textContent = "Start typing to search...";
  }
}

function showSearchResults() {
  dom.searchResults?.classList.add("is-visible");
}

function clearDesktopSearch() {
  dom.searchInput.value = "";
  dom.searchClear?.classList.remove("is-visible");
  renderSearchResults([], [], dom.searchResultsList);
  dom.searchInput?.focus();
}

// ── Mobile search ─────────────────────────────────────────────────────────

export function openMobileSearch() {
  isMobileSearchOpen = true;
  dom.searchOverlay?.classList.add("is-visible");
  document.body.classList.add("mobile-search-open");
  dom.searchOverlayInput?.focus();
  debouncedSearch("", dom.searchOverlayList);
}

export function closeMobileSearch() {
  isMobileSearchOpen = false;
  _searchMode = null;
  _pickerCache = null;
  dom.searchOverlay?.classList.remove("is-visible");
  document.body.classList.remove("mobile-search-open");
  dom.searchOverlayInput.value = "";
  if (dom.searchOverlayInput)
    dom.searchOverlayInput.placeholder = "Search or jump to...";
  dom.searchOverlayClear?.classList.remove("is-visible");
  if (dom.searchOverlayList) {
    dom.searchOverlayList.innerHTML = "";
  }
  // Reset to empty state
  dom.searchOverlayResults?.classList.add("is-empty");
  const emptyEl = dom.searchOverlayResults?.querySelector(
    ".search-overlay__empty",
  );
  if (emptyEl) {
    emptyEl.textContent = "Start typing to search...";
  }
}

function clearMobileSearch() {
  dom.searchOverlayInput.value = "";
  dom.searchOverlayClear?.classList.remove("is-visible");
  renderSearchResults([], [], dom.searchOverlayList);
  dom.searchOverlayInput?.focus();
}

// ── Input handling & debounce ─────────────────────────────────────────────

function handleSearchInput(event) {
  const query = event.target.value;
  dom.searchClear?.classList.toggle("is-visible", query.length > 0);
  debouncedSearch(query, dom.searchResultsList);
}

function handleMobileSearchInput(event) {
  const query = event.target.value;
  dom.searchOverlayClear?.classList.toggle("is-visible", query.length > 0);
  debouncedSearch(query, dom.searchOverlayList);
}

function matchCommands(query) {
  const allCommands = [...ACTION_COMMANDS, ...SEARCH_COMMANDS];
  if (!query?.trim()) return allCommands;
  const terms = query.toLowerCase().split(/\s+/);
  return allCommands.filter((cmd) => {
    const haystack = (cmd.title + " " + cmd.keywords).toLowerCase();
    return terms.every((t) => haystack.includes(t));
  });
}

function debouncedSearch(query, listElement) {
  if (searchDebounceTimer) {
    clearTimeout(searchDebounceTimer);
  }

  searchDebounceTimer = setTimeout(() => {
    searchDebounceTimer = null;
    searchFocusedIndex = 0;

    if (_searchMode === "pick-highlights") {
      if (!_pickerCache) _pickerCache = getBookmarksWithHighlights();
      const filtered = filterPickerCache(query);
      renderPickerResults(filtered, listElement);
      return;
    }

    const commands = matchCommands(query);
    const contentResults = search(query, { limit: 30 });
    renderSearchResults(commands, contentResults, listElement);
  }, 150);
}

// ── Rendering ─────────────────────────────────────────────────────────────

function renderSearchResults(commands, contentResults, listElement) {
  if (!listElement) return;

  const container = listElement.closest(
    ".search-dropdown__results, .search-overlay__results",
  );
  const emptyEl = container?.querySelector(
    ".search-dropdown__empty, .search-overlay__empty",
  );

  const totalCount = commands.length + contentResults.length;

  if (totalCount === 0) {
    listElement.innerHTML = "";
    container?.classList.add("is-empty");
    if (emptyEl) {
      emptyEl.textContent =
        dom.searchInput?.value || dom.searchOverlayInput?.value
          ? "No results found"
          : "Start typing to search...";
    }
    return;
  }

  container?.classList.remove("is-empty");

  let html = "";
  let flatIndex = 0;

  // Group commands by category
  const grouped = new Map();
  for (const cmd of commands) {
    const cat = cmd.category || "Actions";
    if (!grouped.has(cat)) grouped.set(cat, []);
    grouped.get(cat).push(cmd);
  }

  for (const [category, items] of grouped) {
    html += `<li class="search-result-category" aria-hidden="true">${escapeHtml(category)}</li>`;
    for (const cmd of items) {
      html += `
        <li
          class="search-result-item${flatIndex === searchFocusedIndex ? " is-focused" : ""}"
          data-search-result-id="${escapeHtml(cmd.id)}"
          data-search-result-type="command"
          tabindex="0"
        >
          <div class="search-result-item__icon search-result-item__icon--command">
            <i class="fa-solid ${cmd.icon}" aria-hidden="true"></i>
          </div>
          <div class="search-result-item__content">
            <div class="search-result-item__title">${escapeHtml(cmd.title)}</div>
          </div>
          ${flatIndex < 5 ? `<kbd class="search-result-item__shortcut">⌘${flatIndex + 1}</kbd>` : ""}
        </li>`;
      flatIndex++;
    }
  }

  if (contentResults.length > 0) {
    html += `<li class="search-result-category" aria-hidden="true">Results</li>`;
    for (const result of contentResults) {
      html += `
        <li
          class="search-result-item${flatIndex === searchFocusedIndex ? " is-focused" : ""}"
          data-search-result-id="${escapeHtml(result.id)}"
          data-search-result-type="${escapeHtml(result.type)}"
          tabindex="0"
        >
          <div class="search-result-item__icon search-result-item__icon--${result.type}">
            <i class="fa-solid ${result.type === "bookmark" ? "fa-bookmark" : "fa-folder"}" aria-hidden="true"></i>
          </div>
          <div class="search-result-item__content">
            <div class="search-result-item__title">${escapeHtml(result.title || "Untitled")}</div>
            ${result.preview ? `<div class="search-result-item__preview">${escapeHtml(result.preview)}</div>` : ""}
          </div>
          ${flatIndex < 5 ? `<kbd class="search-result-item__shortcut">⌘${flatIndex + 1}</kbd>` : ""}
        </li>`;
      flatIndex++;
    }
  }

  listElement.innerHTML = html;
}

// ── Picker mode rendering ─────────────────────────────────────────────────

function renderPickerResults(articles, listElement) {
  if (!listElement) return;

  const container = listElement.closest(
    ".search-dropdown__results, .search-overlay__results",
  );
  const emptyEl = container?.querySelector(
    ".search-dropdown__empty, .search-overlay__empty",
  );

  if (articles.length === 0) {
    listElement.innerHTML = "";
    container?.classList.add("is-empty");
    if (emptyEl) {
      emptyEl.textContent =
        dom.searchInput?.value || dom.searchOverlayInput?.value
          ? "No matching articles with highlights"
          : "Pick an article to copy highlights from";
    }
    return;
  }

  container?.classList.remove("is-empty");

  let html = `<li class="search-result-category" aria-hidden="true">Articles with highlights</li>`;
  articles.forEach((article, i) => {
    html += `
      <li
        class="search-result-item${i === searchFocusedIndex ? " is-focused" : ""}"
        data-search-result-id="${escapeHtml(article.id)}"
        data-search-result-type="highlight-pick"
        tabindex="0"
      >
        <div class="search-result-item__icon search-result-item__icon--bookmark">
          <i class="fa-solid fa-highlighter" aria-hidden="true"></i>
        </div>
        <div class="search-result-item__content">
          <div class="search-result-item__title">${escapeHtml(article.title)}</div>
          <div class="search-result-item__preview">${article.count} highlight${article.count !== 1 ? "s" : ""}</div>
        </div>
        ${i < 5 ? `<kbd class="search-result-item__shortcut">⌘${i + 1}</kbd>` : ""}
      </li>`;
  });

  listElement.innerHTML = html;
}

// ── Picker mode helpers ───────────────────────────────────────────────────

function enterPickerMode(mode) {
  _searchMode = mode;
  _pickerCache = getBookmarksWithHighlights();
  const input = isMobileSearchOpen ? dom.searchOverlayInput : dom.searchInput;
  const list = isMobileSearchOpen
    ? dom.searchOverlayList
    : dom.searchResultsList;

  if (input) {
    input.value = "";
    input.placeholder = "Search articles with highlights...";
  }
  debouncedSearch("", list);
  input?.focus();
}

function exitPickerMode(listElement) {
  _searchMode = null;
  _pickerCache = null;
  const input = isMobileSearchOpen ? dom.searchOverlayInput : dom.searchInput;
  if (input) {
    input.value = "";
    input.placeholder = "Search or jump to...";
  }
  debouncedSearch("", listElement);
  input?.focus();
}

const PICKER_MAX_RESULTS = 50;

function filterPickerCache(query) {
  if (!_pickerCache) return [];
  if (!query?.trim()) return _pickerCache.slice(0, PICKER_MAX_RESULTS);
  const terms = query.toLowerCase().split(/\s+/);
  const out = [];
  for (const item of _pickerCache) {
    if (terms.every((t) => item._lowerTitle.includes(t))) {
      out.push(item);
      if (out.length >= PICKER_MAX_RESULTS) break;
    }
  }
  return out;
}

// ── Keyboard navigation ───────────────────────────────────────────────────

async function handleSearchKeydown(event) {
  handleSearchNavigation(event, dom.searchResultsList, () => {
    closeDesktopSearch();
  });
}

function handleMobileSearchKeydown(event) {
  handleSearchNavigation(event, dom.searchOverlayList, () => {
    closeMobileSearch();
  });
}

async function handleSearchNavigation(event, listElement, onClose) {
  const items = listElement?.querySelectorAll(".search-result-item") || [];

  // ⌘1–⌘5 quick-select
  if (
    (event.metaKey || event.ctrlKey) &&
    event.key >= "1" &&
    event.key <= "5"
  ) {
    const idx = Number(event.key) - 1;
    if (idx < items.length) {
      event.preventDefault();
      const shouldClose = await selectSearchResult(items[idx]);
      if (shouldClose !== false) onClose();
    }
    return;
  }

  if (event.key === "Escape") {
    event.preventDefault();
    // In picker mode, Escape goes back to normal palette
    if (_searchMode) {
      exitPickerMode(listElement);
      return;
    }
    onClose();
    return;
  }

  if (event.key === "ArrowDown") {
    event.preventDefault();
    searchFocusedIndex = Math.min(searchFocusedIndex + 1, items.length - 1);
    updateSearchFocus(items);
    return;
  }

  if (event.key === "ArrowUp") {
    event.preventDefault();
    searchFocusedIndex = Math.max(searchFocusedIndex - 1, 0);
    updateSearchFocus(items);
    return;
  }

  if (event.key === "Enter") {
    event.preventDefault();
    const focusedItem = items[searchFocusedIndex];
    if (focusedItem) {
      const shouldClose = await selectSearchResult(focusedItem);
      if (shouldClose !== false) onClose();
    }
    return;
  }
}

function updateSearchFocus(items) {
  items.forEach((item, index) => {
    item.classList.toggle("is-focused", index === searchFocusedIndex);
  });

  const focusedItem = items[searchFocusedIndex];
  if (focusedItem) {
    focusedItem.scrollIntoView({ block: "nearest" });
  }
}

// ── Result selection & command execution ──────────────────────────────────

async function handleSearchResultClick(event) {
  const item = event.target.closest(".search-result-item");
  if (!item) return;

  const shouldClose = await selectSearchResult(item);

  // Close search UI (unless we just entered a picker sub-mode)
  if (shouldClose !== false) {
    if (isMobileSearchOpen) {
      closeMobileSearch();
    } else {
      closeDesktopSearch();
    }
  }
}

async function selectSearchResult(item) {
  const id = item.dataset.searchResultId;
  const type = item.dataset.searchResultType;

  if (type === "highlight-pick") {
    await copyArticleHighlightsById(id);
    return;
  }

  if (type === "command") {
    return await executeSearchCommand(id);
  } else if (type === "bookmark") {
    _resetReaderContext();
    state.selectedArticleId = id;
    state.rssReaderArticle = null;
    _markArticleAsOpened(id);
    persistState(state);
    _switchTab("reader");
    _scrollReaderToTop();
  } else if (type === "project") {
    state.selectedProjectId = id;
    state.selectedProjectSidebarArticleId = null;
    persistState(state);
    _switchTab("projects");
    renderProjects(state, dom);
    _pushUrlFromState();
  }
}

async function executeSearchCommand(commandId) {
  // Delegate to action commands first
  const result = await executeActionCommand(commandId);
  if (result === "pick-highlights") {
    enterPickerMode("pick-highlights");
    return false; // don't close search
  }
  if (result) return;

  // Page navigation commands
  if (commandId === "cmd:page:explore") {
    _switchTab("rss");
  } else if (commandId === "cmd:page:library") {
    _switchTab("library");
  } else if (commandId === "cmd:page:projects") {
    _switchTab("projects");
  } else if (commandId === "cmd:page:settings") {
    _switchTab("settings");
  }
  // Settings section commands
  else if (commandId.startsWith("cmd:settings:")) {
    const section = commandId.replace("cmd:settings:", "");
    state.settingsSection = section;
    persistState(state);
    _switchTab("settings");
    renderSettings(state, dom);
    _pushUrlFromState();
  }
}

// ── Index wrappers for external callers ───────────────────────────────────

export function updateSearchIndexForBookmark(bookmark) {
  if (isSearchReady()) {
    updateBookmarkInIndex(bookmark);
  }
}

export function updateSearchIndexForProject(project) {
  if (isSearchReady()) {
    updateProjectInIndex(project);
  }
}

export function removeFromSearchIndex(id) {
  if (isSearchReady()) {
    removeFromIndex(id);
  }
}
