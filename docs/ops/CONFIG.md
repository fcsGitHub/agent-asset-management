# 配置说明

所有配置通过环境变量（`.env`，已在 .gitignore）。无配置中心、无运行时改配置入口。

## 必需

| 变量 | 说明 | 开发默认 |
| --- | --- | --- |
| `DATABASE_URL` | 应用角色（taw_app）连接串，受 RLS | `postgres://taw_app:taw_app_dev@127.0.0.1:5437/taw` |
| `DATABASE_ADMIN_URL` | 管理角色连接串，仅迁移/恢复脚本使用 | `postgres://taw_admin:taw_admin_dev@127.0.0.1:5437/taw` |
| `SESSION_SECRET` | 会话签名密钥（预留）；生产必须更换 | `dev-only-change-me` |

## 服务端口

| 变量 | 默认 |
| --- | --- |
| `API_PORT` | 4000 |
| `WEB_PORT` | 5175 |
| `SEMANTIC_WORKER_PORT` | 8100 |

## 存储

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `BLOBSTORE_ROOT` | `./data/blobs` | 内容寻址库根目录（`<teamId>/<sha256>`）。可指向 S3 挂载点；接口见 packages/storage |

## LLM（可选；不配置时 Agent 功能明确拒绝，其余功能不受影响）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `DEEPSEEK_API_KEY` | — | DeepSeek 官方 key；仅服务端读取，不进前端/Prompt/日志 |
| `DEEPSEEK_BASE_URL` | `https://api.deepseek.com` | OpenAI 兼容端点 |
| `DEEPSEEK_MODEL` | `deepseek-chat` | 官方映射为 deepseek-flash |

## 语义 worker（可选）

| 变量 | 默认 |
| --- | --- |
| `SEMANTIC_WORKER_URL` | `http://127.0.0.1:8100`（每请求读取，可热切换做降级测试） |

## 图数据库（可选，M49 本体检索投影）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `GRAPHDB_URL` | `bolt://127.0.0.1:7687` | Memgraph（Bolt）连接串；`docker compose up -d graphdb` 启动 |
| `GRAPH_RECONCILE_MS` | `5000` | worker 图投影对账周期（毫秒，≥1000） |

图库是 PostgreSQL 的可再生投影（类型层次 / 资产 / 存活关系），不挂数据卷——
丢失或漂移由 worker 对账重建。图库不启动时：类闭包/按类检索自动回落 SQL
（响应 `engine=sql-fallback` 如实标注），多跳邻域与路径端点返回 503
`DEPENDENCY_UNAVAILABLE`，其余功能不受影响。

## 生产注意

- 更换 `taw_app` / `taw_admin` 口令（口令在 migrations/0002 中为开发默认值，生产环境
  应创建角色后修改口令并同步 `.env`）。
- 会话 Cookie：生产（NODE_ENV=production）自动追加 `Secure`；SameSite=Lax + CSRF 双提交已启用。
- 上传大小限制 200MB（apps/api/src/routes/uploads.ts 常量），按需调整。
- 不要把数据库管理角色连接串配置给应用；应用必须以 `taw_app` 运行。
