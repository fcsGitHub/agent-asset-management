-- 0020 语义候选审核队列：
-- 候选从"抽完即丢"升级为跨会话的团队审核队列。抽取仍是纯分析（不落库），
-- 用户显式"入队"后候选持久化，任何团队成员都可映射端点并确认/忽略；
-- 确认经与服务端 POST /relations 完全相同的断言路径（domain/range + 成环禁止）。
BEGIN;

CREATE TABLE semantic_candidates (
    team_id uuid NOT NULL,
    id uuid NOT NULL PRIMARY KEY,
    asset_id uuid NOT NULL,                 -- 证据来源资产
    revision_id uuid,                       -- 证据来源修订（可空 = 抽取时 head）
    relation_type text NOT NULL,            -- 候选关系类型键（确认时解析到最新版本）
    source_text text NOT NULL,
    source_start integer NOT NULL DEFAULT 0,
    source_end integer NOT NULL DEFAULT 0,
    target_text text NOT NULL,
    target_start integer NOT NULL DEFAULT 0,
    target_end integer NOT NULL DEFAULT 0,
    evidence_segment text NOT NULL DEFAULT '',
    confidence numeric NOT NULL DEFAULT 0,
    llm_proposed boolean NOT NULL DEFAULT false,
    extractor_version text NOT NULL DEFAULT '',
    status text NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending', 'confirmed', 'dismissed')),
    created_by uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    decided_by uuid,
    decided_at timestamptz,
    resolved_relation_id uuid,
    FOREIGN KEY (team_id, asset_id) REFERENCES assets(team_id, id)
);

CREATE INDEX idx_semantic_candidates_team_status ON semantic_candidates(team_id, status, created_at);

ALTER TABLE semantic_candidates ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON semantic_candidates
  USING (team_id = NULLIF(current_setting('app.team_id', true), '')::uuid)
  WITH CHECK (team_id = NULLIF(current_setting('app.team_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE ON semantic_candidates TO taw_app;

COMMIT;
