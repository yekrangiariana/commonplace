import { touchBookmarks, touchMeta, touchProjects, recordTombstone, bumpItemSync } from "./state.js";

export function normalizeTag(value) {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

export function splitCommaSeparated(value) {
  return value
    .split(",")
    .map((item) => normalizeTag(item))
    .filter(Boolean);
}

export function normalizeProjectName(value) {
  return value.replace(/\s+/g, " ").trim();
}

export function splitProjectNames(value) {
  const seen = new Set();

  return value
    .split(",")
    .map((item) => normalizeProjectName(item))
    .filter((item) => {
      if (!item) {
        return false;
      }

      const key = item.toLowerCase();

      if (seen.has(key)) {
        return false;
      }

      seen.add(key);
      return true;
    });
}

export function dedupeTags(tags) {
  return [...new Set(tags.filter(Boolean))];
}

export function syncSavedTags(state, tags) {
  state.savedTags = dedupeTags([...state.savedTags, ...tags]);
  touchMeta(state);
  return dedupeTags(tags);
}

export function collectTagsFromBookmarks(bookmarks) {
  return dedupeTags(
    bookmarks.flatMap((bookmark) => bookmark.tags || []).map(normalizeTag),
  );
}

export function countArticlesPerTag(state) {
  const counts = new Map();

  state.bookmarks.forEach((bookmark) => {
    dedupeTags(bookmark.tags || []).forEach((tag) => {
      counts.set(tag, (counts.get(tag) || 0) + 1);
    });
  });

  return counts;
}

export function getProjectNames(state, projectIds) {
  return projectIds
    .map(
      (projectId) =>
        state.projects.find((project) => project.id === projectId)?.name,
    )
    .filter(Boolean);
}

export function syncProjectsByName(state, projectNames, createId) {
  return projectNames.map((projectName) => {
    const existingProject = state.projects.find(
      (project) =>
        normalizeProjectName(project.name).toLowerCase() ===
        projectName.toLowerCase(),
    );

    if (existingProject) {
      return existingProject.id;
    }

    const project = {
      id: createId("project"),
      name: projectName,
      stage: "idea",
      description: "",
      content: "",
      createdAt: new Date().toISOString(),
    };

    state.projects.unshift(project);
    touchProjects(state);
    return project.id;
  });
}

export function toggleArticleProject(state, articleId, projectId) {
  const article = state.bookmarks.find((bookmark) => bookmark.id === articleId);

  if (!article) {
    return;
  }

  if (article.projectIds.includes(projectId)) {
    article.projectIds = article.projectIds.filter(
      (currentProjectId) => currentProjectId !== projectId,
    );
  } else {
    article.projectIds.push(projectId);
  }

  bumpItemSync(article, ["projectIds"]);
  touchBookmarks(state);
}

export function deleteProject(state, projectId) {
  state.projects = state.projects.filter((project) => project.id !== projectId);
  recordTombstone(state, "projects", projectId);
  state.bookmarks = state.bookmarks.map((bookmark) => {
    const filtered = bookmark.projectIds.filter(
      (currentProjectId) => currentProjectId !== projectId,
    );
    const changed = filtered.length !== bookmark.projectIds.length;
    const updated = { ...bookmark, projectIds: filtered };
    if (changed) bumpItemSync(updated, ["projectIds"]);
    return updated;
  });
  state.selectedProjectId =
    state.selectedProjectId === projectId ? null : state.selectedProjectId;
  touchProjects(state);
  touchBookmarks(state);
  touchMeta(state);
}

export function renameProject(state, projectId, nextName) {
  const project = state.projects.find(
    (currentProject) => currentProject.id === projectId,
  );

  if (!project) {
    return;
  }

  project.name = normalizeProjectName(nextName);
  bumpItemSync(project, ["name"]);
  touchProjects(state);
}

export function renameTag(state, currentTag, nextTag) {
  state.bookmarks = state.bookmarks.map((bookmark) => {
    const newTags = dedupeTags(
      bookmark.tags.map((tag) => (tag === currentTag ? nextTag : tag)),
    );
    const changed = newTags.join(",") !== bookmark.tags.join(",");
    const updated = { ...bookmark, tags: newTags };
    if (changed) bumpItemSync(updated, ["tags"]);
    return updated;
  });
  state.savedTags = dedupeTags(
    state.savedTags.map((tag) => (tag === currentTag ? nextTag : tag)),
  );
  touchBookmarks(state);
  touchMeta(state);
}

export function deleteTag(state, tagToDelete) {
  state.bookmarks = state.bookmarks.map((bookmark) => {
    const newTags = bookmark.tags.filter((tag) => tag !== tagToDelete);
    const changed = newTags.length !== bookmark.tags.length;
    const updated = { ...bookmark, tags: newTags };
    if (changed) bumpItemSync(updated, ["tags"]);
    return updated;
  });
  state.savedTags = state.savedTags.filter((tag) => tag !== tagToDelete);
  touchBookmarks(state);
  touchMeta(state);
}
