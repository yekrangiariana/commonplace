import {
  runtimeConfig,
  state,
  touchBookmarks,
  touchProjects,
  touchRss,
  touchMeta,
  markBookmarkDirty,
  markProjectDirty,
  markRssFeedDirty,
} from "./state.js";
import { dom } from "./dom.js";
import { getDerivedIndexes } from "./derivedIndexes.js";
import {
  flattenBlocks,
  normalizeUrl,
  createId,
  previewText,
  escapeHtml,
  formatDate,
  formatRelativeTime,
  debounce,
} from "./utils.js";
import {
  normalizeTag,
  splitCommaSeparated,
  splitProjectNames,
  syncSavedTags,
  syncProjectsByName,
  deleteProject as deleteProjectFromState,
  renameProject as renameProjectInState,
  renameTag as renameTagInState,
  deleteTag as deleteTagFromState,
} from "./taxonomy.js";
import {
  hydrateState,
  persistState,
  serializeMetaState,
  setAfterPersistCallback,
  clearAllPersistedData,
  estimatePersistedStorageUsage,
  putRssReaderCache,
  getRssReaderCache,
  deleteRssReaderCache,
  pruneRssReaderCacheByRetention,
} from "./storage.js";
import { hydrateRuntimeConfig } from "./config.js";
import { fetchArticle } from "./services/articleFetch.js";
import {
  fetchTweet,
  isTweetUrl,
  normalizeTweetUrl,
  createTweetPreview,
} from "./services/tweetFetch.js";
import { fetchArticleViaReaderTool } from "./experimental/readerToolAutomation.js";
import {
  handleSelectionChange,
  createHighlightFromSelection,
  copySelectionAsNote,
  sharePendingSelection,
  hideSelectionMenu,
} from "./highlighter.js";
import {
  renderLibraryFilters,
  renderArticleList,
  goToNextLibraryPage,
  goToPreviousLibraryPage,
  updateLibraryVirtualWindow,
  getLibraryReadingOrder,
} from "./pages/libraryPage.js";
import { renderReader } from "./pages/readerPage.js";
import {
  renderProjects,
  renderProjectFilters,
  goToNextProjectsPage,
  goToPreviousProjectsPage,
} from "./pages/projectsPage.js";
import {
  saveProjectEditorContent,
  renderProjectMarkdownPreview,
  applyProjectMarkdownShortcut,
} from "./pages/editor.js";
import {
  renderSettings,
  renderArticleTaxonomyHelpers,
} from "./pages/settingsPage.js";
import {
  getPaginatedItems,
  goToNextPage,
  goToPreviousPage,
  buildPaginationMarkup,
} from "./pages/pagination.js";
import { initWorkspaceContextMenu } from "./contextMenu.js";
import { initReaderTtsPlayer } from "./ttsPlayer.js";
import { initSwipeNavigation } from "./swipeNavigation.js";
import { injectAccentStyles, isValidAccent } from "./accentColors.js";
import {
  initImageCache,
  ensurePageImagesLoaded,
  getCachedBlobUrl,
  fetchAndCacheImage,
  evictCachedImage,
} from "./services/imageCache.js";
import {
  normalizeAutoTagRules,
  parseAutoTagRulesImport,
  getAutoTagSuggestionsForArticle,
} from "./services/autoTagging.js";
import { fetchRssFeed } from "./services/rssFetch.js";
import {
  createRssAutoRefreshController,
  normalizeRssAutoRefreshMinutes,
} from "./services/rssAutoRefresh.js";
import {
  exportMarkdownToFolder,
  exportMarkdownToSavedFolder,
  exportMarkdownAsZip,
  getSavedMarkdownExportStatus,
  isMarkdownFolderExportSupported,
  isMobileDevice,
} from "./services/markdownExport.js";
import {
  initDataTransfer,
  openExportDialog,
  openImportDialog,
} from "./services/dataTransfer.js";
import {
  initSearchIndex,
  rebuildIndex,
  updateBookmarkInIndex,
  updateProjectInIndex,
  removeFromIndex,
  search,
  isSearchReady,
} from "./services/search.js";
import { createFocusModeController } from "./focusMode.js";
import {
  handleAuthRedirect,
  isLoggedIn,
  restoreSession,
} from "./sync/supabaseClient.js";
import {
  pullSync,
  pushSyncNow,
  schedulePushSync,
  startAutoPull,
  stopAutoPull,
  applyRemoteSyncData,
  initSyncUI,
} from "./sync/cloudSync.js";

let statusTimeoutId = null;
let projectLinkSelection = null;
let isApplyingRoute = false;
let draggedProjectId = null;
let workspaceContextMenu = null;
let selectionMenuWasOpenAtPointerDown = false;
let readerTtsPlayer = null;
let wasReaderRendered = false;
let pendingFetchedArticle = null;
let lastDraftNormalizedUrl = "";
let rssReaderContext = null;
let readerSideTab = "highlights";
const rssSortedItemsCache = new Map();
let rssAutoRefreshController = null;
let rssRefreshInFlight = null;
let pendingRssReaderSlug = null;
let rssImagePrefetchTimerId = null;
const rssImagePrefetchQueue = new Map();
let rssOpenRequestVersion = 0;
let savedRssScrollPosition = 0;
let suspendedLibraryArticleId = null;
let suspendedRssReaderArticle = false;
let focusModeController = null;
// Search state
let searchDebounceTimer = null;
let searchFocusedIndex = -1;
let isSearchExpanded = false;
let isMobileSearchOpen = false;
let lastTabClickTime = 0;
let lastTabClickTarget = null;
let storageUsageRequestInFlight = false;
let markdownExportInFlight = false;
let markdownAutoSyncTimerId = null;
let markdownAutoSyncPending = false;
let markdownAutoSyncReady = false;
let markdownAutoSyncedBookmarksVersion = 0;
let markdownAutoSyncedProjectsVersion = 0;
let experimentalReaderFetchInFlight = false;

const MARKDOWN_AUTO_SYNC_DEBOUNCE_MS = 2500;
const MOBILE_EXPORT_TIMESTAMP_KEY = "commonplace-mobile-export-timestamp";

const RSS_PAGINATION_SCOPE = "rss";

const VALID_TABS = new Set([
  "rss",
  "library",
  "reader",
  "projects",
  "settings",
]);
const VALID_SETTINGS_SECTIONS = new Set([
  "export",
  "sync",
  "projects",
  "tags",
  "display",
  "rss",
]);

init();

function dismissSplash() {
  const splash = document.getElementById("splash-screen");
  if (!splash) return;
  splash.classList.add("splash-hidden");
  // Remove after transition, with fallback timeout in case transitionend doesn't fire
  const removeTimeout = setTimeout(() => splash.remove(), 1000);
  splash.addEventListener(
    "transitionend",
    () => {
      clearTimeout(removeTimeout);
      splash.remove();
    },
    { once: true },
  );
}

async function init() {
  // Safety: always dismiss splash even if init fails
  const splashTimeout = setTimeout(dismissSplash, 6000);
  let splashDone = Promise.resolve();
  let didClearData = false;

  try {
    // Handle pending data clear FIRST, before any DB connections are opened
    if (window.localStorage.getItem("pendingClearAllData") === "1") {
      window.localStorage.removeItem("pendingClearAllData");
      didClearData = true;
      await clearAllPersistedData();
      // Dismiss splash immediately for instant feedback
      dismissSplash();
    }

    await hydrateRuntimeConfig(runtimeConfig);
    renderFeedSuggestions();

    // Handle magic link auth redirect (exchange token hash for session)
    const didAuth = await handleAuthRedirect();

    // Only hydrate state from DB if we didn't just clear it
    if (!didClearData) {
      await hydrateState(state);
    }

    // If logged in, try to pull remote sync data and merge
    if (isLoggedIn() && !didClearData) {
      try {
        const remoteData = await pullSync(state);
        if (remoteData) {
          applyRemoteSyncData(remoteData, getSyncDeps());
        }
      } catch {
        // Sync failure should not block app init
      }
      // Start background polling for cross-device changes
      startAutoPull(state, serializeMetaState, (data) =>
        applyRemoteSyncData(data, getSyncDeps()),
      );
    }

    // Only show splash delay if not clearing data and splash is enabled
    // Skip if the page was recently hidden (e.g. fold-triggered reload) so the
    // user doesn't see a black screen when unfolding their phone.
    const lastHiddenAt = Number(localStorage.getItem("__lastHiddenAt") || 0);
    const recentlyHidden =
      lastHiddenAt > 0 && Date.now() - lastHiddenAt < 30_000;
    if (!didClearData && state.splashEnabled !== false && !recentlyHidden) {
      splashDone = new Promise((r) => setTimeout(r, 1000));
    } else if (!didClearData) {
      dismissSplash();
    }

    if (state.activeTab === "add") {
      state.activeTab = "library";
    }
    pruneRssItemsForRetention();
    pruneRssReaderCacheByRetention(state).catch(() => {});
    initImageCache(state.bookmarks).catch(() => {});
    initSearchIndex(state.bookmarks, state.projects).catch(() => {});

    // Schedule cloud sync push after each local persist
    setAfterPersistCallback((stateRef) => {
      schedulePushSync(stateRef, serializeMetaState);
    });

    focusModeController = createFocusModeController({
      dom,
      state,
      getActiveReaderArticle,
      getLibraryReadingOrder,
      markArticleAsOpened,
      renderAndSyncUrl,
      applyDisplayPreferences,
      getIsApplyingRoute: () => isApplyingRoute,
      setIsApplyingRoute: (next) => {
        isApplyingRoute = Boolean(next);
      },
      onSelectionDetected: () => handleSelectionChange(dom),
    });
    applyRouteFromUrl();
    try {
      await restorePendingRssArticle();
    } catch {
      // Continue initialization even if RSS restoration fails
    }
    injectAccentStyles();
    // Re-query accent buttons after dynamic generation
    dom.displayHighlightButtons = [
      ...document.querySelectorAll("[data-display-highlight]"),
    ];
    applyDisplayPreferences();
    bindEvents();
    initSwipeNavigation(switchTab, () => state.activeTab);
    initDataTransfer();
    workspaceContextMenu = initWorkspaceContextMenu({
      state,
      setStatus,
      persistState,
      render,
      switchTab,
      createId,
      openAddArticleModal: openAddModal,
      openProjectsCreate: openProjectsCreateFromContextMenu,
      openRssItem: handleRssOpenItem,
      addRssItemToLibrary: handleRssAddItem,
      markRssItemRead: markRssItemAsReadFromContextMenu,
      openRssSubscribe: openRssSubscribePopover,
      refreshRssActive: refreshAllRssFeeds,
      scrollReaderToTop,
    });
    readerTtsPlayer = initReaderTtsPlayer({
      state,
      dom,
      persistState,
      touchMeta,
      setStatus,
      getSelectedArticle: getActiveReaderArticle,
    });
    rssAutoRefreshController = createRssAutoRefreshController({
      getIntervalMinutes: () => state.rssAutoRefreshMinutes,
      getLastFetchedAtMs: () => {
        // Get the oldest fetch time among all feeds
        const fetchTimes = state.rssFeeds
          .map((feed) => Date.parse(feed.lastFetchedAt || "") || 0)
          .filter((t) => t > 0);
        return fetchTimes.length > 0 ? Math.min(...fetchTimes) : 0;
      },
      canRefresh: () => state.rssFeeds.length > 0,
      onRefresh: () => refreshAllRssFeeds({ silent: true, source: "auto" }),
    });
    rssAutoRefreshController.start();

    // Render UI first, before non-critical async operations
    renderAndSyncUrl();
    try {
      consumeShareTarget();
    } catch (shareErr) {
      console.error("Share target error:", shareErr);
    }

    // Non-critical: check markdown export status (with timeout protection)
    Promise.race([
      refreshMarkdownExportBindingStatus(),
      new Promise((resolve) => setTimeout(resolve, 3000)),
    ]).catch(() => {});

    await splashDone;
    clearTimeout(splashTimeout);
    dismissSplash();
  } catch (err) {
    console.error("Init error:", err);
    // Attempt to render even on error so UI is visible
    try {
      renderAndSyncUrl();
    } catch {
      // Last resort: just show the library tab
    }
    clearTimeout(splashTimeout);
    dismissSplash();
  }
}

function consumeShareTarget() {
  const params = new URLSearchParams(window.location.search);
  const sharedUrl = params.get("shared_url") || params.get("shared_text") || "";
  if (!sharedUrl) return;

  // Strip the query string so it doesn't persist on refresh
  const cleanUrl =
    window.location.pathname + (window.location.hash || "#library");
  window.history.replaceState(null, "", cleanUrl);

  // Check if the shared URL is a tweet
  if (isTweetUrl(sharedUrl)) {
    openAddModal("tweet");
    if (dom.addTweetUrl) {
      dom.addTweetUrl.value = sharedUrl;
      dom.addTweetUrl.dispatchEvent(new Event("input", { bubbles: true }));
    }
    return;
  }

  // Pre-fill the Add Article dialog with the shared URL
  openAddModal("article");
  if (dom.articleUrl) {
    dom.articleUrl.value = sharedUrl;
    dom.articleUrl.dispatchEvent(new Event("input", { bubbles: true }));
  }
}

function bindEvents() {
  dom.bookmarkForm.addEventListener("submit", handleBookmarkSubmit);
  document
    .querySelector("#add-article-open-button")
    ?.addEventListener("click", () => openAddModal());
  document
    .querySelector("#add-article-open-button-mobile")
    ?.addEventListener("click", () => openAddModal());
  document
    .querySelector("#add-dialog-close-fab")
    ?.addEventListener("click", () => closeAddModal());
  dom.addArticleDialog?.addEventListener("click", (event) => {
    if (event.target === dom.addArticleDialog) {
      closeAddModal();
    }
  });

  // Add dialog tab switching
  dom.addDialogTabs.forEach((tab) => {
    tab.addEventListener("click", () => switchAddDialogTab(tab.dataset.addTab));
  });

  // Add dialog indicator clicks (mobile)
  dom.addDialogIndicators.forEach((indicator) => {
    indicator.addEventListener("click", () =>
      switchAddDialogTab(indicator.dataset.addIndicator),
    );
  });

  // Add dialog swipe detection (mobile)
  dom.addDialogPanels?.addEventListener("scroll", () => {
    const scrollLeft = dom.addDialogPanels.scrollLeft;
    const panelWidth = dom.addDialogPanels.scrollWidth / 4;
    const index = Math.round(scrollLeft / panelWidth);
    const tabs = ["feed", "article", "project", "tweet"];
    if (tabs[index] && tabs[index] !== currentAddTab) {
      currentAddTab = tabs[index];
      // Update UI without scrolling again
      dom.addDialogTabs.forEach((tabBtn) => {
        tabBtn.classList.toggle(
          "is-active",
          tabBtn.dataset.addTab === currentAddTab,
        );
      });
      dom.addDialogPanelElements.forEach((panel) => {
        panel.classList.toggle(
          "is-active",
          panel.dataset.addPanel === currentAddTab,
        );
      });
      dom.addDialogIndicators.forEach((ind) => {
        ind.classList.toggle(
          "is-active",
          ind.dataset.addIndicator === currentAddTab,
        );
      });
    }
  });

  // Add feed form
  dom.addFeedForm?.addEventListener("submit", handleAddFeedSubmit);
  dom.addFeedFolderSuggestions?.addEventListener("click", (event) => {
    const btn = event.target.closest("[data-add-feed-folder]");
    if (btn && dom.addFeedFolder) {
      dom.addFeedFolder.value = btn.dataset.addFeedFolder;
    }
  });
  dom.addArticleDialog?.addEventListener("click", (event) => {
    const btn = event.target.closest("[data-add-feed-suggest]");
    if (btn && dom.addFeedUrl) {
      dom.addFeedUrl.value = btn.dataset.addFeedSuggest;
      if (dom.addFeedName)
        dom.addFeedName.value = btn.dataset.addFeedSuggestName || "";
      dom.addFeedForm?.requestSubmit();
    }
  });

  // Add project form
  dom.addProjectForm?.addEventListener("submit", handleAddProjectSubmit);

  // Add tweet form
  dom.addTweetForm?.addEventListener("submit", handleTweetSubmit);

  dom.openAddProjectModalButton?.addEventListener("click", () => {
    openAddModal("project");
  });

  dom.tagForm.addEventListener("submit", handleTagSubmit);
  dom.rssSubscribeForm?.addEventListener("submit", handleRssSubscribeSubmit);
  dom.rssSubscribePopover?.addEventListener("click", (event) => {
    const btn = event.target.closest("[data-rss-suggest]");
    if (!btn || !dom.rssFeedUrlInput || !dom.rssSubscribeForm) return;
    dom.rssFeedUrlInput.value = btn.dataset.rssSuggest;
    if (dom.rssFeedNameInput)
      dom.rssFeedNameInput.value = btn.dataset.rssSuggestName || "";
    dom.rssSubscribeForm.requestSubmit();
  });
  dom.rssOpenSubscribeButton?.addEventListener(
    "click",
    openRssSubscribePopover,
  );
  dom.rssCloseSubscribeButton?.addEventListener(
    "click",
    closeRssSubscribePopover,
  );
  dom.rssRefreshActiveButton?.addEventListener("click", refreshAllRssFeeds);

  dom.libraryTagClear.addEventListener("click", () => {
    state.libraryTagFilters = [];
    persistState(state);
    renderLibraryFilters(state, dom);
    renderArticleList(state, dom);
    pushUrlFromState();
  });

  dom.libraryProjectClear.addEventListener("click", () => {
    state.libraryProjectFilters = [];
    persistState(state);
    renderLibraryFilters(state, dom);
    renderArticleList(state, dom);
    pushUrlFromState();
  });

  dom.projectsProjectClear.addEventListener("click", () => {
    state.projectsStageFilter = null;
    persistState(state);
    renderProjectFilters(state, dom);
    renderProjects(state, dom);
  });

  dom.highlightSelectionButton.addEventListener("click", () => {
    createHighlightFromSelection({
      state,
      dom,
      getSelectedArticle: getActiveReaderArticle,
      createId,
      setStatus,
      onChanged: () => {
        const didSave = ensureHighlightedRssReaderArticleInLibrary();
        // If article was already in library (not saved just now), mark bookmarks dirty
        if (!didSave && state.selectedArticleId) {
          touchBookmarks(state);
        }
        persistState(state);
        renderAndSyncUrl();

        // Sync focus mode content if it's open (with delay for DOM update)
        requestAnimationFrame(() => focusModeController?.syncContent());

        if (didSave) {
          showTransientStatus(
            "Saved this RSS article to library after highlight.",
          );
        }
      },
    });
  });
  dom.noteSelectionButton.addEventListener("click", () => {
    copySelectionAsNote({
      state,
      dom,
      getSelectedArticle: getActiveReaderArticle,
      setStatus,
    });
  });
  dom.shareSelectionButton.addEventListener("click", () => {
    sharePendingSelection({
      state,
      dom,
      getSelectedArticle: getActiveReaderArticle,
      setStatus,
    });
  });
  dom.settingsNavButtons.forEach((button) => {
    button.addEventListener("click", () => {
      state.settingsSection = button.dataset.settingsSection;
      persistState(state);
      renderSettings(state, dom);
      pushUrlFromState();
    });
  });
  dom.exportMarkdownFolderButton?.addEventListener(
    "click",
    handleMarkdownFolderExport,
  );

  // Data transfer (clipboard import/export)
  document
    .querySelector("#data-transfer-export-button")
    ?.addEventListener("click", openExportDialog);
  document
    .querySelector("#data-transfer-import-button")
    ?.addEventListener("click", openImportDialog);
  window.addEventListener("dataTransferImportComplete", () => {
    renderAndSyncUrl();
    rebuildIndex(state.bookmarks, state.projects).catch(() => {});
    setStatus("Import complete");
  });

  dom.settingsStorageRefreshButton?.addEventListener(
    "click",
    refreshStorageUsageDisplay,
  );
  dom.deleteAllDataButton.addEventListener("click", handleDeleteAllData);

  // Cloud sync UI
  initSyncUI({
    formatRelativeTime,
    getState: () => state,
    getSyncDeps,
    serializeMetaState,
    applyRemote: (data) => applyRemoteSyncData(data, getSyncDeps()),
  });

  document
    .querySelector("[data-about-open-features]")
    ?.addEventListener("click", openFeatureInventoryInReader);

  dom.displayFontButtons.forEach((button) => {
    button.addEventListener("click", () => {
      state.displayFont = button.dataset.displayFont;
      touchMeta(state);
      persistState(state);
      applyDisplayPreferences();
      renderSettings(state, dom);
    });
  });
  dom.displayThemeButtons.forEach((button) => {
    button.addEventListener("click", () => {
      state.theme = button.dataset.displayTheme;
      touchMeta(state);
      persistState(state);
      applyDisplayPreferences();
      renderSettings(state, dom);
    });
  });
  dom.displayHighlightButtons.forEach((button) => {
    button.addEventListener("click", () => {
      state.displayHighlightColor = button.dataset.displayHighlight;
      touchMeta(state);
      persistState(state);
      applyDisplayPreferences();
      renderSettings(state, dom);
    });
  });
  dom.splashEnabled?.addEventListener("change", () => {
    state.splashEnabled = dom.splashEnabled.checked;
    touchMeta(state);
    try {
      if (state.splashEnabled) {
        localStorage.removeItem("splashOff");
      } else {
        localStorage.setItem("splashOff", "1");
      }
    } catch {}
    persistState(state);
  });
  dom.rssRetentionSelect?.addEventListener("change", () => {
    const raw = dom.rssRetentionSelect.value;
    state.rssRetentionDays = raw === "never" ? "never" : Number(raw) || 7;
    touchMeta(state);
    const removedCount = pruneRssItemsForRetention();
    persistState(state);
    renderSettings(state, dom);

    if (state.activeTab === "rss") {
      renderRssPanel();
    }

    if (removedCount > 0) {
      setStatus(
        `Removed ${removedCount} stale RSS item${removedCount === 1 ? "" : "s"}.`,
      );
    }
  });

  dom.rssAutoRefreshSelect?.addEventListener("change", () => {
    state.rssAutoRefreshMinutes = normalizeRssAutoRefreshMinutes(
      dom.rssAutoRefreshSelect.value,
    );
    touchMeta(state);
    persistState(state);
    renderSettings(state, dom);
    rssAutoRefreshController?.sync();

    const interval = state.rssAutoRefreshMinutes;

    if (interval === "off") {
      setStatus("RSS auto refresh disabled.");
      return;
    }

    setStatus(`RSS auto refresh set to every ${interval} minute(s).`);
  });

  dom.articleTags.addEventListener("input", () => {
    syncPendingAutoTagSelectionFromInput();
  });

  dom.articleProjects.addEventListener("input", () => {
    renderArticleTaxonomyHelpers(state, dom);
  });

  dom.addTweetTags?.addEventListener("input", () => {
    renderTweetTagSuggestions();
  });

  dom.articleUrl.addEventListener("change", () => {
    const raw = dom.articleUrl.value.trim();
    const next = raw ? normalizeUrl(raw) : "";

    if (lastDraftNormalizedUrl && next && next !== lastDraftNormalizedUrl) {
      dom.articleTags.value = "";
      clearPendingFetchedArticle();
      renderArticleTaxonomyHelpers(state, dom);
    }

    lastDraftNormalizedUrl = next;
  });

  dom.autoTagEnabled?.addEventListener("change", () => {
    state.autoTagEnabled = Boolean(dom.autoTagEnabled.checked);
    touchMeta(state);
    persistState(state);
    renderSettings(state, dom);
  });

  dom.autoTagUseDefaultCountries?.addEventListener("change", () => {
    state.autoTagUseDefaultCountries = Boolean(
      dom.autoTagUseDefaultCountries.checked,
    );
    touchMeta(state);
    persistState(state);
    renderSettings(state, dom);
  });

  dom.autoTagRuleForm?.addEventListener("submit", (event) => {
    event.preventDefault();
    saveCustomAutoTagRule();
  });

  dom.autoTagImportButton?.addEventListener("click", () => {
    importAutoTagRulesFromInput();
  });

  dom.readerBackButton.addEventListener("click", () => {
    if (
      (state.rssReaderArticle && !state.selectedArticleId) ||
      rssReaderContext
    ) {
      switchTab("rss");
      return;
    }

    switchTab("library");
  });

  focusModeController?.attachEventHandlers();

  dom.projectBackButton.addEventListener("click", () => {
    closeProjectLinkPopover();
    state.selectedProjectId = null;
    state.selectedProjectSidebarArticleId = null;
    persistState(state);
    renderProjects(state, dom);
    pushUrlFromState();
  });
  dom.projectToggleMarkdownButton.addEventListener("click", () => {
    state.projectShowMarkdown = !state.projectShowMarkdown;
    if (!state.projectShowMarkdown) {
      closeProjectLinkPopover();
    }
    persistState(state);
    renderProjects(state, dom);
  });
  dom.projectSidebarBackButton.addEventListener("click", () => {
    state.selectedProjectSidebarArticleId = null;
    renderProjects(state, dom);
    pushUrlFromState();
  });

  dom.projectEditorContent.addEventListener("input", (event) => {
    if (!state.selectedProjectId) {
      return;
    }

    const content = event.target.value;
    const normalizedContent = saveProjectEditorContent(
      state,
      state.selectedProjectId,
      content,
    );
    if (normalizedContent !== content) {
      event.target.value = normalizedContent;
    }
    renderProjectMarkdownPreview(dom, normalizedContent);
    persistState(state);
  });
  dom.projectStageMenuList.addEventListener(
    "click",
    handleProjectStageMenuClick,
  );
  dom.projectEditorContent.addEventListener(
    "keydown",
    handleProjectEditorKeydown,
  );
  dom.projectLinkApplyButton.addEventListener(
    "click",
    applyProjectLinkFromPopover,
  );
  dom.projectLinkCancelButton.addEventListener(
    "click",
    closeProjectLinkPopover,
  );
  dom.projectLinkInput.addEventListener(
    "keydown",
    handleProjectLinkInputKeydown,
  );
  dom.readerMeta.addEventListener("click", handleReaderMetaClick);
  dom.readerMeta.addEventListener("change", handleReaderMetaChange);
  dom.readerMeta.addEventListener("input", handleReaderMetaInput);

  dom.tabButtons.forEach((button) => {
    button.addEventListener("click", () => {
      const tabId = button.dataset.tabTarget;
      const now = Date.now();
      const isDoubleTap =
        lastTabClickTarget === tabId && now - lastTabClickTime < 400;
      lastTabClickTime = now;
      lastTabClickTarget = tabId;

      // Double tap on library: clear suspended article and go to list view
      if (isDoubleTap && tabId === "library") {
        suspendedLibraryArticleId = null;
        state.selectedArticleId = null;
        persistState(state);
        switchTab("library");
        return;
      }

      // Double tap on rss/explore: clear suspended reader and go to feed view
      if (isDoubleTap && tabId === "rss") {
        suspendedRssReaderArticle = false;
        state.rssReaderArticle = null;
        persistState(state);
        switchTab("rss");
        return;
      }

      // Single tap returning to library: restore reader with suspended article
      if (tabId === "library" && suspendedLibraryArticleId) {
        state.selectedArticleId = suspendedLibraryArticleId;
        suspendedLibraryArticleId = null;
        persistState(state);
        switchTab("reader");
        return;
      }

      // Single tap returning to rss: restore reader with suspended rss article
      if (
        tabId === "rss" &&
        suspendedRssReaderArticle &&
        state.rssReaderArticle
      ) {
        suspendedRssReaderArticle = false;
        persistState(state);
        switchTab("reader");
        return;
      }

      switchTab(tabId);
    });
  });

  dom.articleList.addEventListener(
    "scroll",
    () => {
      updateLibraryVirtualWindow(state, dom);
    },
    { passive: true },
  );
  window.addEventListener("resize", debounce(handleWindowResize, 150));

  document.addEventListener("selectionchange", () => {
    handleSelectionChange({
      state,
      dom,
      getSelectedArticle: getActiveReaderArticle,
      flattenBlocks,
    });
  });

  document.addEventListener("click", handleDocumentClick);
  document.addEventListener("pointerdown", handleDocumentPointerDown, true);
  document.addEventListener("keydown", handleDocumentKeydown);
  document.addEventListener("dragstart", handleDocumentDragStart);
  document.addEventListener("dragover", handleDocumentDragOver);
  document.addEventListener("drop", handleDocumentDrop);
  document.addEventListener("dragend", handleDocumentDragEnd);
  window.addEventListener("popstate", handleBrowserNavigation);
  window.addEventListener("hashchange", handleBrowserNavigation);
  window.addEventListener("resize", debounce(positionRssSubscribePopover, 150));
  document.addEventListener("visibilitychange", handleDocumentVisibilityChange);

  // Search event bindings
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
  dom.mobileSearchFab?.addEventListener("click", openMobileSearch);
  document
    .querySelector("#mobile-search-fab-projects")
    ?.addEventListener("click", openMobileSearch);
  dom.searchOverlayBack?.addEventListener("click", closeMobileSearch);
  dom.searchOverlayInput?.addEventListener("input", handleMobileSearchInput);
  dom.searchOverlayInput?.addEventListener(
    "keydown",
    handleMobileSearchKeydown,
  );
  dom.searchOverlayClear?.addEventListener("click", clearMobileSearch);
  dom.searchOverlayResults?.addEventListener("click", handleSearchResultClick);
}

