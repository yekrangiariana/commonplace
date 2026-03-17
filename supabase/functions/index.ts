export {};

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type FetchRequest = {
  url?: string;
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
  } catch (error) {
    return json(
      {
        error: error instanceof Error ? error.message : "Unknown error",
      },
      500,
    );
  }
});

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
