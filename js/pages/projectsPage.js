import { escapeHtml, previewText } from "../utils.js";
import { getSelectedProject, renderProjectEditor } from "./editor.js";
import { getDerivedIndexes } from "../derivedIndexes.js";
import {
  getPaginatedItems,
  goToNextPage,
  goToPreviousPage,
  buildPaginationMarkup,
} from "./pagination.js";

const PROJECTS_PAGINATION_SCOPE = "projects";
const PROJECT_STAGES = ["idea", "research", "done"];
let _sortedProjectsCache = null;
let _projectFilterCache = null;

function getCachedSortedProjects(state, sortMode) {
  const version = Number(state.__projectsVersion || 0);
  const stageKey = state.projectsStageFilter || "all";

  if (
    _sortedProjectsCache &&
    _sortedProjectsCache.version === version &&
    _sortedProjectsCache.stageKey === stageKey &&
    _sortedProjectsCache.sortMode === sortMode
  ) {
    return _sortedProjectsCache.result;
  }

  const result = sortProjects(getFilteredProjects(state), sortMode);
  _sortedProjectsCache = { version, stageKey, sortMode, result };
  return result;
}

export function renderProjectFilters(state, dom) {
  if (state.projects.length === 0) {
    dom.projectsProjectFilters.innerHTML = "";
    dom.projectsProjectClear.hidden = true;
    return;
  }

  const projectsVersion = Number(state.__projectsVersion || 0);
  const activeStage = state.projectsStageFilter || "all";

  if (
    !_projectFilterCache ||
    _projectFilterCache.projectsVersion !== projectsVersion ||
    _projectFilterCache.activeStage !== activeStage
  ) {
    const countsByStage = PROJECT_STAGES.reduce((accumulator, stage) => {
      accumulator[stage] = 0;
      return accumulator;
    }, {});

    state.projects.forEach((project) => {
      const stage = PROJECT_STAGES.includes(project.stage)
        ? project.stage
        : "idea";
      countsByStage[stage] += 1;
    });

    _projectFilterCache = {
      projectsVersion,
      activeStage,
      markup: PROJECT_STAGES.map((stage) => {
        const isActive = state.projectsStageFilter === stage;
        const label = stage.charAt(0).toUpperCase() + stage.slice(1);

        return `
        <button
          type="button"
          class="stage-folder sidebar-folder-button stage-folder--${stage} ${isActive ? "sidebar-folder-button--active stage-folder--active" : ""}"
          data-toggle-project-stage="${stage}"
          aria-pressed="${isActive ? "true" : "false"}"
        >
          <span class="stage-folder__name sidebar-folder-button__name"><i class="fa-solid fa-folder" aria-hidden="true"></i>${label}</span>
          <span class="stage-folder__count sidebar-folder-button__count">${countsByStage[stage]}</span>
        </button>
      `;
      }).join(""),
    };
  }

  dom.projectsProjectFilters.innerHTML = _projectFilterCache.markup;

  dom.projectsProjectClear.hidden = !state.projectsStageFilter;
}

