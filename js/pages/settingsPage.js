import { escapeHtml, formatDate } from "../utils.js";
import { getDerivedIndexes } from "../derivedIndexes.js";
import { splitCommaSeparated, splitProjectNames } from "../taxonomy.js";
import { normalizeRssAutoRefreshMinutes } from "../services/rssAutoRefresh.js";
import { runtimeConfig } from "../state.js";

const SETTINGS_SECTIONS = [
  "export",
  "projects",
  "tags",
  "display",
  "rss",
  "about",
];

export function renderSettings(state, dom) {
  const activeSection = SETTINGS_SECTIONS.includes(state.settingsSection)
    ? state.settingsSection
    : "export";

  dom.settingsNavButtons.forEach((button) => {
    const isActive = button.dataset.settingsSection === activeSection;
    button.classList.toggle("settings-nav-button--active", isActive);
    button.setAttribute("aria-pressed", isActive ? "true" : "false");
  });

  dom.settingsPanels.forEach((panel) => {
    panel.hidden = panel.dataset.settingsPanel !== activeSection;
  });

  dom.displayFontButtons.forEach((button) => {
    const isActive = button.dataset.displayFont === state.displayFont;
    button.classList.toggle("display-option-tile--active", isActive);
    button.setAttribute("aria-pressed", isActive ? "true" : "false");
  });
  dom.displayThemeButtons.forEach((button) => {
    const isActive = button.dataset.displayTheme === state.theme;
    button.classList.toggle("display-option-tile--active", isActive);
    button.setAttribute("aria-pressed", isActive ? "true" : "false");
  });
  dom.displayHighlightButtons.forEach((button) => {
    const isActive =
      button.dataset.displayHighlight === state.displayHighlightColor;
    button.classList.toggle("display-option-tile--active", isActive);
    button.setAttribute("aria-pressed", isActive ? "true" : "false");
  });

  if (dom.rssRetentionSelect) {
    const retentionValue =
      state.rssRetentionDays === "never"
        ? "never"
        : String(Number(state.rssRetentionDays) || 7);
    dom.rssRetentionSelect.value = retentionValue;
  }

  if (dom.rssAutoRefreshSelect) {
    const autoRefreshValue = normalizeRssAutoRefreshMinutes(
      state.rssAutoRefreshMinutes,
    );
    dom.rssAutoRefreshSelect.value = String(autoRefreshValue);
  }

  if (dom.rssSettingsLastFetched) {
    const activeFeed = state.rssFeeds.find(
      (feed) => feed.id === state.rssActiveFeedId,
    );
    const fetchedAtEpoch = Date.parse(activeFeed?.lastFetchedAt || "");
    const fetchedAtText = Number.isFinite(fetchedAtEpoch)
      ? formatDate(activeFeed.lastFetchedAt)
      : "Never";

    dom.rssSettingsLastFetched.textContent = activeFeed
      ? `${activeFeed.title || activeFeed.url} last fetched: ${fetchedAtText}`
      : "Select a feed in Explore to see its last fetch time.";
  }

  if (dom.exportMarkdownStatus && activeSection === "export") {
    const supported = typeof window.showDirectoryPicker === "function";

    if (!supported) {
      dom.exportMarkdownStatus.textContent =
        "Markdown folder export requires a Chromium browser (Chrome or Edge).";
    }
  }

  renderProjectList(state, dom);
  renderTagList(state, dom);
  renderAutoTagSettings(state, dom);
  renderArticleTaxonomyHelpers(state, dom);
  renderAboutSection(dom);
}

export function buildArticlesExportPayload(state) {
  return {
    exportedAt: new Date().toISOString(),
    version: 1,
    articles: state.bookmarks,
  };
}

export function buildProjectsExportPayload(state) {
  return {
    exportedAt: new Date().toISOString(),
    version: 1,
    projects: state.projects,
  };
}

function renderAboutSection(dom) {
  const versionEl = dom.aboutAppVersion;
  const descEl = dom.aboutAppDescription;
  if (versionEl) versionEl.textContent = runtimeConfig.appVersion;
  if (descEl) descEl.textContent = runtimeConfig.appDescription;
}

function renderTagList(state, dom) {
  if (state.savedTags.length === 0) {
    dom.tagList.innerHTML =
      '<div class="empty-state empty-state--compact"><h3>No tags yet</h3><p>Tags saved on articles will appear here for editing.</p></div>';
    return;
  }

  const indexes = getDerivedIndexes(state);
  const tagCounts = indexes.tagArticleCount;
  dom.tagList.innerHTML = `
    <table class="settings-table">
      <thead>
        <tr>
          <th>Tag</th>
          <th>Articles</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        ${state.savedTags
          .slice()
          .sort((left, right) => left.localeCompare(right))
          .map(
            (tag) => `
            <tr class="settings-table__row">
              <td class="settings-table__name">
                <i class="fa-solid fa-tag" aria-hidden="true"></i>
                ${escapeHtml(tag)}
              </td>
              <td class="settings-table__count">${tagCounts.get(tag) || 0}</td>
              <td class="settings-table__actions">
                <button class="link-button" data-rename-tag="${escapeHtml(tag)}">Rename</button>
                <button class="link-button" data-delete-tag="${escapeHtml(tag)}">Delete</button>
              </td>
            </tr>
          `,
          )
          .join("")}
      </tbody>
    </table>
  `;
}

