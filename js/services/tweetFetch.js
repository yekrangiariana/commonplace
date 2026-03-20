/**
 * Fetches tweet data using Twitter's oEmbed API.
 * Uses the fetch service proxy to avoid CORS issues.
 */

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
 * Fetches tweet data via the edge function proxy (uses fxtwitter API).
 * @param {Object} runtimeConfig - The runtime configuration.
 * @param {string} tweetUrl - The tweet URL to fetch.
 * @param {Object} options - Fetch options.
 * @param {number} [options.timeoutMs=10000] - Request timeout in milliseconds.
 * @returns {Promise<Object>} The tweet data.
 */
export async function fetchTweet(
  runtimeConfig,
  tweetUrl,
  { timeoutMs = 10000 } = {},
) {
  if (!runtimeConfig.fetchServiceUrl) {
    throw new Error(
      "Fetch service is not configured. Add app-settings.json and set fetchServiceUrl.",
    );
  }

  const normalizedUrl = normalizeTweetUrl(tweetUrl);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const headers = {
      "Content-Type": "application/json",
    };

    if (runtimeConfig.supabaseAnonKey) {
      headers.apikey = runtimeConfig.supabaseAnonKey;
      headers.Authorization = `Bearer ${runtimeConfig.supabaseAnonKey}`;
    }

    const response = await fetch(runtimeConfig.fetchServiceUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({ url: normalizedUrl, type: "tweet" }),
      signal: controller.signal,
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(
        data.error || `Failed to fetch tweet (${response.status}).`,
      );
    }

    // fxtwitter returns text directly - no HTML parsing needed
    const text = data.text || "";

    return {
      url: data.url || normalizedUrl,
      authorName: data.author_name || "Unknown",
      authorScreenName: data.author_screen_name || "",
      authorUrl: data.author_url || "",
      authorAvatar: data.author_avatar || "",
      text,
      segments: [{ text }], // Simple single segment
      createdAt: data.created_at || "",
      likes: data.likes || 0,
      retweets: data.retweets || 0,
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
