import {
  buildR2Key,
  cleanMarkdown,
  extractArticleLinks,
  extractMainArticleHtml,
  extractPaginationLinks,
  extractSitemapArticleLinks,
  extractTitleFromHtml,
} from "./extract";
import {
  getCandidates,
  insertDiscoveredPages,
  markFailed,
  markNotModified,
  replaceChunks,
  sha256,
  splitMarkdownIntoChunks,
  upsertStoredPage,
} from "./storage";

export interface Env {
  AI: {
    toMarkdown: (input: Array<{ name: string; blob: Blob }>) => Promise<unknown>;
  };
  BUCKET: R2Bucket;
  DB: D1Database;
}

const PUBLIC_DOMAIN = "https://miles.2z2z.org";
const VIDEO_HOSTS = ["odysee.com", "rumble.com"];

export interface SeedResult {
  discovered: number;
  inserted: number;
  links: string[];
  scannedPages: number;
}

export interface RunResult {
  requested: number;
  picked: number;
  succeeded: number;
  skippedNotModified: number;
  failed: number;
  errors: Array<{ url: string; error: string }>;
}

export async function crawlSeed(
  seed: string,
  limit: number,
  env: Env,
  maxListPages = 10
): Promise<SeedResult> {
  const queue: string[] = [seed];
  const visited = new Set<string>();
  const discovered = new Set<string>();
  let scannedPages = 0;

  while (queue.length > 0 && scannedPages < maxListPages && discovered.size < limit) {
    const pageUrl = queue.shift() as string;
    if (visited.has(pageUrl)) continue;
    visited.add(pageUrl);
    scannedPages += 1;

    const resp = await fetch(pageUrl, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; MarkdownBot/1.0)" },
    });
    if (!resp.ok) {
      throw new Error(`seed fetch failed (${resp.status}) at ${pageUrl}`);
    }

    const body = await resp.text();
    const isSitemap =
      pageUrl.endsWith(".xml") ||
      (resp.headers.get("content-type") ?? "").includes("xml") ||
      body.includes("<urlset");

    if (isSitemap) {
      for (const link of extractSitemapArticleLinks(body, seed, limit)) {
        discovered.add(link);
        if (discovered.size >= limit) break;
      }
    } else {
      for (const link of extractArticleLinks(body, seed, limit)) {
        discovered.add(link);
        if (discovered.size >= limit) break;
      }

      for (const page of extractPaginationLinks(body, pageUrl)) {
        if (!visited.has(page) && !queue.includes(page) && visited.size + queue.length < maxListPages) {
          queue.push(page);
        }
      }
    }
  }

  const links = [...discovered].slice(0, limit);
  const inserted = await insertDiscoveredPages(env.DB, links);

  return { discovered: links.length, inserted, links, scannedPages };
}

export async function crawlRun(max: number, env: Env): Promise<RunResult> {
  const candidates = await getCandidates(env.DB, max);
  const stats: RunResult = {
    requested: max,
    picked: candidates.length,
    succeeded: 0,
    skippedNotModified: 0,
    failed: 0,
    errors: [],
  };

  await runPool(
    candidates,
    3,
    async (row) => {
      try {
        const outcome = await processOne(row, env);
        if (outcome === "ok") stats.succeeded += 1;
        if (outcome === "not_modified") stats.skippedNotModified += 1;
      } catch (e) {
        stats.failed += 1;
        const msg = toErrorMessage(e);
        stats.errors.push({ url: row.url, error: msg });
        await markFailed(env.DB, row.url_hash, msg);
      }
    }
  );

  return stats;
}

type Candidate = {
  url: string;
  url_hash: string;
  etag: string | null;
  last_modified: string | null;
  content_sha256: string | null;
};

async function processOne(row: Candidate, env: Env): Promise<"ok" | "not_modified"> {
  const headers: HeadersInit = {
    "User-Agent": "Mozilla/5.0 (compatible; MarkdownBot/1.0)",
  };

  if (row.etag) headers["If-None-Match"] = row.etag;
  if (row.last_modified) headers["If-Modified-Since"] = row.last_modified;

  const resp = await fetchWithRetry(row.url, headers);

  if (resp.status === 304) {
    await markNotModified(env.DB, row.url_hash);
    return "not_modified";
  }

  if (!resp.ok) {
    throw new Error(`fetch failed (${resp.status})`);
  }

  const html = await resp.text();
  const articleHtml = extractMainArticleHtml(html);
  const title = extractTitleFromHtml(html);

  const converted = await env.AI.toMarkdown([
    {
      name: new URL(row.url).pathname.split("/").pop() ?? "page.html",
      blob: new Blob([articleHtml], { type: "text/html" }),
    },
  ]);

  const first = Array.isArray(converted) ? converted[0] : converted;
  if (!first || typeof first !== "object") {
    throw new Error("tomarkdown returned unexpected payload");
  }

  const format = (first as { format?: string }).format;
  const data = (first as { data?: string }).data;
  const error = (first as { error?: string }).error;

  if (format !== "markdown" || typeof data !== "string") {
    throw new Error(`tomarkdown failed: ${error ?? "invalid output"}`);
  }

  const md = cleanMarkdown(data);
  const mdWithSubtitles = await mirrorSrtAssets(md, env);
  const mdNormalized = normalizeVideoLinks(mdWithSubtitles);
  const contentHash = await sha256(mdNormalized);

  if (row.content_sha256 && row.content_sha256 === contentHash) {
    await upsertStoredPage(env.DB, {
      url: row.url,
      urlHash: row.url_hash,
      status: "stored",
      etag: resp.headers.get("etag"),
      lastModified: resp.headers.get("last-modified"),
      contentSha256: contentHash,
      title,
      error: null,
    });
    return "ok";
  }

  const key = buildR2Key(row.url);

  await env.BUCKET.put(key, mdNormalized, {
    httpMetadata: { contentType: "text/markdown; charset=utf-8" },
  });

  const chunks = splitMarkdownIntoChunks(mdNormalized, 2000);
  await replaceChunks(env.DB, {
    url: row.url,
    urlHash: row.url_hash,
    title,
    chunks,
  });

  await upsertStoredPage(env.DB, {
    url: row.url,
    urlHash: row.url_hash,
    status: "stored",
    etag: resp.headers.get("etag"),
    lastModified: resp.headers.get("last-modified"),
    contentSha256: contentHash,
    r2Key: key,
    title,
    error: null,
  });

  return "ok";
}

