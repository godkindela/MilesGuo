import { crawlRun, crawlSeed, Env } from "./crawl";
import { getPageByHash, getPageByUrl, getRecentStoredPages, getSitemapPages, searchChunks } from "./storage";
import { enqueueTrace, getTrace, processTraceMessage, upsertHotspot } from "./trace";

const PRIMARY_HOST = "miles.2z2z.org";
const PRIMARY_ORIGIN = `https://${PRIMARY_HOST}`;

interface JsonObj {
  [key: string]: unknown;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(req.url);
      if (shouldRedirectToPrimary(url)) {
        return Response.redirect(`${PRIMARY_ORIGIN}${url.pathname}${url.search}`, 301);
      }
      const ua = req.headers.get("user-agent") ?? "";
      const agent = classifyAgent(ua);

      if (req.method === "GET" && url.pathname === "/robots.txt") {
        return new Response(renderRobotsTxt(), {
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
      }

      if (req.method === "GET" && url.pathname === "/sitemap.xml") {
        const entries = await getSitemapPages(env.DB, 5000);
        return new Response(renderSitemapXml(entries), {
          headers: { "content-type": "application/xml; charset=utf-8" },
        });
      }

      if (req.method === "GET" && url.pathname === "/") {
        if (agent.isAiBot) {
          const recent = await getRecentStoredPages(env.DB, 30);
          return new Response(renderHomeMarkdownForAi(recent), {
            headers: {
              "content-type": "text/markdown; charset=utf-8",
              "x-ai-format": "markdown",
            },
          });
        }

        return new Response(renderHomePage(), {
          headers: {
            "content-type": "text/html; charset=utf-8",
            "x-robots-tag": "index,follow,max-snippet:-1,max-image-preview:large,max-video-preview:-1",
          },
        });
      }

      if (req.method === "GET" && url.pathname.startsWith("/results/")) {
        const urlHash = decodeURIComponent(url.pathname.slice("/results/".length)).trim();
        if (!urlHash) return json({ ok: false, error: "missing result id" }, 400);

        const page = await getPageByHash(env.DB, urlHash);
        if (!page?.r2_key) return json({ ok: false, error: "page not found" }, 404);

        const obj = await env.BUCKET.get(page.r2_key);
        if (!obj) return json({ ok: false, error: "r2 object not found" }, 404);
        const md = await obj.text();

        if (agent.isAiBot) {
          return new Response(md, {
            headers: {
              "content-type": "text/markdown; charset=utf-8",
              "x-ai-format": "markdown",
            },
          });
        }

        const html = markdownToHtml(md);

        return new Response(
          renderResultPage({
            title: page.title ?? page.url,
            sourceUrl: page.url,
            canonicalUrl: `${PRIMARY_ORIGIN}/results/${urlHash}`,
            html,
          }),
          {
            headers: {
              "content-type": "text/html; charset=utf-8",
              "x-robots-tag": "index,follow,max-snippet:-1,max-image-preview:large,max-video-preview:-1",
            },
          }
        );
      }

      if (req.method === "GET" && url.pathname.startsWith("/uploads/srt/")) {
        const keyEncoded = url.pathname.replace(/^\/+/, "");
        const keyDecoded = decodeURIComponent(url.pathname).replace(/^\/+/, "");

        let obj = await env.BUCKET.get(keyEncoded);
        if (!obj && keyDecoded !== keyEncoded) {
          obj = await env.BUCKET.get(keyDecoded);
        }
        if (!obj) {
          const source = `https://gwins.org${url.pathname}`;
          const upstream = await fetch(source, {
            headers: { "User-Agent": "Mozilla/5.0 (compatible; MarkdownBot/1.0)" },
          });
          if (!upstream.ok) return json({ ok: false, error: "subtitle not found" }, 404);
          const body = await upstream.arrayBuffer();
          const writeKey = keyEncoded || keyDecoded;
          await env.BUCKET.put(writeKey, body, {
            httpMetadata: {
              contentType: upstream.headers.get("content-type") || "application/x-subrip; charset=utf-8",
            },
          });
          obj = await env.BUCKET.get(writeKey);
          if (!obj) return json({ ok: false, error: "subtitle not found" }, 404);
        }

        return new Response(obj.body, {
          headers: {
            "content-type": obj.httpMetadata?.contentType || "application/x-subrip; charset=utf-8",
            "cache-control": "public, max-age=86400",
          },
        });
      }

      if (req.method === "GET" && url.pathname === "/health") {
        return json({
          ok: true,
          version: "0.1.0",
          date: new Date().toISOString(),
          bindings: {
            DB: !!env.DB,
            BUCKET: !!env.BUCKET,
            AI: !!env.AI,
            VEC: !!(env as unknown as { VEC?: unknown }).VEC,
            TRACE_QUEUE: !!(env as unknown as { TRACE_QUEUE?: unknown }).TRACE_QUEUE,
          },
        });
      }

      if (req.method === "POST" && url.pathname === "/crawl/seed") {
        const body = await readJson(req);
        const seed = typeof body.seed === "string" ? body.seed : "https://gwins.org/cn/milesguo/";
        const limit = clampInt(body.limit, 1, 10000, 50);
        const crawlPages = clampInt(body.crawlPages, 1, 150, 10);

        const result = await crawlSeed(seed, limit, env, crawlPages);
        return json({ ok: true, ...result });
      }

      if (req.method === "POST" && url.pathname === "/crawl/run") {
        const body = await readJson(req);
        const max = clampInt(body.max, 1, 100, 10);

        const result = await crawlRun(max, env);
        return json({ ok: result.failed === 0, ...result });
      }

      if (req.method === "GET" && url.pathname === "/page") {
        const target = url.searchParams.get("url");
        if (!target) return json({ ok: false, error: "missing url parameter" }, 400);

        const page = await getPageByUrl(env.DB, target);
        if (!page?.r2_key) return json({ ok: false, error: "page not found" }, 404);

        const obj = await env.BUCKET.get(page.r2_key);
        if (!obj) return json({ ok: false, error: "r2 object not found" }, 404);

        const md = await obj.text();
        return new Response(md, {
          headers: { "content-type": "text/markdown; charset=utf-8", "x-r2-key": page.r2_key },
        });
      }

      if (req.method === "GET" && url.pathname === "/search") {
        const q = (url.searchParams.get("q") ?? "").trim();
        const limit = clampInt(url.searchParams.get("limit"), 1, 50, 20);
        if (!q) return json({ ok: false, error: "missing q parameter" }, 400);

        const hits = await searchChunks(env.DB, q, limit);
        const normalized = hits.map((h) => ({
          ...h,
          result_path: `${PRIMARY_ORIGIN}/results/${h.url_hash}`,
        }));
        return json({ ok: true, q, limit, count: normalized.length, hits: normalized });
      }

      if (req.method === "POST" && url.pathname === "/hotspots/upsert") {
        const body = await readJson(req);
        if (typeof body.title !== "string" || typeof body.description !== "string") {
          return json({ ok: false, error: "title and description are required" }, 400);
        }

        const result = await upsertHotspot(env as any, {
          hotspot_id: asString(body.hotspot_id),
          title: body.title,
          description: body.description,
          time_start: asNullableString(body.time_start),
          time_end: asNullableString(body.time_end),
          entities: asStringArray(body.entities),
          keywords: asStringArray(body.keywords),
          must_include: asStringArray(body.must_include),
          exclude: asStringArray(body.exclude),
        });
        return json({ ok: true, ...result });
      }

      if (req.method === "POST" && url.pathname === "/trace") {
        const body = await readJson(req);
        if (typeof body.hotspot_id !== "string" || typeof body.anchor !== "string") {
          return json({ ok: false, error: "hotspot_id and anchor are required" }, 400);
        }

        const result = await enqueueTrace(env as any, {
          hotspot_id: body.hotspot_id,
          anchor: body.anchor,
          event: asNullableString(body.event),
          aliases: asStringArray(body.aliases),
        });
        return json({ ok: true, ...result });
      }

      if (req.method === "GET" && url.pathname.startsWith("/trace/")) {
        const traceId = decodeURIComponent(url.pathname.slice("/trace/".length)).trim();
        if (!traceId) return json({ ok: false, error: "missing trace id" }, 400);
        const trace = await getTrace(env as any, traceId);
        if (!trace) return json({ ok: false, error: "trace not found" }, 404);
        return json({ ok: true, trace });
      }

      return json({ ok: false, error: "not found" }, 404);
    } catch (e) {
      return json(
        {
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        },
        500
      );
    }
  },

  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      (async () => {
        await crawlSeed("https://gwins.org/cn/milesguo/", 50, env, 20);
        await crawlRun(10, env);
      })()
    );
  },

  async queue(batch: MessageBatch<unknown>, env: Env, ctx: ExecutionContext): Promise<void> {
    for (const msg of batch.messages) {
      ctx.waitUntil(
        (async () => {
          try {
            await processTraceMessage(env as any, msg.body);
            msg.ack();
          } catch {
            msg.retry();
          }
        })()
      );
    }
  },
};

