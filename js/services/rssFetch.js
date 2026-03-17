/**
 * Fetches and parses an RSS or Atom feed through the configured fetch service.
 * Returns { title, items } where items are { id, url, title, excerpt, pubDate, author, thumbnail }.
 */
export async function fetchRssFeed(runtimeConfig, url) {
  if (!runtimeConfig.fetchServiceUrl) {
    throw new Error(
      "Fetch service is not configured. Add app-settings.json and set fetchServiceUrl.",
    );
  }

  const controller = new AbortController();
  const timeout = window.setTimeout(
    () => controller.abort(),
    runtimeConfig.requestTimeoutMs,
  );

  try {
    const headers = { "Content-Type": "application/json" };

    if (runtimeConfig.supabaseAnonKey) {
      headers.apikey = runtimeConfig.supabaseAnonKey;
      headers.Authorization = `Bearer ${runtimeConfig.supabaseAnonKey}`;
    }

    const response = await fetch(runtimeConfig.fetchServiceUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({ url }),
      signal: controller.signal,
    });

    const body = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(body.error || `Fetch failed with ${response.status}.`);
    }

    const rawXml = body.html || body.text || "";

    if (!rawXml) {
      throw new Error("Feed returned no content.");
    }

    return parseRssFeed(rawXml, url);
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error("Feed fetch timed out.");
    }

    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
}

function parseRssFeed(xml, feedUrl) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xml, "text/xml");

  const parseError = doc.querySelector("parsererror");

  if (parseError) {
    throw new Error("Could not parse feed — not valid RSS or Atom XML.");
  }

  if (doc.querySelector("feed")) {
    return parseAtomFeed(doc, feedUrl);
  }

  return parseRss2Feed(doc, feedUrl);
}

function parseRss2Feed(doc, feedUrl) {
  const channel = doc.querySelector("channel");
  const title = channel?.querySelector("title")?.textContent?.trim() || feedUrl;

  const items = [...doc.querySelectorAll("item")]
    .slice(0, 50)
    .map((item) => {
      const url =
        item.querySelector("link")?.textContent?.trim() ||
        [...item.querySelectorAll("guid")]
          .find((el) => el.getAttribute("isPermaLink") !== "false")
          ?.textContent?.trim() ||
        "";

      const rawTitle = item.querySelector("title")?.textContent?.trim() || "";
      const title = rawTitle
        ? new DOMParser()
            .parseFromString(rawTitle, "text/html")
            .body.textContent?.trim() || rawTitle
        : "Untitled";

      const description =
        item.querySelector("description")?.textContent?.trim() || "";
      const contentEncoded =
        item.getElementsByTagNameNS("*", "encoded")[0]?.textContent?.trim() ||
        "";
      const pubDate = item.querySelector("pubDate")?.textContent?.trim() || "";
      const author =
        item.getElementsByTagNameNS("*", "creator")[0]?.textContent?.trim() ||
        item.querySelector("author")?.textContent?.trim() ||
        "";

      const mediaThumbnail =
        item.getElementsByTagNameNS("*", "thumbnail")[0]?.getAttribute("url") ||
        "";
      const enclosure = extractImageEnclosureUrl([
        ...item.getElementsByTagName("enclosure"),
      ]);
      const mediaContentImage = extractMediaContentImage([
        ...item.getElementsByTagNameNS("*", "content"),
      ]);
      const inlineDescriptionImage = extractFirstImageUrlFromHtml(description);
      const inlineContentImage = extractFirstImageUrlFromHtml(contentEncoded);
      const thumbnail = absolutizeFeedUrl(
        mediaThumbnail ||
          enclosure ||
          mediaContentImage ||
          inlineDescriptionImage ||
          inlineContentImage,
        url || feedUrl,
      );

      const descriptionText = htmlToText(description);
      const excerpt = toConciseFeedDescription(descriptionText);

      let isoDate = "";

      try {
        if (pubDate) {
          const d = new Date(pubDate);

          if (!Number.isNaN(d.getTime())) {
            isoDate = d.toISOString();
          }
        }
      } catch {
        // ignore bad dates
      }

      const canonicalUrl = canonicalizeRssItemUrl(url);

      return {
        id: stableId(url || title),
        url,
        canonicalUrl,
        title,
        excerpt,
        pubDate: isoDate,
        author,
        thumbnail,
      };
    })
    .filter((item) => item.url);

  return { title, items };
}