export function renderProjects(state, dom) {
  const selectedProject = getSelectedProject(state);
  const view = state.projectsView || "2";
  const sortMode = state.projectsSort || "newest";
  const indexes = getDerivedIndexes(state);

  if (dom.projectsTitle) {
    dom.projectsTitle.textContent = `Workspaces (${state.projects.length})`;
  }

  dom.projectList.className = `project-list project-list--view-${view}`;

  document.querySelectorAll("[data-project-view]").forEach((btn) => {
    btn.classList.toggle("view-btn--active", btn.dataset.projectView === view);
  });

  document.querySelectorAll("[data-project-sort]").forEach((btn) => {
    btn.classList.toggle(
      "view-btn--active",
      btn.dataset.projectSort === sortMode,
    );
  });

  renderProjectEditor(state, dom, selectedProject);

  const sortedProjects = getCachedSortedProjects(state, sortMode);
  const paginationKey = [
    view,
    sortMode,
    sortedProjects.length,
    state.projectsStageFilter || "all",
  ].join("::");
  const {
    pagedItems: pagedProjects,
    currentPage,
    totalPages,
  } = getPaginatedItems({
    scope: PROJECTS_PAGINATION_SCOPE,
    items: sortedProjects,
    view,
    paginationKey,
  });

  if (state.projects.length === 0) {
    dom.projectList.innerHTML =
      '<div class="empty-state"><h3>No projects yet</h3><p>Create a project in Settings to start building a writing workspace.</p></div>';
    return;
  }

  if (sortedProjects.length === 0) {
    dom.projectList.innerHTML =
      '<div class="empty-state"><h3>No matching projects</h3><p>Try clearing one or more filters.</p></div>';
    return;
  }

  const cardsMarkup = pagedProjects
    .map((project) => {
      const stats = indexes.projectStatsById.get(project.id) || {
        articleCount: 0,
        highlightCount: 0,
      };
      const stage = getNormalizedProjectStage(project.stage);
      const stageLabel = getProjectStageLabel(stage);
      const hasDraft = Boolean((project.content || "").trim());
      const noteText = hasDraft
        ? previewText(project.content, 180)
        : "No draft notes yet";

      return `
        <article
          class="project-card"
          data-open-project="${project.id}"
          data-project-id="${project.id}"
          draggable="true"
          role="button"
          tabindex="0"
        >
          <div class="project-card__header">
            <div>
              <h3 class="project-card__title">
                <span class="project-card__stage project-card__stage--${stage}">
                  <i class="fa-solid fa-folder" aria-hidden="true"></i>
                  ${escapeHtml(stageLabel)}
                </span>
                <span class="project-card__title-separator" aria-hidden="true">-</span>
                <span>${escapeHtml(project.name)}</span>
              </h3>
              <p class="project-description">${escapeHtml(project.description || "No description yet.")}</p>
            </div>
            <button
              class="article-card__delete"
              type="button"
              data-delete-project="${project.id}"
              title="Delete project"
              aria-label="Delete ${escapeHtml(project.name)}"
            >
              <i class="fa-solid fa-xmark" aria-hidden="true"></i>
            </button>
          </div>

          <div class="project-card__body">
            <div class="chip-row">
              <span class="chip chip--project" title="${stats.articleCount} related articles" aria-label="${stats.articleCount} related articles"><i class="fa-solid fa-link" aria-hidden="true"></i> ${stats.articleCount}</span>
              <span class="chip chip--count"><i class="fa-regular fa-comment" aria-hidden="true"></i> ${stats.highlightCount}</span>
            </div>
            <p class="meta-text">${escapeHtml(noteText)}</p>
          </div>
        </article>
      `;
    })
    .join("");

  const paginationMarkup = buildPaginationMarkup({
    scope: PROJECTS_PAGINATION_SCOPE,
    currentPage,
    totalPages,
    label: "Projects pagination",
  });

  dom.projectList.innerHTML = `${cardsMarkup}${paginationMarkup}`;
}

export function goToNextProjectsPage(state, dom) {
  const sortMode = state.projectsSort || "newest";
  const filteredProjects = getCachedSortedProjects(state, sortMode);
  const view = state.projectsView || "2";
  const paginationKey = [
    view,
    sortMode,
    filteredProjects.length,
    state.projectsStageFilter || "all",
  ].join("::");
  const { totalPages } = getPaginatedItems({
    scope: PROJECTS_PAGINATION_SCOPE,
    items: filteredProjects,
    view,
    paginationKey,
  });

  if (!goToNextPage(PROJECTS_PAGINATION_SCOPE, totalPages)) {
    return;
  }

  renderProjects(state, dom);
}

export function goToPreviousProjectsPage(state, dom) {
  if (!goToPreviousPage(PROJECTS_PAGINATION_SCOPE)) {
    return;
  }

  renderProjects(state, dom);
}

function getFilteredProjects(state) {
  return state.projects.filter((project) => {
    const stage = PROJECT_STAGES.includes(project.stage)
      ? project.stage
      : "idea";
    const matchesProjectFilter =
      !state.projectsStageFilter || state.projectsStageFilter === stage;

    if (!matchesProjectFilter) {
      return false;
    }

    return true;
  });
}

function sortProjects(projects, sortMode) {
  const sorted = projects.slice();

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

function getCreatedAtMs(project) {
  return Date.parse(project.createdAt || 0) || 0;
}

function getLastOpenedAtMs(project) {
  const opened = Date.parse(project.lastOpenedAt || 0) || 0;
  return opened || getCreatedAtMs(project);
}

function getProjectStageLabel(stage) {
  return stage.charAt(0).toUpperCase() + stage.slice(1);
}

function getNormalizedProjectStage(stage) {
  return PROJECT_STAGES.includes(stage) ? stage : "idea";
}