async function handleBookmarkSubmit(event) {
  event.preventDefault();

  const url = dom.articleUrl.value.trim();
  const normalizedUrl = normalizeUrl(url);

  if (!url) {
    return;
  }

  if (pendingFetchedArticle) {
    if (pendingFetchedArticle.normalizedUrl === normalizedUrl) {
      savePendingFetchedArticle();
      return;
    }

    clearPendingFetchedArticle();
    dom.articleTags.value = "";
    renderArticleTaxonomyHelpers(state, dom);
  }

  if (hasDuplicateArticle(normalizedUrl)) {
    showTransientStatus("That article is already in your library.");
    return;
  }

  if (experimentalReaderFetchInFlight) {
    return;
  }

  const useExperimentalHelper = Boolean(dom.experimentalReaderToggle?.checked);

  if (useExperimentalHelper) {
    await fetchArticleWithExperimentalHelper({
      articleUrl: url,
      normalizedUrl,
    });
    return;
  }

  try {
    const article = await fetchArticle(runtimeConfig, url);
    stageFetchedArticle(normalizedUrl, article);
  } catch (error) {
    clearPendingFetchedArticle();
    showTransientStatus(
      error.message || "Could not fetch that article. Try another URL.",
    );
  }
}

async function fetchArticleWithExperimentalHelper({
  articleUrl,
  normalizedUrl,
}) {
  if (!normalizedUrl) {
    showTransientStatus("Add an article URL first.");
    dom.articleUrl?.focus();
    return;
  }

  if (hasDuplicateArticle(normalizedUrl)) {
    showTransientStatus("That article is already in your library.");
    return;
  }

  if (experimentalReaderFetchInFlight) {
    return;
  }

  experimentalReaderFetchInFlight = true;
  const submitButton = dom.bookmarkForm?.querySelector('button[type="submit"]');

  if (submitButton) {
    submitButton.disabled = true;
  }

  try {
    showTransientStatus(
      "Using PressReleased Reader mode to extract article body...",
    );
    const article = await fetchArticleViaReaderTool({
      articleUrl,
      timeoutMs: runtimeConfig.requestTimeoutMs,
    });
    stageFetchedArticle(normalizedUrl, article);
  } catch (error) {
    clearPendingFetchedArticle();
    showTransientStatus(
      error.message || "Experimental fetch failed. Try normal fetch instead.",
    );
  } finally {
    experimentalReaderFetchInFlight = false;

    if (submitButton) {
      submitButton.disabled = false;
    }
  }
}

async function handleDeleteAllData() {
  const shouldDelete = window.confirm(
    "Delete all saved data from this browser? This cannot be undone.",
  );

  if (!shouldDelete) {
    return;
  }

  // Set flag for deletion on next page load (avoids blocked database issues)
  window.localStorage.setItem("pendingClearAllData", "1");
  window.location.href = window.location.pathname + "#library";
  window.location.reload();
}

function getSyncDeps() {
  return {
    state,
    touchBookmarks,
    touchProjects,
    touchRss,
    persistState,
    renderAndSyncUrl,
    rebuildIndex,
    applyDisplayPreferences,
  };
}

async function handleMarkdownFolderExport() {
  // Use ZIP download on mobile devices to avoid Android FSAA issues
  if (isMobileDevice()) {
    await runMobileZipExport();
    return;
  }

  await runMarkdownSync({
    reason: "manual",
    allowFolderPicker: true,
    forceNow: true,
    announceStatus: true,
  });
}

async function runMobileZipExport() {
  if (dom.exportMarkdownFolderButton) {
    dom.exportMarkdownFolderButton.disabled = true;
  }

  try {
    const result = await exportMarkdownAsZip(state, {
      onProgress: (progress) => {
        if (!dom.exportMarkdownStatus) return;

        if (progress.stage === "loading-zip-library") {
          dom.exportMarkdownStatus.textContent = "Loading...";
        } else if (progress.stage === "building-content") {
          dom.exportMarkdownStatus.textContent = "Building content...";
        } else if (progress.stage === "adding-files") {
          dom.exportMarkdownStatus.textContent = `Adding files: ${progress.completed}/${progress.total}`;
        } else if (progress.stage === "generating-zip") {
          dom.exportMarkdownStatus.textContent = "Generating ZIP...";
        } else if (progress.stage === "downloading") {
          dom.exportMarkdownStatus.textContent = "Starting download...";
        }
      },
    });

    // Save export timestamp
    localStorage.setItem(MOBILE_EXPORT_TIMESTAMP_KEY, new Date().toISOString());

    if (dom.exportMarkdownStatus) {
      dom.exportMarkdownStatus.textContent = `Exported ${result.library.total} articles and ${result.projects.total} projects to ${result.fileName}`;
    }
  } catch (error) {
    console.error("ZIP export failed:", error);
    if (dom.exportMarkdownStatus) {
      dom.exportMarkdownStatus.textContent = `Export failed: ${error.message}`;
    }
  } finally {
    if (dom.exportMarkdownFolderButton) {
      dom.exportMarkdownFolderButton.disabled = false;
    }
  }
}

async function refreshMarkdownExportBindingStatus() {
  // On mobile, show ZIP export messaging instead of folder sync
  if (isMobileDevice()) {
    markdownAutoSyncReady = false;
    if (dom.exportMarkdownStatus) {
      const lastExport = localStorage.getItem(MOBILE_EXPORT_TIMESTAMP_KEY);
      if (lastExport) {
        const relativeTime = formatRelativeTime(lastExport);
        dom.exportMarkdownStatus.textContent = `On mobile, export downloads as a ZIP file. Last exported ${relativeTime}.`;
      } else {
        dom.exportMarkdownStatus.textContent =
          "On mobile, export downloads as a ZIP file.";
      }
    }
    return;
  }

  if (!isMarkdownFolderExportSupported()) {
    markdownAutoSyncReady = false;
    return;
  }

  const status = await getSavedMarkdownExportStatus({
    requestPermission: false,
  });
  markdownAutoSyncReady = status.hasSavedHandle && status.canWrite;

  if (markdownAutoSyncReady) {
    if (dom.exportMarkdownStatus) {
      dom.exportMarkdownStatus.textContent = `Syncing to folder: ${status.rootFolderName}. Auto-sync is on.`;
    }
    if (dom.exportMarkdownFolderButton) {
      dom.exportMarkdownFolderButton.innerHTML = `<i class="fa-solid fa-sync" aria-hidden="true"></i> Sync Now`;
    }
    return;
  }

  // Reset button to default state when not linked
  if (dom.exportMarkdownFolderButton) {
    dom.exportMarkdownFolderButton.innerHTML = `<i class="fa-solid fa-folder-open" aria-hidden="true"></i> Export`;
  }

  if (status.hasSavedHandle && !status.canWrite) {
    if (dom.exportMarkdownStatus) {
      dom.exportMarkdownStatus.textContent =
        "Export folder linked, but permission is missing. Click Export to reconnect.";
    }
  }
}

function getMarkdownDataVersions() {
  return {
    bookmarksVersion: Number(state.__bookmarksVersion || 0),
    projectsVersion: Number(state.__projectsVersion || 0),
  };
}

function hasUnsyncedMarkdownChanges() {
  const versions = getMarkdownDataVersions();

  return (
    versions.bookmarksVersion !== markdownAutoSyncedBookmarksVersion ||
    versions.projectsVersion !== markdownAutoSyncedProjectsVersion
  );
}

function markMarkdownSyncCheckpoint() {
  const versions = getMarkdownDataVersions();
  markdownAutoSyncedBookmarksVersion = versions.bookmarksVersion;
  markdownAutoSyncedProjectsVersion = versions.projectsVersion;
}

function queueMarkdownAutoSync(reason = "auto") {
  if (!markdownAutoSyncReady || !hasUnsyncedMarkdownChanges()) {
    return;
  }

  if (markdownAutoSyncTimerId !== null) {
    return;
  }

  markdownAutoSyncTimerId = window.setTimeout(() => {
    markdownAutoSyncTimerId = null;
    runMarkdownSync({
      reason,
      allowFolderPicker: false,
      forceNow: false,
      announceStatus: false,
    });
  }, MARKDOWN_AUTO_SYNC_DEBOUNCE_MS);
}

function clearMarkdownAutoSyncTimer() {
  if (markdownAutoSyncTimerId === null) {
    return;
  }

  window.clearTimeout(markdownAutoSyncTimerId);
  markdownAutoSyncTimerId = null;
}

async function runMarkdownSync(options = {}) {
  const reason = options.reason || "auto";
  const allowFolderPicker = options.allowFolderPicker === true;
  const forceNow = options.forceNow === true;
  const announceStatus = options.announceStatus !== false;

  if (!isMarkdownFolderExportSupported()) {
    return;
  }

  if (!forceNow && !hasUnsyncedMarkdownChanges()) {
    return;
  }

  if (markdownExportInFlight) {
    markdownAutoSyncPending = true;
    return;
  }

  if (forceNow) {
    clearMarkdownAutoSyncTimer();
  }

  markdownExportInFlight = true;

  if (dom.exportMarkdownFolderButton) {
    dom.exportMarkdownFolderButton.disabled = true;
  }

  try {
    let result = null;

    if (markdownAutoSyncReady) {
      result = await exportMarkdownToSavedFolder(state, {
        requestPermission: false,
        onProgress: (progress) => {
          if (!announceStatus || !dom.exportMarkdownStatus) {
            return;
          }

          if (
            (progress.stage === "sync-library" ||
              progress.stage === "sync-projects") &&
            Number.isFinite(progress.completed) &&
            Number.isFinite(progress.total)
          ) {
            const label =
              progress.stage === "sync-library"
                ? "Syncing library"
                : "Syncing projects";
            dom.exportMarkdownStatus.textContent = `${label}: ${progress.completed}/${progress.total}`;
          }
        },
      });
    } else if (allowFolderPicker) {
      const savedStatus = await getSavedMarkdownExportStatus({
        requestPermission: true,
      });

      if (savedStatus.hasSavedHandle && savedStatus.canWrite) {
        result = await exportMarkdownToSavedFolder(state, {
          requestPermission: true,
          onProgress: (progress) => {
            if (!dom.exportMarkdownStatus) {
              return;
            }

            if (
              (progress.stage === "sync-library" ||
                progress.stage === "sync-projects") &&
              Number.isFinite(progress.completed) &&
              Number.isFinite(progress.total)
            ) {
              const label =
                progress.stage === "sync-library"
                  ? "Syncing library"
                  : "Syncing projects";
              dom.exportMarkdownStatus.textContent = `${label}: ${progress.completed}/${progress.total}`;
            }
          },
        });
      } else {
        result = await exportMarkdownToFolder(state, {
          appFolderName: "Bookmark Manager",
          onProgress: (progress) => {
            if (!dom.exportMarkdownStatus) {
              return;
            }

            if (progress.stage === "pick-folder") {
              dom.exportMarkdownStatus.textContent =
                "Waiting for folder selection...";
              return;
            }

            if (
              (progress.stage === "sync-library" ||
                progress.stage === "sync-projects") &&
              Number.isFinite(progress.completed) &&
              Number.isFinite(progress.total)
            ) {
              const label =
                progress.stage === "sync-library"
                  ? "Syncing library"
                  : "Syncing projects";
              dom.exportMarkdownStatus.textContent = `${label}: ${progress.completed}/${progress.total}`;
            }
          },
        });
      }
    } else {
      markdownAutoSyncReady = false;
      return;
    }

    markdownAutoSyncReady = true;
    markMarkdownSyncCheckpoint();

    if (dom.exportMarkdownStatus && result) {
      dom.exportMarkdownStatus.textContent = `Linked folder: ${result.rootFolderName}. Last sync: library ${result.library.written} written, ${result.library.skipped} skipped; projects ${result.projects.written} written, ${result.projects.skipped} skipped.`;
    }

    if (announceStatus || reason === "manual") {
      setStatus("Markdown sync completed.");
    }
  } catch (error) {
    if (error?.name === "AbortError") {
      if (reason === "manual") {
        if (dom.exportMarkdownStatus) {
          dom.exportMarkdownStatus.textContent = "Export cancelled.";
        }
        setStatus("Markdown export cancelled.");
      }
      return;
    }

    const message =
      error?.message || "Markdown export failed. Please try again.";

    if (dom.exportMarkdownStatus) {
      dom.exportMarkdownStatus.textContent = message;
    }

    if (announceStatus || reason === "manual") {
      setStatus(message);
    }

    if (/permission|linked|reconnect|No export folder/i.test(message)) {
      markdownAutoSyncReady = false;
    }
  } finally {
    markdownExportInFlight = false;

    if (dom.exportMarkdownFolderButton) {
      dom.exportMarkdownFolderButton.disabled = false;
    }

    if (markdownAutoSyncPending) {
      markdownAutoSyncPending = false;
      queueMarkdownAutoSync("pending");
    }
  }
}

function handleDocumentVisibilityChange() {
  // Stamp the time so init() can skip the splash delay on a fold-triggered reload
  if (document.visibilityState === "hidden") {
    try {
      localStorage.setItem("__lastHiddenAt", Date.now().toString());
    } catch {
      // ignore storage errors
    }
  }

  if (document.visibilityState !== "hidden") {
    return;
  }

  if (!markdownAutoSyncReady || !hasUnsyncedMarkdownChanges()) {
    return;
  }

  runMarkdownSync({
    reason: "hidden",
    allowFolderPicker: false,
    forceNow: true,
    announceStatus: false,
  });
}

async function refreshStorageUsageDisplay() {
  if (storageUsageRequestInFlight) {
    return;
  }

  storageUsageRequestInFlight = true;

  if (dom.settingsStorageRefreshButton) {
    dom.settingsStorageRefreshButton.disabled = true;
  }

  const resultsEl = document.querySelector("#settings-storage-results");

  if (dom.settingsStorageSummary) {
    dom.settingsStorageSummary.innerHTML = `<p class="meta-text">Calculating...</p>`;
  }
  if (resultsEl) {
    resultsEl.hidden = false;
  }

  try {
    const usage = await estimatePersistedStorageUsage();
    const estimatedDbText = formatBytes(usage.estimatedDbBytes || 0);
    const browserUsageText = Number.isFinite(usage.browserUsageBytes)
      ? formatBytes(usage.browserUsageBytes)
      : "n/a";
    const browserQuotaText = Number.isFinite(usage.browserQuotaBytes)
      ? formatBytes(usage.browserQuotaBytes)
      : "n/a";

    if (dom.settingsStorageSummary) {
      dom.settingsStorageSummary.innerHTML = `
        <div class="settings-storage-meter">
          <div class="settings-storage-meter__label">
            <span>Used</span>
            <strong>${browserUsageText}</strong>
          </div>
          <div class="settings-storage-meter__bar">
            <div class="settings-storage-meter__fill" style="width: ${Math.min(100, (usage.browserUsageBytes / usage.browserQuotaBytes) * 100 || 0).toFixed(1)}%"></div>
          </div>
          <div class="settings-storage-meter__label">
            <span>Quota</span>
            <strong>${browserQuotaText}</strong>
          </div>
        </div>
      `;
    }

    if (dom.settingsStorageBreakdown) {
      const rows = usage.storeBreakdown.length
        ? usage.storeBreakdown
            .map((entry) => {
              if (entry.error) {
                return `<tr><td>${entry.storeName}</td><td>-</td><td class="meta-text">unavailable</td></tr>`;
              }
              const countLabel = Number.isFinite(entry.recordCount)
                ? entry.recordCount
                : "-";
              const bytesLabel = Number.isFinite(entry.approxBytes)
                ? formatBytes(entry.approxBytes)
                : "-";
              return `<tr><td>${entry.storeName}</td><td>${countLabel}</td><td>${bytesLabel}</td></tr>`;
            })
            .join("")
        : "<tr><td colspan='3' class='meta-text'>No data stores found yet.</td></tr>";

      dom.settingsStorageBreakdown.innerHTML = `
        <table class="settings-storage-table">
          <thead><tr><th>Store</th><th>Records</th><th>Size</th></tr></thead>
          <tbody>${rows}</tbody>
          <tfoot><tr><td><strong>Total (approx)</strong></td><td></td><td><strong>${estimatedDbText}</strong></td></tr></tfoot>
        </table>
      `;
    }

    setStatus(`Estimated local DB usage: ${estimatedDbText}.`);
  } catch {
    if (dom.settingsStorageSummary) {
      dom.settingsStorageSummary.innerHTML = `<p class="meta-text">Could not calculate storage usage in this browser.</p>`;
    }

    if (dom.settingsStorageBreakdown) {
      dom.settingsStorageBreakdown.innerHTML = `<p class="meta-text">Try again or check browser storage permissions.</p>`;
    }

    setStatus("Could not calculate storage usage.");
  } finally {
    storageUsageRequestInFlight = false;

    if (dom.settingsStorageRefreshButton) {
      dom.settingsStorageRefreshButton.disabled = false;
    }
  }
}

