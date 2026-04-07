import { escapeHtml } from "../utils.js";
import { getDerivedIndexes } from "../derivedIndexes.js";
import {
  getCachedBlobUrl,
  ensurePageImagesLoaded,
} from "../services/imageCache.js";
import {
  getPaginatedItems,
  goToNextPage,
  goToPreviousPage,
  buildPaginationMarkup,
} from "./pagination.js";

const LIBRARY_PAGINATION_SCOPE = "library";

// Memoized sort+filter result keyed by (persistEpoch, tagFilters, projectFilters, sortMode).
// Avoids O(n log n) re-sort on every render and every page-turn with large libraries.
let _sortedArticlesCache = null;

function getCachedSortedArticles(state, sortMode) {
  const epoch = Number(state.__bookmarksVersion || 0);
  const tagKey = state.libraryTagFilters.join("\0");
  const projectKey = state.libraryProjectFilters.join("\0");

  if (
    _sortedArticlesCache &&
    _sortedArticlesCache.epoch === epoch &&
    _sortedArticlesCache.tagKey === tagKey &&
    _sortedArticlesCache.projectKey === projectKey &&
    _sortedArticlesCache.sortMode === sortMode
  ) {
    return _sortedArticlesCache.result;
  }

  const result = sortArticles(getFilteredArticles(state), sortMode);
  _sortedArticlesCache = { epoch, tagKey, projectKey, sortMode, result };
  return result;
}

export function renderLibraryFilters(state, dom) {
  const indexes = getDerivedIndexes(state);
  const availableTags = [
    ...new Set((state.savedTags || []).filter(Boolean)),
  ].sort((left, right) => left.localeCompare(right));
  const availableTagSet = new Set(availableTags);
  state.libraryTagFilters = state.libraryTagFilters.filter((tag) =>
    availableTagSet.has(tag),
  );

  const availableProjectIds = new Set(
    state.projects.map((project) => project.id),
  );
  state.libraryProjectFilters = state.libraryProjectFilters.filter(
    (projectId) => availableProjectIds.has(projectId),
  );

  const totalActive =
    state.libraryTagFilters.length + state.libraryProjectFilters.length;

  // Badge on trigger button
  if (dom.libraryFilterBadge) {
    dom.libraryFilterBadge.hidden = totalActive === 0;
    dom.libraryFilterBadge.textContent = totalActive;
  }

  // Active filter pills in sidebar
  if (dom.libraryActiveFilters) {
    const tagPills = state.libraryTagFilters.map(
      (tag) => `
        <span class="chip chip--filter-active chip--removable">
          <span class="chip__label">${escapeHtml(tag)}</span>
          <button type="button" class="chip__remove" data-remove-tag-filter="${escapeHtml(tag)}" aria-label="Remove ${escapeHtml(tag)} filter">
            <i class="fa-solid fa-xmark" aria-hidden="true"></i>
          </button>
        </span>`,
    );

    const projectNameById = new Map(state.projects.map((p) => [p.id, p.name]));
    const projectPills = state.libraryProjectFilters.map((projectId) => {
      const name = projectNameById.get(projectId) || projectId;
      return `
        <span class="chip chip--filter-active chip--removable">
          <span class="chip__label">${escapeHtml(name)}</span>
          <button type="button" class="chip__remove" data-remove-project-filter="${projectId}" aria-label="Remove ${escapeHtml(name)} filter">
            <i class="fa-solid fa-xmark" aria-hidden="true"></i>
          </button>
        </span>`;
    });

    dom.libraryActiveFilters.innerHTML = [...tagPills, ...projectPills].join(
      "",
    );
  }

  // Populate the dialog contents (so it's ready when opened)
  renderFilterDialogContents(state, dom, availableTags, indexes);
}

const FILTER_COLLAPSE_LIMIT = 5;
let _tagsExpanded = false;
let _projectsExpanded = false;

function resetExpansion() {
  _tagsExpanded = false;
  _projectsExpanded = false;
}

