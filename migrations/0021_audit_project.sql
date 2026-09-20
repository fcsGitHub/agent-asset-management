-- 0021 审计事件补项目维度：
-- 项目级动作（审核准备/发布/回滚）写入 project_id；团队级动作（资产归档/恢复等）保持 NULL。
-- 语义：按项目过滤活动流时只显示该项目内的动作，团队级动作仅在"全部"视图出现。
BEGIN;

ALTER TABLE audit_events ADD COLUMN IF NOT EXISTS project_id uuid;

CREATE INDEX IF NOT EXISTS idx_audit_team_project_time ON audit_events(team_id, project_id, created_at);

COMMIT;