function formatBytes(bytes) {
  const value = Number(bytes);

  if (!Number.isFinite(value) || value <= 0) {
    return "0 B";
  }

  const units = ["B", "KB", "MB", "GB", "TB"];
  const exponent = Math.min(
    Math.floor(Math.log(value) / Math.log(1024)),
    units.length - 1,
  );
  const scaled = value / 1024 ** exponent;
  const precision = scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2;

  return `${scaled.toFixed(precision)} ${units[exponent]}`;
}

function canonicalizeArticleUrl(url) {
  try {
    const parsed = new URL(normalizeUrl(url));
    const hostname = parsed.hostname.replace(/^www\./i, "").toLowerCase();
    const pathname = parsed.pathname.replace(/\/+$/, "") || "/";
    return `${parsed.protocol}//${hostname}${pathname}`;
  } catch {
    return normalizeUrl(url).toLowerCase();
  }
}

/**
 * Extracts a URL slug (last path segment) for use in readable URL hashes.
 * Example: "https://aljazeera.com/news/2024/article-1" → "article-1"
 */
function extractUrlSlug(url) {
  try {
    const parsed = new URL(normalizeUrl(url));
    const pathname = parsed.pathname.replace(/\/+$/, "") || "/";
    const segments = pathname.split("/").filter(Boolean);
    return segments[segments.length - 1] || "article";
  } catch {
    return "article";
  }
}

// Cache reference to .app-main for mobile scroll reset
const appMainEl = document.querySelector(".app-main");

/**
 * Scrolls the reader view to the top.
 * On desktop, scroll is within .reader-surface.
 * On mobile, scroll is on .app-main or window (page scroll).
 * Always reset both to ensure consistent behavior across devices.
 */
function scrollReaderToTop() {
  // Reset desktop scroll container
  dom.readerSurface.scrollTop = 0;
  // Reset mobile scroll - scroll the app-main element and window
  if (appMainEl) {
    appMainEl.scrollTop = 0;
  }
  window.scrollTo(0, 0);
}

async function openFeatureInventoryInReader() {
  try {
    const response = await fetch("./docs/feature-inventory.md", {
      cache: "no-store",
    });
    if (!response.ok) return;
    const text = await response.text();

    const lines = text.replace(/\r\n/g, "\n").split("\n");
    const blocks = [];
    let paragraphLines = [];

    function pushParagraph() {
      const joined = paragraphLines.join(" ").replace(/\s+/g, " ").trim();
      if (joined) {
        blocks.push({
          type: "paragraph",
          text: joined,
          segments: [{ text: joined }],
        });
      }
      paragraphLines = [];
    }

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        pushParagraph();
        continue;
      }
      if (/^#{1,6}\s/.test(trimmed)) {
        pushParagraph();
        const heading = trimmed.replace(/^#{1,6}\s*/, "");
        blocks.push({
          type: "heading",
          text: heading,
          segments: [{ text: heading }],
        });
        continue;
      }
      if (trimmed.startsWith("- ")) {
        pushParagraph();
        const item = trimmed.replace(/^-\s*/, "");
        blocks.push({
          type: "paragraph",
          text: `\u2022 ${item}`,
          segments: [{ text: `\u2022 ${item}` }],
        });
        continue;
      }
      paragraphLines.push(trimmed);
    }
    pushParagraph();

    state.selectedArticleId = null;
    state.rssReaderArticle = {
      id: createId("rss-reader"),
      url: "",
      title: "Feature Inventory",
      description: "",
      source: "Commonplace",
      publishedAt: "",
      previewText: "",
      imageUrl: "",
      tags: [],
      projectIds: [],
      blocks,
      fetchedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      lastOpenedAt: new Date().toISOString(),
      highlights: [],
      isTransientRss: true,
    };
    switchTab("reader");
    scrollReaderToTop();
  } catch {
    // Silently fail if the file can't be loaded
  }
}

function handleTagSubmit(event) {
  event.preventDefault();
  const tag = normalizeTag(dom.tagName.value);

  if (!tag) {
    return;
  }

  syncSavedTags(state, [tag]);
  persistState(state);
  dom.tagForm.reset();
  renderSettings(state, dom);
}

function handleDocumentClick(event) {
  if (
    !dom.selectionMenu.hidden &&
    selectionMenuWasOpenAtPointerDown &&
    !hasActiveReaderSelection() &&
    !dom.selectionMenu.contains(event.target)
  ) {
    state.pendingSelection = null;
    hideSelectionMenu(dom);
  }

  selectionMenuWasOpenAtPointerDown = false;

  // Close desktop search if clicking outside
  if (
    isSearchExpanded &&
    !dom.searchContainer?.contains(event.target) &&
    !dom.searchToggle?.contains(event.target)
  ) {
    closeDesktopSearch();
  }

  const deleteArticleTrigger = event.target.closest("[data-delete-article]");

  if (deleteArticleTrigger) {
    const id = deleteArticleTrigger.dataset.deleteArticle;
    state.bookmarks = state.bookmarks.filter((b) => b.id !== id);
    markBookmarkDirty(state, id);
    if (state.selectedArticleId === id) state.selectedArticleId = null;
    touchBookmarks(state);
    persistState(state);
    evictCachedImage(id).catch(() => {});
    removeFromSearchIndex(id);
    renderAndSyncUrl();
    return;
  }

  const libraryViewTrigger = event.target.closest("[data-library-view]");

  if (libraryViewTrigger) {
    state.libraryView = libraryViewTrigger.dataset.libraryView;
    touchMeta(state);
    persistState(state);
    renderArticleList(state, dom);
    return;
  }

  const librarySortTrigger = event.target.closest("[data-library-sort]");

  if (librarySortTrigger) {
    state.librarySort = librarySortTrigger.dataset.librarySort;
    touchMeta(state);
    persistState(state);
    renderArticleList(state, dom);
    return;
  }

  const libraryToggleImagesTrigger = event.target.closest(
    "[data-library-toggle-images]",
  );

  if (libraryToggleImagesTrigger) {
    state.libraryShowImages = !(state.libraryShowImages !== false);
    touchMeta(state);
    persistState(state);
    renderArticleList(state, dom);
    return;
  }

  const libraryToggleTagsTrigger = event.target.closest(
    "[data-library-toggle-tags]",
  );

  if (libraryToggleTagsTrigger) {
    state.libraryShowTags = !(state.libraryShowTags !== false);
    touchMeta(state);
    persistState(state);
    renderArticleList(state, dom);
    return;
  }

  const articleTrigger = event.target.closest("[data-select-article]");

  if (articleTrigger) {
    rssReaderContext = null;
    readerSideTab = "highlights";
    state.selectedArticleId = articleTrigger.dataset.selectArticle;
    state.rssReaderArticle = null;
    markArticleAsOpened(state.selectedArticleId);
    persistState(state);
    switchTab("reader");
    scrollReaderToTop();
    return;
  }

  const openProjectSidebarArticleTrigger = event.target.closest(
    "[data-open-project-sidebar-article]",
  );

  if (openProjectSidebarArticleTrigger) {
    state.selectedProjectSidebarArticleId =
      openProjectSidebarArticleTrigger.dataset.openProjectSidebarArticle;
    renderProjects(state, dom);
    pushUrlFromState();
    return;
  }

  const removeHighlightTrigger = event.target.closest(
    "[data-remove-highlight]",
  );

  if (removeHighlightTrigger) {
    removeHighlight(removeHighlightTrigger.dataset.removeHighlight);
    return;
  }

  const deleteProjectTrigger = event.target.closest("[data-delete-project]");

  if (deleteProjectTrigger) {
    const projectId = deleteProjectTrigger.dataset.deleteProject;
    state.selectedProjectIds = (state.selectedProjectIds || []).filter(
      (id) => id !== projectId,
    );
    deleteProjectFromState(state, projectId);
    persistState(state);
    removeFromSearchIndex(projectId);
    renderAndSyncUrl();
    return;
  }

  const renameProjectTrigger = event.target.closest("[data-rename-project]");

  if (renameProjectTrigger) {
    const projectId = renameProjectTrigger.dataset.renameProject;
    const currentProject = state.projects.find(
      (project) => project.id === projectId,
    );

    if (!currentProject) {
      return;
    }

    const nextName = (
      window.prompt("Rename project", currentProject.name) || ""
    ).trim();

    if (
      !nextName ||
      nextName.toLowerCase() === currentProject.name.toLowerCase()
    ) {
      return;
    }

    const hasDuplicateName = state.projects.some(
      (project) =>
        project.id !== projectId &&
        project.name.trim().toLowerCase() === nextName.toLowerCase(),
    );

    if (hasDuplicateName) {
      setStatus("A project with that name already exists.");
      return;
    }

    renameProjectInState(state, projectId, nextName);
    persistState(state);
    const renamedProject = state.projects.find((p) => p.id === projectId);
    if (renamedProject) {
      updateSearchIndexForProject(renamedProject);
    }
    renderAndSyncUrl();
    return;
  }

  const projectViewTrigger = event.target.closest("[data-project-view]");

  if (projectViewTrigger) {
    state.projectsView = projectViewTrigger.dataset.projectView;
    persistState(state);
    renderProjects(state, dom);
    return;
  }

  const projectSortTrigger = event.target.closest("[data-project-sort]");

  if (projectSortTrigger) {
    state.projectsSort = projectSortTrigger.dataset.projectSort;
    persistState(state);
    renderProjects(state, dom);
    return;
  }

  const toggleProjectStageTrigger = event.target.closest(
    "[data-toggle-project-stage]",
  );

  if (toggleProjectStageTrigger) {
    toggleProjectsStageFilter(
      toggleProjectStageTrigger.dataset.toggleProjectStage,
    );
    return;
  }

  const openProjectTrigger = event.target.closest("[data-open-project]");

  if (openProjectTrigger) {
    state.selectedProjectId = openProjectTrigger.dataset.openProject;
    markProjectAsOpened(state.selectedProjectId);
    state.selectedProjectSidebarArticleId = null;
    persistState(state);
    renderProjects(state, dom);
    pushUrlFromState();
    return;
  }

  const renameTagTrigger = event.target.closest("[data-rename-tag]");

  if (renameTagTrigger) {
    const currentTag = renameTagTrigger.dataset.renameTag;
    const nextTag = normalizeTag(window.prompt("Rename tag", currentTag) || "");

    if (!nextTag || nextTag === currentTag) {
      return;
    }

    renameTagInState(state, currentTag, nextTag);
    persistState(state);
    renderAndSyncUrl();
    return;
  }

  const deleteTagTrigger = event.target.closest("[data-delete-tag]");

  if (deleteTagTrigger) {
    deleteTagFromState(state, deleteTagTrigger.dataset.deleteTag);
    persistState(state);
    renderAndSyncUrl();
    return;
  }

  const deleteSettingsFeedTrigger = event.target.closest(
    "[data-delete-settings-feed]",
  );

  if (deleteSettingsFeedTrigger) {
    const feedId = deleteSettingsFeedTrigger.dataset.deleteSettingsFeed;
    handleDeleteFeed(feedId);
    return;
  }

  const deleteAutoTagRuleTrigger = event.target.closest(
    "[data-delete-autotag-rule]",
  );

  if (deleteAutoTagRuleTrigger) {
    deleteCustomAutoTagRule(deleteAutoTagRuleTrigger.dataset.deleteAutotagRule);
    return;
  }

  const inputTagToggleTrigger = event.target.closest("[data-toggle-input-tag]");

  if (inputTagToggleTrigger) {
    toggleInputTag(inputTagToggleTrigger.dataset.toggleInputTag);
    return;
  }

  const tweetTagToggleTrigger = event.target.closest("[data-toggle-tweet-tag]");

  if (tweetTagToggleTrigger) {
    toggleTweetTag(tweetTagToggleTrigger.dataset.toggleTweetTag);
    return;
  }

  const inputProjectToggleTrigger = event.target.closest(
    "[data-toggle-input-project]",
  );

  if (inputProjectToggleTrigger) {
    toggleInputProject(inputProjectToggleTrigger.dataset.toggleInputProject);
    return;
  }

  const removeReaderTagTrigger = event.target.closest(
    "[data-reader-remove-tag]",
  );

  if (removeReaderTagTrigger) {
    removeReaderTag(removeReaderTagTrigger.dataset.readerRemoveTag);
    return;
  }

  const removeReaderProjectTrigger = event.target.closest(
    "[data-reader-remove-project]",
  );

  if (removeReaderProjectTrigger) {
    removeReaderProject(removeReaderProjectTrigger.dataset.readerRemoveProject);
    return;
  }

  const navLibraryTagTrigger = event.target.closest("[data-nav-library-tag]");

  if (navLibraryTagTrigger) {
    const tag = navLibraryTagTrigger.dataset.navLibraryTag;

    if (!tag) {
      return;
    }

    state.activeTab = "library";
    state.libraryTagFilters = [tag];
    state.libraryProjectFilters = [];
    persistState(state);
    render();
    pushUrlFromState();
    return;
  }

  const navLibraryProjectTrigger = event.target.closest(
    "[data-nav-library-project]",
  );

  if (navLibraryProjectTrigger) {
    const projectId = navLibraryProjectTrigger.dataset.navLibraryProject;

    if (!projectId) {
      return;
    }

    state.activeTab = "library";
    state.libraryProjectFilters = [projectId];
    state.libraryTagFilters = [];
    persistState(state);
    render();
    pushUrlFromState();
    return;
  }

  const toggleLibraryTagTrigger = event.target.closest(
    "[data-toggle-library-tag]",
  );

  if (toggleLibraryTagTrigger) {
    toggleLibraryTagFilter(toggleLibraryTagTrigger.dataset.toggleLibraryTag);
    return;
  }

  const paginationTrigger = event.target.closest(
    "[data-pagination-action][data-pagination-scope]",
  );

  if (paginationTrigger) {
    const scope = paginationTrigger.dataset.paginationScope;
    const action = paginationTrigger.dataset.paginationAction;

    if (scope === "library" && action === "prev") {
      goToPreviousLibraryPage(state, dom);
      return;
    }

    if (scope === "library" && action === "next") {
      goToNextLibraryPage(state, dom);
      return;
    }

    if (scope === "projects" && action === "prev") {
      goToPreviousProjectsPage(state, dom);
      return;
    }

    if (scope === "projects" && action === "next") {
      goToNextProjectsPage(state, dom);
      return;
    }

    if (scope === RSS_PAGINATION_SCOPE && action === "prev") {
      goToPreviousRssPage();
      return;
    }

    if (scope === RSS_PAGINATION_SCOPE && action === "next") {
      goToNextRssPage();
      return;
    }

    return;
  }

  const toggleLibraryProjectTrigger = event.target.closest(
    "[data-toggle-library-project]",
  );

  if (toggleLibraryProjectTrigger) {
    toggleLibraryProjectFilter(
      toggleLibraryProjectTrigger.dataset.toggleLibraryProject,
    );
    return;
  }

  const readerTagToggleTrigger = event.target.closest(
    "[data-reader-open-tags]",
  );

  if (readerTagToggleTrigger) {
    toggleReaderPopover(readerTagToggleTrigger, "tags");
    return;
  }

  const readerProjectToggleTrigger = event.target.closest(
    "[data-reader-open-projects]",
  );

  if (readerProjectToggleTrigger) {
    toggleReaderPopover(readerProjectToggleTrigger, "projects");
    return;
  }

  const readerPickTagTrigger = event.target.closest("[data-reader-pick-tag]");

  if (readerPickTagTrigger) {
    const input = dom.readerMeta.querySelector("[data-reader-input-tags]");
    appendTokenValue(input, readerPickTagTrigger.dataset.readerPickTag);
    return;
  }

  const readerPickProjectTrigger = event.target.closest(
    "[data-reader-pick-project]",
  );

  if (readerPickProjectTrigger) {
    const input = dom.readerMeta.querySelector("[data-reader-input-projects]");
    appendTokenValue(input, readerPickProjectTrigger.dataset.readerPickProject);
    return;
  }

  if (event.target.closest("[data-reader-apply-tags]")) {
    applyReaderTagsFromPopover();
    return;
  }

  if (event.target.closest("[data-reader-apply-projects]")) {
    applyReaderProjectsFromPopover();
    return;
  }

  if (event.target.closest("[data-reader-save-rss]")) {
    saveRssReaderArticleToLibrary();
    return;
  }

  if (event.target.closest("[data-reader-edit-content]")) {
    enterReaderEditMode();
    return;
  }

  if (event.target.closest("[data-reader-save-content]")) {
    saveReaderEditedContent();
    return;
  }

  if (event.target.closest("[data-reader-cancel-edit]")) {
    cancelReaderEditMode();
    return;
  }

  const readerOpenNextRssTrigger = event.target.closest(
    "[data-reader-open-next-rss]",
  );

  if (readerOpenNextRssTrigger) {
    const nextUrl = readerOpenNextRssTrigger.dataset.readerOpenNextRss;

    if (nextUrl) {
      handleRssOpenItem(nextUrl);
    }

    return;
  }

  const readerSideTabTrigger = event.target.closest("[data-reader-side-tab]");

  if (readerSideTabTrigger) {
    const tab = readerSideTabTrigger.dataset.readerSideTab;

    if (tab === "highlights" || tab === "next") {
      readerSideTab = tab;
      renderReaderRssContext(getActiveReaderArticle());
    }

    return;
  }

  const readerOpenRssItemTrigger = event.target.closest(
    "[data-reader-open-rss-item]",
  );

  if (readerOpenRssItemTrigger) {
    const nextUrl = readerOpenRssItemTrigger.dataset.readerOpenRssItem;

    if (nextUrl) {
      handleRssOpenItem(nextUrl);
    }

    return;
  }

  // RSS interactions
  const rssFolderTrigger = event.target.closest("[data-rss-folder]");

  if (rssFolderTrigger) {
    state.rssFolderFilter = rssFolderTrigger.dataset.rssFolder || "";
    // Clear feed selections when switching to a specific folder (not All or Today)
    if (state.rssFolderFilter && state.rssFolderFilter !== "__today__") {
      state.rssSelectedFeedIds = [];
      state.rssActiveFeedId = null;
    } else {
      // For All/Today views, keep selections but filter to valid feeds
      const visibleFeeds = getVisibleRssFeeds();
      const visibleFeedIds = new Set(visibleFeeds.map((feed) => feed.id));
      state.rssSelectedFeedIds = (state.rssSelectedFeedIds || []).filter(
        (feedId) => visibleFeedIds.has(feedId),
      );
      if (state.rssActiveFeedId && !visibleFeedIds.has(state.rssActiveFeedId)) {
        state.rssActiveFeedId = state.rssSelectedFeedIds[0] || null;
      }
    }

    persistState(state);
    renderRssPanel();
    rssAutoRefreshController?.sync();
    return;
  }

  const rssViewTrigger = event.target.closest("[data-rss-view]");

  if (rssViewTrigger) {
    state.rssView = rssViewTrigger.dataset.rssView;
    persistState(state);
    renderRssPanel();
    return;
  }

  const rssSortTrigger = event.target.closest("[data-rss-sort]");

  if (rssSortTrigger) {
    state.rssSort = rssSortTrigger.dataset.rssSort;
    persistState(state);
    renderRssPanel();
    return;
  }

  const rssReadFilterTrigger = event.target.closest("[data-rss-read-filter]");

  if (rssReadFilterTrigger) {
    state.rssReadFilter = rssReadFilterTrigger.dataset.rssReadFilter;
    persistState(state);
    renderRssPanel();
    return;
  }

  const rssPickFolderTrigger = event.target.closest("[data-rss-pick-folder]");

  if (rssPickFolderTrigger && dom.rssFeedFolderInput) {
    dom.rssFeedFolderInput.value =
      rssPickFolderTrigger.dataset.rssPickFolder || "";
    dom.rssFeedFolderInput.focus();
    return;
  }

  const rssRemoveFeedTrigger = event.target.closest("[data-rss-remove-feed]");

  if (rssRemoveFeedTrigger) {
    const feedId = rssRemoveFeedTrigger.dataset.rssRemoveFeed;
    handleDeleteFeed(feedId);
    return;
  }

  const rssSelectFeedTrigger = event.target.closest("[data-rss-select-feed]");

  if (rssSelectFeedTrigger) {
    const nextFeedId = rssSelectFeedTrigger.dataset.rssSelectFeed;
    const feed = state.rssFeeds.find((f) => f.id === nextFeedId);

    // If clicking a feed that's not in the current folder, switch to "All feeds"
    if (state.rssFolderFilter && state.rssFolderFilter !== "__today__") {
      const feedFolder = normalizeRssFolderName(feed?.folder);
      if (feedFolder !== state.rssFolderFilter) {
        state.rssFolderFilter = "";
      }
    }

    const selectedFeedIds = new Set(
      Array.isArray(state.rssSelectedFeedIds) ? state.rssSelectedFeedIds : [],
    );

    if (selectedFeedIds.has(nextFeedId)) {
      selectedFeedIds.delete(nextFeedId);
      if (state.rssActiveFeedId === nextFeedId) {
        state.rssActiveFeedId = [...selectedFeedIds][0] || null;
      }
    } else {
      selectedFeedIds.add(nextFeedId);
      state.rssActiveFeedId = nextFeedId;
    }

    state.rssSelectedFeedIds = [...selectedFeedIds];
    persistState(state);
    renderRssPanel();
    rssAutoRefreshController?.sync();
    return;
  }

  const rssDeselectFeedsTrigger = event.target.closest(
    "[data-rss-deselect-feeds]",
  );

  if (rssDeselectFeedsTrigger) {
    state.rssSelectedFeedIds = [];
    state.rssActiveFeedId = null;
    persistState(state);
    renderRssPanel();
    rssAutoRefreshController?.sync();
    return;
  }

  const rssAddItemTrigger = event.target.closest("[data-rss-add-item]");

  if (rssAddItemTrigger) {
    handleRssAddItem(rssAddItemTrigger.dataset.rssAddItem);
    return;
  }

  const rssOpenItemTrigger = event.target.closest("[data-rss-open-item]");

  if (rssOpenItemTrigger) {
    handleRssOpenItem(rssOpenItemTrigger.dataset.rssOpenItem);
    return;
  }

  if (
    dom.rssSubscribePopover &&
    !dom.rssSubscribePopover.hidden &&
    !dom.rssSubscribePopover.contains(event.target) &&
    !dom.rssOpenSubscribeButton?.contains(event.target)
  ) {
    closeRssSubscribePopover();
  }

  if (dom.readerMeta && !dom.readerMeta.contains(event.target)) {
    closeReaderPopovers();
  }
}

