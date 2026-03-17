import { escapeHtml, formatDate } from "../utils.js";
import { getDerivedIndexes } from "../derivedIndexes.js";
import { splitCommaSeparated, splitProjectNames } from "../taxonomy.js";
import { normalizeRssAutoRefreshMinutes } from "../services/rssAutoRefresh.js";

const SETTINGS_SECTIONS = ["export", "projects", "tags", "display", "rss"];

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

function renderTagList(state, dom) {
  if (state.savedTags.length === 0) {
    dom.tagList.innerHTML =
      '<div class="empty-state empty-state--compact"><h3>No tags yet</h3><p>Tags saved on articles will appear here for editing.</p></div>';
    return;
  }

  const indexes = getDerivedIndexes(state);
  const tagCounts = indexes.tagArticleCount;
  dom.tagList.innerHTML = state.savedTags
    .slice()
    .sort((left, right) => left.localeCompare(right))
    .map(
      (tag) => `
      <article class="tag-card settings-entity-card">
        <div class="tag-card__header settings-entity-card__header">
          <div>
            <h3 class="settings-entity-card__title">
              <i class="fa-solid fa-tag" aria-hidden="true"></i>
              ${escapeHtml(tag)}
            </h3>
            <p class="meta-text settings-entity-card__meta">Used in ${tagCounts.get(tag) || 0} articles</p>
          </div>
          <div class="tag-card__actions settings-entity-card__actions">
            <button class="link-button" data-rename-tag="${escapeHtml(tag)}">Rename</button>
            <button class="link-button" data-delete-tag="${escapeHtml(tag)}">Delete</button>
          </div>
        </div>
      </article>
    `,
    )
    .join("");
}

function renderProjectList(state, dom) {
  if (state.projects.length === 0) {
    dom.projectSettingsList.innerHTML =
      '<div class="empty-state empty-state--compact"><h3>No projects yet</h3><p>Create a project to organize your writing workspace.</p></div>';
    return;
  }

  const indexes = getDerivedIndexes(state);

  dom.projectSettingsList.innerHTML = state.projects
    .slice()
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((project) => {
      const stats = indexes.projectStatsById.get(project.id) || {
        articleCount: 0,
        highlightCount: 0,
      };

      return `
        <article class="tag-card settings-entity-card">
          <div class="tag-card__header settings-entity-card__header">
            <div>
              <h3 class="settings-entity-card__title">
                <i class="fa-solid fa-folder-tree" aria-hidden="true"></i>
                ${escapeHtml(project.name)}
              </h3>
              <div class="chip-row settings-entity-card__chips">
                <span class="chip chip--project" title="${stats.articleCount} related articles" aria-label="${stats.articleCount} related articles"><i class="fa-solid fa-link" aria-hidden="true"></i> ${stats.articleCount}</span>
                <span class="chip chip--count"><i class="fa-regular fa-comment" aria-hidden="true"></i> ${stats.highlightCount}</span>
              </div>
            </div>
            <div class="tag-card__actions settings-entity-card__actions">
              <button class="link-button" data-rename-project="${project.id}">Rename</button>
              <button class="link-button" data-delete-project="${project.id}">Delete</button>
            </div>
          </div>
        </article>
      `;
    })
    .join("");
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
    dom.autoTagRulesList.innerHTML =
      '<div class="empty-state empty-state--compact"><h3>No custom rules yet</h3><p>Add keyword to tag mappings, or import them as JSON.</p></div>';
    return;
  }

  dom.autoTagRulesList.innerHTML = rules
    .slice()
    .sort((left, right) => left.tag.localeCompare(right.tag))
    .map(
      (rule) => `
      <article class="tag-card settings-entity-card">
        <div class="tag-card__header settings-entity-card__header">
          <div>
            <h3 class="settings-entity-card__title">
              <i class="fa-solid fa-wand-magic-sparkles" aria-hidden="true"></i>
              ${escapeHtml(rule.tag)}
            </h3>
            <p class="meta-text settings-entity-card__meta">Triggers on: ${escapeHtml(
              (rule.keywords || []).join(", "),
            )}</p>
          </div>
          <div class="tag-card__actions settings-entity-card__actions">
            <button class="link-button" data-delete-autotag-rule="${escapeHtml(
              rule.tag,
            )}">Delete</button>
          </div>
        </div>
      </article>
    `,
    )
    .join("");
}