function renderFilterDialogContents(state, dom, availableTags, indexes) {
  const searchTerm = (dom.filterDialogSearch?.value || "").trim().toLowerCase();
  const isSearching = searchTerm.length > 0;

  const sortedProjects = state.projects
    .slice()
    .sort((left, right) => left.name.localeCompare(right.name));

  const filteredTags = isSearching
    ? availableTags.filter((tag) => tag.toLowerCase().includes(searchTerm))
    : availableTags;

  const filteredProjects = isSearching
    ? sortedProjects.filter((p) => p.name.toLowerCase().includes(searchTerm))
    : sortedProjects;

  if (dom.filterDialogTagsSection) {
    dom.filterDialogTagsSection.hidden =
      filteredTags.length === 0 && isSearching;
  }
  if (dom.filterDialogTags) {
    if (filteredTags.length === 0) {
      dom.filterDialogTags.innerHTML = isSearching
        ? '<p class="meta-text" style="font-style:italic">No matching tags</p>'
        : "";
    } else {
      const showAll = isSearching || _tagsExpanded;
      const visibleTags = showAll
        ? filteredTags
        : filteredTags.slice(0, FILTER_COLLAPSE_LIMIT);
      const hiddenCount = filteredTags.length - visibleTags.length;

      const optionsMarkup = visibleTags
        .map((tag) => {
          const isActive = state.libraryTagFilters.includes(tag);
          const count = indexes.tagArticleCount.get(tag) || 0;
          return `
            <button type="button" class="filter-option ${isActive ? "filter-option--active" : ""}" data-filter-tag="${escapeHtml(tag)}">
              <span class="filter-option__check"><i class="fa-solid fa-check" aria-hidden="true"></i></span>
              <span class="filter-option__label">${escapeHtml(tag)}</span>
              <span class="filter-option__count">${count}</span>
            </button>`;
        })
        .join("");

      const toggleMarkup =
        hiddenCount > 0
          ? `<button type="button" class="filter-dialog__see-more" data-filter-expand="tags">Show ${hiddenCount} more</button>`
          : !isSearching &&
              filteredTags.length > FILTER_COLLAPSE_LIMIT &&
              _tagsExpanded
            ? '<button type="button" class="filter-dialog__see-more" data-filter-expand="tags">Show less</button>'
            : "";

      dom.filterDialogTags.innerHTML = optionsMarkup + toggleMarkup;
    }
  }

  if (dom.filterDialogProjectsSection) {
    dom.filterDialogProjectsSection.hidden =
      filteredProjects.length === 0 && isSearching;
  }
  if (dom.filterDialogProjects) {
    if (filteredProjects.length === 0) {
      dom.filterDialogProjects.innerHTML = isSearching
        ? '<p class="meta-text" style="font-style:italic">No matching projects</p>'
        : "";
    } else {
      const showAll = isSearching || _projectsExpanded;
      const visibleProjects = showAll
        ? filteredProjects
        : filteredProjects.slice(0, FILTER_COLLAPSE_LIMIT);
      const hiddenCount = filteredProjects.length - visibleProjects.length;

      const optionsMarkup = visibleProjects
        .map((project) => {
          const isActive = state.libraryProjectFilters.includes(project.id);
          return `
            <button type="button" class="filter-option ${isActive ? "filter-option--active" : ""}" data-filter-project="${project.id}">
              <span class="filter-option__check"><i class="fa-solid fa-check" aria-hidden="true"></i></span>
              <span class="filter-option__label">${escapeHtml(project.name)}</span>
            </button>`;
        })
        .join("");

      const toggleMarkup =
        hiddenCount > 0
          ? `<button type="button" class="filter-dialog__see-more" data-filter-expand="projects">Show ${hiddenCount} more</button>`
          : !isSearching &&
              filteredProjects.length > FILTER_COLLAPSE_LIMIT &&
              _projectsExpanded
            ? '<button type="button" class="filter-dialog__see-more" data-filter-expand="projects">Show less</button>'
            : "";

      dom.filterDialogProjects.innerHTML = optionsMarkup + toggleMarkup;
    }
  }
}