function handleReaderMetaClick(event) {
  if (!readerTtsPlayer) {
    return;
  }

  const consumed = readerTtsPlayer.handleClick(event);

  if (consumed) {
    event.preventDefault();
    event.stopPropagation();
  }
}

function handleReaderMetaChange(event) {
  if (!readerTtsPlayer) {
    return;
  }

  const consumed = readerTtsPlayer.handleChange(event);

  if (consumed) {
    event.stopPropagation();
  }
}

function handleReaderMetaInput(event) {
  if (!readerTtsPlayer) {
    return;
  }

  const consumed = readerTtsPlayer.handleInput(event);

  if (consumed) {
    event.stopPropagation();
  }
}

function handleDocumentPointerDown() {
  selectionMenuWasOpenAtPointerDown = !dom.selectionMenu.hidden;
}

function hasActiveReaderSelection() {
  const selection = window.getSelection();

  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
    return false;
  }

  const anchorNode = selection.anchorNode;
  const focusNode = selection.focusNode;

  if (!anchorNode || !focusNode) {
    return false;
  }

  return (
    dom.readerSurface.contains(anchorNode) &&
    dom.readerSurface.contains(focusNode)
  );
}

function handleDocumentKeydown(event) {
  // Cmd/Ctrl+K to open search
  if ((event.metaKey || event.ctrlKey) && event.key === "k") {
    event.preventDefault();
    if (window.innerWidth <= 761) {
      openMobileSearch();
    } else {
      openDesktopSearch();
    }
    return;
  }

  const articleTrigger = event.target.closest("[data-select-article]");

  if (articleTrigger && (event.key === "Enter" || event.key === " ")) {
    event.preventDefault();
    articleTrigger.click();
    return;
  }

  const projectTrigger = event.target.closest("[data-open-project]");

  if (projectTrigger && (event.key === "Enter" || event.key === " ")) {
    event.preventDefault();
    projectTrigger.click();
  }

  const rssItemTrigger = event.target.closest("[data-rss-open-item]");

  if (rssItemTrigger && (event.key === "Enter" || event.key === " ")) {
    event.preventDefault();
    rssItemTrigger.click();
  }
}

function handleDocumentDragStart(event) {
  if (
    event.target.closest(".article-card") ||
    event.target.closest("#article-list")
  ) {
    event.preventDefault();
    return;
  }

  const projectCard = event.target.closest(".project-card[data-project-id]");

  if (!projectCard) {
    return;
  }

  draggedProjectId = projectCard.dataset.projectId || null;

  if (!draggedProjectId || !event.dataTransfer) {
    return;
  }

  event.dataTransfer.setData("text/plain", draggedProjectId);
  event.dataTransfer.effectAllowed = "move";
  projectCard.classList.add("project-card--dragging");
}

function handleDocumentDragOver(event) {
  const stageFolder = event.target.closest("[data-toggle-project-stage]");

  if (!stageFolder || !draggedProjectId) {
    return;
  }

  event.preventDefault();
  if (event.dataTransfer) {
    event.dataTransfer.dropEffect = "move";
  }

  clearStageDropTargets();
  stageFolder.classList.add("stage-folder--drop-target");
}

function handleDocumentDrop(event) {
  const stageFolder = event.target.closest("[data-toggle-project-stage]");

  if (!stageFolder || !draggedProjectId) {
    clearStageDropTargets();
    return;
  }

  event.preventDefault();

  const stage = stageFolder.dataset.toggleProjectStage;

  if (!["idea", "research", "done"].includes(stage)) {
    clearStageDropTargets();
    return;
  }

  const project = state.projects.find((item) => item.id === draggedProjectId);

  if (!project) {
    clearStageDropTargets();
    return;
  }

  if (project.stage !== stage) {
    project.stage = stage;
    touchProjects(state);
    persistState(state);
    renderProjectFilters(state, dom);
    renderProjects(state, dom);
  }

  clearStageDropTargets();
}

function handleDocumentDragEnd() {
  draggedProjectId = null;
  clearStageDropTargets();
  document
    .querySelectorAll(".project-card--dragging")
    .forEach((card) => card.classList.remove("project-card--dragging"));
}

function clearStageDropTargets() {
  document
    .querySelectorAll(".stage-folder--drop-target")
    .forEach((folder) => folder.classList.remove("stage-folder--drop-target"));
}

function handleProjectEditorKeydown(event) {
  if (!state.selectedProjectId || !state.projectShowMarkdown) {
    return;
  }

  if (!(event.metaKey || event.ctrlKey) || event.altKey) {
    return;
  }

  const key = event.key.toLowerCase();

  if (!["b", "i", "k"].includes(key)) {
    return;
  }

  event.preventDefault();

  if (key === "k") {
    openProjectLinkPopover();
    return;
  } else {
    const didApply = applyProjectMarkdownShortcut(
      dom.projectEditorContent,
      key === "b" ? "bold" : "italic",
    );

    if (!didApply) {
      return;
    }
  }

  const content = dom.projectEditorContent.value;
  const normalizedContent = saveProjectEditorContent(
    state,
    state.selectedProjectId,
    content,
  );
  if (normalizedContent !== content) {
    dom.projectEditorContent.value = normalizedContent;
  }
  renderProjectMarkdownPreview(dom, normalizedContent);
  persistState(state);
}

function handleProjectStageMenuClick(event) {
  const option = event.target.closest("[data-project-stage-option]");

  if (!option) {
    return;
  }

  const stage = option.dataset.projectStageOption;
  handleProjectStageChange(stage);
}

function handleProjectStageChange(stage) {
  if (!state.selectedProjectId) {
    return;
  }

  if (!["idea", "research", "done"].includes(stage)) {
    return;
  }

  const project = state.projects.find(
    (item) => item.id === state.selectedProjectId,
  );

  if (!project || project.stage === stage) {
    return;
  }

  project.stage = stage;
  project.updatedAt = new Date().toISOString();
  markProjectDirty(state, project.id);
  touchProjects(state);
  persistState(state);
  renderProjectFilters(state, dom);
  renderProjects(state, dom);
}

function openProjectLinkPopover() {
  const selectionStart = dom.projectEditorContent.selectionStart ?? 0;
  const selectionEnd = dom.projectEditorContent.selectionEnd ?? selectionStart;
  const currentSelection = dom.projectEditorContent.value
    .slice(selectionStart, selectionEnd)
    .trim();
  const suggestedUrl = /^https?:\/\//i.test(currentSelection)
    ? currentSelection
    : "https://";

  projectLinkSelection = {
    start: selectionStart,
    end: selectionEnd,
  };

  dom.projectLinkInput.value = suggestedUrl;
  dom.projectLinkPopover.hidden = false;
  dom.projectLinkInput.focus();
  dom.projectLinkInput.select();
}

function closeProjectLinkPopover() {
  dom.projectLinkPopover.hidden = true;
  projectLinkSelection = null;
  dom.projectEditorContent.focus();
}

function applyProjectLinkFromPopover() {
  if (!state.selectedProjectId || !projectLinkSelection) {
    closeProjectLinkPopover();
    return;
  }

  const url = dom.projectLinkInput.value.trim();

  if (!url) {
    dom.projectLinkInput.focus();
    return;
  }

  dom.projectEditorContent.focus();
  dom.projectEditorContent.setSelectionRange(
    projectLinkSelection.start,
    projectLinkSelection.end,
  );

  const didApply = applyProjectMarkdownShortcut(
    dom.projectEditorContent,
    "link",
    { url },
  );

  if (!didApply) {
    dom.projectLinkInput.focus();
    return;
  }

  const content = dom.projectEditorContent.value;
  const normalizedContent = saveProjectEditorContent(
    state,
    state.selectedProjectId,
    content,
  );
  if (normalizedContent !== content) {
    dom.projectEditorContent.value = normalizedContent;
  }
  renderProjectMarkdownPreview(dom, normalizedContent);
  persistState(state);
  closeProjectLinkPopover();
}

function handleProjectLinkInputKeydown(event) {
  if (event.key === "Enter") {
    event.preventDefault();
    applyProjectLinkFromPopover();
    return;
  }

  if (event.key === "Escape") {
    event.preventDefault();
    closeProjectLinkPopover();
  }
}

function render() {
  renderTabs();

  if (state.activeTab === "rss") {
    renderRssPanel();
  }

  if (state.activeTab === "library") {
    renderLibraryFilters(state, dom);
    renderArticleList(state, dom);
  }

  if (state.activeTab === "reader") {
    const selectedArticle = getActiveReaderArticle();
    renderReader(state, dom, selectedArticle);
    renderReaderRssContext(selectedArticle);
    updateReaderBackButton();
    focusModeController?.reconcileWithRoute();
    readerTtsPlayer?.mount(selectedArticle);
    wasReaderRendered = true;
  } else {
    if (wasReaderRendered) {
      readerTtsPlayer?.mount(null);
      wasReaderRendered = false;
    }

    focusModeController?.close({ skipRouteSync: true });
  }

  if (state.activeTab === "projects") {
    renderProjectFilters(state, dom);
    renderProjects(state, dom);
  }

  if (state.activeTab === "settings") {
    renderSettings(state, dom);
  }

  queueMarkdownAutoSync("render");

  workspaceContextMenu?.syncSelectionClasses();
}

function renderAndSyncUrl() {
  render();
  syncUrlFromState({ replace: true });
}

function renderTabs() {
  dom.tabButtons.forEach((button) => {
    button.classList.toggle(
      "is-active",
      button.dataset.tabTarget === state.activeTab,
    );
  });

  dom.tabPanels.forEach((panel) => {
    panel.classList.toggle(
      "is-active",
      panel.dataset.tabPanel === state.activeTab,
    );
  });

  if (state.activeTab !== "reader") {
    state.pendingSelection = null;
    dom.selectionMenu.hidden = true;
  }
}

function getSelectedArticle() {
  return (
    state.bookmarks.find(
      (bookmark) => bookmark.id === state.selectedArticleId,
    ) || null
  );
}

function getActiveReaderArticle() {
  return getSelectedArticle() || state.rssReaderArticle || null;
}

// ─── Focus Reading Mode (Paginated Two-Column) ─────────────────────────────────

function openFocusMode(options = {}) {
  focusModeController?.open(options);
}

function closeFocusMode(options = {}) {
  focusModeController?.close(options);
}

function calculateFocusModePages() {
  focusModeController?.calculatePages();
}

function focusModePrevPage() {
  return focusModeController?.prevPage();
}

function focusModeNextPage() {
  return focusModeController?.nextPage();
}

function syncFocusModeContent() {
  focusModeController?.syncContent();
}

function reconcileFocusModeWithRoute() {
  focusModeController?.reconcileWithRoute();
}

function updateReaderBackButton() {
  if (!dom.readerBackButton) {
    return;
  }

  dom.readerBackButton.innerHTML = `
    <i class="fa-solid fa-arrow-left" aria-hidden="true"></i>
    Back
  `;
}

function renderReaderRssContext(activeArticle) {
  if (
    !dom.rssReaderNext ||
    !dom.readerSurface ||
    !dom.readerSidePaneHighlights ||
    !dom.readerSidePaneNext
  ) {
    return;
  }

  dom.readerSurface.querySelector(".reader-rss-next-footer")?.remove();

  const setActiveReaderSideTab = (tab) => {
    const isNextActive = tab === "next";

    dom.readerSideTabs.forEach((button) => {
      const isActive = button.dataset.readerSideTab === tab;
      button.classList.toggle("is-active", isActive);
      button.setAttribute("aria-selected", isActive ? "true" : "false");
    });

    dom.readerSidePaneHighlights.classList.toggle("is-active", !isNextActive);
    dom.readerSidePaneHighlights.hidden = isNextActive;
    dom.readerSidePaneNext.classList.toggle("is-active", isNextActive);
    dom.readerSidePaneNext.hidden = !isNextActive;
  };

  if (!activeArticle || !rssReaderContext) {
    readerSideTab = "highlights";
    setActiveReaderSideTab("highlights");

    const nextTabButton = dom.readerSideTabs.find(
      (button) => button.dataset.readerSideTab === "next",
    );

    if (nextTabButton) {
      nextTabButton.hidden = true;
    }

    dom.rssReaderNext.innerHTML = "";
    return;
  }

  const activeCanonical = canonicalizeArticleUrl(activeArticle.url || "");

  if (activeCanonical !== rssReaderContext.itemCanonicalUrl) {
    rssReaderContext = null;
    readerSideTab = "highlights";
    setActiveReaderSideTab("highlights");

    const nextTabButton = dom.readerSideTabs.find(
      (button) => button.dataset.readerSideTab === "next",
    );

    if (nextTabButton) {
      nextTabButton.hidden = true;
    }

    dom.rssReaderNext.innerHTML = "";
    return;
  }

  const nextTabButton = dom.readerSideTabs.find(
    (button) => button.dataset.readerSideTab === "next",
  );

  if (nextTabButton) {
    nextTabButton.hidden = false;
  }

  const upcomingItems = getUpcomingRssItems(10);

  if (readerSideTab !== "highlights" && readerSideTab !== "next") {
    readerSideTab = "next";
  }

  setActiveReaderSideTab(readerSideTab);

  if (upcomingItems.length === 0) {
    dom.rssReaderNext.innerHTML =
      '<div class="empty-state empty-state--compact empty-state--left"><p>No next article in this feed.</p></div>';
    return;
  }

  dom.rssReaderNext.innerHTML = `
    <div class="reader-next-list">
      ${upcomingItems
        .map(
          (item) => `
            <button
              type="button"
              class="reader-next-item${item.lastOpenedAt ? " is-read" : ""}"
              data-reader-open-rss-item="${escapeHtml(item.url)}"
              title="Open ${escapeHtml(item.title || "Untitled")}" 
            >
              ${escapeHtml(item.title || "Untitled")}
            </button>
          `,
        )
        .join("")}
    </div>
  `;

  const firstNext = upcomingItems[0];

  if (!firstNext) {
    return;
  }

  dom.readerSurface.insertAdjacentHTML(
    "beforeend",
    `
      <div class="reader-rss-next-footer">
        <button
          type="button"
          class="button button--primary reader-rss-next-button"
          data-reader-open-rss-item="${escapeHtml(firstNext.url)}"
        >
          Next
          <i class="fa-solid fa-arrow-right" aria-hidden="true"></i>
        </button>
      </div>
    `,
  );
}

function setRssReaderContextByItemUrl(url) {
  const canonical = canonicalizeArticleUrl(url || "");

  for (const feed of state.rssFeeds || []) {
    for (const item of feed.items || []) {
      const itemCanonical =
        item.canonicalUrl || canonicalizeArticleUrl(item.url || "");

      if (itemCanonical === canonical) {
        rssReaderContext = {
          feedId: feed.id,
          itemCanonicalUrl: itemCanonical,
        };
        return;
      }
    }
  }

  rssReaderContext = null;
}

/**
 * Finds an RSS item URL by its slug, searching all feeds.
 * Used to re-fetch articles on page refresh when cache is empty.
 */
function findRssItemUrlBySlug(slug) {
  for (const feed of state.rssFeeds || []) {
    for (const item of feed.items || []) {
      if (extractUrlSlug(item.url) === slug) {
        return item.url;
      }
    }
  }
  return null;
}

function getNextRssItemContext() {
  if (!rssReaderContext) {
    return null;
  }

  const feed = (state.rssFeeds || []).find(
    (item) => item.id === rssReaderContext.feedId,
  );

  if (!feed) {
    return null;
  }

  const sortedItems = getCachedSortedRssItems(feed, state.rssSort || "newest");
  const currentIndex = sortedItems.findIndex((item) => {
    const itemCanonical =
      item.canonicalUrl || canonicalizeArticleUrl(item.url || "");
    return itemCanonical === rssReaderContext.itemCanonicalUrl;
  });

  if (currentIndex < 0 || currentIndex >= sortedItems.length - 1) {
    return null;
  }

  return {
    feed,
    item: sortedItems[currentIndex + 1],
  };
}

function getUpcomingRssItems(limit = 10) {
  if (!rssReaderContext) {
    return [];
  }

  const feed = (state.rssFeeds || []).find(
    (item) => item.id === rssReaderContext.feedId,
  );

  if (!feed) {
    return [];
  }

  const sortedItems = getCachedSortedRssItems(feed, state.rssSort || "newest");
  const currentIndex = sortedItems.findIndex((item) => {
    const itemCanonical =
      item.canonicalUrl || canonicalizeArticleUrl(item.url || "");
    return itemCanonical === rssReaderContext.itemCanonicalUrl;
  });

  if (currentIndex < 0) {
    return [];
  }

  return sortedItems.slice(currentIndex + 1, currentIndex + 1 + limit);
}

function ensureHighlightedRssReaderArticleInLibrary() {
  const article = state.rssReaderArticle;

  if (!article || !article.isTransientRss || state.selectedArticleId) {
    return false;
  }

  const canonical = canonicalizeArticleUrl(article.url);
  const existing = state.bookmarks.find(
    (bookmark) => canonicalizeArticleUrl(bookmark.url) === canonical,
  );

  if (existing) {
    const existingHighlights = Array.isArray(existing.highlights)
      ? existing.highlights
      : [];
    const incomingHighlights = Array.isArray(article.highlights)
      ? article.highlights
      : [];
    const mergedHighlights = [...existingHighlights];

    incomingHighlights.forEach((highlight) => {
      const duplicate = mergedHighlights.some(
        (item) => item.start === highlight.start && item.end === highlight.end,
      );

      if (!duplicate) {
        mergedHighlights.push(highlight);
      }
    });

    existing.highlights = mergedHighlights;
    existing.tags = [
      ...new Set([...(existing.tags || []), ...(article.tags || [])]),
    ];
    existing.projectIds = [
      ...new Set([
        ...(existing.projectIds || []),
        ...(article.projectIds || []),
      ]),
    ];
    existing.lastOpenedAt = new Date().toISOString();
    // Store RSS origin so "Next in Feed" survives refresh
    if (rssReaderContext && !existing._rssOrigin) {
      existing._rssOrigin = { ...rssReaderContext };
    }
    markBookmarkDirty(state, existing.id);
    touchBookmarks(state);
    state.selectedArticleId = existing.id;
    state.rssReaderArticle = null;
    // Clean up the transient cache entry now that article is in library
    deleteRssReaderCache(extractUrlSlug(article.url)).catch(() => {});
    return true;
  }

  const bookmark = buildRssBookmark(article, article.url, "", {
    applyAutoTags: false,
  });
  bookmark.highlights = Array.isArray(article.highlights)
    ? article.highlights.slice()
    : [];
  // Store RSS origin so "Next in Feed" survives refresh
  if (rssReaderContext) {
    bookmark._rssOrigin = { ...rssReaderContext };
  }

  state.bookmarks.unshift(bookmark);
  state.selectedArticleId = bookmark.id;
  state.rssReaderArticle = null;
  touchBookmarks(state);
  // Clean up the transient cache entry now that article is in library
  deleteRssReaderCache(extractUrlSlug(article.url)).catch(() => {});

  if (bookmark.imageUrl) {
    fetchAndCacheImage(bookmark.id, bookmark.imageUrl).catch(() => {});
  }

  return true;
}

function markArticleAsOpened(articleId) {
  const article = state.bookmarks.find((bookmark) => bookmark.id === articleId);

  if (!article) {
    return;
  }

  article.lastOpenedAt = new Date().toISOString();
  touchBookmarks(state);
}

function markProjectAsOpened(projectId) {
  const project = state.projects.find((item) => item.id === projectId);

  if (!project) {
    return;
  }

  project.lastOpenedAt = new Date().toISOString();
  touchProjects(state);
}

function saveRssScrollPosition() {
  const isMobile = window.matchMedia("(max-width: 761px)").matches;
  const scrollContainer = isMobile ? dom.appMain : dom.rssPanelMain;
  if (scrollContainer) {
    savedRssScrollPosition = scrollContainer.scrollTop;
  }
}

function restoreRssScrollPosition() {
  const isMobile = window.matchMedia("(max-width: 761px)").matches;
  const scrollContainer = isMobile ? dom.appMain : dom.rssPanelMain;
  if (scrollContainer && savedRssScrollPosition > 0) {
    // Use requestAnimationFrame to ensure DOM has rendered
    requestAnimationFrame(() => {
      scrollContainer.scrollTop = savedRssScrollPosition;
    });
  }
}

