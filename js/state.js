export const STORAGE_KEY = "bookmark-manager-state-v1";
export const DEFAULT_FETCH_TIMEOUT_MS = 25000;

export const runtimeConfig = {
  fetchServiceUrl: "",
  supabaseAnonKey: "",
  requestTimeoutMs: DEFAULT_FETCH_TIMEOUT_MS,
  appVersion: "1.0.0",
  appDescription: "",
};

function nextRuntimeVersion(value) {
  return Number(value || 0) + 1;
}

export function initializeRuntimeState(state) {
  state.__persistEpoch = Number(state.__persistEpoch || 0);
  state.__bookmarksVersion = Number(state.__bookmarksVersion || 0);
  state.__projectsVersion = Number(state.__projectsVersion || 0);
  state.__rssVersion = Number(state.__rssVersion || 0);
  state.__dirtyBookmarks = Boolean(state.__dirtyBookmarks);
  state.__dirtyProjects = Boolean(state.__dirtyProjects);
  state.__dirtyRss = Boolean(state.__dirtyRss);
  state.__dirtyMeta = Boolean(state.__dirtyMeta);
}

export function touchBookmarks(state) {
  initializeRuntimeState(state);
  state.__bookmarksVersion = nextRuntimeVersion(state.__bookmarksVersion);
  state.__dirtyBookmarks = true;
}

export function touchProjects(state) {
  initializeRuntimeState(state);
  state.__projectsVersion = nextRuntimeVersion(state.__projectsVersion);
  state.__dirtyProjects = true;
}

export function touchRss(state) {
  initializeRuntimeState(state);
  state.__rssVersion = nextRuntimeVersion(state.__rssVersion);
  state.__dirtyRss = true;
}

export function touchMeta(state) {
  initializeRuntimeState(state);
  state.__dirtyMeta = true;
}

export const state = {
  bookmarks: [],
  projects: [],
  savedTags: [],
  selectedArticleId: null,
  selectedProjectId: null,
  selectedProjectSidebarArticleId: null,
  projectShowMarkdown: true,
  activeTab: "library",
  libraryTagFilters: [],
  libraryProjectFilters: [],
  libraryView: "2",
  librarySort: "newest",
  libraryShowImages: true,
  libraryShowTags: true,
  projectsStageFilter: null,
  projectsView: "2",
  projectsSort: "newest",
  settingsSection: "export",
  autoTagEnabled: true,
  autoTagUseDefaultCountries: true,
  autoTagCustomRules: [],
  displayFont: "mono",
  theme: "light",
  displayHighlightColor: "green",
  ttsVoiceId: "",
  ttsRate: 1,
  pendingSelection: null,
  rssFeeds: [],
  rssActiveFeedId: null,
  rssSelectedFeedIds: [],
  rssFolderFilter: "",
  rssView: "2",
  rssSort: "newest",
  rssReadFilter: "all",
  rssRetentionDays: 7,
  rssAutoRefreshMinutes: "off",
  rssReaderArticle: null,
  __persistEpoch: 0,
  __bookmarksVersion: 0,
  __projectsVersion: 0,
  __rssVersion: 0,
  __dirtyBookmarks: false,
  __dirtyProjects: false,
  __dirtyRss: false,
  __dirtyMeta: false,
};
