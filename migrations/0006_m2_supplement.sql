-- 0006: M2 补充 — 幂等键表；release_sets 允许回退集不带 CR/快照。

ALTER TABLE release_sets ALTER COLUMN change_request_id DROP NOT NULL;
ALTER TABLE release_sets ALTER COLUMN review_snapshot_id DROP NOT NULL;

CREATE TABLE idempotency_keys (
    team_id uuid NOT NULL,
    actor_id uuid NOT NULL,
    scope text NOT NULL,
    key text NOT NULL,
    response_code integer NOT NULL,
    response_body text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (team_id, actor_id, scope, key)
);
-- 说明：幂等表由服务端以复合键 (team, actor, scope, key) 受控写入，
-- 读写发生在租户事务之外（q()），因此不启用 RLS；无任意客户端输入参与键构造。

GRANT SELECT, INSERT ON idempotency_keys TO taw_app;