function switchTab(tabId, shouldRender = true) {
  // Save RSS scroll position before switching away
  if (state.activeTab === "rss" && tabId !== "rss") {
    saveRssScrollPosition();
  }

  // Save library article when leaving reader to go to another tab
  if (
    state.activeTab === "reader" &&
    state.selectedArticleId &&
    !state.rssReaderArticle &&
    tabId !== "library" &&
    tabId !== "reader"
  ) {
    suspendedLibraryArticleId = state.selectedArticleId;
  }

  // Save RSS reader article when leaving reader to go to another tab
  if (
    state.activeTab === "reader" &&
    state.rssReaderArticle &&
    tabId !== "rss" &&
    tabId !== "reader"
  ) {
    suspendedRssReaderArticle = true;
  }

  // Clear suspended article when explicitly navigating to library
  if (tabId === "library" && state.activeTab !== "reader") {
    suspendedLibraryArticleId = null;
  }

  // Clear suspended RSS article when explicitly navigating to rss
  if (tabId === "rss" && state.activeTab !== "reader") {
    suspendedRssReaderArticle = false;
  }

  closeAddModal();
  state.activeTab = tabId;
  persistState(state);

  if (shouldRender) {
    render();
    pushUrlFromState();

    // Restore RSS scroll position when returning
    if (tabId === "rss") {
      restoreRssScrollPosition();
    }
    return;
  }

  renderTabs();
  pushUrlFromState();

  // Restore RSS scroll position when returning
  if (tabId === "rss") {
    restoreRssScrollPosition();
  }
}

async function handleBrowserNavigation() {
  if (isApplyingRoute) {
    return;
  }

  applyRouteFromUrl();
  try {
    await restorePendingRssArticle();
  } catch {
    // Continue even if restoration fails
  }
  persistState(state);
  render();
}

function handleWindowResize() {
  if (state.activeTab !== "library") {
    return;
  }

  updateLibraryVirtualWindow(state, dom);
}

function applyRouteFromUrl() {
  const segments = getRouteSegments();

  if (segments.length === 0) {
    return;
  }

  const routeHead = segments[0];

  if (!VALID_TABS.has(routeHead)) {
    return;
  }

  if (routeHead === "settings") {
    focusModeController?.clearPendingPage();
    state.activeTab = "settings";
    state.settingsSection =
      segments[1] && VALID_SETTINGS_SECTIONS.has(segments[1])
        ? segments[1]
        : "export";
    return;
  }

  if (routeHead === "projects") {
    focusModeController?.clearPendingPage();
    state.activeTab = "projects";
    const projectSlug = segments[1];
    const projectSlugMap = buildProjectSlugMap(state.projects);
    const projectId = projectSlug ? projectSlugMap.get(projectSlug)?.id : null;

    state.selectedProjectId = projectId || null;
    state.selectedProjectSidebarArticleId = null;

    if (segments[2] === "article" && segments[3]) {
      const articleSlugMap = buildArticleSlugMap(state.bookmarks);
      const articleId = articleSlugMap.get(segments[3])?.id || null;
      state.selectedProjectSidebarArticleId = articleId;
    }

    return;
  }

  if (routeHead === "library") {
    const allTags = getAllKnownTags(state);
    const tagSlugMap = buildTagSlugMap(allTags);
    const projectSlugMap = buildProjectSlugMap(state.projects);
    focusModeController?.clearPendingPage();

    const parseTagFilters = (value) =>
      value
        .split("+")
        .map((entry) => entry.trim())
        .filter(Boolean)
        .map((slug) => tagSlugMap.get(slug)?.tag)
        .filter(Boolean);

    const parseProjectFilters = (value) =>
      value
        .split("+")
        .map((entry) => entry.trim())
        .filter(Boolean)
        .map((slug) => projectSlugMap.get(slug)?.id)
        .filter(Boolean);

    const firstSegment = segments[1] || "";
    const secondSegment = segments[2] || "";
    const thirdSegment = segments[3] || "";

    if (firstSegment === "projects" && secondSegment) {
      state.activeTab = "library";
      state.libraryTagFilters = [];
      state.libraryProjectFilters = parseProjectFilters(secondSegment);
      return;
    }

    if (firstSegment === "projects") {
      state.activeTab = "library";
      state.libraryTagFilters = [];
      state.libraryProjectFilters = [];
      return;
    }

    if (firstSegment === "tags" && secondSegment) {
      state.activeTab = "library";
      state.libraryTagFilters = parseTagFilters(secondSegment);
      state.libraryProjectFilters = [];

      if (thirdSegment === "projects" && segments[4]) {
        state.libraryProjectFilters = parseProjectFilters(segments[4]);
      }

      return;
    }

    if (firstSegment.includes("+")) {
      state.activeTab = "library";
      state.libraryTagFilters = parseTagFilters(firstSegment);
      state.libraryProjectFilters =
        secondSegment === "projects" && thirdSegment
          ? parseProjectFilters(thirdSegment)
          : [];
      return;
    }

    const articleSlug = firstSegment;

    if (articleSlug) {
      const articleSlugMap = buildArticleSlugMap(state.bookmarks);
      const articleId = articleSlugMap.get(articleSlug)?.id;

      if (articleId) {
        state.selectedArticleId = articleId;
        state.activeTab = "reader";
        const pendingFocusPage =
          focusModeController?.getRoutePageFromSegments(routeHead, segments) ??
          null;
        focusModeController?.setPendingPage(pendingFocusPage);
        return;
      }
    }

    state.activeTab = "library";
    state.libraryTagFilters = [];
    state.libraryProjectFilters = [];
    return;
  }

  if (routeHead === "rss") {
    // Handle #rss/<slug> for RSS article restoration
    if (segments[1]) {
      pendingRssReaderSlug = decodeURIComponent(segments[1]);
      state.activeTab = "reader";
      const pendingFocusPage =
        focusModeController?.getRoutePageFromSegments(routeHead, segments) ??
        null;
      focusModeController?.setPendingPage(pendingFocusPage);
      return;
    }

    focusModeController?.clearPendingPage();
    state.activeTab = "rss";
    return;
  }

  if (routeHead === "reader") {
    const pendingFocusPage =
      focusModeController?.getRoutePageFromSegments(routeHead, segments) ??
      null;
    focusModeController?.setPendingPage(pendingFocusPage);
    state.activeTab = "reader";
    return;
  }

  focusModeController?.clearPendingPage();
  state.activeTab = routeHead;
}

function pushUrlFromState() {
  syncUrlFromState({ replace: false });
}

function syncUrlFromState({ replace }) {
  if (isApplyingRoute) {
    return;
  }

  const articleSlugById = buildArticleSlugByIdMap(state.bookmarks);
  const projectSlugById = buildProjectSlugByIdMap(state.projects);
  let nextHash = "#add";

  if (state.activeTab === "library") {
    const tagSlugByValue = buildTagSlugByValueMap(getAllKnownTags(state));
    const selectedTagSlugs = state.libraryTagFilters
      .map((tag) => tagSlugByValue.get(tag) || slugify(tag))
      .filter(Boolean);
    const selectedProjectSlugs = state.libraryProjectFilters
      .map((projectId) => projectSlugById.get(projectId))
      .filter(Boolean);

    if (selectedTagSlugs.length > 1) {
      nextHash = `#library/${selectedTagSlugs.map((slug) => encodeURIComponent(slug)).join("+")}`;

      if (selectedProjectSlugs.length > 0) {
        nextHash += `/projects/${selectedProjectSlugs.map((slug) => encodeURIComponent(slug)).join("+")}`;
      }
    } else if (selectedTagSlugs.length === 1) {
      nextHash = `#library/tags/${encodeURIComponent(selectedTagSlugs[0])}`;

      if (selectedProjectSlugs.length > 0) {
        nextHash += `/projects/${selectedProjectSlugs.map((slug) => encodeURIComponent(slug)).join("+")}`;
      }
    } else if (selectedProjectSlugs.length > 0) {
      nextHash = `#library/projects/${selectedProjectSlugs.map((slug) => encodeURIComponent(slug)).join("+")}`;
    } else {
      nextHash = "#library";
    }
  } else if (state.activeTab === "reader") {
    const articleSlug = state.selectedArticleId
      ? articleSlugById.get(state.selectedArticleId)
      : null;
    const focusSuffix = focusModeController?.getReaderRouteSuffix() || "";

    if (articleSlug) {
      nextHash = `#library/${encodeURIComponent(articleSlug)}`;
      nextHash += focusSuffix;
    } else if (state.rssReaderArticle?.url) {
      // Transient RSS article - include slug in hash for refresh persistence
      const rssSlug = extractUrlSlug(state.rssReaderArticle.url);
      nextHash = `#rss/${encodeURIComponent(rssSlug)}`;
      nextHash += focusSuffix;
    } else {
      nextHash = "#reader";
      nextHash += focusSuffix;
    }
  } else if (state.activeTab === "projects") {
    const projectSlug = state.selectedProjectId
      ? projectSlugById.get(state.selectedProjectId)
      : null;
    const projectArticleSlug = state.selectedProjectSidebarArticleId
      ? articleSlugById.get(state.selectedProjectSidebarArticleId)
      : null;

    if (projectSlug && projectArticleSlug) {
      nextHash = `#projects/${encodeURIComponent(projectSlug)}/article/${encodeURIComponent(projectArticleSlug)}`;
    } else if (projectSlug) {
      nextHash = `#projects/${encodeURIComponent(projectSlug)}`;
    } else {
      nextHash = "#projects";
    }
  } else if (state.activeTab === "settings") {
    nextHash =
      state.settingsSection && state.settingsSection !== "export"
        ? `#settings/${encodeURIComponent(state.settingsSection)}`
        : "#settings";
  } else if (state.activeTab === "rss") {
    nextHash = "#rss";
  }

  if (window.location.hash === nextHash) {
    return;
  }

  isApplyingRoute = true;
  window.history[replace ? "replaceState" : "pushState"]({}, "", nextHash);
  isApplyingRoute = false;
}

function getRouteSegments() {
  const hash = window.location.hash.startsWith("#")
    ? window.location.hash.slice(1)
    : window.location.hash;

  return hash
    .split("/")
    .map((segment) => decodeURIComponent(segment.trim()))
    .filter(Boolean);
}

function buildArticleSlugMap(bookmarks) {
  const entries = buildUniqueSlugEntries(bookmarks, (bookmark) =>
    buildArticleSlugSource(bookmark),
  );

  return new Map(entries.map((entry) => [entry.slug, entry.item]));
}

function buildArticleSlugByIdMap(bookmarks) {
  const entries = buildUniqueSlugEntries(bookmarks, (bookmark) =>
    buildArticleSlugSource(bookmark),
  );

  return new Map(entries.map((entry) => [entry.item.id, entry.slug]));
}

function buildProjectSlugMap(projects) {
  const entries = buildUniqueSlugEntries(
    projects,
    (project) => project.name || project.id,
  );
  return new Map(entries.map((entry) => [entry.slug, entry.item]));
}

function buildProjectSlugByIdMap(projects) {
  const entries = buildUniqueSlugEntries(
    projects,
    (project) => project.name || project.id,
  );
  return new Map(entries.map((entry) => [entry.item.id, entry.slug]));
}

function buildTagSlugMap(tags) {
  const entries = buildUniqueSlugEntries(tags, (tag) => tag);
  return new Map(entries.map((entry) => [entry.slug, { tag: entry.item }]));
}

function buildTagSlugByValueMap(tags) {
  const entries = buildUniqueSlugEntries(tags, (tag) => tag);
  return new Map(entries.map((entry) => [entry.item, entry.slug]));
}

function buildUniqueSlugEntries(items, sourceGetter) {
  const used = new Map();

  return items.map((item) => {
    const baseSlug = slugify(sourceGetter(item)) || slugify(item.id) || "item";
    const count = (used.get(baseSlug) || 0) + 1;
    used.set(baseSlug, count);
    const slug = count === 1 ? baseSlug : `${baseSlug}-${count}`;

    return { item, slug };
  });
}

function buildArticleSlugSource(bookmark) {
  try {
    const url = new URL(bookmark.url);
    const segments = url.pathname.split("/").filter(Boolean);
    return segments.at(-1) || bookmark.title || bookmark.id;
  } catch {
    return bookmark.title || bookmark.id;
  }
}