async function readJson(req: Request): Promise<JsonObj> {
  const ct = req.headers.get("content-type") ?? "";
  if (!ct.includes("application/json")) return {};
  const body = (await req.json()) as JsonObj;
  return body && typeof body === "object" ? body : {};
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function shouldRedirectToPrimary(url: URL): boolean {
  if (url.hostname === PRIMARY_HOST) return false;
  return url.hostname.endsWith(".workers.dev");
}

function json(body: JsonObj, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function renderHomePage(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="description" content="Miles Guo 郭文贵内容检索与证据阅读，支持全文搜索、线索追踪与结果页索引。" />
  <meta name="robots" content="index,follow,max-snippet:-1,max-image-preview:large,max-video-preview:-1" />
  <link rel="canonical" href="${PRIMARY_ORIGIN}/" />
  <meta property="og:type" content="website" />
  <meta property="og:title" content="Miles Guo 郭文贵" />
  <meta property="og:description" content="输入关键词检索已入库内容，浏览结构化结果页。" />
  <meta property="og:url" content="${PRIMARY_ORIGIN}/" />
  <title>Miles Guo 郭文贵</title>
  <style>
    :root {
      --bg: #f5f1e8;
      --card: #fffdf8;
      --ink: #1e2a26;
      --muted: #5f6d67;
      --accent: #0d7a5f;
      --border: #d7d2c7;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      font-family: "Space Grotesk", "Noto Sans SC", "PingFang SC", sans-serif;
      color: var(--ink);
      background:
        radial-gradient(circle at 15% 20%, #e8f6ea 0 18%, transparent 19%),
        radial-gradient(circle at 85% 0%, #ffe9ce 0 22%, transparent 23%),
        var(--bg);
      padding: 32px 16px;
    }
    .wrap {
      max-width: 980px;
      margin: 0 auto;
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 18px;
      box-shadow: 0 12px 30px rgba(39, 50, 47, 0.08);
      overflow: hidden;
    }
    .header {
      padding: 28px 24px 20px;
      border-bottom: 1px solid var(--border);
    }
    h1 {
      margin: 0;
      font-size: clamp(1.4rem, 2.2vw, 2rem);
      letter-spacing: 0.02em;
    }
    .desc {
      margin: 8px 0 0;
      color: var(--muted);
      font-size: 0.95rem;
    }
    .search {
      padding: 18px 24px;
      position: sticky;
      top: 0;
      background: linear-gradient(180deg, rgba(255, 253, 248, 0.95), rgba(255, 253, 248, 0.85));
      backdrop-filter: blur(4px);
      border-bottom: 1px solid var(--border);
      z-index: 2;
    }
    input {
      width: 100%;
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 14px 15px;
      font-size: 1rem;
      outline: none;
      transition: border-color .2s ease, box-shadow .2s ease;
      background: #fffcf6;
    }
    input:focus {
      border-color: var(--accent);
      box-shadow: 0 0 0 3px rgba(13, 122, 95, 0.15);
    }
    .meta {
      margin-top: 8px;
      color: var(--muted);
      font-size: 0.9rem;
      min-height: 18px;
    }
    .results { padding: 8px 24px 24px; }
    .item {
      padding: 16px 0;
      border-bottom: 1px dashed var(--border);
      animation: fadeIn .2s ease;
    }
    .item:last-child { border-bottom: 0; }
    .url {
      color: var(--accent);
      text-decoration: none;
      word-break: break-all;
      font-size: 0.9rem;
    }
    .title {
      margin: 6px 0 8px;
      font-size: 1rem;
      font-weight: 600;
      line-height: 1.45;
    }
    .snippet {
      margin: 0;
      color: var(--muted);
      line-height: 1.55;
      font-size: 0.94rem;
    }
    .empty {
      padding: 28px 0;
      text-align: center;
      color: var(--muted);
    }
    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(4px); }
      to { opacity: 1; transform: translateY(0); }
    }
  </style>
</head>
<body>
  <main class="wrap">
    <header class="header">
      <h1>Miles Guo 视频信息内容 全文检索</h1>
      <p class="desc">输入关键词实时检索索引内容 </p>
    </header>
    <section class="search">
      <input id="q" autocomplete="off" placeholder="输入人物、事件、关键词..." />
      <div id="meta" class="meta"></div>
    </section>
    <section id="results" class="results">
      <div class="empty">开始输入即可查看相关内容</div>
    </section>
  </main>
  <script type="application/ld+json">
  {
    "@context":"https://schema.org",
    "@type":"WebSite",
    "name":"Miles Guo 郭文贵",
    "url":"${PRIMARY_ORIGIN}/",
    "potentialAction":{
      "@type":"SearchAction",
      "target":"${PRIMARY_ORIGIN}/search?q={search_term_string}",
      "query-input":"required name=search_term_string"
    }
  }
  </script>
  <script>
    const input = document.getElementById("q");
    const meta = document.getElementById("meta");
    const results = document.getElementById("results");
    let timer = null;
    let controller = null;

    function escapeHtml(text) {
      return text
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;");
    }

    function renderItems(items) {
      if (!items.length) {
        results.innerHTML = '<div class="empty">没有找到相关内容</div>';
        return;
      }
      results.innerHTML = items.map((it) => \`
        <article class="item">
          <a class="url" href="\${it.result_path || '#'}">\${escapeHtml(it.result_path || "")}</a>
          <p class="snippet">来源：\${escapeHtml(it.url || "")}</p>
          <h2 class="title">\${escapeHtml(it.title || "Untitled")}</h2>
          <p class="snippet">\${escapeHtml((it.snippet || "").replaceAll("[", "").replaceAll("]", ""))}</p>
        </article>
      \`).join("");
    }

    async function searchNow(keyword) {
      const q = keyword.trim();
      if (!q) {
        meta.textContent = "";
        results.innerHTML = '<div class="empty">开始输入即可查看相关内容</div>';
        return;
      }

      if (controller) controller.abort();
      controller = new AbortController();
      meta.textContent = "检索中...";

      try {
        const resp = await fetch(\`/search?q=\${encodeURIComponent(q)}&limit=20\`, { signal: controller.signal });
        const data = await resp.json();
        if (!resp.ok || !data.ok) throw new Error(data.error || "search failed");
        meta.textContent = \`关键词: "\${q}"，命中 \${data.count} 条\`;
        renderItems(data.hits || []);
      } catch (err) {
        if (err.name === "AbortError") return;
        meta.textContent = "检索失败";
        results.innerHTML = '<div class="empty">请求失败，请稍后重试</div>';
      }
    }

    input.addEventListener("input", () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => searchNow(input.value), 260);
    });
  </script>
</body>
</html>`;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((v) => String(v).trim()).filter(Boolean);
}

function renderResultPage(args: { title: string; sourceUrl: string; canonicalUrl: string; html: string }): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="description" content="${escapeHtml(args.title)}" />
  <meta name="robots" content="index,follow,max-snippet:-1,max-image-preview:large,max-video-preview:-1" />
  <link rel="canonical" href="${args.canonicalUrl}" />
  <meta property="og:type" content="article" />
  <meta property="og:title" content="${escapeHtml(args.title)}" />
  <meta property="og:url" content="${args.canonicalUrl}" />
  <title>${escapeHtml(args.title)}</title>
  <style>
    body { margin:0; font-family:"Noto Serif SC","PingFang SC",serif; background:#f7f7f7; color:#222; }
    .wrap { max-width: 900px; margin: 24px auto; background:#fff; border:1px solid #e4e4e4; border-radius:14px; overflow:hidden; }
    .head { padding:18px 22px; border-bottom:1px solid #ececec; background:#fafafa; }
    .head a { color:#0d7a5f; text-decoration:none; font-size:14px; }
    .head h1 { margin:10px 0 0; font-size:24px; line-height:1.35; }
    .source { color:#666; font-size:13px; margin-top:8px; word-break:break-all; }
    .article { padding:24px 22px; line-height:1.75; font-size:17px; }
    .article h1,.article h2,.article h3 { line-height:1.4; margin-top:1.2em; }
    .article pre { background:#f4f4f4; padding:10px; border-radius:8px; overflow:auto; }
    .article code { background:#f1f1f1; padding:2px 4px; border-radius:4px; }
    .article blockquote { margin:0; padding:0 0 0 14px; border-left:3px solid #d8d8d8; color:#555; }
    .article a { color:#0d7a5f; }
    .article ul,.article ol { padding-left: 1.2em; }
  </style>
</head>
<body>
  <main class="wrap">
    <header class="head">
      <a href="/">← 返回搜索</a>
      <h1>${escapeHtml(args.title)}</h1>
      <div class="source">原文 URL: ${escapeHtml(args.sourceUrl)}</div>
    </header>
    <article class="article">${args.html}</article>
  </main>
</body>
</html>`;
}

function renderHomeMarkdownForAi(
  pages: Array<{ url_hash: string; title: string | null; updated_at: string | null }>
): string {
  const lines = [
    "# Miles Guo Content Index",
    "",
    `- site: ${PRIMARY_ORIGIN}`,
    "- format: markdown",
    "- usage: call `/search?q=关键词&limit=20` for retrieval",
    "",
    "## Recent Results",
    "",
  ];

  for (const p of pages) {
    lines.push(
      `- [${(p.title ?? p.url_hash).replaceAll("\\n", " ")}](${PRIMARY_ORIGIN}/results/${p.url_hash}) (${p.updated_at ?? "unknown"})`
    );
  }

  return lines.join("\\n");
}

function renderRobotsTxt(): string {
  return `User-agent: *\nAllow: /\nDisallow: /trace\nDisallow: /hotspots\nDisallow: /crawl\n\nSitemap: ${PRIMARY_ORIGIN}/sitemap.xml\nHost: ${PRIMARY_HOST}\n`;
}

function renderSitemapXml(entries: Array<{ url_hash: string; updated_at: string | null }>): string {
  const urls = entries
    .map((e) => {
      const lastmod = e.updated_at ? `<lastmod>${new Date(e.updated_at).toISOString()}</lastmod>` : "";
      return `<url><loc>${PRIMARY_ORIGIN}/results/${e.url_hash}</loc>${lastmod}</url>`;
    })
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${PRIMARY_ORIGIN}/</loc></url>${urls}</urlset>`;
}

function markdownToHtml(md: string): string {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let inList = false;
  let inCode = false;

  for (const raw of lines) {
    const line = raw.trimEnd();

    if (line.startsWith("```")) {
      if (!inCode) {
        inCode = true;
        if (inList) {
          out.push("</ul>");
          inList = false;
        }
        out.push("<pre><code>");
      } else {
        inCode = false;
        out.push("</code></pre>");
      }
      continue;
    }

    if (inCode) {
      out.push(escapeHtml(line) + "\n");
      continue;
    }

    if (!line.trim()) {
      if (inList) {
        out.push("</ul>");
        inList = false;
      }
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      if (inList) {
        out.push("</ul>");
        inList = false;
      }
      const level = heading[1].length;
      out.push(`<h${level}>${inlineMd(heading[2])}</h${level}>`);
      continue;
    }

    if (line.startsWith(">")) {
      if (inList) {
        out.push("</ul>");
        inList = false;
      }
      out.push(`<blockquote>${inlineMd(line.replace(/^>\s?/, ""))}</blockquote>`);
      continue;
    }

    const li = line.match(/^[-*]\s+(.*)$/);
    if (li) {
      if (!inList) {
        out.push("<ul>");
        inList = true;
      }
      out.push(`<li>${inlineMd(li[1])}</li>`);
      continue;
    }

    if (inList) {
      out.push("</ul>");
      inList = false;
    }
    out.push(`<p>${inlineMd(line)}</p>`);
  }

  if (inList) out.push("</ul>");
  if (inCode) out.push("</code></pre>");
  return out.join("\n");
}

function inlineMd(text: string): string {
  let s = escapeHtml(text);
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label, href) => `<a href="${escapeHtml(href)}" target="_blank" rel="noreferrer">${label}</a>`);
  s = s.replace(/&lt;(https?:\/\/[^&\s]+)&gt;/gi, (_m, href) => `<a href="${escapeHtml(href)}" target="_blank" rel="noreferrer">${escapeHtml(href)}</a>`);
  s = s.replace(/(^|[\s：:])((https?:\/\/(?:odysee\.com|rumble\.com)\/[^\s<]+))/gi, (_m, prefix, href) => `${prefix}<a href="${escapeHtml(href)}" target="_blank" rel="noreferrer">${escapeHtml(href)}</a>`);
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
  return s;
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function classifyAgent(userAgent: string): { isAiBot: boolean; isSearchBot: boolean } {
  const ua = userAgent.toLowerCase();
  const aiBots = [
    "gptbot",
    "chatgpt-user",
    "oai-searchbot",
    "claudebot",
    "anthropic-ai",
    "perplexitybot",
    "youbot",
    "cohere-ai",
    "ccbot",
    "bytespider",
  ];
  const searchBots = [
    "googlebot",
    "bingbot",
    "duckduckbot",
    "yandexbot",
    "baiduspider",
    "applebot",
    "slurp",
  ];

  return {
    isAiBot: aiBots.some((s) => ua.includes(s)),
    isSearchBot: searchBots.some((s) => ua.includes(s)),
  };
}