async function mirrorSrtAssets(markdown: string, env: Env): Promise<string> {
  const links = extractSrtLinks(markdown);
  let output = markdown;
  for (const link of links) {
    const normalizedPath = normalizeSrtPath(link);
    if (!normalizedPath) continue;

    const sourceUrl = `https://gwins.org${normalizedPath}`;
    const targetKey = normalizedPath.replace(/^\/+/, "");
    const targetUrl = `${PUBLIC_DOMAIN}${normalizedPath}`;

    try {
      const resp = await fetch(sourceUrl, {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; MarkdownBot/1.0)" },
      });
      if (!resp.ok) continue;
      const body = await resp.arrayBuffer();
      await env.BUCKET.put(targetKey, body, {
        httpMetadata: {
          contentType: "application/x-subrip; charset=utf-8",
        },
      });

      output = output.replaceAll(link, targetUrl);
    } catch {
      // keep original subtitle link if mirroring fails
    }
  }

  output = output
    .replace(/\(\/uploads\/srt\/([^)]+\.srt)\)/gi, `(${PUBLIC_DOMAIN}/uploads/srt/$1)`)
    .replace(/\(https?:\/\/gwins\.org\/uploads\/srt\/([^)]+\.srt)\)/gi, `(${PUBLIC_DOMAIN}/uploads/srt/$1)`);

  return output;
}

function extractSrtLinks(markdown: string): string[] {
  const set = new Set<string>();
  const mdLinkRe = /\(([^)\s]+\.srt)\)/gi;
  for (const m of markdown.matchAll(mdLinkRe)) {
    const link = m[1];
    if (link) set.add(link.trim());
  }
  return [...set];
}

function normalizeSrtPath(input: string): string | null {
  if (!input || input.endsWith("/.srt")) return null;

  try {
    if (input.startsWith("http://") || input.startsWith("https://")) {
      const u = new URL(input);
      if (u.hostname !== "gwins.org") return null;
      if (!u.pathname.startsWith("/uploads/srt/")) return null;
      return u.pathname;
    }

    if (input.startsWith("/uploads/srt/")) return input;
    return null;
  } catch {
    return null;
  }
}

function normalizeVideoLinks(markdown: string): string {
  let output = markdown;

  const autoLinkRe = new RegExp(
    `<(https?:\\/\\/(?:${VIDEO_HOSTS.map(escapeRe).join("|")})\\/[^>\\s]+)>`,
    "gi"
  );
  output = output.replace(autoLinkRe, (_m, url: string) => `[${url}](${url})`);

  const plainRe = new RegExp(
    `(^|[\\s：:])((https?:\\/\\/(?:${VIDEO_HOSTS.map(escapeRe).join("|")})\\/[^\\s)\\]]+))`,
    "gim"
  );
  output = output.replace(plainRe, (m: string, prefix: string, url: string, offset: number) => {
    const before = output.slice(Math.max(0, offset - 2), offset);
    if (before.endsWith("](")) return m;
    return `${prefix}[${url}](${url})`;
  });

  return output;
}

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function runPool<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (i < items.length) {
      const idx = i;
      i += 1;
      await fn(items[idx]);
    }
  });
  await Promise.all(workers);
}

async function fetchWithRetry(url: string, headers: HeadersInit): Promise<Response> {
  const delays = [0, 250, 1000];

  let lastErr: unknown;
  for (let attempt = 0; attempt < delays.length; attempt += 1) {
    if (delays[attempt] > 0) {
      await sleep(delays[attempt]);
    }

    try {
      const resp = await fetch(url, { headers, redirect: "follow" });

      if ((resp.status === 429 || resp.status === 503) && attempt < delays.length - 1) {
        await sleep(1500 * (attempt + 1));
        continue;
      }

      return resp;
    } catch (e) {
      lastErr = e;
      if (attempt === delays.length - 1) break;
    }
  }

  throw lastErr instanceof Error ? lastErr : new Error("network request failed after retries");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toErrorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
