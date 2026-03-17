function sanitizeText(value) {
  return value.replace(/\s+/g, " ").trim();
}

function toIsoDate(value) {
  if (!value) {
    return "";
  }

  const parsedMs = Date.parse(value);

  if (Number.isNaN(parsedMs)) {
    return "";
  }

  return new Date(parsedMs).toISOString();
}

function getSourceFromUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return "";
  }
}

function findPublishedDateInJsonLd(doc) {
  const candidates = [];
  const scripts = [
    ...doc.querySelectorAll("script[type='application/ld+json']"),
  ];

  const collectDates = (value) => {
    if (!value || typeof value !== "object") {
      return;
    }

    if (Array.isArray(value)) {
      value.forEach(collectDates);
      return;
    }

    const dateKeys = [
      "datePublished",
      "dateCreated",
      "uploadDate",
      "pubDate",
      "dateModified",
    ];

    for (const key of dateKeys) {
      if (typeof value[key] === "string") {
        candidates.push(value[key]);
      }
    }

    Object.values(value).forEach(collectDates);
  };

  for (const script of scripts) {
    const raw = (script.textContent || "").trim();

    if (!raw) {
      continue;
    }

    try {
      collectDates(JSON.parse(raw));
    } catch {
      // Some sites emit invalid JSON-LD fragments. Ignore and continue.
    }
  }

  for (const candidate of candidates) {
    const asIso = toIsoDate(candidate);

    if (asIso) {
      return asIso;
    }
  }

  return "";
}

function findPublishedDateInHtml(doc) {
  const fromJsonLd = findPublishedDateInJsonLd(doc);

  if (fromJsonLd) {
    return fromJsonLd;
  }

  const metaSelectors = [
    "meta[property='article:published_time']",
    "meta[property='og:article:published_time']",
    "meta[property='og:published_time']",
    "meta[name='article:published_time']",
    "meta[name='parsely-pub-date']",
    "meta[name='sailthru.date']",
    "meta[name='dc.date']",
    "meta[name='dc.date.issued']",
    "meta[name='publish_date']",
    "meta[name='pubdate']",
    "meta[name='date']",
    "meta[itemprop='datePublished']",
    "time[itemprop='datePublished']",
  ];

  for (const selector of metaSelectors) {
    const node = doc.querySelector(selector);
    const value =
      node?.getAttribute("content") ||
      node?.getAttribute("datetime") ||
      node?.textContent ||
      "";
    const asIso = toIsoDate(value);

    if (asIso) {
      return asIso;
    }
  }

  const timeNodes = [...doc.querySelectorAll("time[datetime]")].slice(0, 3);

  for (const node of timeNodes) {
    const asIso = toIsoDate(node.getAttribute("datetime") || "");

    if (asIso) {
      return asIso;
    }
  }

  return "";
}

function normalizeInlineWhitespace(value) {
  return value.replace(/\s+/g, " ");
}

function absolutizeHref(href, fallbackUrl) {
  if (!href) {
    return "";
  }

  try {
    return new URL(href, fallbackUrl).toString();
  } catch {
    return href;
  }
}

function extractInlineSegments(node, fallbackUrl) {
  const segments = [];

  node.childNodes.forEach((child) => {
    if (child.nodeType === Node.TEXT_NODE) {
      const text = normalizeInlineWhitespace(child.textContent || "");

      if (text) {
        segments.push({ text });
      }
      return;
    }

    if (child.nodeType !== Node.ELEMENT_NODE) {
      return;
    }

    const element = child;

    if (element.tagName === "BR") {
      segments.push({ text: " " });
      return;
    }

    if (element.tagName === "A") {
      const text = normalizeInlineWhitespace(element.textContent || "");

      if (text) {
        segments.push({
          text,
          href: absolutizeHref(element.getAttribute("href"), fallbackUrl),
        });
      }
      return;
    }

    segments.push(...extractInlineSegments(element, fallbackUrl));
  });

  return segments;
}

function normalizeSegments(segments) {
  const merged = [];

  segments.forEach((segment) => {
    const text = normalizeInlineWhitespace(segment.text);

    if (!text) {
      return;
    }

    const previous = merged[merged.length - 1];

    if (previous && previous.href === segment.href) {
      previous.text += text;
      return;
    }

    merged.push({
      text,
      ...(segment.href ? { href: segment.href } : {}),
    });
  });

  return merged;
}

function extractBlockFromNode(node, fallbackUrl) {
  if (
    (node.closest("blockquote") && node.tagName === "P") ||
    (node.closest("li") && node.tagName === "P")
  ) {
    return null;
  }

  const segments = normalizeSegments(extractInlineSegments(node, fallbackUrl));
  const text = sanitizeText(segments.map((segment) => segment.text).join(""));
  const isHeading = /^H[1-4]$/.test(node.tagName);

  if (!text || (!isHeading && text.length < 35)) {
    return null;
  }

  return {
    type: isHeading ? "heading" : "paragraph",
    text,
    segments,
  };
}

