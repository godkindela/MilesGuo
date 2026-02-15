# gwins-md (Cloudflare Worker)

抓取 `https://gwins.org/cn/milesguo/` 文章，使用 Workers AI `toMarkdown` 转换为 Markdown，写入 R2，并在 D1 建立元数据与全文检索索引（FTS5）。

## 功能

- `POST /crawl/seed`：从栏目页发现文章链接并入库去重。
- `POST /crawl/run`：批量抓取文章、转换 Markdown、写入 R2、写入 D1 chunks/FTS。
- `GET /page?url=...`：按 URL 返回对应 Markdown。
- `GET /search?q=...&limit=20`：基于 FTS 搜索。
- `GET /health`：健康检查与绑定状态。
- `scheduled()`：每小时自动执行一轮 seed + run。

## 1) 安装依赖

```bash
npm install
```

## 2) Cloudflare 登录与资源创建

```bash
npx wrangler whoami
# 如未登录：npx wrangler login

npx wrangler r2 bucket create gwins-md
npx wrangler d1 create gwins-md
```

执行 `d1 create` 后，把输出中的 `database_id` 填入 `wrangler.toml` 的 `[[d1_databases]]`。

## 3) 初始化 D1 表结构

本地：

```bash
npx wrangler d1 execute gwins-md --local --file=src/schema.sql
```

远端：

```bash
npx wrangler d1 execute gwins-md --remote --file=src/schema.sql
```

## 4) 本地开发

```bash
npm run dev
```

## 5) 测试 Cron（scheduled）

```bash
npm run dev:scheduled
```

启动后访问（触发 scheduled handler）：

```bash
curl "http://127.0.0.1:8787/__scheduled?cron=0+*+*+*+*"
```

## 6) 部署

```bash
npm run deploy
```

## HTTP API 示例

### 健康检查

```bash
curl "http://127.0.0.1:8787/health"
```

### 发现链接

```bash
curl -X POST "http://127.0.0.1:8787/crawl/seed" \
  -H "content-type: application/json" \
  -d '{"seed":"https://gwins.org/cn/milesguo/","limit":50,"crawlPages":10}'
```

也支持直接使用 sitemap 作为 seed（推荐全量发现）：

```bash
curl -X POST "http://127.0.0.1:8787/crawl/seed" \
  -H "content-type: application/json" \
  -d '{"seed":"https://gwins.org/googlemap_1.xml","limit":500}'
```

### 执行抓取与转换

```bash
curl -X POST "http://127.0.0.1:8787/crawl/run" \
  -H "content-type: application/json" \
  -d '{"max":10}'
```

### 拉取 Markdown

```bash
curl "http://127.0.0.1:8787/page?url=https://gwins.org/cn/milesguo/23874.html"
```

### 搜索

```bash
curl "http://127.0.0.1:8787/search?q=%E9%83%AD%E6%96%87%E8%B4%B5&limit=20"
```

## 数据表

- `pages`：URL、抓取状态、etag/last-modified、R2 key、错误信息。
- `chunks`：Markdown 切块明细。
- `chunks_fts`：FTS5 全文检索表。

## 可靠性策略

- 并发上限：3。
- 重试：最多 2 次（250ms、1000ms 指数退避）。
- 对 `429/503` 额外退避。
- 失败会写入 `pages.error` 且状态置为 `failed`，下次可重试。

## 说明

- R2 key 规范：`gwins/<pathname>.md`，例如 `gwins/cn/milesguo/23874.md`。
- 列表页发现支持分页（如 `list_2_*.html`），可通过 `crawlPages` 控制扫描页数上限。
- 增量抓取：请求时带 `If-None-Match` 与 `If-Modified-Since`，若 `304` 则仅更新时间戳。
