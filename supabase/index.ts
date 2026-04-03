export {};

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type FetchRequest = {
  url?: string;
  type?: "article" | "tweet";
};

const FORWARDED_HEADERS = {
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "accept-language": "en-US,en;q=0.9",
  "cache-control": "no-cache",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  try {
    const body = (await req.json()) as FetchRequest;
    const rawUrl = (body.url || "").trim();

    if (!rawUrl) {
      return json({ error: "Missing url" }, 400);
    }

    // Route based on request type
    if (body.type === "tweet") {
      return await handleTweetFetch(rawUrl);
    }

    // Default: article fetch
    return await handleArticleFetch(rawUrl);
  } catch (error) {
    return json(
      {
        error: error instanceof Error ? error.message : "Unknown error",
      },
      500,
    );
  }
});

async function handleArticleFetch(rawUrl: string) {
  const targetUrl = normalizeUrl(rawUrl);
  ensureSafeHttpUrl(targetUrl);

  const upstream = await fetch(targetUrl, {
    method: "GET",
    redirect: "follow",
    headers: FORWARDED_HEADERS,
  });

  const contentType = upstream.headers.get("content-type") || "";
  const html = await upstream.text();

  if (!upstream.ok) {
    return json(
      {
        error: `Upstream fetch failed with ${upstream.status}`,
        upstreamStatus: upstream.status,
        contentType,
        preview: html.slice(0, 600),
      },
      502,
    );
  }

  return json({
    finalUrl: upstream.url || targetUrl,
    contentType,
    title: extractTitle(html),
    html,
  });
}

async function handleTweetFetch(rawUrl: string) {
  // Extract username and status ID from URL
  const { username, statusId } = parseTweetUrl(rawUrl);
  
  if (!username || !statusId) {
    return json({ error: "Invalid tweet URL" }, 400);
  }

  // Use fxtwitter API - returns full untruncated content
  const fxUrl = `https://api.fxtwitter.com/${username}/status/${statusId}`;
  
  const response = await fetch(fxUrl, {
    headers: {
      accept: "application/json",
    },
  });

  if (!response.ok) {
    if (response.status === 404) {
      return json(
        { error: "Tweet not found. It may have been deleted or is private." },
        404,
      );
    }
    return json(
      { error: `Twitter API error (${response.status})` },
      response.status,
    );
  }

  const data = await response.json();
  
  if (!data.tweet) {
    return json(
      { error: data.message || "Tweet not found" },
      404,
    );
  }

  const tweet = data.tweet;
  
  return json({
    url: tweet.url || `https://twitter.com/${username}/status/${statusId}`,
    author_name: tweet.author?.name || "Unknown",
    author_screen_name: tweet.author?.screen_name || username,
    author_url: tweet.author?.url || `https://twitter.com/${username}`,
    author_avatar: tweet.author?.avatar_url || "",
    text: tweet.text || "",
    created_at: tweet.created_at || "",
    likes: tweet.likes || 0,
    retweets: tweet.retweets || 0,
    replies: tweet.replies || 0,
    media: tweet.media?.photos || [],
  });
}

function parseTweetUrl(url: string): { username: string | null; statusId: string | null } {
  try {
    const parsed = new URL(url);
    const match = parsed.pathname.match(/^\/([^/]+)\/status\/(\d+)/);
    if (!match) return { username: null, statusId: null };
    return { username: match[1], statusId: match[2] };
  } catch {
    return { username: null, statusId: null };
  }
}

function normalizeUrl(value: string): string {
  return /^https?:\/\//i.test(value) ? value : `https://${value}`;
}

function ensureSafeHttpUrl(value: string) {
  const parsed = new URL(value);

  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("Only http and https URLs are allowed.");
  }

  const host = parsed.hostname.toLowerCase();

  if (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "0.0.0.0" ||
    host.endsWith(".local")
  ) {
    throw new Error("Local/private addresses are not allowed.");
  }
}

function extractTitle(html: string): string {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);

  if (!match) {
    return "";
  }

  return decodeHtmlEntities(match[1]).trim();
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
    },
  });
}
