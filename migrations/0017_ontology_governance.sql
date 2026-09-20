-- 0017 本体治理（吸收 semantica 的关系语义层）：
-- 1) 资产类型层次 parent_type_version_id（subClassOf 语义；显式版本引用，定义仍不可变）。
-- 2) 关系类型的类级 domain/range：source/target_type_keys（空数组 = 不限类型）。
--    kind 级（source_kinds/target_kinds）列已存在，本迁移补 NOT NULL 校验所需的取值约束。
-- 3) 活动流与审计查询索引。
BEGIN;

-- 类型层次：指向同团队另一类型版本；应用层保证无环 + 子定义是父定义的收窄。
ALTER TABLE asset_type_versions
  ADD COLUMN IF NOT EXISTS parent_type_version_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_type_parent'
  ) THEN
    ALTER TABLE asset_type_versions
      ADD CONSTRAINT fk_type_parent FOREIGN KEY (team_id, parent_type_version_id)
      REFERENCES asset_type_versions (team_id, id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_type_versions_parent ON asset_type_versions (team_id, parent_type_version_id);

-- 关系类型的类级 domain/range（引用资产类型的 type_key；空数组 = 任意类型）
ALTER TABLE relation_type_versions
  ADD COLUMN IF NOT EXISTS source_type_keys text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS target_type_keys text[] NOT NULL DEFAULT '{}';

-- 关系断言校验需要按类型键反查资产当前类型
CREATE INDEX IF NOT EXISTS idx_assets_type ON assets (team_id, current_type_version_id);

-- 活动流：按团队时间倒序取近况（audit_events 已有 idx_audit_team_time）
CREATE INDEX IF NOT EXISTS idx_agent_runs_team_time ON agent_runs (team_id, created_at DESC);

COMMIT;
