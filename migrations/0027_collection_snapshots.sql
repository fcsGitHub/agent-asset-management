-- 0027 (M67⑤) 集合只读分享快照（Zenodo/HF snapshot 冻结语义）
-- POST /collections/:id/snapshots 把集合当前内容深拷贝冻结 + 签发 128-bit token；
-- GET /share/collections/:token 免登录只读。RLS 双策略：
--   tenant_isolation —— 写侧（创建/团队内列出）照旧走 app.team_id；
--   public_share_read —— 仅当事务内 SET LOCAL app.share_read = 'on' 才可 SELECT，
--   该 GUC 只有分享查看这一个代码路径设置，其余端点跨团队照常不可见。
-- 快照不可变：不授权 UPDATE/DELETE；不设集合 FK——集合删除后快照保留（冻结语义，
-- 名称/描述/条目均已深拷贝，不依赖原集合存在）。

CREATE TABLE asset_collection_snapshots (
    team_id uuid NOT NULL REFERENCES teams(id),
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    collection_id uuid NOT NULL,
    token text NOT NULL,
    collection_name text NOT NULL,
    description text NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    payload jsonb NOT NULL,
    PRIMARY KEY (team_id, id),
    UNIQUE (token)
);
CREATE INDEX idx_collection_snapshots_collection ON asset_collection_snapshots(team_id, collection_id, created_at DESC);

ALTER TABLE asset_collection_snapshots ENABLE ROW LEVEL SECURITY;
-- NULLIF 包裹（同 0004 口径）：连接复用时事务结束后 app.team_id 回退为空串而非
-- NULL，直接 ::uuid 会抛 22P02；空串按"未设置"处理 → 租户策略拒绝。
CREATE POLICY tenant_isolation ON asset_collection_snapshots
  USING (team_id = NULLIF(current_setting('app.team_id', true), '')::uuid)
  WITH CHECK (team_id = NULLIF(current_setting('app.team_id', true), '')::uuid);
CREATE POLICY public_share_read ON asset_collection_snapshots
  FOR SELECT
  USING (current_setting('app.share_read', true) = 'on');
GRANT SELECT, INSERT ON asset_collection_snapshots TO taw_app;
