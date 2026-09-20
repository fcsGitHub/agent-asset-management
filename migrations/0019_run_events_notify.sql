-- 0019 运行事件流实时推送（迁移 M11 的活动流同款机制，替代 SSE 400ms 轮询）：
-- run_events 插入与 agent_runs 状态变化在事务提交时 pg_notify('taw_run')。
-- API 的 activityHub 单例 LISTEN 连接收到通知后按 team_id/run_id 扇出给
-- /runs/:id/events 的 SSE 订阅者；事件正文由订阅连接按 seq 游标实时取（可续传）。
-- 约定（应用层 runner 保证）：终态路径先写 run_events 再更新 agent_runs 状态——
-- 因此「终态状态通知」到达时，该运行的全部事件通知必然已先投递，done 不会早到。
BEGIN;

CREATE OR REPLACE FUNCTION taw_notify_run() RETURNS trigger AS $$
BEGIN
  IF TG_TABLE_NAME = 'run_events' THEN
    -- seq 转 text：bigserial 在 JS 端超过 2^53 会失真
    PERFORM pg_notify('taw_run', json_build_object(
      'type', 'event', 'team_id', NEW.team_id, 'run_id', NEW.run_id, 'seq', NEW.seq::text
    )::text);
  ELSE
    PERFORM pg_notify('taw_run', json_build_object(
      'type', 'status', 'team_id', NEW.team_id, 'run_id', NEW.id::text
    )::text);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_run_events_notify ON run_events;
CREATE TRIGGER trg_run_events_notify AFTER INSERT ON run_events
  FOR EACH ROW EXECUTE FUNCTION taw_notify_run();

DROP TRIGGER IF EXISTS trg_agent_run_status_run_notify ON agent_runs;
CREATE TRIGGER trg_agent_run_status_run_notify AFTER INSERT OR UPDATE OF status ON agent_runs
  FOR EACH ROW EXECUTE FUNCTION taw_notify_run();

COMMIT;