function parsePlainTextArticle(rawText, fallbackTitle) {
  const lines = rawText
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd());

  const blocks = [];
  let title = "";
  let description = "";
  let publishedAt = "";
  let paragraphLines = [];

  function pushParagraph() {
    const text = paragraphLines.join(" ").replace(/\s+/g, " ").trim();

    if (text) {
      blocks.push({ type: "paragraph", text, segments: [{ text }] });
    }

    paragraphLines = [];
  }

  for (const line of lines) {
    const trimmed = line.trim();

    if (!trimmed) {
      pushParagraph();
      continue;
    }

    if (!title && trimmed.startsWith("Title:")) {
      title = trimmed.replace(/^Title:\s*/, "");
      continue;
    }

    if (!description && /^Description:/i.test(trimmed)) {
      description = trimmed.replace(/^Description:\s*/i, "").trim();
      continue;
    }

    if (!publishedAt && /^Published Time:/i.test(trimmed)) {
      publishedAt =
        toIsoDate(trimmed.replace(/^Published Time:\s*/i, "").trim()) ||
        publishedAt;
      continue;
    }

    if (
      /^(URL Source:|Markdown Content:|Published Time:|Description:)/i.test(
        trimmed,
      )
    ) {
      continue;
    }

    if (/^#{1,6}\s/.test(trimmed)) {
      pushParagraph();
      const text = trimmed.replace(/^#{1,6}\s*/, "");
      blocks.push({ type: "heading", text, segments: [{ text }] });
      continue;
    }

    if (trimmed === "***" || trimmed === "---") {
      pushParagraph();
      continue;
    }

    paragraphLines.push(trimmed);
  }

  pushParagraph();

  return {
    title: title || fallbackTitle,
    description,
    imageUrl: "",
    publishedAt,
    source: "",
    blocks,
  };
}

function parseHtmlArticle(rawHtml, fallbackTitle, fallbackUrl) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(rawHtml, "text/html");
  const publishedAt = findPublishedDateInHtml(doc);

  [
    ...doc.querySelectorAll("script,style,noscript,template,svg,iframe"),
  ].forEach((node) => node.remove());

  const title =
    doc.querySelector("meta[property='og:title']")?.getAttribute("content") ||
    doc.querySelector("meta[name='twitter:title']")?.getAttribute("content") ||
    doc.querySelector("h1")?.textContent ||
    doc.title ||
    fallbackTitle;

  const description =
    doc
      .querySelector("meta[property='og:description']")
      ?.getAttribute("content") ||
    doc
      .querySelector("meta[name='twitter:description']")
      ?.getAttribute("content") ||
    doc.querySelector("meta[name='description']")?.getAttribute("content") ||
    "";

  const rawImageUrl =
    doc.querySelector("meta[property='og:image']")?.getAttribute("content") ||
    doc.querySelector("meta[name='twitter:image']")?.getAttribute("content") ||
    doc.querySelector("article img")?.getAttribute("src") ||
    doc.querySelector("main img")?.getAttribute("src") ||
    "";
  const imageUrl = absolutizeHref(rawImageUrl, fallbackUrl);
  const source = getSourceFromUrl(fallbackUrl);

  const root =
    doc.querySelector("article") ||
    doc.querySelector("main article") ||
    doc.querySelector("main") ||
    doc.body;

  if (!root) {
    return {
      title,
      description: sanitizeText(description),
      imageUrl,
      publishedAt,
      source,
      blocks: [],
    };
  }

  const blocks = [...root.querySelectorAll("h1,h2,h3,h4,p,li,blockquote")]
    .map((node) => extractBlockFromNode(node, fallbackUrl))
    .filter(Boolean)
    .slice(0, 220);

  if (blocks.length > 0) {
    return {
      title,
      description: sanitizeText(description),
      imageUrl,
      publishedAt,
      source,
      blocks,
    };
  }

  const fallbackText = sanitizeText(doc.body?.textContent || "").slice(
    0,
    12000,
  );
  return {
    title,
    description: sanitizeText(description),
    imageUrl,
    publishedAt,
    source,
    blocks: fallbackText
      ? [
          {
            type: "paragraph",
            text: fallbackText,
            segments: [{ text: fallbackText }],
          },
        ]
      : [],
  };
}

export function parseFetchedPayload(payload, fallbackUrl) {
  const contentType = (payload.contentType || "").toLowerCase();
  const isHtmlLike = contentType.includes("html") || payload.html;
  const fallbackTitle = payload.title || fallbackUrl;

  if (isHtmlLike) {
    return parseHtmlArticle(
      payload.html || payload.text || "",
      fallbackTitle,
      payload.finalUrl || fallbackUrl,
    );
  }

  return {
    ...parsePlainTextArticle(payload.text || "", fallbackTitle),
    source: getSourceFromUrl(payload.finalUrl || fallbackUrl),
  };
}
