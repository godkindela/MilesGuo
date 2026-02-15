# 开发规范（MilesGuo / gwins-md）

## 1. 目标与范围
- 本规范适用于 `Cloudflare Worker + Workers AI + R2 + D1` 项目。
- 目标是保证抓取、转 Markdown、存储、检索链路稳定、可维护、可审计。

## 2. 代码组织
- 入口文件：`src/index.ts`，仅负责路由与请求编排。
- 业务逻辑：
  - `src/crawl.ts`：抓取、重试、并发、转换流程。
  - `src/extract.ts`：链接提取、标题提取、R2 Key 生成。
  - `src/storage.ts`：D1/R2 读写与搜索。
- Schema：`src/schema.sql`，任何 D1 表结构变更必须同步更新。
- 文档：放在 `Docs/`，对外说明放在 `README.md`。

## 3. API 设计规范
- 所有 JSON API 统一返回：
  - `ok`（布尔）
  - 成功数据字段（如 `stats` / `hits`）
  - 失败时 `error`（字符串）
- 必须明确 HTTP 状态码：
  - `200` 成功
  - `400` 参数错误
  - `404` 资源不存在
  - `500` 服务内部错误
- 路由变更需更新 `README.md` 示例 `curl`。

## 4. 抓取与转换规范
- 默认 UA：`Mozilla/5.0 (compatible; MarkdownBot/1.0)`。
- 并发上限：3，禁止无上限并发。
- 重试策略：最多 2 次，指数退避（250ms、1000ms），`429/503` 额外退避。
- 增量抓取必须带 `If-None-Match` / `If-Modified-Since`。
- `304` 时禁止重复转换与写入。
- `200` 时需比对 Markdown 内容哈希，未变化仅更新抓取元数据。

## 5. 存储规范
- R2 Key 统一规则：`gwins/<pathname>.md`。
- R2 对象写入必须设置：`contentType = text/markdown; charset=utf-8`。
- D1 `pages` 为状态源，`chunks` 为分块存储，`chunks_fts` 为全文检索。
- 写入新分块前必须删除旧分块，避免脏索引。

## 6. 错误处理与可观测性
- 所有失败场景必须落库到 `pages.error`，状态置为 `failed`。
- 禁止吞异常；错误需保留核心上下文（URL、阶段、状态码）。
- 对外返回错误时不得暴露敏感凭据。

## 7. 数据库变更规范
- 结构变更必须通过 `src/schema.sql` 提交。
- 每次变更需补充迁移说明（在 `README.md` 或 `Docs/`）。
- 查询语句优先使用参数绑定，禁止字符串拼接 SQL。

## 8. 代码风格与质量
- TypeScript `strict` 保持开启。
- 函数职责单一，避免在路由层堆积业务逻辑。
- 公共工具函数放入对应模块，不做重复实现。
- 注释只写关键决策与边界条件，不写无意义注释。

## 9. 测试与验收
- 提交前最低要求：`npm run typecheck` 通过。
- 功能回归最小集合：
  - `/health`
  - `/crawl/seed`
  - `/crawl/run`
  - `/search`
  - `/page`
- `scheduled` 变更后需执行 `wrangler dev --test-scheduled` 验证。

## 10. 部署规范
- 部署前必须确认：
  - `wrangler whoami` 已登录正确账号。
  - `wrangler.toml` 中 D1/R2/AI 绑定正确。
  - D1 schema 已执行到目标环境（`--remote`）。
- 发布命令统一：`npm run deploy`。

## 11. 安全与合规
- 遵守目标站点 robots、服务条款与抓取频率限制。
- 不抓取与业务无关的敏感页面。
- 不在日志、代码、文档中提交密钥与 token。

## 12. 文档维护
- 每次新增接口、配置项、表字段时，必须同步更新：
  - `README.md`
  - `Docs/development-guidelines.md`（如规范本身变化）
- 文档变更和代码变更尽量同一提交，防止规范过期。
