# 备份与恢复手册

适用版本：迁移 0001–0013。演练脚本 `scripts/e2e-m5-restore.ts` 每一步都对应本手册，
最近一次真实演练报告见 `docs/evidence/m5-restore-report.json`。

## 备份什么

| 内容 | 方式 | 说明 |
| --- | --- | --- |
| 数据库（业务数据/审计/运行状态/outbox） | `pg_dump -U taw_admin -d taw` 逻辑备份 | 覆盖全部权威事实 |
| 文件内容库 | 复制 `$BLOBSTORE_ROOT`（默认 `./data/blobs`）目录 | `<teamId>/<sha256>` 结构，只增不改 |
| 配置与密钥 | `.env` 单独保管 | 不入 dump、不入库；丢失需轮换 |

只有 SQL dump 没有文件目录不算完整备份；两者必须同批次。

## 恢复顺序（必须遵守）

1. 启动全新 PostgreSQL 实例（例：`docker run ... -p 127.0.0.1:5438:5432 pgvector/pgvector:pg16`）。
2. **先重建角色**（角色是集群级对象，不在数据库 dump 内）：
   ```sql
   CREATE ROLE taw_app LOGIN PASSWORD '<强口令>' NOSUPERUSER NOCREATEDB NOCREATEROLE;
   GRANT USAGE ON SCHEMA public TO taw_app;
   ```
   若先导 dump 后建角色，dump 内的 GRANT 语句会失败，应用角色将无任何表权限。
3. 导入 dump：`psql -U taw_admin -d taw < dump.sql`。
4. 将 `$BLOBSTORE_ROOT` 指向同批次的文件目录副本。
5. 以**应用角色**连接串启动 API：`DATABASE_URL=postgres://taw_app:<口令>@<host>:5438/taw`。
   管理角色连接只用于 psql 导入；应用永远走 `taw_app`（受限、受 RLS）。
6. 按下节核对。

## 恢复后核对清单

- 登录可用；备份前的**已撤销会话**仍然 401（撤销状态随库恢复）。
- 打开旧项目基线与资产；抽查修订 `content_digest`（64 位十六进制）。
- 下载备份批次内的制品，`sha256(文件) == 数据库 digest`。
- `outbox` 表：事件行数与备份时一致（不重复投递；待投递事件由 worker 幂等消费）。
- 备份后数据库迁移若比 dump 新：`npx tsx scripts/migrate.ts --role=admin` 补齐增量。

## 已知边界

- dump 不含集群级对象（角色/口令）——见恢复顺序第 2 步。
- 文件目录与 dump 非同一时刻的快照会有少量"新文件、旧索引"差集；内容寻址设计下
  这些对象只是暂无引用，不会污染正确性，可稍后重新备份。
- 恢复不重放外部副作用（通知/Git 同步等）：对应 outbox 事件由消费方幂等语义兜底。
