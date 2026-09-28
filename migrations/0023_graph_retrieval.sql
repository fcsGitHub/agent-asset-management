-- 0023 图数据库本体检索层（M49）：
-- PostgreSQL 是唯一事实源；图库（Memgraph，Bolt）只保存可再生投影——
-- 类型层次（subClassOf）、资产（OF_TYPE）、存活关系断言（RELATES）。
-- 本迁移只加两样东西：
--   1) graph_sync_state：投影状态表。API 写路径在业务事务内盖「脏标记」
--      （marked_at），worker 轮询脏团队做幂等全量重建并回写 last_synced_at；
--      status 端点据此如实暴露同步滞后与漂移，管理员可手动触发同步。
--   2) taw_worker 的跨租户读授权：投影需要读五张源表。RLS 的 tenant_isolation
--      策略依赖 app.team_id 上下文（worker 没有），补独立放行策略——
--      沿用 0016 对 outbox 的先例。

BEGIN;

CREATE TABLE IF NOT EXISTS graph_sync_state (
  team_id uuid PRIMARY KEY REFERENCES teams(id),
  marked_at timestamptz NOT NULL DEFAULT now(),
  last_synced_at timestamptz,
  node_count integer,
  edge_count integer,
  last_error text,
  last_error_at timestamptz
);

ALTER TABLE graph_sync_state ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON graph_sync_state;
CREATE POLICY tenant_isolation ON graph_sync_state
  USING (team_id = NULLIF(current_setting('app.team_id', true), '')::uuid)
  WITH CHECK (team_id = NULLIF(current_setting('app.team_id', true), '')::uuid);

DROP POLICY IF EXISTS graph_sync_worker_all ON graph_sync_state;
CREATE POLICY graph_sync_worker_all ON graph_sync_state FOR ALL TO taw_worker USING (true);

GRANT SELECT, INSERT, UPDATE ON graph_sync_state TO taw_app;
GRANT SELECT, INSERT, UPDATE ON graph_sync_state TO taw_worker;

-- worker 投影所需跨租户读（只放行五张源表，均带 team_id 谓词查询）
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'entities','assets','asset_type_versions','relation_type_versions','relation_assertions'
  ]
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS graph_worker_read ON %I', t);
    EXECUTE format('CREATE POLICY graph_worker_read ON %I FOR SELECT TO taw_worker USING (true)', t);
    EXECUTE format('GRANT SELECT ON %I TO taw_worker', t);
  END LOOP;
END$$;

COMMIT;
