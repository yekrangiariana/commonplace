import { renderBlock, hideSelectionMenu } from "../highlighter.js";
import { escapeHtml, formatDate } from "../utils.js";

function normalizeHeading(value) {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function formatDateDayMonthYear(isoDate) {
  if (!isoDate) {
    return "";
  }

  const date = new Date(isoDate);

  if (Number.isNaN(date.getTime())) {
    return "";
  }

  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(date);
}

function formatAddedDateTime(isoDate) {
  if (!isoDate) {
    return "";
  }

  const date = new Date(isoDate);

  if (Number.isNaN(date.getTime())) {
    return "";
  }

  const dayMonth = new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "2-digit",
  }).format(date);
  const time = new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);

  return `${dayMonth} at ${time}`;
}

function deriveSource(article) {
  if (article.source) {
    return article.source;
  }

  try {
    return new URL(article.url || "").hostname.replace(/^www\./i, "");
  } catch {
    return "this source";
  }
}

function buildSourceLinkMarkup(article) {
  const sourceLabel = escapeHtml(deriveSource(article));
  const href = escapeHtml(article.url || "");

  if (!href) {
    return sourceLabel;
  }

  return `<a class="reader-byline__source" href="${href}" target="_blank" rel="noopener noreferrer">${sourceLabel}</a>`;
}

function getReaderByline(article) {
  const sourceLink = buildSourceLinkMarkup(article);
  const publishedText = formatDateDayMonthYear(article.publishedAt);
  const addedText = formatAddedDateTime(article.createdAt);
  const publishedSegment = publishedText
    ? `Published on ${publishedText} by ${sourceLink}.`
    : `By ${sourceLink}.`;
  const addedSegment = addedText ? ` Added on ${addedText}` : "";

  return `${publishedSegment}${addedSegment}`;
}