function parseAtomFeed(doc, feedUrl) {
  const title =
    doc.querySelector("feed > title")?.textContent?.trim() || feedUrl;

  const items = [...doc.querySelectorAll("entry")]
    .slice(0, 50)
    .map((entry) => {
      const linkEl =
        entry.querySelector("link[rel='alternate']") ||
        entry.querySelector("link:not([rel='self']):not([rel='enclosure'])");
      const url =
        linkEl?.getAttribute("href") ||
        entry.querySelector("id")?.textContent?.trim() ||
        "";

      const rawTitle = entry.querySelector("title")?.textContent?.trim() || "";
      const title = rawTitle
        ? new DOMParser()
            .parseFromString(rawTitle, "text/html")
            .body.textContent?.trim() || rawTitle
        : "Untitled";

      const summary = entry.querySelector("summary")?.textContent?.trim() || "";
      const content = entry.querySelector("content")?.textContent?.trim() || "";
      const pubDate =
        entry.querySelector("published")?.textContent?.trim() ||
        entry.querySelector("updated")?.textContent?.trim() ||
        "";
      const author =
        entry.querySelector("author > name")?.textContent?.trim() || "";

      const mediaThumbnail =
        entry
          .getElementsByTagNameNS("*", "thumbnail")[0]
          ?.getAttribute("url") || "";
      const linkEnclosureImage =
        [...entry.querySelectorAll("link[rel='enclosure']")]
          .find((el) => {
            const href = (el.getAttribute("href") || "").trim();
            const type = (el.getAttribute("type") || "").toLowerCase();
            return type.startsWith("image/") || isLikelyImageUrl(href);
          })
          ?.getAttribute("href") || "";
      const mediaContentImage = extractMediaContentImage([
        ...entry.getElementsByTagNameNS("*", "content"),
      ]);
      const inlineSummaryImage = extractFirstImageUrlFromHtml(summary);
      const inlineContentImage = extractFirstImageUrlFromHtml(content);
      const thumbnail = absolutizeFeedUrl(
        mediaThumbnail ||
          linkEnclosureImage ||
          mediaContentImage ||
          inlineSummaryImage ||
          inlineContentImage,
        url || feedUrl,
      );

      const summaryText = htmlToText(summary);
      const excerpt = toConciseFeedDescription(summaryText);

      let isoDate = "";

      try {
        if (pubDate) {
          const d = new Date(pubDate);

          if (!Number.isNaN(d.getTime())) {
            isoDate = d.toISOString();
          }
        }
      } catch {
        // ignore bad dates
      }

      const canonicalUrl = canonicalizeRssItemUrl(url);

      return {
        id: stableId(url || title),
        url,
        canonicalUrl,
        title,
        excerpt,
        pubDate: isoDate,
        author,
        thumbnail,
      };
    })
    .filter((item) => item.url);

  return { title, items };
}

function stableId(str) {
  let h = 0;

  for (let i = 0; i < str.length; i++) {
    h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  }

  return Math.abs(h).toString(36);
}

function canonicalizeRssItemUrl(url) {
  if (!url) {
    return "";
  }

  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.replace(/^www\./i, "").toLowerCase();
    const pathname = parsed.pathname.replace(/\/+$/, "") || "/";
    return `${parsed.protocol}//${hostname}${pathname}`;
  } catch {
    return url.toLowerCase();
  }
}

function htmlToText(value) {
  if (!value) {
    return "";
  }

  const tempDiv = document.createElement("div");
  tempDiv.innerHTML = value;
  return (tempDiv.textContent || "").replace(/\s+/g, " ").trim();
}

function extractFirstImageUrlFromHtml(value) {
  if (!value) {
    return "";
  }

  const tempDiv = document.createElement("div");
  tempDiv.innerHTML = value;
  return tempDiv.querySelector("img")?.getAttribute("src")?.trim() || "";
}

function extractImageEnclosureUrl(enclosures) {
  return (
    (enclosures || [])
      .find((el) => {
        const url = (el.getAttribute("url") || "").trim();
        const type = (el.getAttribute("type") || "").toLowerCase();
        return type.startsWith("image/") || isLikelyImageUrl(url);
      })
      ?.getAttribute("url") || ""
  );
}

function extractMediaContentImage(contentElements) {
  if (!Array.isArray(contentElements) || contentElements.length === 0) {
    return "";
  }

  const withScore = contentElements
    .map((el) => {
      const url = (el.getAttribute("url") || "").trim();

      if (!url) {
        return null;
      }

      const medium = (el.getAttribute("medium") || "").toLowerCase();
      const type = (el.getAttribute("type") || "").toLowerCase();
      const width = Number(el.getAttribute("width") || 0);
      const isImageLike =
        medium === "image" ||
        type.startsWith("image/") ||
        isLikelyImageUrl(url);

      if (!isImageLike) {
        return null;
      }

      return {
        url,
        score: Number.isFinite(width) && width > 0 ? width : 0,
      };
    })
    .filter(Boolean)
    .sort((left, right) => right.score - left.score);

  return withScore[0]?.url || "";
}

function isLikelyImageUrl(value) {
  if (!value) {
    return false;
  }

  const normalized = String(value).toLowerCase();
  return /\.(jpg|jpeg|png|webp|gif|avif|bmp|svg)(\?|#|$)/.test(normalized);
}

function absolutizeFeedUrl(rawUrl, baseUrl) {
  if (!rawUrl) {
    return "";
  }

  try {
    return new URL(rawUrl, baseUrl).toString();
  } catch {
    return rawUrl;
  }
}

function toConciseFeedDescription(text) {
  const normalized = (text || "").replace(/\s+/g, " ").trim();

  if (!normalized) {
    return "";
  }

  const sentence =
    normalized.match(/[^.!?]+[.!?](\s|$)/)?.[0]?.trim() || normalized;
  const MAX_LENGTH = 280;

  if (sentence.length <= MAX_LENGTH) {
    return sentence;
  }

  return `${sentence.slice(0, MAX_LENGTH - 3).trim()}...`;
}
