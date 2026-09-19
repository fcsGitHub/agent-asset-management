-- 0011: M4 — Agent 运行、持久事件、工具调用、预算。
-- 运行状态机：queued → running → completed / failed / cancelled / blocked / unknown_reconcile

CREATE TABLE agent_runs (
    team_id uuid NOT NULL,
    id uuid NOT NULL,
    session_id uuid NOT NULL,
    project_id uuid NOT NULL,
    status text NOT NULL DEFAULT 'queued'
      CHECK (status IN ('queued', 'running', 'waiting_user', 'completed', 'failed', 'cancelled', 'blocked', 'unknown_reconcile')),
    prompt text NOT NULL,
    context_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
    allowed_tools jsonb NOT NULL DEFAULT '[]'::jsonb,
    budget jsonb NOT NULL DEFAULT '{"maxToolCalls": 8, "maxTokens": 20000}'::jsonb,
    used jsonb NOT NULL DEFAULT '{"toolCalls": 0, "tokens": 0}'::jsonb,
    model_provider text NOT NULL DEFAULT 'deepseek',
    model_name text NOT NULL DEFAULT '',
    result text NOT NULL DEFAULT '',
    error text NOT NULL DEFAULT '',
    executor_id text NOT NULL DEFAULT '',       -- 执行进程标识（租约）
    lease_until timestamptz,
    cancel_requested boolean NOT NULL DEFAULT false,
    created_by uuid NOT NULL REFERENCES users(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (team_id, id),
    FOREIGN KEY (team_id, session_id) REFERENCES sessions(team_id, id)
);
CREATE INDEX idx_runs_session ON agent_runs(team_id, session_id);

-- 持久事件：SSE 可续接（seq 从 1 开始，落库后再发送）
CREATE TABLE run_events (
    seq bigserial PRIMARY KEY,
    team_id uuid NOT NULL,
    run_id uuid NOT NULL,
    type text NOT NULL,
    payload jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (team_id, run_id, seq)
);

CREATE TABLE tool_invocations (
    team_id uuid NOT NULL,
    id uuid NOT NULL,
    run_id uuid NOT NULL,
    call_id text NOT NULL,
    name text NOT NULL,
    args jsonb NOT NULL DEFAULT '{}'::jsonb,
    result jsonb,
    status text NOT NULL CHECK (status IN ('ok', 'denied', 'error')),
    error text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (team_id, id),
    FOREIGN KEY (team_id, run_id) REFERENCES agent_runs(team_id, id)
);
CREATE INDEX idx_tool_inv_run ON tool_invocations(team_id, run_id);

-- Agent 资产整理提案（成员审查后才落为正式草稿）
CREATE TABLE agent_proposals (
    team_id uuid NOT NULL,
    id uuid NOT NULL,
    run_id uuid NOT NULL,
    project_id uuid NOT NULL,
    kind text NOT NULL CHECK (kind IN ('asset_registration', 'issue_triage', 'relation_suggestion')),
    payload jsonb NOT NULL,
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected')),
    reviewed_by uuid REFERENCES users(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (team_id, id),
    FOREIGN KEY (team_id, run_id) REFERENCES agent_runs(team_id, id)
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['agent_runs', 'tool_invocations', 'agent_proposals']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      $f$
        CREATE POLICY tenant_isolation ON %I
          USING (team_id = NULLIF(current_setting('app.team_id', true), '')::uuid)
          WITH CHECK (team_id = NULLIF(current_setting('app.team_id', true), '')::uuid)
      $f$, t);
  END LOOP;
END$$;

ALTER TABLE run_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON run_events
  USING (team_id = NULLIF(current_setting('app.team_id', true), '')::uuid)
  WITH CHECK (team_id = NULLIF(current_setting('app.team_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE ON agent_runs TO taw_app;
GRANT SELECT, INSERT ON run_events TO taw_app;                 -- 事件只追加
GRANT SELECT, INSERT ON tool_invocations TO taw_app;           -- 调用记录只追加
GRANT SELECT, INSERT, UPDATE ON agent_proposals TO taw_app;
