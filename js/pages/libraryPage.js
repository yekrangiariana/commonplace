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

  if (availableTags.length === 0) {
    dom.libraryTagFilters.innerHTML = "";
    dom.libraryTagClear.hidden = true;
  } else {
    dom.libraryTagFilters.innerHTML = availableTags
      .map((tag) => {
        const isActive = state.libraryTagFilters.includes(tag);

        return `
          <button
            type="button"
            class="chip chip--helper ${isActive ? "chip--filter-active" : ""}"
            data-toggle-library-tag="${escapeHtml(tag)}"
            aria-pressed="${isActive ? "true" : "false"}"
          >
            ${escapeHtml(tag)} (${indexes.tagArticleCount.get(tag) || 0})
          </button>
        `;
      })
      .join("");

    dom.libraryTagClear.hidden = state.libraryTagFilters.length === 0;
  }

  const availableProjectIds = new Set(
    state.projects.map((project) => project.id),
  );
  state.libraryProjectFilters = state.libraryProjectFilters.filter(
    (projectId) => availableProjectIds.has(projectId),
  );

  if (state.projects.length === 0) {
    dom.libraryProjectFilters.innerHTML = "";
    dom.libraryProjectClear.hidden = true;
    return;
  }

  dom.libraryProjectFilters.innerHTML = state.projects
    .slice()
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((project) => {
      const isActive = state.libraryProjectFilters.includes(project.id);

      return `
        <button
          type="button"
          class="chip chip--helper ${isActive ? "chip--filter-active" : ""}"
          data-toggle-library-project="${project.id}"
          aria-pressed="${isActive ? "true" : "false"}"
        >
          ${escapeHtml(project.name)}
        </button>
      `;
    })
    .join("");

  dom.libraryProjectClear.hidden = state.libraryProjectFilters.length === 0;
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
