-- 0024 (M55) 使用度事件与资产别名
-- 调研吸收：npm/HF 使用度信号（下载/引用复制/Agent 读取计数，动态排序依据）；
-- MLflow alias 思想（稳定可变命名引用，下游消费升级不断链）。

-- 使用度事件：仅追加；聚合查询按 90 天窗口
CREATE TABLE usage_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    team_id uuid NOT NULL REFERENCES teams(id),
    asset_id uuid NOT NULL,
    kind text NOT NULL CHECK (kind IN ('download', 'copy_ref', 'agent_read')),
    actor_id uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_usage_events_asset ON usage_events(team_id, asset_id, created_at);

ALTER TABLE usage_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON usage_events
  USING (team_id = current_setting('app.team_id', true)::uuid)
  WITH CHECK (team_id = current_setting('app.team_id', true)::uuid);
GRANT SELECT, INSERT ON usage_events TO taw_app;

-- 资产别名：团队内唯一的小写 slug；解析端点 /assets/by-alias/:alias
CREATE TABLE asset_aliases (
    team_id uuid NOT NULL REFERENCES teams(id),
    alias text NOT NULL CHECK (alias ~ '^[a-z0-9][a-z0-9._@-]{1,63}$'),
    asset_id uuid NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (team_id, alias),
    FOREIGN KEY (team_id, asset_id) REFERENCES assets(team_id, id)
);
CREATE INDEX idx_asset_aliases_asset ON asset_aliases(team_id, asset_id);

ALTER TABLE asset_aliases ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON asset_aliases
  USING (team_id = current_setting('app.team_id', true)::uuid)
  WITH CHECK (team_id = current_setting('app.team_id', true)::uuid);
GRANT SELECT, INSERT, DELETE ON asset_aliases TO taw_app;