function refreshDialogSearch(state, dom) {
  const indexes = getDerivedIndexes(state);
  const availableTags = [
    ...new Set((state.savedTags || []).filter(Boolean)),
  ].sort((left, right) => left.localeCompare(right));
  renderFilterDialogContents(state, dom, availableTags, indexes);
}

// ── Filter modal controller ──
// Keeps all filter-modal state and event wiring out of main.js.

export function isFilterModalOpen(dom) {
  return !!dom.libraryFilterDialog?.open;
}

export function closeFilterModalDirect(dom) {
  dom.libraryFilterDialog?.close();
}

export function initLibraryFilterModal({
  state,
  dom,
  persistState,
  pushUrlFromState,
}) {
  function openModal() {
    if (!dom.libraryFilterDialog) return;
    if (dom.filterDialogSearch) dom.filterDialogSearch.value = "";
    resetExpansion();
    renderLibraryFilters(state, dom);
    dom.libraryFilterDialog.showModal();
    if (window.matchMedia("(min-width: 762px)").matches) {
      dom.filterDialogSearch?.focus();
    }
    history.pushState({ filterModal: true }, "");
  }

  function closeModal() {
    if (!dom.libraryFilterDialog?.open) return;
    dom.libraryFilterDialog.close();
    if (history.state?.filterModal) {
      history.back();
    }
  }

  function toggleTag(tag) {
    if (!tag) return;
    if (state.libraryTagFilters.includes(tag)) {
      state.libraryTagFilters = state.libraryTagFilters.filter(
        (t) => t !== tag,
      );
    } else {
      state.libraryTagFilters = [...state.libraryTagFilters, tag];
    }
    persistState(state);
    renderLibraryFilters(state, dom);
    renderArticleList(state, dom);
    pushUrlFromState();
  }

  function toggleProject(projectId) {
    if (!projectId) return;
    if (state.libraryProjectFilters.includes(projectId)) {
      state.libraryProjectFilters = state.libraryProjectFilters.filter(
        (id) => id !== projectId,
      );
    } else {
      state.libraryProjectFilters = [...state.libraryProjectFilters, projectId];
    }
    persistState(state);
    renderLibraryFilters(state, dom);
    renderArticleList(state, dom);
    pushUrlFromState();
  }

  // Direct event listeners
  dom.libraryFilterTrigger?.addEventListener("click", openModal);
  dom.filterDialogClose?.addEventListener("click", closeModal);
  dom.filterDialogApply?.addEventListener("click", closeModal);

  dom.libraryFilterDialog?.addEventListener("cancel", (event) => {
    event.preventDefault();
    closeModal();
  });

  dom.libraryFilterDialog?.addEventListener("click", (event) => {
    if (event.target === dom.libraryFilterDialog) closeModal();
  });

  dom.filterDialogSearch?.addEventListener("input", () => {
    resetExpansion();
    refreshDialogSearch(state, dom);
  });

  dom.filterDialogClear?.addEventListener("click", () => {
    state.libraryTagFilters = [];
    state.libraryProjectFilters = [];
    persistState(state);
    renderLibraryFilters(state, dom);
    renderArticleList(state, dom);
    pushUrlFromState();
    closeModal();
  });

  // Return toggle functions so main.js delegated handler can call them
  return {
    toggleTag,
    toggleProject,
    toggleSection(section) {
      if (section === "tags") _tagsExpanded = !_tagsExpanded;
      if (section === "projects") _projectsExpanded = !_projectsExpanded;
      refreshDialogSearch(state, dom);
    },
  };
}

