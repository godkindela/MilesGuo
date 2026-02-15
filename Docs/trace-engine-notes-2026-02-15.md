# Trace Engine Notes (2026-02-15)

## What was added
- New API endpoints:
  - `POST /hotspots/upsert`
  - `POST /trace` (async, queue producer)
  - `GET /trace/:id`
- Queue consumer pipeline for trace tasks.
- Dual-recall path:
  - FTS recall via `chunks_fts_v2`
  - Vector recall via `VEC` binding (when embeddings are available)
- Graph/timeline/evidence output persisted in `traces.result_json`.

## Cloudflare resources
- Vectorize index: `gwins-md-chunks`
- Queue: `gwins-trace-queue`
- Worker bindings updated in `wrangler.toml`:
  - `DB`, `BUCKET`, `AI`, `VEC`, `TRACE_QUEUE`

## D1 schema additions
- `chunks_fts_v2`
- `entities`, `entity_aliases`, `mentions`
- `events`, `edges`
- `hotspots`, `traces`

## Data backfill
- Backfilled `chunks_fts_v2` from existing `chunks + pages`.
- Backfill row count: `19528`.

## Smoke test
- Hotspot created: `44759a4e-f7c2-4191-9a67-08e1ff797c78`
- Trace job: `6a076d1d-5060-4dba-8357-f2632f775094`
- Result status: `done`
- Output stats (sample run):
  - `top_count=17`
  - `timeline_count=25`
  - `edges_count=34`
  - `evidence_count=17`

## Notes
- Current vector recall in smoke test returned `0` candidates because embeddings were not yet populated for corpus-wide chunks; pipeline still works via FTS and can lazily upsert vectors during trace processing.
