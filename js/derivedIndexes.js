let cachedEpoch = -1;
let cachedIndexes = null;

export function getDerivedIndexes(state) {
  const epoch = `${Number(state.__bookmarksVersion || 0)}::${Number(state.__projectsVersion || 0)}`;

  if (cachedIndexes && cachedEpoch === epoch) {
    return cachedIndexes;
  }

  const projectNameById = new Map();
  const projectStatsById = new Map();
  const tagArticleCount = new Map();

  (state.projects || []).forEach((project) => {
    projectNameById.set(project.id, project.name);
    projectStatsById.set(project.id, { articleCount: 0, highlightCount: 0 });
  });

  (state.bookmarks || []).forEach((bookmark) => {
    const uniqueTags = new Set((bookmark.tags || []).filter(Boolean));
    uniqueTags.forEach((tag) => {
      tagArticleCount.set(tag, (tagArticleCount.get(tag) || 0) + 1);
    });

    const highlightCount = Array.isArray(bookmark.highlights)
      ? bookmark.highlights.length
      : 0;
    const uniqueProjectIds = new Set(
      (bookmark.projectIds || []).filter(Boolean),
    );

    uniqueProjectIds.forEach((projectId) => {
      const stats = projectStatsById.get(projectId);

      if (!stats) {
        return;
      }

      stats.articleCount += 1;
      stats.highlightCount += highlightCount;
    });
  });

  const availableTags = [...tagArticleCount.keys()].sort((left, right) =>
    left.localeCompare(right),
  );

  cachedEpoch = epoch;
  cachedIndexes = {
    projectNameById,
    projectStatsById,
    tagArticleCount,
    availableTags,
  };

  return cachedIndexes;
}
