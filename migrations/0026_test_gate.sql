-- 0026 (M58) 发布测试门禁
-- 调研吸收：GitHub Required Status Checks——策略声明在仓库（类型）层而非 PR 层；
-- 必需 check 未运行即阻断；strict 模式下过时状态不放过。
-- 落地：类型定义版本携带 requires_test_evidence——"部分模型需要过测试才可发布"
-- 由类型声明（门禁策略随类型版本不可变，改门禁=注册新版本，与 schema 演进同构）。

ALTER TABLE asset_type_versions
  ADD COLUMN requires_test_evidence boolean NOT NULL DEFAULT false;

-- 发布端按 (team, target_asset, target_revision) 取最新一次运行判 pass：
-- prepare 之后新落的 fail/error 会使门禁状态翻转 → 快照摘要失配（B04 同机制）。
CREATE INDEX idx_test_runs_target_latest
  ON test_runs(team_id, target_asset_id, target_revision_id, executed_at DESC);