function slugify(value) {
  return (value || "")
    .toString()
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function getAllKnownTags(currentState) {
  const fromBookmarks = currentState.bookmarks.flatMap(
    (bookmark) => bookmark.tags || [],
  );
  return [...new Set([...(currentState.savedTags || []), ...fromBookmarks])];
}

function removeHighlight(highlightId) {
  const article = getSelectedArticle();

  if (!article) {
    return;
  }

  article.highlights = article.highlights.filter(
    (highlight) => highlight.id !== highlightId,
  );
  markBookmarkDirty(state, article.id);
  touchBookmarks(state);
  persistState(state);
  renderAndSyncUrl();
}

function applyDisplayPreferences() {
  const root = document.documentElement;
  const highlightColor = isValidAccent(state.displayHighlightColor)
    ? state.displayHighlightColor
    : "green";
  const accentColor = isValidAccent(highlightColor) ? highlightColor : "green";

  root.setAttribute("data-theme", state.theme === "dark" ? "dark" : "light");
  root.setAttribute(
    "data-font",
    ["mono", "sans", "guardian", "josefin"].includes(state.displayFont)
      ? state.displayFont
      : "mono",
  );
  root.setAttribute("data-highlight-color", accentColor);
  root.setAttribute("data-accent-color", accentColor);

  // Update theme-color meta for status bar / notch area
  const themeColorMeta = document.getElementById("theme-color-meta");
  if (themeColorMeta) {
    themeColorMeta.content = state.theme === "dark" ? "#181716" : "#f8f5ed";
  }
}

// Add dialog tab management
let currentAddTab = "article";

function switchAddDialogTab(tab) {
  currentAddTab = tab;

  // Update tabs
  dom.addDialogTabs.forEach((tabBtn) => {
    tabBtn.classList.toggle("is-active", tabBtn.dataset.addTab === tab);
  });

  // Update panels
  dom.addDialogPanelElements.forEach((panel) => {
    panel.classList.toggle("is-active", panel.dataset.addPanel === tab);
  });

  // Update indicators
  dom.addDialogIndicators.forEach((indicator) => {
    indicator.classList.toggle(
      "is-active",
      indicator.dataset.addIndicator === tab,
    );
  });

  // Scroll to panel on mobile
  const isMobile = window.matchMedia("(max-width: 761px)").matches;
  if (isMobile && dom.addDialogPanels) {
    const panelIndex = ["feed", "article", "project", "tweet"].indexOf(tab);
    const scrollTarget = dom.addDialogPanels.scrollWidth * (panelIndex / 4);
    dom.addDialogPanels.scrollTo({ left: scrollTarget, behavior: "smooth" });
  }

  // Focus appropriate input
  setTimeout(() => {
    if (tab === "feed") {
      dom.addFeedUrl?.focus();
    } else if (tab === "article") {
      dom.articleUrl?.focus();
    } else if (tab === "project") {
      dom.addProjectName?.focus();
    } else if (tab === "tweet") {
      dom.addTweetUrl?.focus();
    }
  }, 100);
}

function getDefaultAddTab() {
  // Select tab based on current main tab
  if (state.activeTab === "rss") return "feed";
  if (state.activeTab === "library") return "article";
  if (state.activeTab === "projects") return "project";
  return "article";
}

function openAddModal(tabOverride) {
  // Toggle behavior: if already open, close it
  if (dom.addArticleDialog?.open) {
    closeAddModal();
    return;
  }

  const targetTab = tabOverride || getDefaultAddTab();
  switchAddDialogTab(targetTab);

  renderArticleTaxonomyHelpers(state, dom);
  renderAddFeedFolderSuggestions();
  renderTweetTagSuggestions();

  // Use show() on mobile to allow header interaction, showModal() on desktop for centering
  const isMobile = window.matchMedia("(max-width: 761px)").matches;
  if (isMobile) {
    dom.addArticleDialog?.show();
    // Set scroll position instantly (no animation) after showing
    setTimeout(() => {
      const panelIndex = ["feed", "article", "project", "tweet"].indexOf(
        targetTab,
      );
      if (dom.addDialogPanels) {
        const scrollTarget = dom.addDialogPanels.scrollWidth * (panelIndex / 4);
        dom.addDialogPanels.scrollTo({
          left: scrollTarget,
          behavior: "instant",
        });
      }
    }, 0);
  } else {
    dom.addArticleDialog?.showModal();
  }

  document.body.classList.add("add-dialog-open");
}

function closeAddModal() {
  dom.addArticleDialog?.close();
  document.body.classList.remove("add-dialog-open");
}

function renderFeedSuggestions() {
  const feeds = runtimeConfig.suggestedFeeds || [];
  if (feeds.length === 0) {
    if (dom.rssFeedSuggestions) dom.rssFeedSuggestions.innerHTML = "";
    if (dom.addFeedSuggestions) dom.addFeedSuggestions.innerHTML = "";
    return;
  }

  // Explore page popover uses data-rss-suggest
  if (dom.rssFeedSuggestions) {
    dom.rssFeedSuggestions.innerHTML = feeds
      .map(
        (f) =>
          `<button type="button" class="chip chip--helper" data-rss-suggest="${escapeHtml(f.url)}" data-rss-suggest-name="${escapeHtml(f.name)}">${escapeHtml(f.name)}</button>`,
      )
      .join("");
  }

  // Add dialog uses data-add-feed-suggest
  if (dom.addFeedSuggestions) {
    dom.addFeedSuggestions.innerHTML = feeds
      .map(
        (f) =>
          `<button type="button" class="chip chip--helper" data-add-feed-suggest="${escapeHtml(f.url)}" data-add-feed-suggest-name="${escapeHtml(f.name)}">${escapeHtml(f.name)}</button>`,
      )
      .join("");
  }
}

function renderAddFeedFolderSuggestions() {
  if (!dom.addFeedFolderSuggestions) return;

  const folders = [
    ...new Set(state.rssFeeds.map((f) => f.folder).filter(Boolean)),
  ];
  if (folders.length === 0) {
    dom.addFeedFolderSuggestions.innerHTML = "";
    return;
  }

  dom.addFeedFolderSuggestions.innerHTML = folders
    .map(
      (folder) =>
        `<button type="button" class="chip chip--helper" data-add-feed-folder="${escapeHtml(folder)}">${escapeHtml(folder)}</button>`,
    )
    .join("");
}

function renderTweetTagSuggestions() {
  if (!dom.addTweetAvailableTags) return;

  const indexes = getDerivedIndexes(state);
  const savedTags = indexes.availableTags || [];
  const currentTags = new Set(
    splitCommaSeparated(dom.addTweetTags?.value || ""),
  );

  if (savedTags.length === 0) {
    dom.addTweetAvailableTags.innerHTML = "";
    return;
  }

  dom.addTweetAvailableTags.innerHTML = `
    <div class="chip-row">
      ${savedTags
        .map((tag) => {
          const isSelected = currentTags.has(tag);
          return `<button type="button" class="chip chip--helper ${isSelected ? "chip--filter-active" : ""}" data-toggle-tweet-tag="${escapeHtml(tag)}" aria-pressed="${isSelected ? "true" : "false"}">${escapeHtml(tag)}</button>`;
        })
        .join("")}
    </div>
  `;
}

async function handleAddFeedSubmit(event) {
  event.preventDefault();

  const url = (dom.addFeedUrl?.value || "").trim();
  const customName = (dom.addFeedName?.value || "").trim();
  const folder = normalizeRssFolderName(dom.addFeedFolder?.value || "");

  if (!url) {
    return;
  }

  const normalized = normalizeUrl(url);
  const alreadySubscribed = state.rssFeeds.some(
    (f) => normalizeUrl(f.url) === normalized,
  );

  if (alreadySubscribed) {
    showTransientStatus("Already subscribed to that feed.");
    return;
  }

  showTransientStatus("Loading feed…");

  try {
    const feedData = await fetchRssFeed(runtimeConfig, url);
    const fetchedCount = Array.isArray(feedData.items)
      ? feedData.items.length
      : 0;
    const feed = {
      id: createUniqueRssFeedId(),
      url: normalized,
      title: customName || feedData.title,
      items: (feedData.items || []).map((item) => ({
        ...item,
        canonicalUrl: canonicalizeArticleUrl(item.url),
      })),
      folder,
      lastFetchedAt: new Date().toISOString(),
      lastFetchItemCount: fetchedCount,
      lastFetchNewItemCount: fetchedCount,
      itemsVersion: 1,
    };

    state.rssFeeds.push(feed);
    pruneRssItemsForRetention();
    state.rssFolderFilter = folder || "";
    state.rssActiveFeedId = feed.id;
    touchRss(state);
    persistState(state);
    dom.addFeedForm?.reset();
    closeAddModal();
    showTransientStatus(`Subscribed to "${feed.title}".`);
    switchTab("rss");
    rssAutoRefreshController?.sync();
  } catch (error) {
    showTransientStatus(error.message || "Could not load feed.");
  }
}

function handleAddProjectSubmit(event) {
  event.preventDefault();
  const name = (dom.addProjectName?.value || "").replace(/\s+/g, " ").trim();
  const description = (dom.addProjectDescription?.value || "").trim();

  if (!name) {
    return;
  }

  const existingProject = state.projects.find(
    (project) => project.name.trim().toLowerCase() === name.toLowerCase(),
  );

  if (existingProject) {
    showTransientStatus(`Project "${name}" already exists.`);
    return;
  }

  const newProject = {
    id: createId("project"),
    name,
    stage: "idea",
    description,
    content: "",
    createdAt: new Date().toISOString(),
  };
  state.projects.unshift(newProject);
  touchProjects(state);
  persistState(state);
  updateSearchIndexForProject(newProject);
  dom.addProjectForm?.reset();
  closeAddModal();
  showTransientStatus(`Created project "${name}".`);
  renderAndSyncUrl();
}

async function handleTweetSubmit(event) {
  event.preventDefault();

  const url = dom.addTweetUrl?.value?.trim() || "";

  if (!url) {
    return;
  }

  if (!isTweetUrl(url)) {
    showTransientStatus("Enter a valid Twitter/X post URL.");
    return;
  }

  const normalizedUrl = normalizeTweetUrl(url);

  // Check for duplicate
  const existingTweet = state.bookmarks.find(
    (b) => b.url === normalizedUrl || b.url === url,
  );
  if (existingTweet) {
    showTransientStatus("That tweet is already in your library.");
    return;
  }

  const submitButton = dom.addTweetForm?.querySelector('button[type="submit"]');
  if (submitButton) {
    submitButton.disabled = true;
    submitButton.innerHTML =
      '<i class="fa-solid fa-spinner fa-spin" aria-hidden="true"></i> Fetching...';
  }

  try {
    showTransientStatus("Fetching tweet...");
    const tweet = await fetchTweet(runtimeConfig, normalizedUrl, {
      timeoutMs: runtimeConfig.requestTimeoutMs,
    });

    // Use blocks from tweet (preserves paragraph structure)
    const tweetBlocks = tweet.blocks;

    // Apply auto-tagging based on tweet content
    const autoTags = getAutoTagSuggestionsForArticle(
      { blocks: tweetBlocks },
      {
        autoTagEnabled: state.autoTagEnabled,
        autoTagUseDefaultCountries: state.autoTagUseDefaultCountries,
        autoTagCustomRules: state.autoTagCustomRules,
      },
    );

    // Parse user tags and always include "tweet" tag, plus auto tags
    const userTags = splitCommaSeparated(dom.addTweetTags?.value || "");
    const tags = syncSavedTags(state, [
      ...new Set(["tweet", ...userTags, ...autoTags]),
    ]);

    // Create the bookmark with tweet data
    const bookmark = {
      id: createId("article"),
      url: normalizedUrl,
      title: `Tweet by ${tweet.authorName}`,
      description: tweet.text,
      source: tweet.authorUrl,
      publishedAt: "",
      previewText: createTweetPreview(tweet.text, 180),
      imageUrl: "",
      tags,
      projectIds: [],
      blocks: tweetBlocks,
      tweetHtml: tweet.html, // Store original embed HTML for rich display
      fetchedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      lastOpenedAt: new Date().toISOString(),
      highlights: [],
    };

    state.bookmarks.unshift(bookmark);
    state.selectedArticleId = bookmark.id;
    state.libraryTagFilters = [];
    state.libraryProjectFilters = [];
    touchBookmarks(state);
    persistState(state);
    dom.addTweetForm?.reset();
    closeAddModal();
    switchTab("library", false);
    renderLibraryFilters(state, dom);
    renderArticleList(state, dom);
    showTransientStatus(`Saved tweet by ${tweet.authorName}.`);
  } catch (error) {
    showTransientStatus(
      error.message || "Could not fetch that tweet. Try again.",
    );
  } finally {
    if (submitButton) {
      submitButton.disabled = false;
      submitButton.innerHTML =
        '<i class="fa-brands fa-x-twitter" aria-hidden="true"></i> Save tweet';
    }
  }
}

function openProjectsCreateFromContextMenu() {
  openAddModal("project");
}

function markRssItemAsReadFromContextMenu(url) {
  if (!url) {
    return;
  }

  markRssItemAsOpened(url);
  persistState(state);

  if (state.activeTab === "rss") {
    renderRssPanel();
  }

  showTransientStatus("Marked item as read.");
}

function showTransientStatus(message) {
  window.clearTimeout(statusTimeoutId);
  dom.fetchStatus.textContent = message;
  dom.fetchStatus.hidden = false;
  statusTimeoutId = window.setTimeout(() => {
    dom.fetchStatus.hidden = true;
    dom.fetchStatus.textContent = "";
  }, 3200);
}

function setStatus(message) {
  showTransientStatus(message);
}

function hasDuplicateArticle(normalizedUrl) {
  const canonicalUrl = canonicalizeArticleUrl(normalizedUrl);

  return state.bookmarks.some(
    (bookmark) => canonicalizeArticleUrl(bookmark.url) === canonicalUrl,
  );
}

function stageFetchedArticle(normalizedUrl, article) {
  const suggestedTags = getAutoTagSuggestionsForArticle(article, {
    autoTagEnabled: state.autoTagEnabled,
    autoTagUseDefaultCountries: state.autoTagUseDefaultCountries,
    autoTagCustomRules: state.autoTagCustomRules,
  });

  pendingFetchedArticle = {
    normalizedUrl,
    article,
  };
  lastDraftNormalizedUrl = normalizedUrl;
  state.pendingAutoTagSuggestions = suggestedTags;
  state.pendingAutoTagSelected = [...suggestedTags];

  if (suggestedTags.length > 0) {
    mergeTagsIntoInput(suggestedTags);
    renderArticleTaxonomyHelpers(state, dom);
    syncBookmarkSubmitButton();
    showTransientStatus(
      `Found ${suggestedTags.length} auto-tag suggestion${
        suggestedTags.length === 1 ? "" : "s"
      }. Review tags, then save.`,
    );
    return;
  }

  savePendingFetchedArticle();
}

function appendTokenValue(field, token) {
  const value = token?.trim();

  if (!value || !field) {
    return;
  }

  const existingValues = field.value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const hasValue = existingValues.some(
    (item) => item.toLowerCase() === value.toLowerCase(),
  );

  if (!hasValue) {
    existingValues.push(value);
    field.value = existingValues.join(", ");
  }

  field.focus();
}

function clearPendingFetchedArticle() {
  pendingFetchedArticle = null;
  state.pendingAutoTagSuggestions = [];
  state.pendingAutoTagSelected = [];
  renderArticleTaxonomyHelpers(state, dom);
  syncBookmarkSubmitButton();
}

function toggleInputTag(tag) {
  const normalized = normalizeTag(tag || "");

  if (!normalized) {
    return;
  }

  const currentTags = new Set(splitCommaSeparated(dom.articleTags.value));

  if (currentTags.has(normalized)) {
    removeTokenValue(dom.articleTags, normalized);
  } else {
    appendTokenValue(dom.articleTags, normalized);
  }

  syncPendingAutoTagSelectionFromInput();
  renderArticleTaxonomyHelpers(state, dom);
}

function toggleTweetTag(tag) {
  const normalized = normalizeTag(tag || "");

  if (!normalized || !dom.addTweetTags) {
    return;
  }

  const currentTags = new Set(splitCommaSeparated(dom.addTweetTags.value));

  if (currentTags.has(normalized)) {
    removeTokenValue(dom.addTweetTags, normalized);
  } else {
    appendTokenValue(dom.addTweetTags, normalized);
  }

  renderTweetTagSuggestions();
}

function syncPendingAutoTagSelectionFromInput() {
  if (
    !pendingFetchedArticle ||
    !Array.isArray(state.pendingAutoTagSuggestions)
  ) {
    return;
  }

  const selected = new Set(splitCommaSeparated(dom.articleTags.value));
  state.pendingAutoTagSelected = state.pendingAutoTagSuggestions.filter((tag) =>
    selected.has(tag),
  );
  renderArticleTaxonomyHelpers(state, dom);
}

function toggleInputProject(projectName) {
  const normalized = String(projectName || "").trim();

  if (!normalized) {
    return;
  }

  const currentProjects = splitProjectNames(dom.articleProjects.value);
  const hasProject = currentProjects.some(
    (name) => name.toLowerCase() === normalized.toLowerCase(),
  );

  if (hasProject) {
    dom.articleProjects.value = currentProjects
      .filter((name) => name.toLowerCase() !== normalized.toLowerCase())
      .join(", ");
    dom.articleProjects.focus();
  } else {
    appendTokenValue(dom.articleProjects, normalized);
  }

  renderArticleTaxonomyHelpers(state, dom);
}

function syncBookmarkSubmitButton() {
  const button = dom.bookmarkForm?.querySelector('button[type="submit"]');

  if (!button) {
    return;
  }

  button.innerHTML = pendingFetchedArticle
    ? '<i class="fa-solid fa-floppy-disk" aria-hidden="true"></i> Save article'
    : '<i class="fa-solid fa-link" aria-hidden="true"></i> Fetch article';
}

function mergeTagsIntoInput(tags) {
  const merged = new Set(splitCommaSeparated(dom.articleTags.value));

  tags.forEach((tag) => {
    const normalized = normalizeTag(tag);

    if (normalized) {
      merged.add(normalized);
    }
  });

  dom.articleTags.value = [...merged].join(", ");
}

function removeTokenValue(field, token) {
  const normalized = normalizeTag(token || "");

  if (!normalized || !field) {
    return;
  }

  field.value = splitCommaSeparated(field.value)
    .filter((item) => item !== normalized)
    .join(", ");
  field.focus();
}

function savePendingFetchedArticle() {
  if (!pendingFetchedArticle) {
    return;
  }

  const tags = syncSavedTags(state, splitCommaSeparated(dom.articleTags.value));
  const projectIds = syncProjectsByName(
    state,
    splitProjectNames(dom.articleProjects.value),
    createId,
  );
  const { normalizedUrl, article } = pendingFetchedArticle;

  const bookmark = {
    id: createId("article"),
    url: normalizedUrl,
    title: article.title || normalizedUrl,
    description: article.description || "",
    source: article.source || "",
    publishedAt: article.publishedAt || "",
    previewText: previewText(flattenBlocks(article.blocks), 180),
    imageUrl: article.imageUrl || "",
    tags,
    projectIds,
    blocks: article.blocks,
    fetchedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    lastOpenedAt: new Date().toISOString(),
    highlights: [],
  };

  clearPendingFetchedArticle();

  state.bookmarks.unshift(bookmark);
  state.selectedArticleId = bookmark.id;
  state.libraryTagFilters = [];
  state.libraryProjectFilters = [];
  touchBookmarks(state);
  persistState(state);
  updateSearchIndexForBookmark(bookmark);
  dom.bookmarkForm.reset();
  closeAddModal();
  switchTab("library", false);
  renderLibraryFilters(state, dom);
  renderArticleList(state, dom);
  showTransientStatus(`Saved "${bookmark.title}" to the library.`);

  if (bookmark.imageUrl) {
    fetchAndCacheImage(bookmark.id, bookmark.imageUrl).catch(() => {});
  }
}

function saveCustomAutoTagRule() {
  const tag = normalizeTag(dom.autoTagRuleTag?.value || "");
  const keywords = splitCommaSeparated(dom.autoTagRuleKeywords?.value || "");

  if (!tag || keywords.length === 0) {
    setStatus("Provide a tag and at least one keyword.");
    return;
  }

  const merged = normalizeAutoTagRules([
    ...(state.autoTagCustomRules || []),
    { tag, keywords },
  ]);

  state.autoTagCustomRules = merged;
  touchMeta(state);
  persistState(state);
  dom.autoTagRuleForm?.reset();
  if (dom.autoTagRuleDetails) {
    dom.autoTagRuleDetails.open = false;
  }
  renderSettings(state, dom);
  setStatus(`Saved auto-tag rule for "${tag}".`);
}

function deleteCustomAutoTagRule(tag) {
  const normalizedTag = normalizeTag(tag || "");

  if (!normalizedTag) {
    return;
  }

  state.autoTagCustomRules = (state.autoTagCustomRules || []).filter(
    (rule) => normalizeTag(rule.tag || "") !== normalizedTag,
  );
  touchMeta(state);
  persistState(state);
  renderSettings(state, dom);
  setStatus(`Deleted auto-tag rule "${normalizedTag}".`);
}

function importAutoTagRulesFromInput() {
  const raw = (dom.autoTagImportInput?.value || "").trim();

  if (!raw) {
    setStatus("Paste JSON rules before importing.");
    return;
  }

  try {
    const imported = parseAutoTagRulesImport(raw);

    state.autoTagCustomRules = normalizeAutoTagRules([
      ...(state.autoTagCustomRules || []),
      ...imported,
    ]);
    touchMeta(state);
    persistState(state);
    renderSettings(state, dom);
    setStatus(
      `Imported ${imported.length} auto-tag rule${
        imported.length === 1 ? "" : "s"
      }.`,
    );
  } catch (error) {
    setStatus(error?.message || "Could not import rules. Check JSON format.");
  }
}

function toggleLibraryTagFilter(tag) {
  if (!tag) {
    return;
  }

  if (state.libraryTagFilters.includes(tag)) {
    state.libraryTagFilters = state.libraryTagFilters.filter(
      (currentTag) => currentTag !== tag,
    );
  } else {
    state.libraryTagFilters = [...state.libraryTagFilters, tag];
  }

  persistState(state);
  renderLibraryFilters(state, dom);
  renderArticleList(state, dom);
  pushUrlFromState();
}

function toggleLibraryProjectFilter(projectId) {
  if (!projectId) {
    return;
  }

  if (state.libraryProjectFilters.includes(projectId)) {
    state.libraryProjectFilters = state.libraryProjectFilters.filter(
      (currentProjectId) => currentProjectId !== projectId,
    );
  } else {
    state.libraryProjectFilters = [...state.libraryProjectFilters, projectId];
  }

  persistState(state);
  renderLibraryFilters(state, dom);
  renderArticleList(state, dom);
  pushUrlFromState();
}

function toggleProjectsStageFilter(stage) {
  if (!["idea", "research", "done"].includes(stage)) {
    return;
  }

  if (state.projectsStageFilter === stage) {
    state.projectsStageFilter = null;
  } else {
    state.projectsStageFilter = stage;
  }

  persistState(state);
  renderProjectFilters(state, dom);
  renderProjects(state, dom);
}

function applyReaderTagsFromPopover() {
  const article = getActiveReaderArticle();
  const input = dom.readerMeta.querySelector("[data-reader-input-tags]");

  if (!article || !input) {
    return;
  }

  const newTags = syncSavedTags(state, splitCommaSeparated(input.value));

  if (newTags.length === 0) {
    closeReaderPopovers();
    return;
  }

  const merged = [...new Set([...(article.tags || []), ...newTags])];
  article.tags = merged;
  markBookmarkDirty(state, article.id);
  const didSave = ensureHighlightedRssReaderArticleInLibrary();
  touchBookmarks(state);
  persistState(state);
  renderAndSyncUrl();

  if (didSave) {
    showTransientStatus("Saved this RSS article to library after adding tag.");
  } else {
    setStatus(
      `Added ${newTags.length} tag${newTags.length === 1 ? "" : "s"} to this article.`,
    );
  }
}

function applyReaderProjectsFromPopover() {
  const article = getActiveReaderArticle();
  const input = dom.readerMeta.querySelector("[data-reader-input-projects]");

  if (!article || !input) {
    return;
  }

  const names = splitProjectNames(input.value);

  if (names.length === 0) {
    closeReaderPopovers();
    return;
  }

  const projectIds = syncProjectsByName(state, names, createId);
  article.projectIds = [
    ...new Set([...(article.projectIds || []), ...projectIds]),
  ];
  markBookmarkDirty(state, article.id);
  const didSave = ensureHighlightedRssReaderArticleInLibrary();
  touchBookmarks(state);
  persistState(state);
  renderAndSyncUrl();

  if (didSave) {
    showTransientStatus(
      "Saved this RSS article to library after adding project.",
    );
  } else {
    setStatus(
      `Added ${projectIds.length} project${projectIds.length === 1 ? "" : "s"} to this article.`,
    );
  }
}

function removeReaderTag(tag) {
  const article = getActiveReaderArticle();

  if (!article || !tag) {
    return;
  }

  article.tags = (article.tags || []).filter(
    (currentTag) => currentTag !== tag,
  );
  markBookmarkDirty(state, article.id);
  touchBookmarks(state);
  persistState(state);
  renderAndSyncUrl();
  setStatus(`Removed tag ${tag} from this article.`);
}

function removeReaderProject(projectId) {
  const article = getActiveReaderArticle();

  if (!article || !projectId) {
    return;
  }

  const project = state.projects.find((item) => item.id === projectId);
  article.projectIds = (article.projectIds || []).filter(
    (currentProjectId) => currentProjectId !== projectId,
  );
  markBookmarkDirty(state, article.id);
  touchBookmarks(state);
  persistState(state);
  renderAndSyncUrl();
  setStatus(`Removed ${project?.name || "this project"} from this article.`);
}

function toggleReaderPopover(trigger, type) {
  closeReaderPopovers();
  const wrap = trigger.closest(".reader-meta-action-wrap");
  const popover = wrap?.querySelector(`[data-reader-popover="${type}"]`);

  if (!popover) {
    return;
  }

  popover.hidden = false;
  const input = popover.querySelector("input");
  input?.focus();
}

function closeReaderPopovers() {
  if (!dom.readerMeta) {
    return;
  }

  dom.readerMeta
    .querySelectorAll("[data-reader-popover]")
    .forEach((popover) => {
      popover.hidden = true;
    });

  readerTtsPlayer?.closeSettingsPopover();
}

// ─── RSS ─────────────────────────────────────────────────────────────────────

function getRssRefreshButtonTitle() {
  return "Refresh all feeds";
}

function handleDeleteFeed(feedId) {
  const removedFeed = state.rssFeeds.find((feed) => feed.id === feedId) || null;

  if (
    !window.confirm(
      `Delete RSS feed "${removedFeed?.title || removedFeed?.url || "this feed"}"? This removes the feed and its fetched items from Explore.`,
    )
  ) {
    return;
  }

  state.rssFeeds = state.rssFeeds.filter((f) => f.id !== feedId);
  markRssFeedDirty(state, feedId);
  state.rssSelectedFeedIds = (state.rssSelectedFeedIds || []).filter(
    (id) => id !== feedId,
  );
  touchRss(state);

  if (removedFeed?.items?.length) {
    const activeImageIds = collectActiveRssImageCacheIds();

    for (const item of removedFeed.items) {
      const cacheId = getRssItemImageCacheId(item);

      if (cacheId && !activeImageIds.has(cacheId)) {
        evictCachedImage(cacheId).catch(() => {});
      }
    }
  }

  const hasFolder = state.rssFeeds.some(
    (feed) => normalizeRssFolderName(feed.folder) === state.rssFolderFilter,
  );

  if (
    state.rssFolderFilter &&
    state.rssFolderFilter !== "__today__" &&
    !hasFolder
  ) {
    state.rssFolderFilter = "";
  }

  const visibleFeeds = getVisibleRssFeeds();

  if (!visibleFeeds.some((feed) => feed.id === state.rssActiveFeedId)) {
    state.rssActiveFeedId = visibleFeeds[0]?.id || null;
  }

  persistState(state);
  renderAndSyncUrl();
  rssAutoRefreshController?.sync();
}

function renderRssPanel() {
  if (!dom.rssFolderList || !dom.rssFeedList || !dom.rssItems) {
    return;
  }

  const folderEntries = [
    ...new Set(
      state.rssFeeds
        .map((feed) => normalizeRssFolderName(feed.folder))
        .filter(Boolean),
    ),
  ]
    .sort((left, right) => left.localeCompare(right))
    .map((folder) => ({
      folder,
      count: state.rssFeeds.filter(
        (feed) => normalizeRssFolderName(feed.folder) === folder,
      ).length,
    }));

  const todayItemCount = getTodayRssItems().length;
  const visibleFeeds = getVisibleRssFeeds();
  const selectedFeedIdSet = new Set(
    Array.isArray(state.rssSelectedFeedIds) ? state.rssSelectedFeedIds : [],
  );

  // Ensure active feed is valid
  if (
    state.rssActiveFeedId &&
    !state.rssFeeds.some((feed) => feed.id === state.rssActiveFeedId)
  ) {
    state.rssActiveFeedId =
      selectedFeedIdSet.size > 0 ? [...selectedFeedIdSet][0] : null;
  }

  const latestVisibleFetch = visibleFeeds.reduce((latest, feed) => {
    const fetchedAtMs = Date.parse(feed.lastFetchedAt || "");

    if (!Number.isFinite(fetchedAtMs)) {
      return latest;
    }

    if (!latest) {
      return feed;
    }

    const latestMs = Date.parse(latest.lastFetchedAt || "");
    return fetchedAtMs > latestMs ? feed : latest;
  }, null);

  if (dom.rssLastUpdated) {
    dom.rssLastUpdated.textContent = latestVisibleFetch?.lastFetchedAt
      ? `Last updated: ${formatDate(latestVisibleFetch.lastFetchedAt)}`
      : "Last updated: Never";
  }

  dom.rssFolderList.innerHTML = `
    <button
      type="button"
      class="rss-folder-chip sidebar-folder-button ${!state.rssFolderFilter ? "sidebar-folder-button--active" : ""}"
      data-rss-folder=""
      aria-pressed="${!state.rssFolderFilter ? "true" : "false"}"
    >
      <span class="sidebar-folder-button__name">
        <i class="fa-solid fa-folder" aria-hidden="true"></i>
        All feeds
      </span>
      <span class="sidebar-folder-button__count">${state.rssFeeds.length}</span>
    </button>
    <button
      type="button"
      class="rss-folder-chip sidebar-folder-button ${state.rssFolderFilter === "__today__" ? "sidebar-folder-button--active" : ""}"
      data-rss-folder="__today__"
      aria-pressed="${state.rssFolderFilter === "__today__" ? "true" : "false"}"
    >
      <span class="sidebar-folder-button__name">
        <i class="fa-solid fa-calendar-day" aria-hidden="true"></i>
        Today
      </span>
      <span class="sidebar-folder-button__count">${todayItemCount}</span>
    </button>
    ${folderEntries
      .map(
        ({ folder, count }) => `
        <button
          type="button"
          class="rss-folder-chip sidebar-folder-button ${state.rssFolderFilter === folder ? "sidebar-folder-button--active" : ""}"
          data-rss-folder="${escapeHtml(folder)}"
          aria-pressed="${state.rssFolderFilter === folder ? "true" : "false"}"
        >
          <span class="sidebar-folder-button__name">
            <i class="fa-solid fa-folder" aria-hidden="true"></i>
            ${escapeHtml(folder)}
          </span>
          <span class="sidebar-folder-button__count">${count}</span>
        </button>
      `,
      )
      .join("")}
    ${state.rssFeeds.length > 0 ? '<hr class="rss-sidebar-divider">' : ""}
    ${
      selectedFeedIdSet.size > 0
        ? `
      <button
        type="button"
        class="rss-sidebar-deselect"
        data-rss-deselect-feeds
        title="Deselect all feeds"
      >
        <i class="fa-solid fa-xmark" aria-hidden="true"></i>
        Deselect (${selectedFeedIdSet.size})
      </button>
    `
        : ""
    }
    ${state.rssFeeds
      .map((feed) => {
        const feedFolder = normalizeRssFolderName(feed.folder);
        const isInCurrentFolder =
          !state.rssFolderFilter ||
          state.rssFolderFilter === "__today__" ||
          feedFolder === state.rssFolderFilter;
        return `
        <div
          class="rss-sidebar-feed ${selectedFeedIdSet.has(feed.id) ? "rss-sidebar-feed--active" : ""} ${!isInCurrentFolder ? "rss-sidebar-feed--outside" : ""}"
          data-rss-select-feed="${escapeHtml(feed.id)}"
          title="${escapeHtml(feed.title || feed.url)}${!isInCurrentFolder ? " (not in this folder)" : ""}"
        >
          <span class="rss-sidebar-feed__name">
            <i class="fa-solid fa-rss" aria-hidden="true"></i>
            ${escapeHtml(feed.title || feed.url)}
          </span>
          <button
            class="rss-sidebar-feed__remove"
            data-rss-remove-feed="${escapeHtml(feed.id)}"
            title="Remove feed"
            type="button"
            aria-label="Remove ${escapeHtml(feed.title || "feed")}"
          ><i class="fa-solid fa-xmark" aria-hidden="true"></i></button>
        </div>
      `;
      })
      .join("")}
  `;

  if (dom.rssRefreshActiveButton) {
    dom.rssRefreshActiveButton.title = getRssRefreshButtonTitle();
  }

  document.querySelectorAll("[data-rss-view]").forEach((button) => {
    button.classList.toggle(
      "view-btn--active",
      button.dataset.rssView === (state.rssView || "2"),
    );
  });

  document.querySelectorAll("[data-rss-sort]").forEach((button) => {
    button.classList.toggle(
      "view-btn--active",
      button.dataset.rssSort === (state.rssSort || "newest"),
    );
  });

  document.querySelectorAll("[data-rss-read-filter]").forEach((button) => {
    button.classList.toggle(
      "view-btn--active",
      button.dataset.rssReadFilter === (state.rssReadFilter || "all"),
    );
  });

  const sortedItems = filterRssItemsByReadState(
    getRssItemsForCurrentScope(),
    state.rssReadFilter || "all",
  );

  const paginationKey = [
    state.rssFolderFilter || "__all__",
    state.rssSort || "newest",
    state.rssReadFilter || "all",
    state.rssView || "2",
    sortedItems.length,
    visibleFeeds.map((feed) => feed.id).join("|"),
  ].join("::");
  const { pagedItems, currentPage, totalPages } = getPaginatedItems({
    scope: RSS_PAGINATION_SCOPE,
    items: sortedItems,
    view: state.rssView || "2",
    paginationKey,
  });

  if (sortedItems.length === 0) {
    dom.rssItems.innerHTML = `<div class="empty-state empty-state--compact empty-state--left"><p>${escapeHtml(
      getRssEmptyStateMessage({
        readFilter: state.rssReadFilter || "all",
        scope: state.rssFolderFilter === "__today__" ? "today" : "folder",
      }),
    )}</p></div>`;
    return;
  }

  const savedUrls = new Set(
    state.bookmarks.map((b) => canonicalizeArticleUrl(b.url)),
  );

  const paginationMarkup = buildPaginationMarkup({
    scope: RSS_PAGINATION_SCOPE,
    currentPage,
    totalPages,
    label: "RSS pagination",
  });

  dom.rssItems.className = `rss-items rss-items--view-${state.rssView || "2"}`;
  dom.rssItems.innerHTML =
    pagedItems
      .map((item) => {
        const isSaved = savedUrls.has(
          item.canonicalUrl || canonicalizeArticleUrl(item.url),
        );
        const isRead = Boolean(item.lastOpenedAt);
        const description = getRssItemCardDescription(item);
        const imageUrl = getRssItemCardImageUrl(item);
        const parts = [
          item.author,
          item.pubDate ? formatDate(item.pubDate) : "",
        ].filter(Boolean);
        const meta = parts.join(" · ");

        return `
      <div class="rss-item-card${isRead ? " rss-item-card--read" : ""}"
           data-rss-open-item="${escapeHtml(item.url)}"
           tabindex="0"
           role="button"
           aria-label="${escapeHtml(item.title)}">
        ${imageUrl ? `<img class="rss-item-card__image" src="${escapeHtml(imageUrl)}" alt="" loading="lazy" draggable="false" />` : ""}
        <div class="rss-item-card__header">
          <h3>${escapeHtml(item.title)}</h3>
        </div>
        ${meta ? `<p class="rss-item-card__meta">${escapeHtml(meta)}</p>` : ""}
        <button
          class="rss-item-card__add${isSaved ? " rss-item-card__add--saved" : ""}"
          data-rss-add-item="${escapeHtml(item.url)}"
          title="${isSaved ? "Already in library" : "Add to library"}"
          type="button"
          ${isSaved ? "aria-disabled='true'" : ""}
        >${isSaved ? '<i class="fa-solid fa-check" aria-hidden="true"></i> In Library' : '<i class="fa-solid fa-plus" aria-hidden="true"></i> Library'}</button>
      </div>`;
      })
      .join("") + paginationMarkup;

  scheduleRssImagePrefetch(pagedItems);

  if (dom.rssSubscribePopover && !dom.rssSubscribePopover.hidden) {
    positionRssSubscribePopover();
  }
}

async function handleRssSubscribeSubmit(event) {
  event.preventDefault();

  const url = (dom.rssFeedUrlInput?.value || "").trim();
  const customName = (dom.rssFeedNameInput?.value || "").trim();
  const folder = normalizeRssFolderName(dom.rssFeedFolderInput?.value || "");

  if (!url) {
    return;
  }

  const normalized = normalizeUrl(url);
  const alreadySubscribed = state.rssFeeds.some(
    (f) => normalizeUrl(f.url) === normalized,
  );

  if (alreadySubscribed) {
    showRssStatus("Already subscribed to that feed.");
    return;
  }

  showRssStatus("Loading feed\u2026");

  try {
    const feedData = await fetchRssFeed(runtimeConfig, url);
    const fetchedCount = Array.isArray(feedData.items)
      ? feedData.items.length
      : 0;
    const feed = {
      id: createUniqueRssFeedId(),
      url: normalized,
      title: customName || feedData.title,
      items: (feedData.items || []).map((item) => ({
        ...item,
        canonicalUrl: canonicalizeArticleUrl(item.url),
      })),
      folder,
      lastFetchedAt: new Date().toISOString(),
      lastFetchItemCount: fetchedCount,
      lastFetchNewItemCount: fetchedCount,
      itemsVersion: 1,
    };

    state.rssFeeds.push(feed);
    pruneRssItemsForRetention();
    state.rssFolderFilter = folder || "";
    state.rssActiveFeedId = feed.id;
    touchRss(state);
    persistState(state);
    dom.rssSubscribeForm?.reset();
    closeRssSubscribePopover();
    clearRssStatus();
    renderRssPanel();
    rssAutoRefreshController?.sync();
  } catch (error) {
    showRssStatus(error.message || "Could not load feed.");
  }
}

async function refreshAllRssFeeds(options = {}) {
  const silent = options.silent === true;
  const source = options.source || "manual";

  if (state.rssFeeds.length === 0) {
    if (!silent) {
      showRssStatus("No feeds to refresh.");
    }
    return;
  }

  if (rssRefreshInFlight) {
    return rssRefreshInFlight.promise;
  }

  if (!silent) {
    setRssRefreshButtonRefreshing(true, 0, state.rssFeeds.length);
  }

  const refreshPromise = (async () => {
    let successCount = 0;
    let totalNewItems = 0;

    for (let i = 0; i < state.rssFeeds.length; i++) {
      const feed = state.rssFeeds[i];

      if (!silent) {
        setRssRefreshButtonRefreshing(true, i + 1, state.rssFeeds.length);
      }

      try {
        const latest = await fetchRssFeed(runtimeConfig, feed.url);
        const previousByUrl = new Map(
          (feed.items || []).map((item) => [
            item.canonicalUrl || canonicalizeArticleUrl(item.url),
            item,
          ]),
        );

        const nextItems = (latest.items || []).map((item) => {
          const canonicalUrl = canonicalizeArticleUrl(item.url);
          const previous = previousByUrl.get(canonicalUrl);

          return {
            ...item,
            canonicalUrl,
            lastOpenedAt: previous?.lastOpenedAt || "",
          };
        });
        const fetchedCount = nextItems.length;
        const newCount = nextItems.reduce((count, item) => {
          if (previousByUrl.has(item.canonicalUrl)) {
            return count;
          }
          return count + 1;
        }, 0);

        // Preserve existing title (may be user-customized) - don't overwrite with fetched title
        feed.items = nextItems;
        feed.lastFetchedAt = new Date().toISOString();
        feed.lastFetchItemCount = fetchedCount;
        feed.lastFetchNewItemCount = newCount;
        feed.lastFetchSource = source;
        feed.itemsVersion = Number(feed.itemsVersion || 0) + 1;
        successCount++;
        totalNewItems += newCount;
      } catch (error) {
        // Continue with other feeds even if one fails
      }
    }

    if (successCount > 0) {
      pruneRssItemsForRetention();
      touchRss(state);
      persistState(state);
      renderRssPanel();
      rssAutoRefreshController?.sync();

      if (!silent && totalNewItems > 0) {
        showTransientStatus(
          `Found ${totalNewItems} new item${totalNewItems === 1 ? "" : "s"}.`,
        );
      }
    }

    setRssRefreshButtonRefreshing(false);
    rssRefreshInFlight = null;
  })();

  rssRefreshInFlight = {
    feedId: "__all__",
    promise: refreshPromise,
  };

  return refreshPromise;
}

function openRssSubscribePopover() {
  if (!dom.rssSubscribePopover || !dom.rssOpenSubscribeButton) {
    return;
  }

  renderRssFolderSuggestions();
  dom.rssSubscribePopover.hidden = false;
  positionRssSubscribePopover();

  // Re-apply after the browser finishes layout, ensuring measured width is final.
  window.requestAnimationFrame(() => {
    positionRssSubscribePopover();
  });

  if (dom.rssFeedUrlInput) {
    try {
      dom.rssFeedUrlInput.focus({ preventScroll: true });
    } catch {
      dom.rssFeedUrlInput.focus();
    }
  }
}

function closeRssSubscribePopover() {
  if (!dom.rssSubscribePopover) {
    return;
  }

  dom.rssSubscribePopover.hidden = true;
}

function positionRssSubscribePopover() {
  if (!dom.rssSubscribePopover || dom.rssSubscribePopover.hidden) {
    return;
  }

  const wrap = dom.rssOpenSubscribeButton?.closest(".rss-subscribe-wrap");
  const panel = wrap?.closest(".panel-card--rss-main");

  if (!wrap || !panel) {
    return;
  }

  const popover = dom.rssSubscribePopover;
  const panelRect = panel.getBoundingClientRect();
  const wrapRect = wrap.getBoundingClientRect();
  const panelPadding = 8;
  const safePanelWidth = Math.max(220, panelRect.width - panelPadding * 2);

  // Anchor to the trigger's top-right corner first.
  popover.style.left = "0px";
  popover.style.right = "auto";
  popover.style.maxWidth = `${safePanelWidth}px`;

  const popoverRect = popover.getBoundingClientRect();
  const popoverWidth = popoverRect.width;
  const desiredLeft = wrapRect.width - popoverWidth;
  const minLeft = panelRect.left + panelPadding - wrapRect.left;
  const maxLeft = panelRect.right - panelPadding - wrapRect.left - popoverWidth;
  const clampedLeft = Math.min(maxLeft, Math.max(minLeft, desiredLeft));

  popover.style.left = `${clampedLeft}px`;
}

function renderRssFolderSuggestions() {
  if (!dom.rssFolderSuggestions) {
    return;
  }

  const folders = [
    ...new Set(
      state.rssFeeds
        .map((feed) => normalizeRssFolderName(feed.folder))
        .filter(Boolean),
    ),
  ].sort((left, right) => left.localeCompare(right));

  if (folders.length === 0) {
    dom.rssFolderSuggestions.innerHTML = "";
    return;
  }

  dom.rssFolderSuggestions.innerHTML = folders
    .map(
      (folder) => `
        <button
          type="button"
          class="chip chip--helper"
          data-rss-pick-folder="${escapeHtml(folder)}"
        >
          ${escapeHtml(folder)}
        </button>
      `,
    )
    .join("");
}

async function handleRssOpenItem(url) {
  setRssReaderContextByItemUrl(url);
  readerSideTab = "next";
  const normalized = normalizeUrl(url);
  const canonical = canonicalizeArticleUrl(normalized);
  const requestVersion = ++rssOpenRequestVersion;
  const existing = state.bookmarks.find(
    (b) => canonicalizeArticleUrl(b.url) === canonical,
  );

  if (existing) {
    // Store RSS origin so "Next in Feed" survives refresh
    if (rssReaderContext && !existing._rssOrigin) {
      existing._rssOrigin = { ...rssReaderContext };
      touchBookmarks(state);
    }
    state.selectedArticleId = existing.id;
    state.rssReaderArticle = null;
    markArticleAsOpened(existing.id);
    markRssItemAsOpened(url);
    persistState(state);
    switchTab("reader");
    scrollReaderToTop();
    return;
  }

  // Check if RSS item already has fetched article content stored
  const rssItem = findRssItemByUrl(normalized);
  if (rssItem?.fetchedArticle) {
    state.selectedArticleId = null;
    state.rssReaderArticle = {
      ...rssItem.fetchedArticle,
      lastOpenedAt: new Date().toISOString(),
    };
    markRssItemAsOpened(url);
    persistState(state);
    switchTab("reader");
    scrollReaderToTop();
    return;
  }

  // Open reader immediately with a lightweight placeholder while network fetch runs.
  state.selectedArticleId = null;
  state.rssReaderArticle = {
    id: createId("rss-reader"),
    url: normalized,
    title: "Loading article...",
    description: "",
    source: "",
    publishedAt: "",
    previewText: "",
    imageUrl: "",
    tags: [],
    projectIds: [],
    blocks: [{ type: "paragraph", text: "Fetching article content..." }],
    fetchedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    lastOpenedAt: new Date().toISOString(),
    highlights: [],
    isTransientRss: true,
  };
  markRssItemAsOpened(url);
  persistState(state);
  switchTab("reader");
  scrollReaderToTop();

  showRssStatus("Fetching article\u2026");

  try {
    const article = await fetchArticle(runtimeConfig, url);

    if (requestVersion !== rssOpenRequestVersion) {
      return;
    }

    const suggestedTags = getAutoTagSuggestionsForArticle(article, {
      autoTagEnabled: state.autoTagEnabled,
      autoTagUseDefaultCountries: state.autoTagUseDefaultCountries,
      autoTagCustomRules: state.autoTagCustomRules,
    });
    state.selectedArticleId = null;
    state.rssReaderArticle = buildRssReaderArticle(
      article,
      normalized,
      suggestedTags,
    );

    // Store the fetched article content on the RSS item for instant access later
    storeArticleOnRssItem(normalized, state.rssReaderArticle);

    // Cache the article by slug for URL-based restoration on refresh
    // Include feed context so "Next in Feed" works after page refresh
    const slug = extractUrlSlug(normalized);
    putRssReaderCache(slug, {
      ...state.rssReaderArticle,
      _feedContext: rssReaderContext,
    }).catch(() => {});

    persistState(state);
    clearRssStatus();
    renderAndSyncUrl();
    scrollReaderToTop();
  } catch (error) {
    if (requestVersion !== rssOpenRequestVersion) {
      return;
    }

    if (state.rssReaderArticle?.url === normalized) {
      state.rssReaderArticle = {
        ...state.rssReaderArticle,
        title: "Could not open article",
        blocks: [
          {
            type: "paragraph",
            text:
              error.message ||
              "Could not fetch article. Try adding the URL manually.",
          },
        ],
      };
      persistState(state);
      renderAndSyncUrl();
      scrollReaderToTop();
    }

    showRssStatus(
      error.message || "Could not fetch article. Try adding the URL manually.",
    );
  }
}

async function handleRssAddItem(url) {
  const normalized = normalizeUrl(url);
  const canonical = canonicalizeArticleUrl(normalized);
  const sourceRssItem = findRssItemByUrl(normalized);
  const existing = state.bookmarks.find(
    (b) => canonicalizeArticleUrl(b.url) === canonical,
  );

  if (existing) {
    showRssStatus(`\u201C${existing.title}\u201D is already in your library.`);
    return;
  }

  showRssStatus("Fetching article\u2026");

  try {
    const article = await fetchArticle(runtimeConfig, url);
    const bookmark = buildRssBookmark(
      article,
      normalized,
      sourceRssItem?.thumbnail || "",
    );

    state.bookmarks.unshift(bookmark);
    touchBookmarks(state);
    persistState(state);

    if (bookmark.imageUrl) {
      fetchAndCacheImage(bookmark.id, bookmark.imageUrl).catch(() => {});
    }

    clearRssStatus();
    renderRssPanel();
    showTransientStatus(`Saved \u201C${bookmark.title}\u201D to the library.`);
  } catch (error) {
    showRssStatus(
      error.message || "Could not fetch article. Try adding the URL manually.",
    );
  }
}

function buildRssBookmark(
  article,
  normalizedUrl,
  fallbackImageUrl = "",
  options = {},
) {
  const shouldApplyAutoTags = options.applyAutoTags !== false;
  const autoTags = shouldApplyAutoTags
    ? getAutoTagSuggestionsForArticle(article, {
        autoTagEnabled: state.autoTagEnabled,
        autoTagUseDefaultCountries: state.autoTagUseDefaultCountries,
        autoTagCustomRules: state.autoTagCustomRules,
      })
    : [];
  const existingTags = Array.isArray(article.tags) ? article.tags : [];
  const tags = syncSavedTags(state, [
    ...new Set([...existingTags, ...autoTags]),
  ]);
  const projectIds = Array.isArray(article.projectIds)
    ? [...new Set(article.projectIds.filter(Boolean))]
    : [];

  return {
    id: createId("article"),
    url: normalizedUrl,
    title: article.title || normalizedUrl,
    description: article.description || "",
    source: article.source || "",
    publishedAt: article.publishedAt || "",
    previewText: previewText(flattenBlocks(article.blocks), 180),
    imageUrl: article.imageUrl || fallbackImageUrl || "",
    tags,
    projectIds,
    blocks: article.blocks,
    fetchedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    lastOpenedAt: new Date().toISOString(),
    highlights: [],
  };
}

function buildRssReaderArticle(article, normalizedUrl, suggestedTags = []) {
  return {
    id: createId("rss-reader"),
    url: normalizedUrl,
    title: article.title || normalizedUrl,
    description: article.description || "",
    source: article.source || "",
    publishedAt: article.publishedAt || "",
    previewText: previewText(flattenBlocks(article.blocks), 180),
    imageUrl: article.imageUrl || "",
    tags: [...new Set((suggestedTags || []).filter(Boolean))],
    projectIds: [],
    blocks: article.blocks,
    fetchedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    lastOpenedAt: new Date().toISOString(),
    highlights: [],
    isTransientRss: true,
  };
}

/**
 * Restores an RSS reader article from cache using its slug.
 * Called after route parsing when #reader/rss/<slug> is detected.
 */
async function restorePendingRssArticle() {
  if (!pendingRssReaderSlug) {
    return;
  }

  const slug = pendingRssReaderSlug;
  pendingRssReaderSlug = null;

  // Check if an article with this slug exists in library
  const existing = state.bookmarks.find((b) => extractUrlSlug(b.url) === slug);

  if (existing) {
    state.selectedArticleId = existing.id;
    state.rssReaderArticle = null;
    persistState(state);
    render();
    scrollReaderToTop();
    return;
  }

  // Try to find the RSS item by slug and check for stored article content
  const urlFromFeeds = findRssItemUrlBySlug(slug);
  if (urlFromFeeds) {
    const rssItem = findRssItemByUrl(urlFromFeeds);
    if (rssItem?.fetchedArticle) {
      state.selectedArticleId = null;
      setRssReaderContextByItemUrl(urlFromFeeds);
      if (rssReaderContext) {
        readerSideTab = "next";
      }
      state.rssReaderArticle = {
        ...rssItem.fetchedArticle,
        lastOpenedAt: new Date().toISOString(),
      };
      persistState(state);
      render();
      scrollReaderToTop();
      return;
    }
  }

  // Try to restore from rssReaderCache (legacy/fallback)
  const cached = await getRssReaderCache(slug);

  if (cached) {
    state.selectedArticleId = null;
    // Restore feed context for "Next in Feed" navigation
    if (cached._feedContext) {
      rssReaderContext = cached._feedContext;
      readerSideTab = "next";
    } else if (cached.url) {
      setRssReaderContextByItemUrl(cached.url);
      if (rssReaderContext) {
        readerSideTab = "next";
      }
    }
    // Remove internal _feedContext before setting state
    const { _feedContext, ...articleWithoutContext } = cached;
    state.rssReaderArticle = articleWithoutContext;
    persistState(state);
    render();
    scrollReaderToTop();
    return;
  }

  // Not in rssReaderCache - try to find URL from feeds and re-fetch
  if (urlFromFeeds) {
    // Re-fetch the article using the found URL
    handleRssOpenItem(urlFromFeeds);
    return;
  }

  // URL not found in feeds - show error
  state.selectedArticleId = null;
  state.rssReaderArticle = {
    id: createId("rss-reader"),
    url: "",
    title: "Article not found",
    description: "",
    source: "",
    publishedAt: "",
    previewText: "",
    imageUrl: "",
    tags: [],
    projectIds: [],
    blocks: [
      {
        type: "paragraph",
        text: "This article is no longer available. It may have been removed based on your retention settings. Please open it again from the Explore tab.",
      },
    ],
    fetchedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    lastOpenedAt: new Date().toISOString(),
    highlights: [],
    isTransientRss: true,
  };
  persistState(state);
  render();
  // Sync URL to #reader since there's no valid RSS article
  syncUrlFromState({ replace: true });
  scrollReaderToTop();
}

function goToNextRssPage() {
  const sortedItems = filterRssItemsByReadState(
    getRssItemsForCurrentScope(),
    state.rssReadFilter || "all",
  );
  const pageSize = state.rssView === "3" ? 21 : 20;
  const totalPages = Math.max(1, Math.ceil(sortedItems.length / pageSize));

  if (!goToNextPage(RSS_PAGINATION_SCOPE, totalPages)) {
    return;
  }

  renderRssPanel();
}

function goToPreviousRssPage() {
  if (!goToPreviousPage(RSS_PAGINATION_SCOPE)) {
    return;
  }

  renderRssPanel();
}

function getTodayRssItems(feeds = state.rssFeeds) {
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const startMs = startOfToday.getTime();
  const items = [];

  for (const feed of feeds || []) {
    for (const item of feed.items || []) {
      const pubMs = Date.parse(item.pubDate || "");

      if (Number.isFinite(pubMs) && pubMs >= startMs) {
        items.push(item);
      }
    }
  }

  return sortRssItems(items, state.rssSort || "newest");
}

function filterRssItemsByReadState(items, readFilter) {
  if (readFilter === "unread") {
    return items.filter((item) => !item.lastOpenedAt);
  }

  if (readFilter === "read") {
    return items.filter((item) => Boolean(item.lastOpenedAt));
  }

  return items;
}

function getRssEmptyStateMessage({ readFilter, scope }) {
  if (scope === "today") {
    if (readFilter === "unread") {
      return "No unread items published today yet.";
    }

    if (readFilter === "read") {
      return "No read items published today yet.";
    }

    return "No items published today yet.";
  }

  if (readFilter === "unread") {
    return "No unread items found in this view.";
  }

  if (readFilter === "read") {
    return "No read items found in this view.";
  }

  return scope === "folder"
    ? "No items found in this folder yet."
    : "No items found in this view.";
}

function getVisibleRssFeeds() {
  const uniqueFeeds = dedupeRssFeedsById(state.rssFeeds || []);

  if (!state.rssFolderFilter || state.rssFolderFilter === "__today__") {
    return uniqueFeeds;
  }

  return uniqueFeeds.filter(
    (feed) => normalizeRssFolderName(feed.folder) === state.rssFolderFilter,
  );
}

function normalizeRssFolderName(value) {
  const normalized = String(value || "").trim();
  return normalized.toLowerCase() === "unfiled" ? "" : normalized;
}

function dedupeRssFeedsById(feeds) {
  const seen = new Set();
  const deduped = [];

  for (const feed of feeds || []) {
    if (!feed || typeof feed !== "object") {
      continue;
    }

    const feedId = String(feed.id || "").trim();

    if (!feedId || seen.has(feedId)) {
      continue;
    }

    seen.add(feedId);
    deduped.push(feed);
  }

  return deduped;
}

function createUniqueRssFeedId() {
  let id = createId("feed");

  while (state.rssFeeds.some((feed) => feed.id === id)) {
    id = createId("feed");
  }

  return id;
}

function getRssItemsForCurrentScope() {
  const visibleFeeds = getVisibleRssFeeds();
  const selectedFeedIdSet = new Set(
    Array.isArray(state.rssSelectedFeedIds) ? state.rssSelectedFeedIds : [],
  );
  // Apply feed selection filter if any feeds are selected
  const scopedFeeds =
    selectedFeedIdSet.size > 0
      ? visibleFeeds.filter((feed) => selectedFeedIdSet.has(feed.id))
      : visibleFeeds;

  if (state.rssFolderFilter === "__today__") {
    return getTodayRssItems(scopedFeeds);
  }

  const items = [];

  for (const feed of scopedFeeds) {
    items.push(...(feed.items || []));
  }

  return sortRssItems(items, state.rssSort || "newest");
}

function getRssItemCardDescription(item) {
  const text = String(item?.excerpt || "")
    .replace(/\s+/g, " ")
    .trim();

  if (!text) {
    return "";
  }

  const firstSentence = text.match(/[^.!?]+[.!?](\s|$)/)?.[0]?.trim() || text;
  const MAX_LENGTH = 280;

  if (firstSentence.length <= MAX_LENGTH) {
    return firstSentence;
  }

  return `${firstSentence.slice(0, MAX_LENGTH - 3).trim()}...`;
}

function getRssItemCardImageUrl(item) {
  const raw = String(item?.thumbnail || "").trim();

  if (!raw) {
    return "";
  }

  const normalized = normalizeRssImageUrl(raw, item?.url || "");

  if (!normalized) {
    return "";
  }

  const cacheId = getRssItemImageCacheId(item);

  if (cacheId) {
    const cached = getCachedBlobUrl(cacheId);

    if (cached) {
      return cached;
    }
  }

  return normalized;
}

function scheduleRssImagePrefetch(items) {
  const candidates = [];

  for (const item of items || []) {
    const raw = String(item?.thumbnail || "").trim();

    if (!raw) {
      continue;
    }

    const url = normalizeRssImageUrl(raw, item?.url || "");
    const cacheId = getRssItemImageCacheId(item);

    if (!url || !cacheId) {
      continue;
    }

    candidates.push({ id: cacheId, imageUrl: url });
  }

  if (candidates.length === 0) {
    return;
  }

  ensurePageImagesLoaded(candidates).catch(() => {});

  for (const candidate of candidates.slice(0, 24)) {
    if (!getCachedBlobUrl(candidate.id)) {
      rssImagePrefetchQueue.set(candidate.id, candidate.imageUrl);
    }
  }

  if (rssImagePrefetchTimerId !== null) {
    return;
  }

  rssImagePrefetchTimerId = window.setTimeout(() => {
    rssImagePrefetchTimerId = null;
    processRssImagePrefetchQueue();
  }, 250);
}

async function processRssImagePrefetchQueue() {
  if (rssImagePrefetchQueue.size === 0) {
    return;
  }

  const batch = [...rssImagePrefetchQueue.entries()].slice(0, 2);

  batch.forEach(([id]) => {
    rssImagePrefetchQueue.delete(id);
  });

  await Promise.allSettled(
    batch.map(([id, url]) => fetchAndCacheImage(id, url)),
  );

  if (rssImagePrefetchQueue.size > 0) {
    window.setTimeout(() => {
      processRssImagePrefetchQueue().catch(() => {});
    }, 300);
  }
}

function normalizeRssImageUrl(raw, baseUrl) {
  try {
    const parsed = new URL(raw, baseUrl || window.location.href);

    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return parsed.toString();
    }
  } catch {
    return "";
  }

  return "";
}

