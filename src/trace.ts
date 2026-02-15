import { sha256 } from "./storage";

export interface TraceEnv {
  DB: D1Database;
  AI: {
    run?: (model: string, payload: unknown) => Promise<unknown>;
  };
  VEC: {
    query?: (vector: number[], options?: Record<string, unknown>) => Promise<unknown>;
    upsert?: (vectors: Array<Record<string, unknown>>) => Promise<unknown>;
    insert?: (vectors: Array<Record<string, unknown>>) => Promise<unknown>;
  };
  TRACE_QUEUE: {
    send: (body: unknown) => Promise<void>;
  };
}

interface HotspotRecord {
  hotspot_id: string;
  title: string;
  description: string;
  time_start: string | null;
  time_end: string | null;
  entities_json: string;
  keywords_json: string;
  must_include_json: string;
  exclude_json: string;
}

interface ChunkCandidate {
  chunk_id: string;
  url: string;
  url_hash: string;
  chunk_index: number;
  content: string;
  published_at: string | null;
  lexicalScore: number;
  vectorScore: number;
  timeScore: number;
  score: number;
}

interface TracePayload {
  trace_id: string;
}

export async function upsertHotspot(
  env: TraceEnv,
  input: {
    hotspot_id?: string;
    title: string;
    description: string;
    time_start?: string | null;
    time_end?: string | null;
    entities?: string[];
    keywords?: string[];
    must_include?: string[];
    exclude?: string[];
  }
): Promise<{ hotspot_id: string }> {
  const hotspotId = input.hotspot_id?.trim() || crypto.randomUUID();

  await env.DB.prepare(
    `INSERT INTO hotspots (
      hotspot_id, title, description, time_start, time_end,
      entities_json, keywords_json, must_include_json, exclude_json, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(hotspot_id) DO UPDATE SET
      title=excluded.title,
      description=excluded.description,
      time_start=excluded.time_start,
      time_end=excluded.time_end,
      entities_json=excluded.entities_json,
      keywords_json=excluded.keywords_json,
      must_include_json=excluded.must_include_json,
      exclude_json=excluded.exclude_json,
      updated_at=CURRENT_TIMESTAMP`
  )
    .bind(
      hotspotId,
      input.title.trim(),
      input.description.trim(),
      input.time_start ?? null,
      input.time_end ?? null,
      JSON.stringify(input.entities ?? []),
      JSON.stringify(input.keywords ?? []),
      JSON.stringify(input.must_include ?? []),
      JSON.stringify(input.exclude ?? [])
    )
    .run();

  return { hotspot_id: hotspotId };
}

