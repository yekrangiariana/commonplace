import { normalizeUrl } from "../utils.js";
import { parseFetchedPayload } from "../services/articleParser.js";

const PRESS_RELEASED_ORIGIN = "https://pressreleased.alwaysdata.net";
const DEFAULT_AUTOMATION_TIMEOUT_MS = 35000;

function getSourceFromUrl(url) {
  try {
    return new URL(url).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return "";
  }
}

function extractBlocksFromArticleHtml(rawHtml) {
  const html = String(rawHtml || "").trim();

  if (!html) {
    return [];
  }

  const doc = new DOMParser().parseFromString(html, "text/html");
  const article =
    doc.querySelector(".article-frame article") || doc.querySelector("article");
  const root = article || doc.body;

  if (!root) {
    return [];
  }

  const nodes = [...root.querySelectorAll("h1,h2,h3,h4,p,li,blockquote")];
  const blocks = nodes
    .map((node) => {
      const text = (node.textContent || "").replace(/\s+/g, " ").trim();

      if (!text) {
        return null;
      }

      return {
        type: /^H[1-4]$/.test(node.tagName) ? "heading" : "paragraph",
        text,
        segments: [{ text }],
      };
    })
    .filter(Boolean)
    .slice(0, 260);

  if (blocks.length > 0) {
    return blocks;
  }

  const fallbackText = (root.textContent || "").replace(/\s+/g, " ").trim();

  if (!fallbackText) {
    return [];
  }

  return [
    {
      type: "paragraph",
      text: fallbackText,
      segments: [{ text: fallbackText }],
    },
  ];
}

function extractArticleHtmlFromChunk(rawHtml) {
  const html = String(rawHtml || "").trim();

  if (!html) {
    return "";
  }

  const doc = new DOMParser().parseFromString(html, "text/html");
  const preferred =
    doc.querySelector(".article-frame article") || doc.querySelector("article");

  if (preferred) {
    return preferred.outerHTML;
  }

  const bodyHtml = (doc.body?.innerHTML || "").trim();

  if (!bodyHtml) {
    return "";
  }

  return `<article>${bodyHtml}</article>`;
}

function buildReaderPayload(apiResponse, articleUrl) {
  const title =
    String(apiResponse.title || articleUrl || "").trim() || articleUrl;

  if (typeof apiResponse.content === "string" && apiResponse.content.trim()) {
    const extractedArticle = extractArticleHtmlFromChunk(apiResponse.content);

    return {
      contentType: "text/html",
      html: `
        <div class="article-frame">
          ${
            extractedArticle ||
            `<article><h1>${title}</h1><div>${apiResponse.content}</div></article>`
          }
        </div>
      `,
      title,
      finalUrl: articleUrl,
    };
  }

  if (
    typeof apiResponse.extractedContent === "string" &&
    apiResponse.extractedContent.trim()
  ) {
    const escapedText = apiResponse.extractedContent
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\n/g, "<br>");

    return {
      contentType: "text/html",
      html: `
        <div class="article-frame">
          <article>
            <h1>${title}</h1>
            <div>${escapedText}</div>
          </article>
        </div>
      `,
      title,
      finalUrl: articleUrl,
    };
  }

  if (typeof apiResponse.html === "string" && apiResponse.html.trim()) {
    const extractedArticle = extractArticleHtmlFromChunk(apiResponse.html);

    return {
      contentType: "text/html",
      html: extractedArticle
        ? `<div class="article-frame">${extractedArticle}</div>`
        : apiResponse.html,
      title,
      finalUrl: articleUrl,
    };
  }

  return {
    contentType: "text/plain",
    text: typeof apiResponse.text === "string" ? apiResponse.text : "",
    title,
    finalUrl: articleUrl,
  };
}

export async function fetchArticleViaReaderTool({
  articleUrl,
  timeoutMs = DEFAULT_AUTOMATION_TIMEOUT_MS,
}) {
  const normalizedArticleUrl = normalizeUrl(articleUrl);

  if (!normalizedArticleUrl) {
    throw new Error("Provide a valid article URL.");
  }

  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);

  try {
    // Step 1: load site X first, mirroring open-and-wait behavior.
    await fetch(`${PRESS_RELEASED_ORIGIN}/`, {
      method: "GET",
      mode: "cors",
      signal: controller.signal,
    }).catch(() => null);

    // Steps 2-4: submit URL with Reader mode, equivalent to input + buttons.
    const response = await fetch(`${PRESS_RELEASED_ORIGIN}/api/proxy`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        url: normalizedArticleUrl,
        mode: "reader",
      }),
      signal: controller.signal,
    });

    const body = await response.json().catch(() => ({}));

    if (!response.ok || body.error) {
      throw new Error(
        body.message || body.error || "Reader helper request failed.",
      );
    }

    const payload = buildReaderPayload(body, normalizedArticleUrl);

    let parsed = parseFetchedPayload(payload, normalizedArticleUrl);

    if (!Array.isArray(parsed.blocks) || parsed.blocks.length === 0) {
      const fallbackBlocks = extractBlocksFromArticleHtml(payload.html || "");

      parsed = {
        ...parsed,
        title: parsed.title || body.title || normalizedArticleUrl,
        source: parsed.source || getSourceFromUrl(normalizedArticleUrl),
        blocks: fallbackBlocks,
      };
    }

    if (!Array.isArray(parsed.blocks) || parsed.blocks.length === 0) {
      throw new Error("Reader helper returned empty content.");
    }

    return parsed;
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error("Reader helper request timed out.");
    }

    throw error;
  } finally {
    window.clearTimeout(timeoutId);
  }
}