function getRssItemImageCacheId(item) {
  const canonical =
    String(item?.canonicalUrl || "") ||
    canonicalizeArticleUrl(String(item?.url || ""));

  return canonical ? `rss-item-image::${canonical}` : "";
}

function collectActiveRssImageCacheIds() {
  const ids = new Set();

  for (const feed of state.rssFeeds) {
    for (const item of feed.items || []) {
      const cacheId = getRssItemImageCacheId(item);

      if (cacheId) {
        ids.add(cacheId);
      }
    }
  }

  return ids;
}

function sortRssItems(items, sortMode) {
  const toEpoch = (value) => {
    const epoch = Date.parse(value || "");
    return Number.isFinite(epoch) ? epoch : 0;
  };

  return [...items].sort((left, right) => {
    if (sortMode === "oldest") {
      return toEpoch(left.pubDate) - toEpoch(right.pubDate);
    }

    if (sortMode === "latest-opened") {
      const openedDelta =
        toEpoch(right.lastOpenedAt) - toEpoch(left.lastOpenedAt);

      if (openedDelta !== 0) {
        return openedDelta;
      }
    }

    return toEpoch(right.pubDate) - toEpoch(left.pubDate);
  });
}

function getCachedSortedRssItems(feed, sortMode) {
  if (!feed) {
    return [];
  }

  const key = [
    feed.id,
    sortMode,
    Number(feed.itemsVersion || 0),
    (feed.items || []).length,
  ].join("::");

  if (rssSortedItemsCache.has(key)) {
    return rssSortedItemsCache.get(key);
  }

  const sorted = sortRssItems(feed.items || [], sortMode);
  rssSortedItemsCache.set(key, sorted);

  if (rssSortedItemsCache.size > 48) {
    const firstKey = rssSortedItemsCache.keys().next().value;

    if (firstKey) {
      rssSortedItemsCache.delete(firstKey);
    }
  }

  return sorted;
}

