-- 0022 关系断言防重（实测走查发现）：
-- 事实型断言（不带修订限定）同（团队 + 关系类型 + 源 + 目标）只允许一条存活记录，
-- 重复确认只会产生平行重边与关系计数虚高。存量重复行撤回处理（保留审计痕迹，
-- withdrawn 在全部查询/图谱路径已被排除）；带修订限定的断言语义上可多条，不约束。
BEGIN;

-- 1) 清理存量：按去重键分组，保留最早一条，其余置为 withdrawn。
WITH ranked AS (
  SELECT team_id, id,
         ROW_NUMBER() OVER (
           PARTITION BY team_id, relation_type_version_id, source_asset_id, target_asset_id
           ORDER BY created_at ASC, id ASC
         ) AS rn
    FROM relation_assertions
   WHERE status <> 'withdrawn'
     AND source_revision_id IS NULL
     AND target_revision_id IS NULL
)
UPDATE relation_assertions ra
   SET status = 'withdrawn',
       withdrawn_reason = 'duplicate-assertion-cleanup (0022)：与更早的存活断言重复'
  FROM ranked r
 WHERE ra.team_id = r.team_id AND ra.id = r.id
   AND r.rn > 1;

-- 2) 部分唯一索引：仅约束不带修订限定的存活断言；并发竞态下兜底拒绝（23505）。
CREATE UNIQUE INDEX IF NOT EXISTS uq_rel_assert_unique_pair
  ON relation_assertions (team_id, relation_type_version_id, source_asset_id, target_asset_id)
  WHERE status <> 'withdrawn'
    AND source_revision_id IS NULL
    AND target_revision_id IS NULL;

COMMIT;
