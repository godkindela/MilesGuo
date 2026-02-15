# Ingestion Notes (2026-02-15)

## Scope
- Source sitemap: `https://gwins.org/googlemap_1.xml`
- Target path pattern: `/cn/milesguo/*.html`
- Pipeline: Cloudflare Worker -> Workers AI `toMarkdown` -> R2 (`.md`) + D1 (`pages/chunks/chunks_fts`)

## Deployment
- Worker URL: `https://gwins-md.godkin.workers.dev`
- Cron: hourly (`0 * * * *`)
- D1 database: `gwins-md`
- R2 bucket: `gwins-md`

## Final Sync Result
- Sitemap URLs: `2874`
- D1 `pages` rows: `2874`
- D1 status distribution: `stored=2874`, `discovered=0`, `failed=0`
- `stored` rows with missing `r2_key`: `0`

## Consistency Checks
- Sitemap vs D1 set diff:
  - Missing in D1: `0`
  - Extra in D1: `0`
- R2 accessibility check via `/page?url=...`:
  - Checked: `2874`
  - HTTP 200: `2874`
  - Errors: `0`
- Index parity:
  - `chunks_count=19528`
  - `fts_count=19528`

## Notes
- Seed endpoint now supports sitemap XML directly.
- Seed limit increased to support full sitemap ingestion (`limit` up to `10000`).
- Crawl workflow includes retry, bounded concurrency, and incremental request headers (`If-None-Match`, `If-Modified-Since`).
