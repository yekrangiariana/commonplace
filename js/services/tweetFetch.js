/**
 * Fetches tweet data using Twitter's oEmbed API.
 * This is CORS-friendly and does not require authentication.
 */

const TWITTER_OEMBED_ENDPOINT = "https://publish.twitter.com/oembed";

/**
 * Checks if a URL is a Twitter/X post URL.
 * @param {string} url - The URL to check.
 * @returns {boolean} True if the URL is a tweet.
 */
export function isTweetUrl(url) {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    const isTwitterHost =
      host === "twitter.com" ||
      host === "www.twitter.com" ||
      host === "x.com" ||
      host === "www.x.com" ||
      host === "mobile.twitter.com" ||
      host === "mobile.x.com";

    if (!isTwitterHost) return false;

    // Match tweet URL patterns: /{username}/status/{id}
    const pathMatch = parsed.pathname.match(/^\/[^/]+\/status\/\d+/);
    return Boolean(pathMatch);
  } catch {
    return false;
  }
}

/**
 * Normalizes a Twitter/X URL to a canonical form.
 * Converts x.com to twitter.com and removes tracking parameters.
 * @param {string} url - The tweet URL.
 * @returns {string} The normalized URL.
 */
export function normalizeTweetUrl(url) {
  try {
    const parsed = new URL(url);

    // Extract username and status ID
    const match = parsed.pathname.match(/^\/([^/]+)\/status\/(\d+)/);
    if (!match) return url;

    const [, username, statusId] = match;
    return `https://twitter.com/${username}/status/${statusId}`;
  } catch {
    return url;
  }
}

/**
 * Fetches tweet data from Twitter's oEmbed API.
 * @param {string} tweetUrl - The tweet URL to fetch.
 * @param {Object} options - Fetch options.
 * @param {number} [options.timeoutMs=10000] - Request timeout in milliseconds.
 * @returns {Promise<Object>} The tweet data.
 */
export async function fetchTweet(tweetUrl, { timeoutMs = 10000 } = {}) {
  const normalizedUrl = normalizeTweetUrl(tweetUrl);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const oembedUrl = new URL(TWITTER_OEMBED_ENDPOINT);
    oembedUrl.searchParams.set("url", normalizedUrl);
    oembedUrl.searchParams.set("omit_script", "true"); // Don't include Twitter's JS widget
    oembedUrl.searchParams.set("dnt", "true"); // Do Not Track

    const response = await fetch(oembedUrl.toString(), {
      signal: controller.signal,
    });

    if (!response.ok) {
      if (response.status === 404) {
        throw new Error("Tweet not found. It may have been deleted or is private.");
      }
      throw new Error(`Failed to fetch tweet (${response.status}).`);
    }

    const data = await response.json();

    // Parse the tweet content from the HTML
    const { text, segments } = extractTweetContent(data.html);

    return {
      url: normalizedUrl,
      authorName: data.author_name || "Unknown",
      authorUrl: data.author_url || "",
      text,
      segments,
      html: data.html,
    };
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error("Tweet fetch timed out. Try again.");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Extracts the text content and links from Twitter's oEmbed HTML.
 * @param {string} html - The oEmbed HTML.
 * @returns {{ text: string, segments: Array<{ text: string, href?: string }> }}
 */
function extractTweetContent(html) {
  if (!html) return { text: "", segments: [] };

  // Create a temporary element to parse the HTML
  const temp = document.createElement("div");
  temp.innerHTML = html;

  // The tweet content is in <p> tags within the blockquote
  const blockquote = temp.querySelector("blockquote");
  if (!blockquote) return { text: "", segments: [] };

  // Get all paragraph elements (tweets can have multiple)
  const paragraphs = blockquote.querySelectorAll("p");
  if (paragraphs.length === 0) return { text: "", segments: [] };

  const allSegments = [];
  let fullText = "";

  paragraphs.forEach((paragraph, pIndex) => {
    // Add paragraph separator for multiple paragraphs
    if (pIndex > 0) {
      allSegments.push({ text: "\n\n" });
      fullText += "\n\n";
    }

    // Walk through child nodes to preserve links
    paragraph.childNodes.forEach((node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        const text = node.textContent || "";
        if (text) {
          allSegments.push({ text });
          fullText += text;
        }
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        const element = node;
        if (element.tagName === "A") {
          const href = element.getAttribute("href") || "";
          const text = element.textContent || "";
          if (text) {
            allSegments.push({ text, href });
            fullText += text;
          }
        } else if (element.tagName === "BR") {
          allSegments.push({ text: "\n" });
          fullText += "\n";
        } else {
          // For other elements, just get text content
          const text = element.textContent || "";
          if (text) {
            allSegments.push({ text });
            fullText += text;
          }
        }
      }
    });
  });

  return trimSegments(fullText, allSegments);
}

/**
 * Trims leading/trailing whitespace from segments to match trimmed text.
 * Ensures segments concatenate exactly to the text for highlight positioning.
 */
function trimSegments(fullText, segments) {
  const trimmedText = fullText.trim();
  if (!trimmedText || segments.length === 0) {
    return { text: trimmedText, segments: [] };
  }

  // Find how much was trimmed from start and end
  const startTrim = fullText.length - fullText.trimStart().length;
  const endTrim = fullText.length - fullText.trimEnd().length;

  // Rebuild segments, skipping trimmed characters
  let charIndex = 0;
  const trimmedSegments = [];

  for (const segment of segments) {
    const segStart = charIndex;
    const segEnd = charIndex + segment.text.length;
    charIndex = segEnd;

    // Skip segments entirely before trim start
    if (segEnd <= startTrim) continue;

    // Skip segments entirely after trim end
    if (segStart >= fullText.length - endTrim) continue;

    // Calculate which part of this segment to keep
    const keepStart = Math.max(0, startTrim - segStart);
    const keepEnd = Math.min(segment.text.length, fullText.length - endTrim - segStart);

    if (keepEnd > keepStart) {
      const keptText = segment.text.slice(keepStart, keepEnd);
      if (keptText) {
        trimmedSegments.push(
          segment.href ? { text: keptText, href: segment.href } : { text: keptText }
        );
      }
    }
  }

  return { text: trimmedText, segments: trimmedSegments };
}

/**
 * Creates a preview text from tweet content.
 * @param {string} content - The full tweet content.
 * @param {number} maxLength - Maximum preview length.
 * @returns {string} The preview text.
 */
export function createTweetPreview(content, maxLength = 180) {
  if (!content) return "";
  if (content.length <= maxLength) return content;
  return content.slice(0, maxLength - 3) + "...";
}
