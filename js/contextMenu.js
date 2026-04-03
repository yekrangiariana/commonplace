import {
  normalizeTag,
  syncSavedTags,
  deleteProject as deleteProjectFromState,
} from "./taxonomy.js";
import {
  touchBookmarks,
  touchProjects,
  markBookmarkDirty,
  markProjectDirty,
} from "./state.js";

const PROJECT_STAGES = ["idea", "research", "done"];

function stageLabel(stage) {
  return stage.charAt(0).toUpperCase() + stage.slice(1);
}

function escapeHtml(value) {
  return (value || "")
    .toString()
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function initWorkspaceContextMenu({
  state,
  setStatus,
  persistState,
  render,
  switchTab,
  createId,
  openAddArticleModal,
  openProjectsCreate,
  openRssItem,
  addRssItemToLibrary,
  markRssItemRead,
  openRssSubscribe,
  refreshRssActive,
  scrollReaderToTop,
}) {
  const menu = document.createElement("div");
  menu.className = "workspace-context-menu";
  menu.hidden = true;
  menu.setAttribute("role", "menu");
  document.body.appendChild(menu);

  const mode = {
    libraryBulk: false,
    projectsBulk: false,
  };
  const selectedLibraryIds = new Set();
  const selectedProjectIds = new Set();

  function hideMenu() {
    menu.hidden = true;
    menu.innerHTML = "";
  }

  function setMenuPosition(x, y) {
    const width = 290;
    const left = Math.max(8, Math.min(window.innerWidth - width - 8, x));
    const top = Math.max(8, Math.min(window.innerHeight - 16, y));
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
  }

  function ensureLibrarySelection(id) {
    if (!id) {
      return;
    }

    if (!selectedLibraryIds.has(id)) {
      selectedLibraryIds.add(id);
      syncSelectionClasses();
    }
  }

  function ensureProjectSelection(id) {
    if (!id) {
      return;
    }

    if (!selectedProjectIds.has(id)) {
      selectedProjectIds.add(id);
      syncSelectionClasses();
    }
  }

  function openArticle(articleId) {
    const article = state.bookmarks.find((item) => item.id === articleId);

    if (!article) {
      return;
    }

    article.lastOpenedAt = new Date().toISOString();
    state.selectedArticleId = articleId;
    persistState(state);
    render();
    switchTab("reader");
    scrollReaderToTop?.();
  }

  function openUrlInNewTab(url) {
    const safeUrl = String(url || "").trim();

    if (!safeUrl) {
      return;
    }

    window.open(safeUrl, "_blank", "noopener,noreferrer");
  }

  function getRssFeedById(feedId) {
    return state.rssFeeds.find((feed) => feed.id === feedId) || null;
  }

  function selectRssFeed(feedId) {
    if (!feedId || !getRssFeedById(feedId)) {
      return;
    }

    state.rssActiveFeedId = feedId;
    persistState(state);
    render();
  }

  function getRssPanelItems() {
    const hasActiveFeed = Boolean(getRssFeedById(state.rssActiveFeedId));

    return [
      {
        type: "button",
        label: "Feed",
        action: "rss-subscribe-new",
      },
      {
        type: "button",
        label: "Refresh all feeds",
        action: "rss-refresh-active",
        value: state.rssActiveFeedId || "",
        disabled: state.rssFeeds.length === 0,
      },
    ];
  }

  function deleteArticle(articleId) {
    const article = state.bookmarks.find((item) => item.id === articleId);

    if (!article) {
      return;
    }

    state.bookmarks = state.bookmarks.filter((item) => item.id !== articleId);
    markBookmarkDirty(state, articleId);

    if (state.selectedArticleId === articleId) {
      state.selectedArticleId = null;
    }

    selectedLibraryIds.delete(articleId);
    touchBookmarks(state);
    persistState(state);
    render();
    syncSelectionClasses();
  }

  async function copyArticleHighlights(articleId) {
    const article = state.bookmarks.find((item) => item.id === articleId);

    if (!article) {
      return;
    }

    if (!article.highlights || article.highlights.length === 0) {
      setStatus("No highlights to copy for this article.");
      return;
    }

    const text = article.highlights
      .slice()
      .sort((left, right) => left.start - right.start)
      .map((highlight) => highlight.quote)
      .join("\n\n");

    await navigator.clipboard.writeText(text);
    setStatus("Copied highlights to clipboard.");
  }

  function openProject(projectId) {
    const project = state.projects.find((item) => item.id === projectId);

    if (!project) {
      return;
    }

    project.lastOpenedAt = new Date().toISOString();
    state.selectedProjectId = projectId;
    state.selectedProjectSidebarArticleId = null;
    touchProjects(state);
    persistState(state);
    switchTab("projects");
  }

  function deleteProject(projectId) {
    const project = state.projects.find((item) => item.id === projectId);

    if (!project) {
      return;
    }

    deleteProjectFromState(state, projectId);
    state.selectedProjectSidebarArticleId = null;
    selectedProjectIds.delete(projectId);
    persistState(state);
    render();
    syncSelectionClasses();
  }

  function applyTagToArticles(tag, articleIds) {
    const normalized = normalizeTag(tag);

    if (!normalized) {
      return;
    }

    const selectedArticles = state.bookmarks.filter((article) =>
      articleIds.has(article.id),
    );

    if (selectedArticles.length === 0) {
      setStatus("No library cards selected.");
      return;
    }

    syncSavedTags(state, [normalized]);
    selectedArticles.forEach((article) => {
      const currentTags = article.tags || [];

      if (!currentTags.includes(normalized)) {
        article.tags = [...currentTags, normalized];
        markBookmarkDirty(state, article.id);
      }
    });

    touchBookmarks(state);
    persistState(state);
    render();
    syncSelectionClasses();
    setStatus(
      `Added tag \"${normalized}\" to ${selectedArticles.length} articles.`,
    );
  }

  function applyProjectToArticles(projectId, articleIds) {
    const project = state.projects.find((item) => item.id === projectId);

    if (!project) {
      return;
    }

    const selectedArticles = state.bookmarks.filter((article) =>
      articleIds.has(article.id),
    );

    if (selectedArticles.length === 0) {
      setStatus("No library cards selected.");
      return;
    }

    selectedArticles.forEach((article) => {
      const current = article.projectIds || [];

      if (!current.includes(projectId)) {
        article.projectIds = [...current, projectId];
        markBookmarkDirty(state, article.id);
      }
    });

    touchBookmarks(state);
    persistState(state);
    render();
    syncSelectionClasses();
    setStatus(
      `Added project \"${project.name}\" to ${selectedArticles.length} articles.`,
    );
  }

  function createProjectAndAssign(name, articleIds) {
    const value = (name || "").replace(/\s+/g, " ").trim();

    if (!value) {
      return;
    }

    const existing = state.projects.find(
      (project) => project.name.toLowerCase() === value.toLowerCase(),
    );

    const project =
      existing ||
      (() => {
        const nextProject = {
          id: createId("project"),
          name: value,
          stage: "idea",
          description: "",
          content: "",
          createdAt: new Date().toISOString(),
        };
        state.projects.unshift(nextProject);
        touchProjects(state);
        return nextProject;
      })();

    applyProjectToArticles(project.id, articleIds);
  }

  function applyStageToProjects(stage, projectIds) {
    if (!PROJECT_STAGES.includes(stage)) {
      return;
    }

    const selectedProjects = state.projects.filter((project) =>
      projectIds.has(project.id),
    );

    if (selectedProjects.length === 0) {
      setStatus("No project cards selected.");
      return;
    }

    selectedProjects.forEach((project) => {
      project.stage = stage;
      markProjectDirty(state, project.id);
    });

    touchProjects(state);
    persistState(state);
    render();
    syncSelectionClasses();
    setStatus(
      `Moved ${selectedProjects.length} projects to ${stageLabel(stage)}.`,
    );
  }

  function buildMenu({ items }) {
    menu.innerHTML = `
      <div class="workspace-context-menu__panel">
        ${items
          .map((item) => {
            if (item.type === "separator") {
              return '<div class="workspace-context-menu__separator" role="separator"></div>';
            }

            if (item.type === "label") {
              return `<p class="workspace-context-menu__label">${escapeHtml(item.label)}</p>`;
            }

            if (item.type === "submenu") {
              return `
                <div class="workspace-context-menu__submenu-group">
                  <button type="button" class="workspace-context-menu__item workspace-context-menu__submenu-trigger" aria-haspopup="true">
                    ${escapeHtml(item.label)}
                  </button>
                  <div class="workspace-context-menu__submenu-flyout" role="menu">
                    ${item.options
                      .map(
                        (option) => `
                          <button
                            type="button"
                            class="workspace-context-menu__item"
                            data-menu-action="${escapeHtml(option.action)}"
                            data-menu-value="${escapeHtml(option.value || "")}" 
                          >
                            ${escapeHtml(option.label)}
                          </button>
                        `,
                      )
                      .join("")}
                  </div>
                </div>
              `;
            }

            return `
              <button
                type="button"
                class="workspace-context-menu__item ${item.danger ? "workspace-context-menu__item--danger" : ""}"
                data-menu-action="${escapeHtml(item.action)}"
                data-menu-value="${escapeHtml(item.value || "")}" 
              >
                ${escapeHtml(item.label)}
              </button>
            `;
          })
          .join("")}
      </div>
    `;

    menu.hidden = false;
  }

  function getLibraryBulkItems() {
    const tagOptions = (state.savedTags || [])
      .slice()
      .sort((a, b) => a.localeCompare(b))
      .map((tag) => ({
        label: tag,
        action: "bulk-library-add-tag",
        value: tag,
      }));

    const projectOptions = state.projects
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((project) => ({
        label: project.name,
        action: "bulk-library-add-project",
        value: project.id,
      }));

    if (tagOptions.length === 0) {
      tagOptions.push({
        label: "No tags available",
        action: "noop",
        value: "",
      });
    }

    if (projectOptions.length === 0) {
      projectOptions.push({
        label: "No projects available",
        action: "noop",
        value: "",
      });
    }

    return [
      {
        type: "label",
        label: `${selectedLibraryIds.size} selected`,
      },
      {
        type: "submenu",
        label: "Add tag",
        options: [
          ...tagOptions,
          {
            label: "New tag...",
            action: "bulk-library-add-tag-prompt",
            value: "",
          },
        ],
      },
      {
        type: "submenu",
        label: "Add project",
        options: [
          ...projectOptions,
          {
            label: "New project...",
            action: "bulk-library-add-project-prompt",
            value: "",
          },
        ],
      },
      { type: "separator" },
      {
        type: "button",
        label: "Select all cards",
        action: "bulk-library-select-all",
      },
      {
        type: "button",
        label: "Clear selection",
        action: "bulk-library-clear-selection",
      },
      {
        type: "button",
        label: "Exit bulk add",
        action: "bulk-library-exit",
      },
    ];
  }

  function getProjectsBulkItems() {
    return [
      {
        type: "label",
        label: `${selectedProjectIds.size} selected`,
      },
      {
        type: "submenu",
        label: "Set folder",
        options: PROJECT_STAGES.map((stage) => ({
          label: stageLabel(stage),
          action: "bulk-projects-set-stage",
          value: stage,
        })),
      },
      { type: "separator" },
      {
        type: "button",
        label: "Select all cards",
        action: "bulk-projects-select-all",
      },
      {
        type: "button",
        label: "Clear selection",
        action: "bulk-projects-clear-selection",
      },
      {
        type: "button",
        label: "Exit bulk folders",
        action: "bulk-projects-exit",
      },
    ];
  }

  function getLibraryPanelItems() {
    const items = [
      {
        type: "button",
        label: "New article",
        action: "library-new-article",
      },
      { type: "separator" },
      {
        type: "button",
        label: "Bulk add mode",
        action: "bulk-library-start",
      },
      {
        type: "button",
        label: "Select all cards",
        action: "bulk-library-select-all",
      },
      {
        type: "button",
        label: "Clear selection",
        action: "bulk-library-clear-selection",
      },
    ];

    if (mode.libraryBulk) {
      items.push({ type: "separator" });
      items.push({
        type: "button",
        label: "Exit bulk add",
        action: "bulk-library-exit",
      });
    }

    return items;
  }

  function getProjectsPanelItems() {
    const items = [
      {
        type: "button",
        label: "New project",
        action: "projects-new-project",
      },
      { type: "separator" },
      {
        type: "button",
        label: "Bulk folders mode",
        action: "bulk-projects-start",
      },
      {
        type: "button",
        label: "Select all cards",
        action: "bulk-projects-select-all",
      },
      {
        type: "button",
        label: "Clear selection",
        action: "bulk-projects-clear-selection",
      },
    ];

    if (mode.projectsBulk) {
      items.push({ type: "separator" });
      items.push({
        type: "button",
        label: "Exit bulk folders",
        action: "bulk-projects-exit",
      });
    }

    return items;
  }

  function onContextMenu(event) {
    const libraryCard = event.target.closest("[data-select-article]");
    const projectCard = event.target.closest("[data-open-project]");
    const rssItemCard = event.target.closest("[data-rss-open-item]");
    const rssFeedChip = event.target.closest("[data-rss-select-feed]");
    const projectPanel = event.target.closest(".panel-card--project-list");
    const libraryPanel = event.target.closest(".panel-card--library-list");
    const rssPanel = event.target.closest(".panel-card--rss-main");
    const inLibraryPanel = Boolean(libraryPanel && !projectPanel);
    const inProjectsPanel = Boolean(projectPanel);
    const inRssPanel = Boolean(rssPanel);

    if (
      !libraryCard &&
      !projectCard &&
      !rssItemCard &&
      !inLibraryPanel &&
      !inProjectsPanel &&
      !inRssPanel
    ) {
      hideMenu();
      return;
    }

    if (mode.libraryBulk && inLibraryPanel) {
      event.preventDefault();
      buildMenu({ items: getLibraryBulkItems() });
      setMenuPosition(event.clientX, event.clientY);
      return;
    }

    if (mode.projectsBulk && inProjectsPanel) {
      event.preventDefault();
      buildMenu({ items: getProjectsBulkItems() });
      setMenuPosition(event.clientX, event.clientY);
      return;
    }

    if (!libraryCard && inLibraryPanel) {
      event.preventDefault();
      buildMenu({ items: getLibraryPanelItems() });
      setMenuPosition(event.clientX, event.clientY);
      return;
    }

    if (!projectCard && inProjectsPanel) {
      event.preventDefault();
      buildMenu({ items: getProjectsPanelItems() });
      setMenuPosition(event.clientX, event.clientY);
      return;
    }

    if (!rssItemCard && !rssFeedChip && inRssPanel) {
      event.preventDefault();
      buildMenu({ items: getRssPanelItems() });
      setMenuPosition(event.clientX, event.clientY);
      return;
    }

    if (libraryCard) {
      event.preventDefault();
      const articleId = libraryCard.dataset.selectArticle;
      ensureLibrarySelection(articleId);
      const article = state.bookmarks.find((item) => item.id === articleId);

      buildMenu({
        items: [
          {
            type: "button",
            label: "Open",
            action: "library-open",
            value: articleId,
          },
          {
            type: "button",
            label: "Open in new tab",
            action: "library-open-new-tab",
            value: article?.url || "",
          },
          {
            type: "button",
            label: "Copy highlights",
            action: "library-copy-highlights",
            value: articleId,
          },
          {
            type: "button",
            label: "Delete",
            action: "library-delete",
            value: articleId,
            danger: true,
          },
          { type: "separator" },
          {
            type: "button",
            label: "Bulk add mode",
            action: "bulk-library-start",
            value: articleId,
          },
        ],
      });
      setMenuPosition(event.clientX, event.clientY);
      return;
    }

    if (rssItemCard) {
      event.preventDefault();
      const itemUrl = rssItemCard.dataset.rssOpenItem || "";

      buildMenu({
        items: [
          {
            type: "button",
            label: "Open",
            action: "rss-open",
            value: itemUrl,
          },
          {
            type: "button",
            label: "Open in new tab",
            action: "rss-open-new-tab",
            value: itemUrl,
          },
          {
            type: "button",
            label: "Add to library",
            action: "rss-add-to-library",
            value: itemUrl,
          },
          {
            type: "button",
            label: "Mark as read",
            action: "rss-mark-read",
            value: itemUrl,
          },
        ],
      });
      setMenuPosition(event.clientX, event.clientY);
      return;
    }

    if (rssFeedChip) {
      event.preventDefault();
      const feedId = rssFeedChip.dataset.rssSelectFeed || "";
      const feed = getRssFeedById(feedId);

      if (!feed) {
        buildMenu({ items: getRssPanelItems() });
        setMenuPosition(event.clientX, event.clientY);
        return;
      }

      buildMenu({
        items: [
          {
            type: "button",
            label: "Open",
            action: "rss-feed-open",
            value: feedId,
          },
          {
            type: "button",
            label: "Open in new tab",
            action: "rss-feed-open-new-tab",
            value: feed.url || "",
          },
          {
            type: "button",
            label: "Refresh all feeds",
            action: "rss-feed-refresh",
            value: feedId,
          },
          { type: "separator" },
          {
            type: "button",
            label: "Feed",
            action: "rss-subscribe-new",
          },
        ],
      });
      setMenuPosition(event.clientX, event.clientY);
      return;
    }

    if (projectCard) {
      event.preventDefault();
      const projectId = projectCard.dataset.openProject;
      ensureProjectSelection(projectId);

      buildMenu({
        items: [
          {
            type: "button",
            label: "Open",
            action: "project-open",
            value: projectId,
          },
          {
            type: "submenu",
            label: "Set folder",
            options: PROJECT_STAGES.map((stage) => ({
              label: stageLabel(stage),
              action: "project-set-stage",
              value: `${projectId}::${stage}`,
            })),
          },
          {
            type: "button",
            label: "Delete",
            action: "project-delete",
            value: projectId,
            danger: true,
          },
          { type: "separator" },
          {
            type: "button",
            label: "Bulk folders mode",
            action: "bulk-projects-start",
            value: projectId,
          },
        ],
      });
      setMenuPosition(event.clientX, event.clientY);
    }
  }

  function onMenuClick(event) {
    const actionNode = event.target.closest("[data-menu-action]");

    if (!actionNode) {
      return;
    }

    const action = actionNode.dataset.menuAction;
    const value = actionNode.dataset.menuValue || "";

    if (action === "noop") {
      return;
    }

    if (action === "library-open") {
      openArticle(value);
      hideMenu();
      return;
    }

    if (action === "library-open-new-tab") {
      openUrlInNewTab(value);
      hideMenu();
      return;
    }

    if (action === "library-new-article") {
      openAddArticleModal?.();
      hideMenu();
      return;
    }

    if (action === "library-copy-highlights") {
      copyArticleHighlights(value);
      hideMenu();
      return;
    }

    if (action === "library-delete") {
      deleteArticle(value);
      hideMenu();
      return;
    }

    if (action === "bulk-library-start") {
      mode.libraryBulk = true;
      selectedLibraryIds.clear();
      if (value) {
        selectedLibraryIds.add(value);
      }
      syncSelectionClasses();
      hideMenu();
      return;
    }

    if (action === "bulk-library-add-tag") {
      applyTagToArticles(value, selectedLibraryIds);
      hideMenu();
      return;
    }

    if (action === "bulk-library-add-tag-prompt") {
      const nextTag = window.prompt("Tag to add to selected articles", "");
      applyTagToArticles(nextTag || "", selectedLibraryIds);
      hideMenu();
      return;
    }

    if (action === "bulk-library-add-project") {
      applyProjectToArticles(value, selectedLibraryIds);
      hideMenu();
      return;
    }

    if (action === "bulk-library-add-project-prompt") {
      const name = window.prompt("Project name for selected articles", "");
      createProjectAndAssign(name || "", selectedLibraryIds);
      hideMenu();
      return;
    }

    if (action === "bulk-library-select-all") {
      mode.libraryBulk = true;
      selectedLibraryIds.clear();
      state.bookmarks.forEach((article) => selectedLibraryIds.add(article.id));
      syncSelectionClasses();
      hideMenu();
      return;
    }

    if (action === "bulk-library-clear-selection") {
      selectedLibraryIds.clear();
      syncSelectionClasses();
      hideMenu();
      return;
    }

    if (action === "bulk-library-exit") {
      mode.libraryBulk = false;
      selectedLibraryIds.clear();
      syncSelectionClasses();
      hideMenu();
      return;
    }

    if (action === "rss-open") {
      openRssItem?.(value);
      hideMenu();
      return;
    }

    if (action === "rss-feed-open") {
      selectRssFeed(value);
      hideMenu();
      return;
    }

    if (action === "rss-feed-open-new-tab") {
      openUrlInNewTab(value);
      hideMenu();
      return;
    }

    if (action === "rss-feed-refresh") {
      if (value) {
        selectRssFeed(value);
      }

      refreshRssActive?.();
      hideMenu();
      return;
    }

    if (action === "rss-refresh-active") {
      refreshRssActive?.();
      hideMenu();
      return;
    }

    if (action === "rss-subscribe-new") {
      openRssSubscribe?.();
      hideMenu();
      return;
    }

    if (action === "rss-open-new-tab") {
      openUrlInNewTab(value);
      hideMenu();
      return;
    }

    if (action === "rss-add-to-library") {
      addRssItemToLibrary?.(value);
      hideMenu();
      return;
    }

    if (action === "rss-mark-read") {
      markRssItemRead?.(value);
      hideMenu();
      return;
    }

    if (action === "projects-new-project") {
      openProjectsCreate?.();
      hideMenu();
      return;
    }

    if (action === "project-open") {
      openProject(value);
      hideMenu();
      return;
    }

    if (action === "project-delete") {
      deleteProject(value);
      hideMenu();
      return;
    }

    if (action === "project-set-stage") {
      const [projectId, stage] = value.split("::");
      applyStageToProjects(stage, new Set([projectId]));
      hideMenu();
      return;
    }

    if (action === "bulk-projects-start") {
      mode.projectsBulk = true;
      selectedProjectIds.clear();
      if (value) {
        selectedProjectIds.add(value);
      }
      syncSelectionClasses();
      hideMenu();
      return;
    }

    if (action === "bulk-projects-set-stage") {
      applyStageToProjects(value, selectedProjectIds);
      hideMenu();
      return;
    }

    if (action === "bulk-projects-select-all") {
      mode.projectsBulk = true;
      selectedProjectIds.clear();
      state.projects.forEach((project) => selectedProjectIds.add(project.id));
      syncSelectionClasses();
      hideMenu();
      return;
    }

    if (action === "bulk-projects-clear-selection") {
      selectedProjectIds.clear();
      syncSelectionClasses();
      hideMenu();
      return;
    }

    if (action === "bulk-projects-exit") {
      mode.projectsBulk = false;
      selectedProjectIds.clear();
      syncSelectionClasses();
      hideMenu();
    }
  }

  function onCaptureClick(event) {
    if (menu.contains(event.target)) {
      return;
    }

    if (mode.libraryBulk) {
      const libraryCard = event.target.closest("[data-select-article]");

      if (libraryCard) {
        event.preventDefault();
        event.stopPropagation();
        const articleId = libraryCard.dataset.selectArticle;

        if (selectedLibraryIds.has(articleId)) {
          selectedLibraryIds.delete(articleId);
        } else {
          selectedLibraryIds.add(articleId);
        }

        syncSelectionClasses();
        return;
      }
    }

    if (mode.projectsBulk) {
      const projectCard = event.target.closest("[data-open-project]");

      if (projectCard) {
        event.preventDefault();
        event.stopPropagation();
        const projectId = projectCard.dataset.openProject;

        if (selectedProjectIds.has(projectId)) {
          selectedProjectIds.delete(projectId);
        } else {
          selectedProjectIds.add(projectId);
        }

        syncSelectionClasses();
        return;
      }
    }

    if (mode.libraryBulk || mode.projectsBulk) {
      mode.libraryBulk = false;
      mode.projectsBulk = false;
      selectedLibraryIds.clear();
      selectedProjectIds.clear();
      syncSelectionClasses();
    }

    hideMenu();
  }

  function onKeydown(event) {
    if (event.key === "Escape") {
      hideMenu();
    }
  }

  function syncSelectionClasses() {
    document
      .querySelectorAll(".article-card[data-select-article]")
      .forEach((card) => {
        const id = card.dataset.selectArticle;
        const isSelected = mode.libraryBulk && selectedLibraryIds.has(id);
        card.classList.toggle("is-bulk-selectable", mode.libraryBulk);
        card.classList.toggle("is-bulk-selected", isSelected);
        card.setAttribute("aria-pressed", isSelected ? "true" : "false");
      });

    document
      .querySelectorAll(".project-card[data-open-project]")
      .forEach((card) => {
        const id = card.dataset.openProject;
        const isSelected = mode.projectsBulk && selectedProjectIds.has(id);
        card.classList.toggle("is-bulk-selectable", mode.projectsBulk);
        card.classList.toggle("is-bulk-selected", isSelected);
        card.setAttribute("aria-pressed", isSelected ? "true" : "false");
      });
  }

  menu.addEventListener("click", onMenuClick);
  document.addEventListener("contextmenu", onContextMenu);
  document.addEventListener("click", onCaptureClick, true);
  document.addEventListener("keydown", onKeydown);

  return {
    syncSelectionClasses,
    clearSelections() {
      mode.libraryBulk = false;
      mode.projectsBulk = false;
      selectedLibraryIds.clear();
      selectedProjectIds.clear();
      syncSelectionClasses();
      hideMenu();
    },
  };
}
