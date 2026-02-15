export type PageStatus = "discovered" | "fetched" | "converted" | "stored" | "failed";

export interface PageRecord {
  url: string;
  urlHash: string;
  status: PageStatus;
  etag?: string | null;
  lastModified?: string | null;
  contentSha256?: string | null;
  r2Key?: string | null;
  title?: string | null;
  error?: string | null;
}

export interface CandidateRow {
  url: string;
  url_hash: string;
  etag: string | null;
  last_modified: string | null;
  content_sha256: string | null;
}

export async function sha256(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function insertDiscoveredPages(db: D1Database, urls: string[]): Promise<number> {
  let inserted = 0;

  for (const url of urls) {
    const hash = await sha256(url);
    const result = await db
      .prepare(
        `INSERT INTO pages (url, url_hash, status, updated_at)
         VALUES (?, ?, 'discovered', CURRENT_TIMESTAMP)
         ON CONFLICT(url) DO UPDATE SET
           updated_at = CURRENT_TIMESTAMP,
           status = CASE
             WHEN pages.status IN ('stored', 'converted') THEN pages.status
             ELSE 'discovered'
           END`
      )
      .bind(url, hash)
      .run();

    if (result.success && result.meta.changes > 0) inserted += 1;
  }

  return inserted;
}

export async function getCandidates(db: D1Database, max: number): Promise<CandidateRow[]> {
  const rs = await db
    .prepare(
      `SELECT url, url_hash, etag, last_modified, content_sha256
       FROM pages
       WHERE status IN ('discovered', 'failed')
       ORDER BY updated_at IS NULL DESC, updated_at ASC, created_at ASC
       LIMIT ?`
    )
    .bind(max)
    .all<CandidateRow>();

  return rs.results ?? [];
}

export async function markNotModified(db: D1Database, urlHash: string): Promise<void> {
  await db
    .prepare(
      `UPDATE pages
       SET checked_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP,
           error = NULL
       WHERE url_hash = ?`
    )
    .bind(urlHash)
    .run();
}

export async function markFailed(db: D1Database, urlHash: string, error: string): Promise<void> {
  await db
    .prepare(
      `UPDATE pages
       SET status = 'failed',
           error = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE url_hash = ?`
    )
    .bind(error.slice(0, 2000), urlHash)
    .run();
}

export async function upsertStoredPage(db: D1Database, page: PageRecord): Promise<void> {
  await db
    .prepare(
      `UPDATE pages
       SET status = ?,
           etag = ?,
           last_modified = ?,
           content_sha256 = ?,
           r2_key = ?,
           title = ?,
           checked_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP,
           error = ?
       WHERE url_hash = ?`
    )
    .bind(
      page.status,
      page.etag ?? null,
      page.lastModified ?? null,
      page.contentSha256 ?? null,
      page.r2Key ?? null,
      page.title ?? null,
      page.error ?? null,
      page.urlHash
    )
    .run();
}

export async function getPageByUrl(
  db: D1Database,
  url: string
): Promise<{ url: string; r2_key: string | null; title: string | null } | null> {
  const row = await db
    .prepare(`SELECT url, r2_key, title FROM pages WHERE url = ? LIMIT 1`)
    .bind(url)
    .first<{ url: string; r2_key: string | null; title: string | null }>();
  return row ?? null;
}

export async function getPageByHash(
  db: D1Database,
  urlHash: string
): Promise<{ url: string; r2_key: string | null; title: string | null; url_hash: string } | null> {
  const row = await db
    .prepare(`SELECT url, r2_key, title, url_hash FROM pages WHERE url_hash = ? LIMIT 1`)
    .bind(urlHash)
    .first<{ url: string; r2_key: string | null; title: string | null; url_hash: string }>();
  return row ?? null;
}

export async function getSitemapPages(
  db: D1Database,
  limit: number
): Promise<Array<{ url_hash: string; updated_at: string | null }>> {
  const rs = await db
    .prepare(
      `SELECT url_hash, updated_at
       FROM pages
       WHERE status = 'stored' AND r2_key IS NOT NULL
       ORDER BY datetime(updated_at) DESC
       LIMIT ?`
    )
    .bind(limit)
    .all<{ url_hash: string; updated_at: string | null }>();
  return rs.results ?? [];
}

export async function getRecentStoredPages(
  db: D1Database,
  limit: number
): Promise<Array<{ url_hash: string; title: string | null; updated_at: string | null }>> {
  const rs = await db
    .prepare(
      `SELECT url_hash, title, updated_at
       FROM pages
       WHERE status = 'stored'
       ORDER BY datetime(updated_at) DESC
       LIMIT ?`
    )
    .bind(limit)
    .all<{ url_hash: string; title: string | null; updated_at: string | null }>();
  return rs.results ?? [];
}

export function splitMarkdownIntoChunks(markdown: string, maxChunkSize = 2000): string[] {
  const blocks = markdown
    .split(/\n\s*\n/g)
    .map((s) => s.trim())
    .filter(Boolean);

  const chunks: string[] = [];
  let current = "";

  for (const block of blocks) {
    if (current.length + block.length + 2 <= maxChunkSize) {
      current = current ? `${current}\n\n${block}` : block;
      continue;
    }

    if (current) chunks.push(current);

    if (block.length <= maxChunkSize) {
      current = block;
      continue;
    }

    const slices = sliceByLength(block, maxChunkSize);
    chunks.push(...slices.slice(0, -1));
    current = slices.at(-1) ?? "";
  }

  if (current) chunks.push(current);
  return chunks;
}

function sliceByLength(input: string, maxChunkSize: number): string[] {
  const out: string[] = [];
  let remain = input;
  while (remain.length > maxChunkSize) {
    out.push(remain.slice(0, maxChunkSize));
    remain = remain.slice(maxChunkSize);
  }
  if (remain.length) out.push(remain);
  return out;
}

export async function replaceChunks(
  db: D1Database,
  args: { url: string; urlHash: string; title: string | null; chunks: string[] }
): Promise<void> {
  await db.prepare(`DELETE FROM chunks WHERE url_hash = ?`).bind(args.urlHash).run();
  await db.prepare(`DELETE FROM chunks_fts WHERE url_hash = ?`).bind(args.urlHash).run();
  await db.prepare(`DELETE FROM chunks_fts_v2 WHERE url_hash = ?`).bind(args.urlHash).run();

  for (let i = 0; i < args.chunks.length; i += 1) {
    const content = args.chunks[i];
    const contentHash = await sha256(content);
    const chunkId = `${args.urlHash}:${i}`;

    await db
      .prepare(
        `INSERT INTO chunks (url_hash, chunk_index, content, content_sha256)
         VALUES (?, ?, ?, ?)`
      )
      .bind(args.urlHash, i, content, contentHash)
      .run();

    await db
      .prepare(
        `INSERT INTO chunks_fts (url_hash, url, title, content)
         VALUES (?, ?, ?, ?)`
      )
      .bind(args.urlHash, args.url, args.title ?? "", content)
      .run();

    await db
      .prepare(
        `INSERT INTO chunks_fts_v2 (content, url, url_hash, chunk_id, published_at)
         VALUES (?, ?, ?, ?, NULL)`
      )
      .bind(content, args.url, args.urlHash, chunkId)
      .run();
  }
}

export async function searchChunks(
  db: D1Database,
  q: string,
  limit: number
): Promise<Array<{ url: string; url_hash: string; title: string; snippet: string }>> {
  try {
    const rs = await db
      .prepare(
        `SELECT url,
                url_hash,
                COALESCE(title, '') AS title,
                snippet(chunks_fts, 3, '[', ']', ' ... ', 24) AS snippet
         FROM chunks_fts
         WHERE chunks_fts MATCH ?
         LIMIT ?`
      )
      .bind(q, limit)
      .all<{ url: string; url_hash: string; title: string; snippet: string }>();
    return rs.results ?? [];
  } catch {
    const like = `%${q}%`;
    const rs = await db
      .prepare(
        `SELECT p.url,
                p.url_hash,
                COALESCE(p.title, '') AS title,
                substr(c.content, 1, 220) AS snippet
         FROM chunks c
         JOIN pages p ON p.url_hash = c.url_hash
         WHERE c.content LIKE ?
         LIMIT ?`
      )
      .bind(like, limit)
      .all<{ url: string; url_hash: string; title: string; snippet: string }>();
    return rs.results ?? [];
  }
}
