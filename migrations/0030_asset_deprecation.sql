-- 0030 (M70) 资产弃用与继任（MLflow Model Registry Archived 阶段 / Docker Hub deprecated
-- images / HF deprecated models 锚点）：assets.lifecycle 的 'deprecated' 枚举自基线
-- （0002 CHECK 约束）起就存在，但一直没有治理出口——目录默认视图把它当 archived 一样
-- 悄悄过滤（CASE ELSE 'active'），Agent 检索硬编码 = 'active' 不可见，前端却备好了
-- 「已弃用」徽标。本迁移补弃用元数据列，让「标记弃用」成为可执行、可审计、可逆的
-- 管理动作；可见性语义在应用层修正（弃用 = 仍可见仍可取用但带警示 + 继任者指引；
-- 归档 = 隐藏 + 终态。两个状态分层，不再共用一条过滤路径）。

ALTER TABLE assets ADD COLUMN deprecated_at timestamptz NULL;
ALTER TABLE assets ADD COLUMN deprecated_by uuid NULL REFERENCES users(id);
ALTER TABLE assets ADD COLUMN deprecation_note text NULL;
ALTER TABLE assets ADD COLUMN successor_asset_id uuid NULL;
-- 继任者指向同团队资产（复合 FK 保证不跨租户）；资产本身不可删除（不可变修订，
-- 归档不删行），ON DELETE SET NULL 仅为 FK 完整性兜底
ALTER TABLE assets
  ADD CONSTRAINT fk_assets_successor
  FOREIGN KEY (team_id, successor_asset_id) REFERENCES assets(team_id, id) ON DELETE SET NULL;

CREATE INDEX idx_assets_successor ON assets(team_id, successor_asset_id) WHERE successor_asset_id IS NOT NULL;
