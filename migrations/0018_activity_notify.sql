-- 0018 活动流实时推送：
-- audit_events / agent_runs 落库即 pg_notify（NOTIFY 在事务提交时才投递——
-- 只有真正提交的事件会被推送，回滚不会产生幻影事件）。
-- API 进程用单例 LISTEN 连接订阅 taw_activity 通道，按 team_id 扇出给 SSE 订阅者；
-- 通知只携带 kind/team_id/id，事件正文由 SSE 处理器按同一查询实时取（与 GET /activity 同源）。
BEGIN;

CREATE OR REPLACE FUNCTION taw_notify_activity() RETURNS trigger AS $$
BEGIN
  -- id 统一转 text：audit_events.id 为 bigserial，JSON 数字在 JS 端超过 2^53 会失真
  PERFORM pg_notify('taw_activity', json_build_object(
    'kind', TG_ARGV[0],
    'team_id', NEW.team_id,
    'id', NEW.id::text
  )::text);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_audit_notify ON audit_events;
CREATE TRIGGER trg_audit_notify AFTER INSERT ON audit_events
  FOR EACH ROW EXECUTE FUNCTION taw_notify_activity('audit');

-- agent_runs：INSERT（新运行出现）与 status 更新（运行态变化）都推送，界面按运行 id 去重覆盖
DROP TRIGGER IF EXISTS trg_agent_run_notify ON agent_runs;
CREATE TRIGGER trg_agent_run_notify AFTER INSERT OR UPDATE OF status ON agent_runs
  FOR EACH ROW EXECUTE FUNCTION taw_notify_activity('agent');

COMMIT;
