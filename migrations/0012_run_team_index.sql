-- 0012: 运行恢复索引（无 RLS；仅服务端写，崩溃恢复时定位 run 的 team）。
-- 说明：agent_runs 受 RLS，崩溃后执行器已无会话上下文；
-- run_team_index 是刻意收窄的恢复路径：只含 (run_id, team_id)，不承载业务数据。

CREATE TABLE run_team_index (
    run_id uuid PRIMARY KEY,
    team_id uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT ON run_team_index TO taw_app;
