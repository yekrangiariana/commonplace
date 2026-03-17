import { normalizeUrl } from "../utils.js";
import { parseFetchedPayload } from "./articleParser.js";

export async function fetchArticle(runtimeConfig, url) {
  const normalizedUrl = normalizeUrl(url);

  if (!runtimeConfig.fetchServiceUrl) {
    throw new Error("Fetch service is not configured. Add app-settings.json and set fetchServiceUrl.");
  }

  const payload = await fetchFromEdgeFunction(runtimeConfig, normalizedUrl);
  const parserResult = parseFetchedPayload(payload, normalizedUrl);

  if (parserResult.blocks.length === 0) {
    throw new Error("Article fetched, but no readable body was extracted.");
  }

  return parserResult;
}

async function fetchFromEdgeFunction(runtimeConfig, url) {
  const controller = new AbortController();
  const timeout = window.setTimeout(
    () => controller.abort(),
    runtimeConfig.requestTimeoutMs,
  );

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
      body: JSON.stringify({ url }),
      signal: controller.signal,
    });

    const body = await response.json().catch(() => ({}));

    if (!response.ok) {
      const message = body.error || body.message || `Fetch service returned ${response.status}.`;
      throw new Error(message);
    }

    if (!body.html && !body.text) {
      throw new Error("Fetch service returned no content.");
    }

    return body;
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error("Fetch service timed out. Try again or increase requestTimeoutMs.");
    }

    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
}
