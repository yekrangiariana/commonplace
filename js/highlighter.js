import { markBookmarkDirty } from "./state.js";

export function renderBlock(block, highlights, escapeHtml) {
  const html = renderInlineContent(block, highlights, escapeHtml);
  const tagName = block.type === "heading" ? "h2" : "p";
  const classes =
    `reader-block ${block.type === "heading" ? "reader-block--heading" : ""}`.trim();

  return `<${tagName} class="${classes}" data-start="${block.start}" data-end="${block.end}">${html}</${tagName}>`;
}

function renderInlineContent(block, highlights, escapeHtml) {
  const relevantHighlights = highlights
    .filter(
      (highlight) => highlight.end > block.start && highlight.start < block.end,
    )
    .sort((left, right) => left.start - right.start);

  const segments =
    block.segments?.length > 0 ? block.segments : [{ text: block.text }];
  let segmentOffset = 0;

  return segments
    .map((segment) => {
      const segmentStart = block.start + segmentOffset;
      const segmentEnd = segmentStart + segment.text.length;
      segmentOffset += segment.text.length;
      const innerHtml = renderHighlightedTextSegment(
        segment.text,
        segmentStart,
        segmentEnd,
        relevantHighlights,
        escapeHtml,
      );

      if (!segment.href) {
        return innerHtml;
      }

      return `<a class="reader-link" href="${escapeHtml(segment.href)}" target="_blank" rel="noreferrer noopener">${innerHtml}</a>`;
    })
    .join("");
}

function renderHighlightedTextSegment(
  text,
  segmentStart,
  segmentEnd,
  highlights,
  escapeHtml,
) {
  let cursor = 0;
  let html = "";

  highlights.forEach((highlight) => {
    const start = Math.max(0, highlight.start - segmentStart);
    const end = Math.min(text.length, highlight.end - segmentStart);

    if (
      highlight.end <= segmentStart ||
      highlight.start >= segmentEnd ||
      end <= start
    ) {
      return;
    }

    if (start > cursor) {
      html += escapeHtml(text.slice(cursor, start));
    }

    html += `<mark class="reader-highlight">${escapeHtml(text.slice(start, end))}</mark>`;
    cursor = Math.max(cursor, end);
  });

  if (cursor < text.length) {
    html += escapeHtml(text.slice(cursor));
  }

  return html;
}

export function handleSelectionChange({
  state,
  dom,
  getSelectedArticle,
  flattenBlocks,
}) {
  const activeArticle = getSelectedArticle();

  if (!activeArticle || state.activeTab !== "reader") {
    return;
  }

  const selection = window.getSelection();

  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
    if (!state.pendingSelection) {
      hideSelectionMenu(dom);
    }
    return;
  }

  const range = selection.getRangeAt(0);

  // Check if selection is in reader surface OR focus mode content
  const focusModeContent = document.querySelector("#focus-mode-content");
  const isInReaderSurface = dom.readerSurface.contains(
    range.commonAncestorContainer,
  );
  const isInFocusMode = focusModeContent?.contains(
    range.commonAncestorContainer,
  );

  if (!isInReaderSurface && !isInFocusMode) {
    return;
  }

  const startBlock = findClosestBlock(range.startContainer);
  const endBlock = findClosestBlock(range.endContainer);

  if (!startBlock || !endBlock) {
    hideSelectionMenu(dom);
    return;
  }

  const startOffset = getOffsetWithinBlock(
    startBlock,
    range.startContainer,
    range.startOffset,
  );
  const endOffset = getOffsetWithinBlock(
    endBlock,
    range.endContainer,
    range.endOffset,
  );
  const start = Number(startBlock.dataset.start) + startOffset;
  const end = Number(endBlock.dataset.start) + endOffset;

  if (Number.isNaN(start) || Number.isNaN(end) || start === end) {
    hideSelectionMenu(dom);
    return;
  }

  const normalizedStart = Math.min(start, end);
  const normalizedEnd = Math.max(start, end);
  const quote = flattenBlocks(activeArticle.blocks)
    .slice(normalizedStart, normalizedEnd)
    .trim();

  if (!quote) {
    hideSelectionMenu(dom);
    return;
  }

  const rect = range.getBoundingClientRect();

  state.pendingSelection = {
    articleId: activeArticle.id,
    start: normalizedStart,
    end: normalizedEnd,
    quote,
    rect: {
      left: rect.left,
      right: rect.right,
      top: rect.top,
      bottom: rect.bottom,
      width: rect.width,
    },
  };

  showSelectionMenu(dom, state.pendingSelection.rect);
}