export async function enqueueTrace(
  env: TraceEnv,
  input: {
    hotspot_id: string;
    anchor: string;
    event?: string | null;
    aliases?: string[];
  }
): Promise<{ trace_id: string; status: string }> {
  const traceId = crypto.randomUUID();
  const aliasesJson = JSON.stringify(input.aliases ?? []);

  await env.DB.prepare(
    `INSERT INTO traces (
      trace_id, hotspot_id, anchor, event, aliases_json,
      status, result_json, error, retries, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'queued', NULL, NULL, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
  )
    .bind(traceId, input.hotspot_id.trim(), input.anchor.trim(), input.event ?? null, aliasesJson)
    .run();

  await env.TRACE_QUEUE.send({ trace_id: traceId } satisfies TracePayload);

  return { trace_id: traceId, status: "queued" };
}

export async function getTrace(env: TraceEnv, traceId: string): Promise<Record<string, unknown> | null> {
  const row = await env.DB.prepare(
    `SELECT trace_id, hotspot_id, anchor, event, status, result_json, error, retries, created_at, updated_at
     FROM traces WHERE trace_id = ? LIMIT 1`
  )
    .bind(traceId)
    .first<Record<string, unknown>>();

  if (!row) return null;
  if (typeof row.result_json === "string" && row.result_json) {
    try {
      row.result_json = JSON.parse(row.result_json);
    } catch {
      // keep raw payload if parsing fails
    }
  }
  return row;
}

export async function processTraceMessage(env: TraceEnv, payload: unknown): Promise<void> {
  const traceId = extractTraceId(payload);
  if (!traceId) return;

  await env.DB.prepare(`UPDATE traces SET status='running', updated_at=CURRENT_TIMESTAMP WHERE trace_id = ?`)
    .bind(traceId)
    .run();

  try {
    const traceRow = await env.DB.prepare(
      `SELECT trace_id, hotspot_id, anchor, event, aliases_json, retries FROM traces WHERE trace_id = ? LIMIT 1`
    )
      .bind(traceId)
      .first<{
        trace_id: string;
        hotspot_id: string;
        anchor: string;
        event: string | null;
        aliases_json: string | null;
        retries: number | null;
      }>();

    if (!traceRow) throw new Error("trace not found");

    const hotspot = await env.DB.prepare(
      `SELECT hotspot_id, title, description, time_start, time_end, entities_json, keywords_json, must_include_json, exclude_json
       FROM hotspots WHERE hotspot_id = ? LIMIT 1`
    )
      .bind(traceRow.hotspot_id)
      .first<HotspotRecord>();

    if (!hotspot) throw new Error("hotspot not found");

    const result = await runTracePipeline(env, {
      traceId,
      hotspot,
      anchor: traceRow.anchor,
      event: traceRow.event,
      requestAliases: safeParseArray(traceRow.aliases_json),
    });

    await env.DB.prepare(
      `UPDATE traces
       SET status='done', result_json=?, error=NULL, updated_at=CURRENT_TIMESTAMP
       WHERE trace_id = ?`
    )
      .bind(JSON.stringify(result), traceId)
      .run();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    await env.DB.prepare(
      `UPDATE traces
       SET status='failed',
           retries = COALESCE(retries, 0) + 1,
           error = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE trace_id = ?`
    )
      .bind(message.slice(0, 2000), traceId)
      .run();

    throw err;
  }
}

async function runTracePipeline(
  env: TraceEnv,
  args: {
    traceId: string;
    hotspot: HotspotRecord;
    anchor: string;
    event: string | null;
    requestAliases: string[];
  }
): Promise<Record<string, unknown>> {
  const hotspotEntities = safeParseArray(args.hotspot.entities_json);
  const hotspotKeywords = safeParseArray(args.hotspot.keywords_json);
  const mustInclude = safeParseArray(args.hotspot.must_include_json);
  const exclude = safeParseArray(args.hotspot.exclude_json);

  const aliases = await getAnchorAliases(env.DB, args.anchor, args.requestAliases);

  const ftsCandidates = await recallByFts(env.DB, {
    aliases,
    event: args.event,
    keywords: hotspotKeywords,
    limit: 300,
  });

  const vectorCandidates = await recallByVector(env, {
    queryText: [args.hotspot.description, args.anchor, args.event ?? ""].join(" ").trim(),
    limit: 300,
  });

  const merged = mergeCandidates(ftsCandidates, vectorCandidates);
  const filtered = filterCandidates(merged, { aliases, mustInclude, exclude, hotspot: args.hotspot });
  const reranked = rerankCandidates(filtered);
  const top = reranked.slice(0, 80);

  await upsertVectorsForCandidates(env, top);

  const extracted = await extractAndPersistKnowledge(env, {
    traceId: args.traceId,
    top,
    anchor: args.anchor,
    hotspotEntities,
    event: args.event,
  });

  const graph = await buildGraph(env.DB, args.anchor, hotspotEntities, 4);
  const timeline = buildTimeline(top, extracted.events);
  const evidencePack = buildEvidencePack(top, 20);

  const summary = await buildSummary(env, {
    anchor: args.anchor,
    event: args.event,
    hotspotTitle: args.hotspot.title,
    timeline,
    graph,
    evidencePack,
  });

  return {
    trace_id: args.traceId,
    hotspot_id: args.hotspot.hotspot_id,
    anchor: args.anchor,
    event: args.event,
    aliases,
    stats: {
      fts_count: ftsCandidates.length,
      vector_count: vectorCandidates.length,
      merged_count: merged.length,
      filtered_count: filtered.length,
      reranked_count: reranked.length,
      top_count: top.length,
    },
    summary,
    timeline,
    graph,
    evidence_pack: evidencePack,
  };
}

async function getAnchorAliases(db: D1Database, anchor: string, requestAliases: string[]): Promise<string[]> {
  const candidates = new Set<string>([anchor.trim(), ...requestAliases.map((s) => s.trim()).filter(Boolean)]);

  const rows = await db
    .prepare(
      `SELECT ea.alias
       FROM entity_aliases ea
       JOIN entities e ON e.entity_id = ea.entity_id
       WHERE e.canonical = ? OR ea.alias = ?
       LIMIT 50`
    )
    .bind(anchor, anchor)
    .all<{ alias: string }>();

  for (const r of rows.results ?? []) {
    if (r.alias?.trim()) candidates.add(r.alias.trim());
  }

  return [...candidates].filter(Boolean);
}

async function recallByFts(
  db: D1Database,
  args: { aliases: string[]; event: string | null; keywords: string[]; limit: number }
): Promise<ChunkCandidate[]> {
  const eventTerms = tokenize(args.event ?? "");
  const keywordTerms = args.keywords.flatMap((k) => tokenize(k));

  const aliasExpr = args.aliases.map((a) => `"${escapeFts(a)}"`).join(" OR ") || '""';
  const topicTokens = [...eventTerms, ...keywordTerms].slice(0, 8);
  const topicExpr = topicTokens.length ? topicTokens.map((t) => `"${escapeFts(t)}"`).join(" OR ") : '""';
  const ftsQuery = `(${aliasExpr}) AND (${topicExpr})`;

  try {
    const rs = await db
      .prepare(
        `SELECT c.url_hash,
                c.chunk_index,
                p.url,
                p.published_at,
                c.content,
                bm25(chunks_fts_v2) AS score
         FROM chunks_fts_v2
         JOIN chunks c ON c.url_hash = chunks_fts_v2.url_hash AND c.chunk_index = CAST(substr(chunks_fts_v2.chunk_id, instr(chunks_fts_v2.chunk_id, ':') + 1) AS INTEGER)
         JOIN pages p ON p.url_hash = c.url_hash
         WHERE chunks_fts_v2 MATCH ?
         LIMIT ?`
      )
      .bind(ftsQuery, args.limit)
      .all<{
        url_hash: string;
        chunk_index: number;
        url: string;
        content: string;
        published_at: string | null;
        score: number;
      }>();

    return (rs.results ?? []).map((r) => {
      const lexical = Math.max(0.1, 5 - (Number.isFinite(r.score) ? Math.abs(r.score) : 1));
      return {
        chunk_id: `${r.url_hash}:${r.chunk_index}`,
        url: r.url,
        url_hash: r.url_hash,
        chunk_index: r.chunk_index,
        content: r.content,
        published_at: r.published_at,
        lexicalScore: lexical,
        vectorScore: 0,
        timeScore: 0,
        score: lexical,
      };
    });
  } catch {
    const likeAlias = args.aliases[0] ?? "";
    const likeEvent = args.event ?? "";
    const rs = await db
      .prepare(
        `SELECT c.url_hash, c.chunk_index, p.url, p.published_at, c.content
         FROM chunks c
         JOIN pages p ON p.url_hash = c.url_hash
         WHERE c.content LIKE ? OR c.content LIKE ?
         LIMIT ?`
      )
      .bind(`%${likeAlias}%`, `%${likeEvent}%`, args.limit)
      .all<{
        url_hash: string;
        chunk_index: number;
        url: string;
        content: string;
        published_at: string | null;
      }>();

    return (rs.results ?? []).map((r) => ({
      chunk_id: `${r.url_hash}:${r.chunk_index}`,
      url: r.url,
      url_hash: r.url_hash,
      chunk_index: r.chunk_index,
      content: r.content,
      published_at: r.published_at,
      lexicalScore: 1,
      vectorScore: 0,
      timeScore: 0,
      score: 1,
    }));
  }
}

async function recallByVector(
  env: TraceEnv,
  args: { queryText: string; limit: number }
): Promise<ChunkCandidate[]> {
  if (!env.AI.run || !env.VEC.query) return [];

  const embedding = await createEmbedding(env, args.queryText);
  if (!embedding) return [];

  try {
    const result = await env.VEC.query(embedding, {
      topK: args.limit,
      returnMetadata: "all",
    });

    const matches = extractVectorMatches(result);
    return matches.map((m) => ({
      chunk_id: String(m.id),
      url: String((m.metadata?.url as string) ?? ""),
      url_hash: String((m.metadata?.url_hash as string) ?? ""),
      chunk_index: Number((m.metadata?.chunk_index as number) ?? 0),
      content: String((m.metadata?.content as string) ?? ""),
      published_at: (m.metadata?.published_at as string | null) ?? null,
      lexicalScore: 0,
      vectorScore: m.score,
      timeScore: 0,
      score: m.score,
    }));
  } catch {
    return [];
  }
}

function mergeCandidates(a: ChunkCandidate[], b: ChunkCandidate[]): ChunkCandidate[] {
  const map = new Map<string, ChunkCandidate>();

  for (const c of [...a, ...b]) {
    const prior = map.get(c.chunk_id);
    if (!prior) {
      map.set(c.chunk_id, c);
      continue;
    }

    prior.lexicalScore = Math.max(prior.lexicalScore, c.lexicalScore);
    prior.vectorScore = Math.max(prior.vectorScore, c.vectorScore);
    prior.score = prior.lexicalScore + prior.vectorScore + prior.timeScore;
    if (!prior.content && c.content) prior.content = c.content;
    if (!prior.url && c.url) prior.url = c.url;
    if (!prior.url_hash && c.url_hash) prior.url_hash = c.url_hash;
  }

  return [...map.values()];
}

function filterCandidates(
  candidates: ChunkCandidate[],
  args: { aliases: string[]; mustInclude: string[]; exclude: string[]; hotspot: HotspotRecord }
): ChunkCandidate[] {
  return candidates
    .filter((c) => containsAny(c.content, args.aliases))
    .filter((c) => (args.mustInclude.length ? containsAll(c.content, args.mustInclude) : true))
    .filter((c) => (args.exclude.length ? !containsAny(c.content, args.exclude) : true))
    .map((c) => {
      c.timeScore = scoreByTimeWindow(c.published_at, args.hotspot.time_start, args.hotspot.time_end);
      c.score = c.lexicalScore + c.vectorScore + c.timeScore;
      return c;
    });
}

function rerankCandidates(candidates: ChunkCandidate[]): ChunkCandidate[] {
  return [...candidates].sort((a, b) => b.score - a.score);
}

async function extractAndPersistKnowledge(
  env: TraceEnv,
  args: {
    traceId: string;
    top: ChunkCandidate[];
    anchor: string;
    hotspotEntities: string[];
    event: string | null;
  }
): Promise<{ events: Array<Record<string, unknown>> }> {
  const anchorEntityId = await upsertEntity(env.DB, args.anchor, "person", [args.anchor]);
  const extractedEvents: Array<Record<string, unknown>> = [];

  for (const c of args.top.slice(0, 80)) {
    const mentionId = await sha256(`mention:${c.chunk_id}:${anchorEntityId}`);
    await env.DB.prepare(
      `INSERT OR REPLACE INTO mentions (mention_id, entity_id, chunk_id, span_json, created_at)
       VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)`
    )
      .bind(mentionId, anchorEntityId, c.chunk_id, JSON.stringify({ start: 0, end: Math.min(180, c.content.length) }))
      .run();

    for (const ent of args.hotspotEntities) {
      const entId = await upsertEntity(env.DB, ent, "topic", [ent]);
      const edgeId = await sha256(`edge:${anchorEntityId}:${entId}:${c.chunk_id}`);
      await env.DB.prepare(
        `INSERT OR REPLACE INTO edges (
          edge_id, src_entity_id, relation, dst_entity_id, event_id, chunk_id, weight, created_at
        ) VALUES (?, ?, 'related_to', ?, NULL, ?, ?, CURRENT_TIMESTAMP)`
      )
        .bind(edgeId, anchorEntityId, entId, c.chunk_id, Number((c.score + 1).toFixed(4)))
        .run();
    }

    const eventSummary = buildEventSummary(c.content, args.event, args.anchor);
    const eventTime = c.published_at ?? null;
    const eventId = await sha256(`event:${c.chunk_id}:${eventSummary}`);
    await env.DB.prepare(
      `INSERT OR REPLACE INTO events (
        event_id, time, type, summary, args_json, chunk_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`
    )
      .bind(eventId, eventTime, args.event ? "hotspot_event" : "mention_event", eventSummary, JSON.stringify({ trace_id: args.traceId }), c.chunk_id)
      .run();

    extractedEvents.push({ event_id: eventId, time: eventTime, summary: eventSummary, chunk_id: c.chunk_id, url: c.url });
  }

  return { events: extractedEvents };
}

async function buildGraph(
  db: D1Database,
  anchor: string,
  hotspotEntities: string[],
  maxHops: number
): Promise<{ nodes: Array<Record<string, unknown>>; edges: Array<Record<string, unknown>>; paths: Array<Record<string, unknown>> }> {
  const anchorRow = await db
    .prepare(`SELECT entity_id, canonical FROM entities WHERE canonical = ? LIMIT 1`)
    .bind(anchor)
    .first<{ entity_id: string; canonical: string }>();

  if (!anchorRow) return { nodes: [], edges: [], paths: [] };

  const edgeRows = await db
    .prepare(
      `SELECT e.edge_id, e.src_entity_id, e.relation, e.dst_entity_id, e.chunk_id, e.weight,
              s.canonical AS src_name, d.canonical AS dst_name
       FROM edges e
       JOIN entities s ON s.entity_id = e.src_entity_id
       JOIN entities d ON d.entity_id = e.dst_entity_id
       WHERE e.src_entity_id = ?
       ORDER BY e.weight DESC
       LIMIT 200`
    )
    .bind(anchorRow.entity_id)
    .all<{
      edge_id: string;
      src_entity_id: string;
      relation: string;
      dst_entity_id: string;
      chunk_id: string;
      weight: number;
      src_name: string;
      dst_name: string;
    }>();

  const rows = edgeRows.results ?? [];
  const nodesMap = new Map<string, { id: string; label: string }>();
  const edges: Array<Record<string, unknown>> = [];

  nodesMap.set(anchorRow.entity_id, { id: anchorRow.entity_id, label: anchorRow.canonical });

  for (const r of rows) {
    nodesMap.set(r.dst_entity_id, { id: r.dst_entity_id, label: r.dst_name });
    edges.push({
      edge_id: r.edge_id,
      src: r.src_entity_id,
      src_label: r.src_name,
      relation: r.relation,
      dst: r.dst_entity_id,
      dst_label: r.dst_name,
      weight: r.weight,
      evidence_chunk_id: r.chunk_id,
    });
  }

  const targetNames = new Set(hotspotEntities);
  const paths = edges
    .filter((e) => targetNames.size === 0 || targetNames.has(String(e.dst_label)))
    .slice(0, maxHops)
    .map((e, idx) => ({
      path_id: `p${idx + 1}`,
      nodes: [String(e.src_label), String(e.dst_label)],
      edges: [e],
      score: e.weight,
    }));

  return {
    nodes: [...nodesMap.values()],
    edges,
    paths,
  };
}

function buildTimeline(
  top: ChunkCandidate[],
  events: Array<Record<string, unknown>>
): Array<Record<string, unknown>> {
  const fromEvents = events.map((e) => ({
    time: e.time,
    summary: e.summary,
    chunk_id: e.chunk_id,
    url: e.url,
  }));

  const supplements = top.slice(0, 8).map((c) => ({
    time: c.published_at,
    summary: buildEventSummary(c.content, null, ""),
    chunk_id: c.chunk_id,
    url: c.url,
  }));

  return [...fromEvents, ...supplements]
    .sort((a, b) => String(a.time ?? "").localeCompare(String(b.time ?? "")))
    .slice(0, 30);
}

function buildEvidencePack(top: ChunkCandidate[], size: number): Array<Record<string, unknown>> {
  return top.slice(0, size).map((c, i) => ({
    rank: i + 1,
    chunk_id: c.chunk_id,
    url: c.url,
    snippet: c.content.slice(0, 320),
    why: `lexical=${c.lexicalScore.toFixed(3)}, vector=${c.vectorScore.toFixed(3)}, time=${c.timeScore.toFixed(3)}`,
    score: Number(c.score.toFixed(4)),
  }));
}

async function buildSummary(
  env: TraceEnv,
  args: {
    anchor: string;
    event: string | null;
    hotspotTitle: string;
    timeline: Array<Record<string, unknown>>;
    graph: { nodes: Array<Record<string, unknown>>; edges: Array<Record<string, unknown>>; paths: Array<Record<string, unknown>> };
    evidencePack: Array<Record<string, unknown>>;
  }
): Promise<string> {
  const fallback = `围绕“${args.anchor}”与热点“${args.hotspotTitle}”构建线索链，提取时间线节点 ${args.timeline.length} 条，图边 ${args.graph.edges.length} 条，证据 ${args.evidencePack.length} 条。${args.event ? `重点事件：${args.event}。` : ""} 结果可能包含不确定项，已保留证据引用供复核。`;

  if (!env.AI.run) return fallback;

  try {
    const prompt = {
      system:
        "You are an analyst. Summarize in Chinese with cautious tone. Mention uncertainty and only use provided evidence counts.",
      user: JSON.stringify(
        {
          anchor: args.anchor,
          event: args.event,
          hotspot: args.hotspotTitle,
          timeline_count: args.timeline.length,
          edge_count: args.graph.edges.length,
          evidence_count: args.evidencePack.length,
        },
        null,
        2
      ),
    };

    const resp = await env.AI.run("@cf/meta/llama-3.1-8b-instruct", prompt);
    const text = extractTextFromAiRun(resp);
    return text?.trim() || fallback;
  } catch {
    return fallback;
  }
}

async function upsertEntity(
  db: D1Database,
  canonical: string,
  type: string,
  aliases: string[]
): Promise<string> {
  const entityId = await sha256(`entity:${canonical}:${type}`);

  await db
    .prepare(
      `INSERT OR REPLACE INTO entities (entity_id, canonical, type, lang, created_at)
       VALUES (?, ?, ?, 'zh', CURRENT_TIMESTAMP)`
    )
    .bind(entityId, canonical, type)
    .run();

  for (const alias of aliases.filter(Boolean)) {
    await db
      .prepare(
        `INSERT OR REPLACE INTO entity_aliases (entity_id, alias, confidence)
         VALUES (?, ?, 0.8)`
      )
      .bind(entityId, alias)
      .run();
  }

  return entityId;
}

async function upsertVectorsForCandidates(env: TraceEnv, candidates: ChunkCandidate[]): Promise<void> {
  if (!env.AI.run || (!env.VEC.upsert && !env.VEC.insert)) return;

  const batch = candidates.slice(0, 120);
  const vectors: Array<Record<string, unknown>> = [];
  for (const c of batch) {
    const emb = await createEmbedding(env, c.content.slice(0, 1200));
    if (!emb) continue;
    vectors.push({
      id: c.chunk_id,
      values: emb,
      metadata: {
        chunk_id: c.chunk_id,
        url: c.url,
        url_hash: c.url_hash,
        chunk_index: c.chunk_index,
        published_at: c.published_at,
        content: c.content.slice(0, 240),
      },
    });
  }

  if (!vectors.length) return;

  try {
    if (env.VEC.upsert) {
      await env.VEC.upsert(vectors);
    } else if (env.VEC.insert) {
      await env.VEC.insert(vectors);
    }
  } catch {
    // skip vector failures to keep trace pipeline resilient
  }
}

async function createEmbedding(env: TraceEnv, text: string): Promise<number[] | null> {
  if (!env.AI.run) return null;
  try {
    const resp = await env.AI.run("@cf/baai/bge-base-en-v1.5", {
      text: [text],
    });
    return extractEmbedding(resp);
  } catch {
    return null;
  }
}

function extractEmbedding(resp: unknown): number[] | null {
  const data = resp as any;

  const fromData = data?.data?.[0]?.embedding;
  if (Array.isArray(fromData) && fromData.length > 0) return fromData as number[];

  const fromResult = data?.result?.data?.[0]?.embedding;
  if (Array.isArray(fromResult) && fromResult.length > 0) return fromResult as number[];

  return null;
}

function extractVectorMatches(
  resp: unknown
): Array<{ id: string; score: number; metadata?: Record<string, unknown> }> {
  const r = resp as { matches?: Array<{ id: string; score?: number; metadata?: Record<string, unknown> }> };
  const matches = r?.matches;
  if (!Array.isArray(matches)) return [];
  return matches.map((m) => ({
    id: String(m.id),
    score: Number(m.score ?? 0),
    metadata: m.metadata,
  }));
}

function extractTextFromAiRun(resp: unknown): string | null {
  if (!resp) return null;

  if (typeof resp === "string") return resp;

  const obj = resp as any;

  return obj.response ?? obj.output_text ?? obj.result?.response ?? obj.result?.output_text ?? null;
}

function tokenize(input: string): string[] {
  return input
    .split(/[\s,，。；;、|/()（）]+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 2)
    .slice(0, 12);
}

function escapeFts(term: string): string {
  return term.replace(/"/g, "");
}

function containsAny(text: string, terms: string[]): boolean {
  if (!terms.length) return true;
  return terms.some((t) => t && text.includes(t));
}

function containsAll(text: string, terms: string[]): boolean {
  if (!terms.length) return true;
  return terms.every((t) => t && text.includes(t));
}

function scoreByTimeWindow(
  publishedAt: string | null,
  start: string | null,
  end: string | null
): number {
  if (!publishedAt || (!start && !end)) return 0;
  if (start && publishedAt < start) return -0.2;
  if (end && publishedAt > end) return -0.2;
  return 0.2;
}

function buildEventSummary(content: string, event: string | null, anchor: string): string {
  const sentence = content.split(/[\n。！？!?]/).map((s) => s.trim()).find((s) => s.length >= 12) ?? content.slice(0, 80);
  const head = [anchor, event].filter(Boolean).join("/");
  return head ? `${head}: ${sentence}` : sentence;
}

function safeParseArray(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const arr = JSON.parse(value) as unknown;
    if (!Array.isArray(arr)) return [];
    return arr.map((s) => String(s).trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function extractTraceId(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const id = (payload as { trace_id?: unknown }).trace_id;
  if (typeof id !== "string" || !id.trim()) return null;
  return id;
}