export function renderArticleList(state, dom) {
  const view = state.libraryView || "2";
  const sortMode = state.librarySort || "newest";
  const showImages = state.libraryShowImages !== false;
  const showTags = state.libraryShowTags !== false;

  document.querySelectorAll("[data-library-view]").forEach((btn) => {
    btn.classList.toggle("view-btn--active", btn.dataset.libraryView === view);
  });

  document.querySelectorAll("[data-library-sort]").forEach((btn) => {
    btn.classList.toggle(
      "view-btn--active",
      btn.dataset.librarySort === sortMode,
    );
  });

  document.querySelectorAll("[data-library-toggle-images]").forEach((btn) => {
    btn.classList.toggle("view-btn--active", showImages);
    btn.setAttribute("aria-pressed", showImages ? "true" : "false");
  });

  document.querySelectorAll("[data-library-toggle-tags]").forEach((btn) => {
    btn.classList.toggle("view-btn--active", showTags);
    btn.setAttribute("aria-pressed", showTags ? "true" : "false");
  });

  const filteredArticles = getCachedSortedArticles(state, sortMode);
  const sortedArticles = filteredArticles;
  const paginationKey = [
    view,
    sortMode,
    sortedArticles.length,
    [...state.libraryTagFilters].sort().join("|"),
    [...state.libraryProjectFilters].sort().join("|"),
  ].join("::");
  const {
    pagedItems: pagedArticles,
    currentPage,
    totalPages,
  } = getPaginatedItems({
    scope: LIBRARY_PAGINATION_SCOPE,
    items: sortedArticles,
    view,
    paginationKey,
  });
  const indexes = getDerivedIndexes(state);

  if (dom.libraryArticlesTitle) {
    dom.libraryArticlesTitle.textContent = `Saved articles (${state.bookmarks.length})`;
  }

  if (sortedArticles.length === 0) {
    dom.articleList.className = "article-list";
    dom.articleList.innerHTML =
      state.bookmarks.length === 0
        ? '<div class="empty-state"><h3>No articles yet</h3><p>Fetch a URL to populate the library.</p></div>'
        : '<div class="empty-state"><h3>No matching articles</h3><p>Try clearing one or more filters.</p></div>';
    return;
  }

  const cardsMarkup = pagedArticles
    .map((article) =>
      createArticleCardMarkup(article, indexes.projectNameById, {
        showImages,
        showTags,
      }),
    )
    .join("");

  const paginationMarkup = buildPaginationMarkup({
    scope: LIBRARY_PAGINATION_SCOPE,
    currentPage,
    totalPages,
    label: "Library pagination",
  });

  dom.articleList.className = `article-list article-list--view-${view}${showImages ? "" : " article-list--no-images"}`;
  dom.articleList.innerHTML = `${cardsMarkup}${paginationMarkup}`;

  if (showImages) {
    patchPageImages(pagedArticles, dom.articleList).catch(() => {});
  }
}

export function goToNextLibraryPage(state, dom) {
  const view = state.libraryView || "2";
  const sortMode = state.librarySort || "newest";
  const filteredArticles = getCachedSortedArticles(state, sortMode);
  const paginationKey = [
    view,
    sortMode,
    filteredArticles.length,
    [...state.libraryTagFilters].sort().join("|"),
    [...state.libraryProjectFilters].sort().join("|"),
  ].join("::");
  const { totalPages } = getPaginatedItems({
    scope: LIBRARY_PAGINATION_SCOPE,
    items: filteredArticles,
    view,
    paginationKey,
  });

  if (!goToNextPage(LIBRARY_PAGINATION_SCOPE, totalPages)) {
    return;
  }

  renderArticleList(state, dom);
}

export function goToPreviousLibraryPage(state, dom) {
  if (!goToPreviousPage(LIBRARY_PAGINATION_SCOPE)) {
    return;
  }

  renderArticleList(state, dom);
}

export function updateLibraryVirtualWindow() {
  // No-op kept for compatibility with existing resize/scroll hooks.
}

export function getLibraryReadingOrder(state) {
  return getCachedSortedArticles(state, state.librarySortMode || "newest");
}