export function createHighlightFromSelection({
  state,
  dom,
  getSelectedArticle,
  createId,
  setStatus,
  onChanged,
}) {
  const activeArticle = getSelectedArticle();

  if (
    !activeArticle ||
    !state.pendingSelection ||
    state.pendingSelection.articleId !== activeArticle.id
  ) {
    return;
  }

  const duplicate = activeArticle.highlights.some(
    (highlight) =>
      highlight.start === state.pendingSelection.start &&
      highlight.end === state.pendingSelection.end,
  );

  if (duplicate) {
    setStatus("That passage is already highlighted.");
    clearPendingSelection(state, dom);
    return;
  }

  activeArticle.highlights.push({
    id: createId("highlight"),
    start: state.pendingSelection.start,
    end: state.pendingSelection.end,
    quote: state.pendingSelection.quote,
    createdAt: new Date().toISOString(),
  });

  markBookmarkDirty(state, activeArticle.id);
  onChanged();
  clearPendingSelection(state, dom);
}

export function clearPendingSelection(state, dom) {
  state.pendingSelection = null;
  hideSelectionMenu(dom);
  window.getSelection()?.removeAllRanges();
}

export async function copySelectionAsNote({
  state,
  dom,
  getSelectedArticle,
  setStatus,
}) {
  const activeArticle = getSelectedArticle();

  if (
    !activeArticle ||
    !state.pendingSelection ||
    state.pendingSelection.articleId !== activeArticle.id
  ) {
    return;
  }

  const noteTemplate = [
    `## ${activeArticle.title}`,
    "",
    `> ${state.pendingSelection.quote.replace(/\n+/g, " ")}`,
    "",
    "Note:",
    "",
    activeArticle.url,
  ].join("\n");

  await navigator.clipboard.writeText(noteTemplate);
  setStatus("Copied a note template for the selected passage.");
  clearPendingSelection(state, dom);
}

export async function sharePendingSelection({
  state,
  dom,
  getSelectedArticle,
  setStatus,
}) {
  const activeArticle = getSelectedArticle();

  if (
    !activeArticle ||
    !state.pendingSelection ||
    state.pendingSelection.articleId !== activeArticle.id
  ) {
    return;
  }

  const shareText = `${state.pendingSelection.quote}\n\n${activeArticle.title}\n${activeArticle.url}`;

  await navigator.clipboard.writeText(shareText);
  setStatus("Copied the selected passage.");

  clearPendingSelection(state, dom);
}

export function hideSelectionMenu(dom) {
  dom.selectionMenu.hidden = true;
  dom.selectionMenu.style.removeProperty("left");
  dom.selectionMenu.style.removeProperty("top");
}

function showSelectionMenu(dom, rect) {
  dom.selectionMenu.hidden = false;

  const menuWidth = dom.selectionMenu.offsetWidth || 240;
  const menuHeight = dom.selectionMenu.offsetHeight || 140;
  const horizontalCenter = rect.left + rect.width / 2;
  const left = Math.max(
    12,
    Math.min(
      window.innerWidth - menuWidth - 12,
      horizontalCenter - menuWidth / 2,
    ),
  );
  const preferredTop = rect.top - menuHeight - 12;
  const top =
    preferredTop >= 12
      ? preferredTop
      : Math.min(window.innerHeight - menuHeight - 12, rect.bottom + 12);

  dom.selectionMenu.style.left = `${left}px`;
  dom.selectionMenu.style.top = `${top}px`;
}

function findClosestBlock(node) {
  return node.nodeType === Node.ELEMENT_NODE
    ? node.closest("[data-start]")
    : node.parentElement?.closest("[data-start]");
}

function getOffsetWithinBlock(blockElement, container, offset) {
  const range = document.createRange();
  range.selectNodeContents(blockElement);
  range.setEnd(container, offset);
  return range.toString().length;
}
