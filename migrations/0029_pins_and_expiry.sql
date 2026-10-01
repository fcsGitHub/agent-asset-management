-- 0029 (M69) 个人收藏 pin + 分享快照有效期
-- ①user_asset_pins（GitHub stars 锚点）：高频取用资产一键可达；团队内按用户
--   隔离（PK(team,user,asset)）；pin 是个人便利不是治理——不进审计/动态。
-- ②asset_collection_snapshots.expires_at（GitHub PAT 过期锚点）：创建时可选，
--   公开端点读时比对（<= now() → 410 SHARE_EXPIRED）；只需 INSERT 写入，
--   不新增 UPDATE 通道；不加定时清理（需调度基建，与已退役项同口径）。

CREATE TABLE user_asset_pins (
    team_id uuid NOT NULL REFERENCES teams(id),
    user_id uuid NOT NULL,
    asset_id uuid NOT NULL,
    pinned_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (team_id, user_id, asset_id),
    FOREIGN KEY (team_id, asset_id) REFERENCES assets(team_id, id) ON DELETE CASCADE
);
CREATE INDEX idx_user_asset_pins_asset ON user_asset_pins(team_id, asset_id);

ALTER TABLE user_asset_pins ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON user_asset_pins
  USING (team_id = NULLIF(current_setting('app.team_id', true), '')::uuid)
  WITH CHECK (team_id = NULLIF(current_setting('app.team_id', true), '')::uuid);
GRANT SELECT, INSERT, DELETE ON user_asset_pins TO taw_app;

ALTER TABLE asset_collection_snapshots ADD COLUMN expires_at timestamptz NULL;
