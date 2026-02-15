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

-- FTS table with stable chunk_id for trace pipeline
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts_v2 USING fts5(
  content,
  url UNINDEXED,
  url_hash UNINDEXED,
  chunk_id UNINDEXED,
  published_at UNINDEXED,
  tokenize='unicode61'
);

-- Entity graph tables
CREATE TABLE IF NOT EXISTS entities (
  entity_id TEXT PRIMARY KEY,
  canonical TEXT NOT NULL,
  type TEXT NOT NULL,
  lang TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_entities_canonical_type ON entities(canonical, type);

CREATE TABLE IF NOT EXISTS entity_aliases (
  entity_id TEXT NOT NULL,
  alias TEXT NOT NULL,
  confidence REAL,
  PRIMARY KEY(entity_id, alias)
);

CREATE INDEX IF NOT EXISTS idx_entity_aliases_alias ON entity_aliases(alias);

CREATE TABLE IF NOT EXISTS mentions (
  mention_id TEXT PRIMARY KEY,
  entity_id TEXT NOT NULL,
  chunk_id TEXT NOT NULL,
  span_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_mentions_entity ON mentions(entity_id);
CREATE INDEX IF NOT EXISTS idx_mentions_chunk ON mentions(chunk_id);

CREATE TABLE IF NOT EXISTS events (
  event_id TEXT PRIMARY KEY,
  time TEXT,
  type TEXT NOT NULL,
  summary TEXT NOT NULL,
  args_json TEXT,
  chunk_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_events_time ON events(time);
CREATE INDEX IF NOT EXISTS idx_events_chunk ON events(chunk_id);

CREATE TABLE IF NOT EXISTS edges (
  edge_id TEXT PRIMARY KEY,
  src_entity_id TEXT NOT NULL,
  relation TEXT NOT NULL,
  dst_entity_id TEXT NOT NULL,
  event_id TEXT,
  chunk_id TEXT NOT NULL,
  weight REAL NOT NULL DEFAULT 0.5,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_edges_src ON edges(src_entity_id);
CREATE INDEX IF NOT EXISTS idx_edges_dst ON edges(dst_entity_id);

CREATE TABLE IF NOT EXISTS hotspots (
  hotspot_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  time_start TEXT,
  time_end TEXT,
  entities_json TEXT NOT NULL DEFAULT '[]',
  keywords_json TEXT NOT NULL DEFAULT '[]',
  must_include_json TEXT NOT NULL DEFAULT '[]',
  exclude_json TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS traces (
  trace_id TEXT PRIMARY KEY,
  hotspot_id TEXT NOT NULL,
  anchor TEXT NOT NULL,
  event TEXT,
  aliases_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL,
  result_json TEXT,
  error TEXT,
  retries INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_traces_status ON traces(status);
CREATE INDEX IF NOT EXISTS idx_traces_hotspot ON traces(hotspot_id);