function pruneRssItemsForRetention() {
  if (state.rssRetentionDays === "never") {
    return 0;
  }

  const retentionDays = Number(state.rssRetentionDays);

  if (!Number.isFinite(retentionDays) || retentionDays <= 0) {
    return 0;
  }

  const cutoffMs = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const bookmarkedUrls = new Set(
    state.bookmarks.map((bookmark) => canonicalizeArticleUrl(bookmark.url)),
  );
  let removedCount = 0;
  const removedImageIds = new Set();

  state.rssFeeds = state.rssFeeds.map((feed) => {
    const nextItems = [];

    for (const item of feed.items || []) {
      const canonicalUrl =
        item.canonicalUrl || canonicalizeArticleUrl(item.url || "");

      if (bookmarkedUrls.has(canonicalUrl)) {
        nextItems.push(item);
        continue;
      }

      const pubMs = Date.parse(item.pubDate || "");

      if (!Number.isFinite(pubMs) || pubMs >= cutoffMs) {
        nextItems.push(item);
        continue;
      }

      const cacheId = getRssItemImageCacheId(item);

      if (cacheId) {
        removedImageIds.add(cacheId);
      }
    }

    removedCount += Math.max(0, (feed.items || []).length - nextItems.length);
    const didChange = nextItems.length !== (feed.items || []).length;

    return {
      ...feed,
      items: nextItems,
      itemsVersion: didChange
        ? Number(feed.itemsVersion || 0) + 1
        : Number(feed.itemsVersion || 0),
    };
  });

  if (removedCount > 0) {
    touchRss(state);
  }

  if (removedImageIds.size > 0) {
    const activeImageIds = collectActiveRssImageCacheIds();

    for (const imageId of removedImageIds) {
      if (!activeImageIds.has(imageId)) {
        evictCachedImage(imageId).catch(() => {});
      }
    }
  }

  return removedCount;
}

function markRssItemAsOpened(url) {
  const canonical = canonicalizeArticleUrl(url);
  const openedAt = new Date().toISOString();

  state.rssFeeds = state.rssFeeds.map((feed) => {
    let didChange = false;
    const nextItems = (feed.items || []).map((item) => {
      const itemCanonical =
        item.canonicalUrl || canonicalizeArticleUrl(item.url || "");

      if (itemCanonical !== canonical) {
        return item;
      }

      if (item.lastOpenedAt === openedAt) {
        return item;
      }

      didChange = true;
      return {
        ...item,
        canonicalUrl: itemCanonical,
        lastOpenedAt: openedAt,
      };
    });

    return {
      ...feed,
      items: nextItems,
      itemsVersion: didChange
        ? Number(feed.itemsVersion || 0) + 1
        : Number(feed.itemsVersion || 0),
    };
  });

  touchRss(state);
}

function findRssItemByUrl(url) {
  const canonical = canonicalizeArticleUrl(url);

  for (const feed of state.rssFeeds) {
    for (const item of feed.items || []) {
      const itemCanonical =
        item.canonicalUrl || canonicalizeArticleUrl(item.url || "");

      if (itemCanonical === canonical) {
        return item;
      }
    }
  }

  return null;
}

/**
 * Store fetched article content on an RSS item for instant access later.
 * The article will be pruned along with the RSS item based on retention settings.
 */
function storeArticleOnRssItem(url, article) {
  const canonical = canonicalizeArticleUrl(url);
  let didUpdate = false;

  state.rssFeeds = state.rssFeeds.map((feed) => {
    const nextItems = (feed.items || []).map((item) => {
      const itemCanonical =
        item.canonicalUrl || canonicalizeArticleUrl(item.url || "");

      if (itemCanonical !== canonical) {
        return item;
      }

      didUpdate = true;
      return {
        ...item,
        fetchedArticle: article,
      };
    });

    return {
      ...feed,
      items: nextItems,
    };
  });

  if (didUpdate) {
    touchRss(state);
  }
}

function saveRssReaderArticleToLibrary() {
  const article = state.rssReaderArticle;

  if (!article) {
    return;
  }

  const canonical = canonicalizeArticleUrl(article.url);
  const existing = state.bookmarks.find(
    (bookmark) => canonicalizeArticleUrl(bookmark.url) === canonical,
  );

  if (existing) {
    state.selectedArticleId = existing.id;
    state.rssReaderArticle = null;
    persistState(state);
    renderAndSyncUrl();
    showTransientStatus(`Saved already: \"${existing.title}\".`);
    return;
  }

  const sourceRssItem = findRssItemByUrl(article.url);
  const bookmark = buildRssBookmark(
    article,
    article.url,
    sourceRssItem?.thumbnail || "",
    {
      applyAutoTags: false,
    },
  );
  // Store RSS origin so "Next in Feed" survives refresh
  if (rssReaderContext) {
    bookmark._rssOrigin = { ...rssReaderContext };
  }
  state.bookmarks.unshift(bookmark);
  state.selectedArticleId = bookmark.id;
  state.rssReaderArticle = null;
  touchBookmarks(state);
  persistState(state);

  if (bookmark.imageUrl) {
    fetchAndCacheImage(bookmark.id, bookmark.imageUrl).catch(() => {});
  }

  renderAndSyncUrl();
  showTransientStatus(`Saved \"${bookmark.title}\" to the library.`);
}

// Reader edit mode
let readerEditOriginalHtml = null;

function handleReaderEditKeydown(event) {
  // Escape cancels
  if (event.key === "Escape") {
    event.preventDefault();
    cancelReaderEditMode();
    return;
  }
  // Cmd/Ctrl+Enter saves
  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    saveReaderEditedContent();
    return;
  }
}

function enterReaderEditMode() {
  const article = getActiveReaderArticle();
  if (!article || article.isTransientRss) return;

  // Store original HTML for cancel
  readerEditOriginalHtml = dom.readerSurface.innerHTML;

  // Make content editable
  dom.readerSurface.contentEditable = "true";
  dom.readerSurface.classList.add("reader-surface--editing");

  // Toggle buttons
  const editBtn = dom.readerMeta.querySelector("[data-reader-edit-content]");
  const saveBtn = dom.readerMeta.querySelector("[data-reader-save-content]");
  const cancelBtn = dom.readerMeta.querySelector("[data-reader-cancel-edit]");

  if (editBtn) editBtn.hidden = true;
  if (saveBtn) saveBtn.hidden = false;
  if (cancelBtn) cancelBtn.hidden = false;

  // Hide other action buttons while editing
  const tagBtn = dom.readerMeta.querySelector("[data-reader-open-tags]");
  const projectBtn = dom.readerMeta.querySelector(
    "[data-reader-open-projects]",
  );
  if (tagBtn) tagBtn.closest(".reader-meta-action-wrap").hidden = true;
  if (projectBtn) projectBtn.closest(".reader-meta-action-wrap").hidden = true;

  // Add keyboard shortcuts
  dom.readerSurface.addEventListener("keydown", handleReaderEditKeydown);

  // Focus the content
  dom.readerSurface.focus();
}

function saveReaderEditedContent() {
  const article = getActiveReaderArticle();
  if (!article || article.isTransientRss) return;

  // Parse the edited HTML back to blocks
  const newBlocks = parseEditedHtmlToBlocks(dom.readerSurface);

  // Check if content actually changed
  const oldText = article.blocks.map((b) => b.text).join("\n\n");
  const newText = newBlocks.map((b) => b.text).join("\n\n");
  const contentChanged = oldText !== newText;

  // Update the bookmark
  const bookmark = state.bookmarks.find((b) => b.id === article.id);
  if (bookmark) {
    bookmark.blocks = newBlocks;

    // Clear highlights if content changed significantly (offsets won't match)
    if (contentChanged && bookmark.highlights?.length > 0) {
      bookmark.highlights = [];
      showTransientStatus(
        "Content updated. Highlights cleared due to changes.",
      );
    } else {
      showTransientStatus("Content updated.");
    }

    // Update preview text
    bookmark.previewText = previewText(flattenBlocks(newBlocks), 180);

    markBookmarkDirty(state, bookmark.id);
    touchBookmarks(state);
    persistState(state);
  }

  exitReaderEditMode();
  renderReader(state, dom, getActiveReaderArticle());
}

function cancelReaderEditMode() {
  // Restore original HTML
  if (readerEditOriginalHtml !== null) {
    dom.readerSurface.innerHTML = readerEditOriginalHtml;
  }
  exitReaderEditMode();
}

function exitReaderEditMode() {
  readerEditOriginalHtml = null;

  // Remove keyboard shortcuts
  dom.readerSurface.removeEventListener("keydown", handleReaderEditKeydown);

  // Exit contenteditable
  dom.readerSurface.contentEditable = "false";
  dom.readerSurface.classList.remove("reader-surface--editing");

  // Toggle buttons back
  const editBtn = dom.readerMeta.querySelector("[data-reader-edit-content]");
  const saveBtn = dom.readerMeta.querySelector("[data-reader-save-content]");
  const cancelBtn = dom.readerMeta.querySelector("[data-reader-cancel-edit]");

  if (editBtn) editBtn.hidden = false;
  if (saveBtn) saveBtn.hidden = true;
  if (cancelBtn) cancelBtn.hidden = true;

  // Show other action buttons
  const tagBtn = dom.readerMeta.querySelector("[data-reader-open-tags]");
  const projectBtn = dom.readerMeta.querySelector(
    "[data-reader-open-projects]",
  );
  if (tagBtn) tagBtn.closest(".reader-meta-action-wrap").hidden = false;
  if (projectBtn) projectBtn.closest(".reader-meta-action-wrap").hidden = false;
}

function parseEditedHtmlToBlocks(container) {
  const blocks = [];

  // Walk through child elements
  for (const child of container.children) {
    const tagName = child.tagName.toLowerCase();
    const text = child.textContent?.trim() || "";

    if (!text) continue;

    if (tagName === "h1" || tagName === "h2" || tagName === "h3") {
      blocks.push({ type: "heading", text });
    } else {
      blocks.push({ type: "paragraph", text });
    }
  }

  // If no block elements found, treat entire content as one paragraph
  if (blocks.length === 0) {
    const text = container.textContent?.trim() || "";
    if (text) {
      blocks.push({ type: "paragraph", text });
    }
  }

  return blocks;
}

function setRssRefreshButtonRefreshing(isRefreshing, current = 0, total = 0) {
  const btn = dom.rssRefreshActiveButton;

  if (!btn) {
    return;
  }

  if (isRefreshing) {
    btn.disabled = true;
    btn.title = getRssRefreshButtonTitle();
    const progressText = total > 0 ? ` ${current}/${total}` : "";
    btn.innerHTML = `<i class="fa-solid fa-rotate rss-icon-spinning" aria-hidden="true"></i> Refreshing${progressText}`;
    return;
  }

  btn.disabled = false;
  btn.title = getRssRefreshButtonTitle();
  btn.innerHTML =
    '<i class="fa-solid fa-rotate" aria-hidden="true"></i> Refresh';
}

function showRssStatus(message) {
  showTransientStatus(message);
}

function clearRssStatus() {
  // messages issued via showTransientStatus clear automatically
}

// ═══════════════════════════════════════════════════════════════════════════
// Search Functions
// ═══════════════════════════════════════════════════════════════════════════

function toggleDesktopSearch() {
  if (isSearchExpanded) {
    closeDesktopSearch();
  } else {
    openDesktopSearch();
  }
}

function openDesktopSearch() {
  isSearchExpanded = true;
  dom.searchContainer?.classList.add("is-visible");
  dom.searchToggle?.classList.add("is-active");
  dom.searchInput?.focus();
  showSearchResults();
}

function closeDesktopSearch() {
  isSearchExpanded = false;
  searchFocusedIndex = -1;
  dom.searchContainer?.classList.remove("is-visible");
  dom.searchToggle?.classList.remove("is-active");
  dom.searchResults?.classList.remove("is-visible");
  dom.searchInput.value = "";
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

function hideSearchResults() {
  dom.searchResults?.classList.remove("is-visible");
  searchFocusedIndex = -1;
}

function clearDesktopSearch() {
  dom.searchInput.value = "";
  dom.searchClear?.classList.remove("is-visible");
  renderSearchResults([], dom.searchResultsList);
  dom.searchInput?.focus();
}

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

function debouncedSearch(query, listElement) {
  if (searchDebounceTimer) {
    clearTimeout(searchDebounceTimer);
  }

  searchDebounceTimer = setTimeout(() => {
    searchDebounceTimer = null;
    const results = search(query, { limit: 30 });
    renderSearchResults(results, listElement);
  }, 150);
}

function renderSearchResults(results, listElement) {
  if (!listElement) return;

  const container = listElement.closest(
    ".search-dropdown__results, .search-overlay__results",
  );
  const emptyEl = container?.querySelector(
    ".search-dropdown__empty, .search-overlay__empty",
  );

  if (results.length === 0) {
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

  listElement.innerHTML = results
    .map(
      (result, index) => `
      <li
        class="search-result-item${index === searchFocusedIndex ? " is-focused" : ""}"
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
      </li>
    `,
    )
    .join("");
}

function handleSearchKeydown(event) {
  handleSearchNavigation(event, dom.searchResultsList, () => {
    closeDesktopSearch();
  });
}

function handleMobileSearchKeydown(event) {
  handleSearchNavigation(event, dom.searchOverlayList, () => {
    closeMobileSearch();
  });
}

function handleSearchNavigation(event, listElement, onClose) {
  const items = listElement?.querySelectorAll(".search-result-item") || [];

  if (event.key === "Escape") {
    event.preventDefault();
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
      selectSearchResult(focusedItem);
      onClose();
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

function handleSearchResultClick(event) {
  const item = event.target.closest(".search-result-item");
  if (!item) return;

  selectSearchResult(item);

  // Close search UI
  if (isMobileSearchOpen) {
    closeMobileSearch();
  } else {
    closeDesktopSearch();
  }
}

function selectSearchResult(item) {
  const id = item.dataset.searchResultId;
  const type = item.dataset.searchResultType;

  if (type === "bookmark") {
    rssReaderContext = null;
    readerSideTab = "highlights";
    state.selectedArticleId = id;
    state.rssReaderArticle = null;
    markArticleAsOpened(id);
    persistState(state);
    switchTab("reader");
    scrollReaderToTop();
  } else if (type === "project") {
    state.selectedProjectId = id;
    state.selectedProjectSidebarArticleId = null;
    persistState(state);
    switchTab("projects");
    renderProjects(state, dom);
    pushUrlFromState();
  }
}

function openMobileSearch() {
  isMobileSearchOpen = true;
  dom.searchOverlay?.classList.add("is-visible");
  dom.searchOverlayInput?.focus();
}

function closeMobileSearch() {
  isMobileSearchOpen = false;
  dom.searchOverlay?.classList.remove("is-visible");
  dom.searchOverlayInput.value = "";
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
  renderSearchResults([], dom.searchOverlayList);
  dom.searchOverlayInput?.focus();
}

// Update search index when bookmarks/projects change
function updateSearchIndexForBookmark(bookmark) {
  if (isSearchReady()) {
    updateBookmarkInIndex(bookmark);
  }
}

function updateSearchIndexForProject(project) {
  if (isSearchReady()) {
    updateProjectInIndex(project);
  }
}

function removeFromSearchIndex(id) {
  if (isSearchReady()) {
    removeFromIndex(id);
  }
}
