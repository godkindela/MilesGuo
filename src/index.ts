import { crawlRun, crawlSeed, Env } from "./crawl";
import { getPageByUrl, searchChunks } from "./storage";
import { enqueueTrace, getTrace, processTraceMessage, upsertHotspot } from "./trace";

interface JsonObj {
  [key: string]: unknown;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(req.url);

      if (req.method === "GET" && url.pathname === "/") {
        return new Response(renderHomePage(), {
          headers: { "content-type": "text/html; charset=utf-8" },
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
        return json({ ok: true, q, limit, count: hits.length, hits });
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
  <title>GWINS Search</title>
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
      <h1>GWINS 全文检索</h1>
      <p class="desc">输入关键词实时检索索引内容，结果来自 D1 FTS / 索引库。</p>
    </header>
    <section class="search">
      <input id="q" autocomplete="off" placeholder="输入人物、事件、关键词..." />
      <div id="meta" class="meta"></div>
    </section>
    <section id="results" class="results">
      <div class="empty">开始输入即可查看相关内容</div>
    </section>
  </main>
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
          <a class="url" href="\${it.url}" target="_blank" rel="noreferrer">\${escapeHtml(it.url || "")}</a>
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