function createArticleCardMarkup(article, projectNameById, options = {}) {
  const showImages = options.showImages !== false;
  const showTags = options.showTags !== false;
  const projectNames = (article.projectIds || [])
    .map((projectId) => projectNameById.get(projectId))
    .filter(Boolean);
  const description = (article.description || "").trim();
  const metaText = description || article.previewText || "";
  const imageMarkup = (() => {
    if (!showImages) {
      return "";
    }

    const cachedUrl = getCachedBlobUrl(article.id);
    const src = cachedUrl || article.imageUrl;

    if (!src) {
      return "";
    }

    return `<img class="article-card__image" src="${cachedUrl ? src : escapeHtml(src)}" alt="" loading="lazy" draggable="false" />`;
  })();

  return `
    <article
      class="article-card"
      data-select-article="${article.id}"
      draggable="false"
      role="button"
      tabindex="0"
    >
      ${imageMarkup}
      <div class="article-card__header">
        <div>
          <h3>${escapeHtml(article.title)}</h3>
        </div>
        <button
          class="article-card__delete"
          type="button"
          data-delete-article="${article.id}"
          title="Delete article"
          aria-label="Delete ${escapeHtml(article.title)}"
        >
          <i class="fa-solid fa-xmark" aria-hidden="true"></i>
        </button>
      </div>

      <p class="meta-text">${escapeHtml(metaText)}</p>

      <div class="chip-row">
        ${
          showTags
            ? (article.tags || [])
                .map(
                  (tag) =>
                    `<span class="chip chip--tag">${escapeHtml(tag)}</span>`,
                )
                .join("")
            : ""
        }
        ${
          showTags
            ? projectNames
                .map(
                  (name) =>
                    `<span class="chip chip--project">${escapeHtml(name)}</span>`,
                )
                .join("")
            : ""
        }
        <span class="chip chip--count"><i class="fa-regular fa-comment" aria-hidden="true"></i> ${article.highlights.length}</span>
      </div>
    </article>
  `;
}

/**
 * After a page renders, reads any blobs that weren't yet in the in-memory
 * cache from IDB and patches img.src attributes without a full re-render.
 * If the user navigates away before the IDB read completes, the querySelectorAll
 * won't find the old card elements and the function exits cleanly.
 */
async function patchPageImages(articles, container) {
  const newlyLoaded = await ensurePageImagesLoaded(articles);

  if (newlyLoaded.size === 0) {
    return;
  }

  for (const [articleId, blobUrl] of newlyLoaded) {
    const card = container.querySelector(
      `[data-select-article="${articleId}"]`,
    );

    if (!card) {
      continue;
    }

    const img = card.querySelector("img.article-card__image");

    if (img) {
      img.src = blobUrl;
    }
  }
}

function getFilteredArticles(state) {
  return state.bookmarks.filter((article) => {
    const matchesProjects =
      state.libraryProjectFilters.length === 0 ||
      state.libraryProjectFilters.some((projectId) =>
        article.projectIds.includes(projectId),
      );

    if (!matchesProjects) {
      return false;
    }

    return state.libraryTagFilters.every((tag) => article.tags.includes(tag));
  });
}

function sortArticles(articles, sortMode) {
  const sorted = articles.slice();

  sorted.sort((left, right) => {
    if (sortMode === "oldest") {
      return getCreatedAtMs(left) - getCreatedAtMs(right);
    }

    if (sortMode === "latest-opened") {
      return getLastOpenedAtMs(right) - getLastOpenedAtMs(left);
    }

    return getCreatedAtMs(right) - getCreatedAtMs(left);
  });

  return sorted;
}

function getCreatedAtMs(article) {
  return Date.parse(article.createdAt || article.fetchedAt || 0) || 0;
}

function getLastOpenedAtMs(article) {
  const opened = Date.parse(article.lastOpenedAt || 0) || 0;
  return opened || getCreatedAtMs(article);
}
