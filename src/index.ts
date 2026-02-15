import { crawlRun, crawlSeed, Env } from "./crawl";
import { getPageByUrl, searchChunks } from "./storage";

interface JsonObj {
  [key: string]: unknown;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(req.url);

      if (req.method === "GET" && url.pathname === "/health") {
        return json({
          ok: true,
          version: "0.1.0",
          date: new Date().toISOString(),
          bindings: {
            DB: !!env.DB,
            BUCKET: !!env.BUCKET,
            AI: !!env.AI,
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
