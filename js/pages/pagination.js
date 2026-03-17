const paginationState = new Map();

export function getPaginatedItems({ scope, items, view, paginationKey }) {
  const pageSize = getPageSizeForView(view);
  const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
  const state = getScopeState(scope);

  if (state.lastKey !== paginationKey) {
    state.currentPage = 1;
    state.lastKey = paginationKey;
  }

  state.currentPage = Math.min(Math.max(1, state.currentPage), totalPages);

  const start = (state.currentPage - 1) * pageSize;
  const pagedItems = items.slice(start, start + pageSize);

  return {
    pagedItems,
    currentPage: state.currentPage,
    totalPages,
    pageSize,
  };
}

export function goToNextPage(scope, totalPages) {
  const state = getScopeState(scope);

  if (state.currentPage >= totalPages) {
    return false;
  }

  state.currentPage += 1;
  return true;
}

export function goToPreviousPage(scope) {
  const state = getScopeState(scope);

  if (state.currentPage <= 1) {
    return false;
  }

  state.currentPage -= 1;
  return true;
}

export function buildPaginationMarkup({
  scope,
  currentPage,
  totalPages,
  label,
}) {
  if (totalPages <= 1) {
    return "";
  }

  return `
    <div class="library-pagination" role="navigation" aria-label="${label}">
      <button
        type="button"
        class="button button--ghost button--small"
        data-pagination-scope="${scope}"
        data-pagination-action="prev"
        ${currentPage === 1 ? "disabled" : ""}
      >
        Previous
      </button>
      <span class="library-pagination__meta">Page ${currentPage} / ${totalPages}</span>
      <button
        type="button"
        class="button button--ghost button--small"
        data-pagination-scope="${scope}"
        data-pagination-action="next"
        ${currentPage === totalPages ? "disabled" : ""}
      >
        Next
      </button>
    </div>
  `;
}

export function getCurrentPage(scope) {
  return getScopeState(scope).currentPage;
}

function getScopeState(scope) {
  if (!paginationState.has(scope)) {
    paginationState.set(scope, {
      currentPage: 1,
      lastKey: "",
    });
  }

  return paginationState.get(scope);
}

function getPageSizeForView(view) {
  if (view === "3") {
    return 21;
  }

  return 20;
}
