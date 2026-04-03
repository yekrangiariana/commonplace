import { renderBlock } from "../highlighter.js";
import { touchProjects, markProjectDirty } from "../state.js";
import { escapeHtml, formatDate } from "../utils.js";

function normalizeHeading(value) {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function normalizeProjectMarkdownTitle(value) {
  return value.replace(/\s+/g, " ").trim();
}

function extractProjectTitleFromMarkdown(markdown) {
  const lines = (markdown || "").replace(/\r\n/g, "\n").split("\n");

  for (const line of lines) {
    if (!line.trim()) {
      continue;
    }

    const headingMatch = line.match(/^#\s+(.+)$/);

    if (!headingMatch) {
      return null;
    }

    const title = normalizeProjectMarkdownTitle(headingMatch[1] || "");
    return title || null;
  }

  return null;
}

function ensureProjectMarkdownHeading(content, projectName) {
  const normalizedContent = (content || "").replace(/\r\n/g, "\n");
  const title = normalizeProjectMarkdownTitle(
    projectName || "Untitled project",
  );
  const lines = normalizedContent.split("\n");
  const firstNonEmptyLine = lines.find((line) => line.trim());

  if (firstNonEmptyLine && /^#\s+/.test(firstNonEmptyLine.trim())) {
    return normalizedContent;
  }

  const body = normalizedContent.trim();
  return body ? `# ${title}\n\n${body}` : `# ${title}\n\n`;
}

function formatProjectStageLabel(stage) {
  if (stage === "research") {
    return "Research";
  }

  if (stage === "done") {
    return "Done";
  }

  return "Idea";
}

export function getSelectedProject(state) {
  return (
    state.projects.find((project) => project.id === state.selectedProjectId) ||
    null
  );
}

export function renderProjectEditor(state, dom, project) {
  const isOpen = Boolean(project);
  dom.projectsLibraryPanel.hidden = isOpen;
  dom.projectEditorPanel.hidden = !isOpen;

  if (!project) {
    return;
  }

  const projectArticles = getProjectArticles(state, project.id);
  const highlightGroups = getProjectHighlightGroups(projectArticles);
  const projectHighlightCount = highlightGroups.reduce(
    (count, group) => count + group.highlights.length,
    0,
  );
  const activeSidebarArticle = projectArticles.find(
    (article) => article.id === state.selectedProjectSidebarArticleId,
  );

  if (!activeSidebarArticle && state.selectedProjectSidebarArticleId) {
    state.selectedProjectSidebarArticleId = null;
  }

  const editorContent = ensureProjectMarkdownHeading(
    project.content,
    project.name,
  );
  const markdownTitle = extractProjectTitleFromMarkdown(editorContent);
  if (markdownTitle && markdownTitle !== project.name) {
    project.name = markdownTitle;
    touchProjects(state);
  }
  dom.projectSidebarMeta.innerHTML = `
    <div class="chip-row">
      <span class="chip chip--project" title="${projectArticles.length} related articles" aria-label="${projectArticles.length} related articles"><i class="fa-solid fa-link" aria-hidden="true"></i> ${projectArticles.length}</span>
      <span class="chip chip--count" title="${projectHighlightCount} highlights" aria-label="${projectHighlightCount} highlights"><i class="fa-regular fa-comment" aria-hidden="true"></i> ${projectHighlightCount}</span>
    </div>
  `;

  dom.projectToggleMarkdownButton.innerHTML = state.projectShowMarkdown
    ? '<i class="fa-solid fa-eye" aria-hidden="true"></i> Preview'
    : '<i class="fa-solid fa-pen" aria-hidden="true"></i> Edit';
  dom.projectToggleMarkdownButton.setAttribute(
    "aria-pressed",
    state.projectShowMarkdown ? "true" : "false",
  );
  const projectStage = ["idea", "research", "done"].includes(project.stage)
    ? project.stage
    : "idea";
  dom.projectStageMenuLabel.textContent = formatProjectStageLabel(projectStage);
  dom.projectStageMenuButton.setAttribute(
    "aria-label",
    `Project progress: ${formatProjectStageLabel(projectStage)}`,
  );
  dom.projectStageMenuOptions.forEach((option) => {
    const isSelected = option.dataset.projectStageOption === projectStage;
    option.classList.toggle("is-selected", isSelected);
    option.setAttribute("aria-checked", isSelected ? "true" : "false");
  });
  dom.projectEditorContent.hidden = !state.projectShowMarkdown;
  dom.projectEditorPreview.hidden = state.projectShowMarkdown;
  dom.projectEditorContent.value = editorContent;
  renderProjectMarkdownPreview(dom, editorContent);
  if (state.projectShowMarkdown) {
    requestAnimationFrame(() => dom.projectEditorContent.focus());
  }

  if (activeSidebarArticle) {
    renderProjectSidebarReader(dom, activeSidebarArticle);
    return;
  }

  dom.projectSidebarTopbar.hidden = true;
  dom.projectSidebarTitle.textContent = "Project excerpts";

  if (projectHighlightCount === 0) {
    dom.projectHighlightList.innerHTML =
      '<div class="empty-state empty-state--compact empty-state--left"><p>Highlights from project articles appear here once you annotate them.</p></div>';
    return;
  }

  dom.projectHighlightList.innerHTML = highlightGroups
    .map(
      (group) => `
      <section class="project-highlight-group">
        <div class="project-highlight-group__header">
          <button
            type="button"
            class="link-button"
            data-open-project-sidebar-article="${group.article.id}"
          >
            ${escapeHtml(group.article.title)}
          </button>
        </div>
        <div class="project-highlight-group__list">
          ${group.highlights
            .map(
              (highlight) => `
              <article class="highlight-card">
                <blockquote class="highlight-quote">${escapeHtml(highlight.quote)}</blockquote>
                <div class="highlight-card__footer">
                  <p class="highlight-meta">${formatDate(highlight.createdAt)}</p>
                </div>
              </article>
            `,
            )
            .join("")}
        </div>
      </section>
    `,
    )
    .join("");
}

export function renderProjectMarkdownPreview(dom, markdown) {
  const value = (markdown || "").trim();

  if (!value) {
    dom.projectEditorPreview.innerHTML =
      '<div class="empty-state empty-state--compact empty-state--left"><p>Markdown preview will appear here as you write.</p></div>';
    return;
  }

  dom.projectEditorPreview.innerHTML = markdownToHtml(markdown);
}

export function saveProjectEditorContent(state, projectId, content) {
  const project = state.projects.find(
    (currentProject) => currentProject.id === projectId,
  );

  if (!project) {
    return content;
  }

  const normalizedContent = ensureProjectMarkdownHeading(content, project.name);
  project.content = normalizedContent;
  const markdownTitle = extractProjectTitleFromMarkdown(normalizedContent);
  if (markdownTitle) {
    project.name = markdownTitle;
  }
  project.updatedAt = new Date().toISOString();
  markProjectDirty(state, project.id);
  touchProjects(state);
  return normalizedContent;
}

export function applyProjectMarkdownShortcut(textarea, shortcut, options = {}) {
  if (!textarea) {
    return false;
  }

  const start = textarea.selectionStart ?? 0;
  const end = textarea.selectionEnd ?? start;
  const selectedText = textarea.value.slice(start, end);
  const hasSelection = end > start;

  if (shortcut === "bold") {
    const content = hasSelection ? selectedText : "bold text";
    const wrapped = `**${content}**`;
    replaceSelection(textarea, start, end, wrapped, 2, 2 + content.length);
    return true;
  }

  if (shortcut === "italic") {
    const content = hasSelection ? selectedText : "italic text";
    const wrapped = `*${content}*`;
    replaceSelection(textarea, start, end, wrapped, 1, 1 + content.length);
    return true;
  }

  if (shortcut === "link") {
    const label = hasSelection ? selectedText : "link text";
    const url = (options.url || "https://").trim();

    if (!url) {
      return false;
    }

    const link = `[${label}](${url})`;
    const urlStartOffset = label.length + 3;
    replaceSelection(
      textarea,
      start,
      end,
      link,
      urlStartOffset,
      urlStartOffset + url.length,
    );
    return true;
  }

  return false;
}

function getProjectArticles(state, projectId) {
  return state.bookmarks.filter((article) =>
    article.projectIds.includes(projectId),
  );
}

function getProjectHighlightGroups(projectArticles) {
  return projectArticles
    .filter((article) => article.highlights.length > 0)
    .map((article) => ({
      article,
      highlights: article.highlights.slice().sort((left, right) => {
        if (left.createdAt === right.createdAt) {
          return left.start - right.start;
        }

        return (
          new Date(right.createdAt).getTime() -
          new Date(left.createdAt).getTime()
        );
      }),
      latestHighlightAt: article.highlights.reduce(
        (latest, highlight) =>
          Math.max(latest, new Date(highlight.createdAt).getTime()),
        0,
      ),
    }))
    .sort((left, right) => right.latestHighlightAt - left.latestHighlightAt);
}

function renderProjectSidebarReader(dom, article) {
  dom.projectSidebarTopbar.hidden = false;
  dom.projectSidebarTitle.textContent = article.title;

  const blocksWithOffsets = computeBlockOffsets(article.blocks);
  const visibleBlocks =
    blocksWithOffsets.length > 0 &&
    blocksWithOffsets[0].type === "heading" &&
    normalizeHeading(blocksWithOffsets[0].text) ===
      normalizeHeading(article.title)
      ? blocksWithOffsets.slice(1)
      : blocksWithOffsets;

  dom.projectHighlightList.innerHTML = `
    <article class="reader-surface project-reference-surface">
      <p class="meta-text"><a class="reader-link" href="${escapeHtml(article.url)}" target="_blank" rel="noreferrer noopener">${escapeHtml(article.url)}</a></p>
      ${visibleBlocks.map((block) => renderBlock(block, article.highlights, escapeHtml)).join("")}
    </article>
  `;
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

function replaceSelection(
  textarea,
  start,
  end,
  replacement,
  selectionStartOffset,
  selectionEndOffset,
) {
  textarea.value = `${textarea.value.slice(0, start)}${replacement}${textarea.value.slice(end)}`;
  textarea.focus();
  textarea.setSelectionRange(
    start + selectionStartOffset,
    start + selectionEndOffset,
  );
}

function markdownToHtml(markdown) {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const html = [];
  let paragraphLines = [];
  let listItems = [];

  const flushParagraph = () => {
    if (paragraphLines.length === 0) {
      return;
    }

    html.push(
      `<p class="reader-block">${paragraphLines.map((line) => renderInlineMarkdown(line)).join("<br>")}</p>`,
    );
    paragraphLines = [];
  };

  const flushList = () => {
    if (listItems.length === 0) {
      return;
    }

    html.push(
      `<ul class="project-markdown-list">${listItems.map((item) => `<li>${renderInlineMarkdown(item)}</li>`).join("")}</ul>`,
    );
    listItems = [];
  };

  lines.forEach((line) => {
    const trimmed = line.trim();

    if (!trimmed) {
      flushParagraph();
      flushList();
      return;
    }

    const headingMatch = trimmed.match(/^(#{1,6})\s+(.+)$/);

    if (headingMatch) {
      flushParagraph();
      flushList();
      const level = Math.min(6, headingMatch[1].length);
      const headingClass =
        level <= 2 ? "reader-block reader-block--heading" : "reader-block";
      html.push(
        `<h${level} class="${headingClass}">${renderInlineMarkdown(headingMatch[2])}</h${level}>`,
      );
      return;
    }

    const listMatch = trimmed.match(/^[-*+]\s+(.+)$/);

    if (listMatch) {
      flushParagraph();
      listItems.push(listMatch[1]);
      return;
    }

    const quoteMatch = trimmed.match(/^>\s+(.+)$/);

    if (quoteMatch) {
      flushParagraph();
      flushList();
      html.push(
        `<blockquote class="highlight-quote">${renderInlineMarkdown(quoteMatch[1])}</blockquote>`,
      );
      return;
    }

    flushList();
    paragraphLines.push(trimmed);
  });

  flushParagraph();
  flushList();

  return html.join("");
}

function renderInlineMarkdown(text) {
  let output = escapeHtml(text);

  output = output.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (match, label, href) => {
    const rawHref = href.trim();

    if (!rawHref) {
      return label;
    }

    if (/^(javascript:|data:|vbscript:)/i.test(rawHref)) {
      return label;
    }

    let normalizedHref = rawHref;
    const hasExplicitSafeScheme = /^(https?:\/\/|mailto:|tel:|ftp:\/\/)/i.test(
      rawHref,
    );
    const isRelativeOrAnchor = /^(\/|\.\/|\.\.\/|#)/.test(rawHref);

    if (!hasExplicitSafeScheme && !isRelativeOrAnchor) {
      normalizedHref = `https://${rawHref}`;
    }

    return `<a class="reader-link" href="${escapeHtml(normalizedHref)}" target="_blank" rel="noreferrer noopener">${label}</a>`;
  });

  output = output.replace(/`([^`]+)`/g, "<code>$1</code>");
  output = output.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  output = output.replace(/\*([^*]+)\*/g, "<em>$1</em>");

  return output;
}
