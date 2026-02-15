-- Core page lifecycle table
CREATE TABLE IF NOT EXISTS pages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  url TEXT NOT NULL UNIQUE,
  url_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'discovered',
  etag TEXT,
  last_modified TEXT,
  content_sha256 TEXT,
  r2_key TEXT,
  title TEXT,
  published_at TEXT,
  updated_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  error TEXT,
  checked_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_pages_status ON pages(status);
CREATE INDEX IF NOT EXISTS idx_pages_updated_at ON pages(updated_at);

-- Search chunks table
CREATE TABLE IF NOT EXISTS chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  url_hash TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  content TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_chunks_url_hash ON chunks(url_hash);

-- FTS index for chunk content search
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  url_hash UNINDEXED,
  url UNINDEXED,
  title,
  content
);