export function renderReader(state, dom, activeArticle) {
  if (!activeArticle) {
    dom.readerTitle.textContent = "Choose an article";
    dom.readerMeta.innerHTML =
      '<p class="reader-byline"></p><div class="tts-player-host" data-reader-tts-player-host></div>';
    dom.readerSurface.innerHTML =
      '<div class="empty-state"><h3>No article selected</h3><p>Select an article from the library to read and highlight it.</p></div>';
    dom.highlightList.innerHTML =
      '<div class="empty-state"><p>Highlights for the selected article will appear here.</p></div>';
    hideSelectionMenu(dom);
    return;
  }

  const isTransientRss = Boolean(activeArticle.isTransientRss);

  dom.readerTitle.textContent = activeArticle.title;

  const availableTags = state.savedTags
    .slice()
    .sort((left, right) => left.localeCompare(right))
    .map(
      (tag) =>
        `<button type="button" class="chip chip--helper" data-reader-pick-tag="${escapeHtml(tag)}">${escapeHtml(tag)}</button>`,
    )
    .join("");
  const availableProjects = state.projects
    .slice()
    .sort((left, right) => left.name.localeCompare(right.name))
    .map(
      (project) =>
        `<button type="button" class="chip chip--helper" data-reader-pick-project="${escapeHtml(project.name)}">${escapeHtml(project.name)}</button>`,
    )
    .join("");

  const projectChips = activeArticle.projectIds
    .map((projectId) => {
      const project = state.projects.find(
        (currentProject) => currentProject.id === projectId,
      );

      if (!project) {
        return null;
      }

      return `
        <span class="chip chip--project chip--removable">
          <button
            type="button"
            class="chip__label chip__label--nav"
            data-nav-library-project="${project.id}"
            title="Filter library by ${escapeHtml(project.name)}"
          >
            ${escapeHtml(project.name)}
          </button>
          <button
            type="button"
            class="chip__remove"
            data-reader-remove-project="${project.id}"
            aria-label="Remove ${escapeHtml(project.name)} from this article"
            title="Remove ${escapeHtml(project.name)} from this article"
          >
            <i class="fa-solid fa-xmark" aria-hidden="true"></i>
          </button>
        </span>
      `;
    })
    .filter(Boolean)
    .join("");

  const tagsMarkup = activeArticle.tags
    .map(
      (tag) => `
        <span class="chip chip--tag chip--removable">
          <button
            type="button"
            class="chip__label chip__label--nav"
            data-nav-library-tag="${escapeHtml(tag)}"
            title="Filter library by ${escapeHtml(tag)}"
          >
            ${escapeHtml(tag)}
          </button>
          <button
            type="button"
            class="chip__remove"
            data-reader-remove-tag="${escapeHtml(tag)}"
            aria-label="Remove ${escapeHtml(tag)} from this article"
            title="Remove ${escapeHtml(tag)} from this article"
          >
            <i class="fa-solid fa-xmark" aria-hidden="true"></i>
          </button>
        </span>
      `,
    )
    .join("");

  const transientSaveButtonMarkup = isTransientRss
    ? `
      <button type="button" class="chip chip--helper chip--meta-action chip--meta-action--library" data-reader-save-rss>
        <i class="fa-solid fa-plus" aria-hidden="true"></i>
        Library
      </button>
    `
    : "";

  const tagProjectActionsMarkup = `
      <div class="reader-meta-action-wrap">
        <button type="button" class="chip chip--helper chip--meta-action" data-reader-open-tags>
          <i class="fa-solid fa-plus" aria-hidden="true"></i>
          Tag
        </button>
        <div class="reader-popover" data-reader-popover="tags" hidden>
          <div class="chip-row">${availableTags}</div>
          <input
            type="text"
            placeholder="tag-one, tag-two"
            data-reader-input-tags
          />
          <div class="reader-popover-actions">
            <button type="button" class="button button--primary button--small" data-reader-apply-tags>
              Apply
            </button>
          </div>
        </div>
      </div>
      <div class="reader-meta-action-wrap">
        <button type="button" class="chip chip--helper chip--meta-action" data-reader-open-projects>
          <i class="fa-solid fa-plus" aria-hidden="true"></i>
          Project
        </button>
        <div class="reader-popover" data-reader-popover="projects" hidden>
          <div class="chip-row">${availableProjects}</div>
          <input
            type="text"
            placeholder="essay draft, policy brief"
            data-reader-input-projects
          />
          <div class="reader-popover-actions">
            <button type="button" class="button button--primary button--small" data-reader-apply-projects>
              Apply
            </button>
          </div>
        </div>
      </div>
    `;

  const editButtonMarkup = isTransientRss
    ? ""
    : `
      <button type="button" class="chip chip--helper chip--meta-action" data-reader-edit-content>
        <i class="fa-solid fa-pen" aria-hidden="true"></i>
        Edit
      </button>
      <button type="button" class="chip chip--helper chip--meta-action chip--success" data-reader-save-content hidden>
        <i class="fa-solid fa-check" aria-hidden="true"></i>
        Save
      </button>
      <button type="button" class="chip chip--helper chip--meta-action" data-reader-cancel-edit hidden>
        <i class="fa-solid fa-xmark" aria-hidden="true"></i>
        Cancel
      </button>
    `;

  dom.readerMeta.innerHTML = `
    <p class="reader-byline">${getReaderByline(activeArticle)}</p>
    <div class="chip-row reader-meta-row">
      ${tagsMarkup}
      ${projectChips}
      ${tagProjectActionsMarkup}
      ${editButtonMarkup}
      ${transientSaveButtonMarkup}
    </div>
    <div class="tts-player-host" data-reader-tts-player-host></div>
  `;

  const blocksWithOffsets = computeBlockOffsets(activeArticle.blocks);
  const visibleBlocks =
    blocksWithOffsets.length > 0 &&
    blocksWithOffsets[0].type === "heading" &&
    normalizeHeading(blocksWithOffsets[0].text) ===
      normalizeHeading(activeArticle.title)
      ? blocksWithOffsets.slice(1)
      : blocksWithOffsets;

  dom.readerSurface.innerHTML = visibleBlocks
    .map((block) => renderBlock(block, activeArticle.highlights, escapeHtml))
    .join("");

  renderHighlightList(dom, activeArticle);
}

export function renderHighlightList(dom, article) {
  if (article.isTransientRss) {
    dom.highlightList.innerHTML =
      '<div class="empty-state"><p>Add this RSS article to bookmarks to start highlighting.</p></div>';
    return;
  }

  if (article.highlights.length === 0) {
    dom.highlightList.innerHTML =
      '<div class="empty-state"><p>Select any text in the article and save it as a highlight.</p></div>';
    return;
  }

  dom.highlightList.innerHTML = article.highlights
    .slice()
    .sort((left, right) => left.start - right.start)
    .map(
      (highlight) => `
      <article class="highlight-card">
        <div class="highlight-card__actions">
          <button class="link-button" data-remove-highlight="${highlight.id}">Remove</button>
        </div>
        <blockquote class="highlight-quote">${escapeHtml(highlight.quote)}</blockquote>
        <div class="highlight-card__footer">
          <p class="highlight-meta">${formatDate(highlight.createdAt)}</p>
        </div>
      </article>
    `,
    )
    .join("");
}

function computeBlockOffsets(blocks) {
  let cursor = 0;

  return blocks.map((block, index) => {
    const start = cursor;
    const end = start + block.text.length;
    cursor = end + (index < blocks.length - 1 ? 2 : 0);
    return { ...block, start, end };
  });
}