function renderProjectList(state, dom) {
  if (state.projects.length === 0) {
    dom.projectSettingsList.innerHTML = "";
    return;
  }

  const indexes = getDerivedIndexes(state);

  dom.projectSettingsList.innerHTML = `
    <table class="settings-table">
      <thead>
        <tr>
          <th>Project</th>
          <th>Articles</th>
          <th>Highlights</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        ${state.projects
          .slice()
          .sort((left, right) => left.name.localeCompare(right.name))
          .map((project) => {
            const stats = indexes.projectStatsById.get(project.id) || {
              articleCount: 0,
              highlightCount: 0,
            };

            return `
            <tr class="settings-table__row">
              <td class="settings-table__name">
                <i class="fa-solid fa-folder-tree" aria-hidden="true"></i>
                ${escapeHtml(project.name)}
              </td>
              <td class="settings-table__count">${stats.articleCount}</td>
              <td class="settings-table__count">${stats.highlightCount}</td>
              <td class="settings-table__actions">
                <button class="link-button" data-rename-project="${project.id}">Rename</button>
                <button class="link-button" data-delete-project="${project.id}">Delete</button>
              </td>
            </tr>
          `;
          })
          .join("")}
      </tbody>
    </table>
  `;
}

export function renderArticleTaxonomyHelpers(state, dom) {
  const indexes = getDerivedIndexes(state);
  const availableTags = indexes.availableTags;
  const availableProjectNames = [
    ...new Set(state.projects.map((project) => project.name)),
  ]
    .slice()
    .sort((left, right) => left.localeCompare(right));

  const autoTagSuggestions = Array.isArray(state.pendingAutoTagSuggestions)
    ? state.pendingAutoTagSuggestions
    : [];

  dom.availableTags.innerHTML = buildTagsSuggestionMarkup({
    savedTags: availableTags,
    autoTagSuggestions,
    currentInputTags: splitCommaSeparated(dom.articleTags?.value || ""),
  });

  dom.availableProjects.innerHTML = buildSuggestionMarkup({
    values: availableProjectNames,
    currentInputProjects: splitProjectNames(dom.articleProjects?.value || ""),
  });
}

function buildSuggestionMarkup({ values, currentInputProjects }) {
  if (values.length === 0) {
    return "";
  }

  const selectedProjects = new Set(
    (Array.isArray(currentInputProjects) ? currentInputProjects : []).map((v) =>
      v.toLowerCase(),
    ),
  );

  return `
    <div class="chip-row">
      ${values
        .map((value) => {
          const isSelected = selectedProjects.has(value.toLowerCase());

          return `<button type="button" class="chip chip--helper ${isSelected ? "chip--filter-active" : ""}" data-toggle-input-project="${escapeHtml(value)}" aria-pressed="${isSelected ? "true" : "false"}">${escapeHtml(value)}</button>`;
        })
        .join("")}
    </div>
  `;
}

function buildTagsSuggestionMarkup({
  savedTags,
  autoTagSuggestions,
  currentInputTags,
}) {
  const currentTags = new Set(
    Array.isArray(currentInputTags) ? currentInputTags : [],
  );
  const seen = new Set();
  const orderedTags = [];

  autoTagSuggestions.forEach((tag) => {
    if (!seen.has(tag)) {
      seen.add(tag);
      orderedTags.push({ value: tag, isSuggestion: true });
    }
  });

  savedTags.forEach((tag) => {
    if (!seen.has(tag)) {
      seen.add(tag);
      orderedTags.push({ value: tag, isSuggestion: false });
    }
  });

  if (orderedTags.length === 0) {
    return "";
  }

  return `
    <div class="chip-row">
      ${orderedTags
        .map(({ value }) => {
          const isSelected = currentTags.has(value);

          return `
            <button
              type="button"
              class="chip chip--helper ${isSelected ? "chip--filter-active" : ""}"
              data-toggle-input-tag="${escapeHtml(value)}"
              aria-pressed="${isSelected ? "true" : "false"}"
            >
              ${escapeHtml(value)}
            </button>
          `;
        })
        .join("")}
    </div>
  `;
}

function renderAutoTagSettings(state, dom) {
  if (dom.autoTagEnabled) {
    dom.autoTagEnabled.checked = state.autoTagEnabled !== false;
  }

  if (dom.autoTagUseDefaultCountries) {
    dom.autoTagUseDefaultCountries.checked =
      state.autoTagUseDefaultCountries !== false;
  }

  if (!dom.autoTagRulesList) {
    return;
  }

  const rules = Array.isArray(state.autoTagCustomRules)
    ? state.autoTagCustomRules
    : [];

  if (rules.length === 0) {
    dom.autoTagRulesList.innerHTML = "";
    return;
  }

  dom.autoTagRulesList.innerHTML = rules
    .slice()
    .sort((left, right) => left.tag.localeCompare(right.tag))
    .map(
      (rule) => `
      <div class="settings-rule-item">
        <div class="settings-rule-item__info">
          <span class="settings-rule-item__tag">${escapeHtml(rule.tag)}</span>
          <span class="settings-rule-item__keywords">${escapeHtml(
            (rule.keywords || []).join(", "),
          )}</span>
        </div>
        <button class="link-button" data-delete-autotag-rule="${escapeHtml(
          rule.tag,
        )}">Delete</button>
      </div>
    `,
    )
    .join("");
}
