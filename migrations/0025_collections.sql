-- 0025 (M56) 资产集合（人工策展）
-- 调研吸收：HF Datasets Collections 思想——跨类型人工策展集合 + 条目备注，
-- 服务「权威榜单 / 新人入门包 / 评审材料包」等随取随用场景；与自动检索互补。

-- 集合：团队内名称唯一（Agent/NL 可按名解析）；管理权=创建者或管理员，条目=全员协作
CREATE TABLE asset_collections (
    team_id uuid NOT NULL REFERENCES teams(id),
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    name text NOT NULL,
    description text NOT NULL DEFAULT '',
    created_by uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (team_id, id),
    UNIQUE (team_id, name)
);
CREATE INDEX idx_asset_collections_team ON asset_collections(team_id, created_at);

ALTER TABLE asset_collections ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON asset_collections
  USING (team_id = current_setting('app.team_id', true)::uuid)
  WITH CHECK (team_id = current_setting('app.team_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON asset_collections TO taw_app;

-- 集合条目：跨类型资产 + 每条备注；同一资产同一集合内唯一
CREATE TABLE asset_collection_items (
    team_id uuid NOT NULL REFERENCES teams(id),
    collection_id uuid NOT NULL,
    asset_id uuid NOT NULL,
    note text NOT NULL DEFAULT '',
    added_by uuid NOT NULL,
    added_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (team_id, collection_id, asset_id),
    FOREIGN KEY (team_id, collection_id) REFERENCES asset_collections(team_id, id) ON DELETE CASCADE,
    FOREIGN KEY (team_id, asset_id) REFERENCES assets(team_id, id)
);
CREATE INDEX idx_collection_items_asset ON asset_collection_items(team_id, asset_id);

ALTER TABLE asset_collection_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON asset_collection_items
  USING (team_id = current_setting('app.team_id', true)::uuid)
  WITH CHECK (team_id = current_setting('app.team_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON asset_collection_items TO taw_app;
