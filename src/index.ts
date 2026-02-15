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
