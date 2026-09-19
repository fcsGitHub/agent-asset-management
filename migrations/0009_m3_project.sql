-- 0009: M3 — 需求（不可变修订+基线）、工作项、测试运行、验收记录、阶段门。
-- 测试定义复用资产体系（test.suite 类型资产），运行记录绑定精确修订。

CREATE TABLE requirements (
    team_id uuid NOT NULL,
    id uuid NOT NULL,
    project_id uuid NOT NULL,
    req_key text NOT NULL,               -- 如 R-12
    title text NOT NULL,
    status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'baselined', 'implemented', 'verified', 'accepted', 'dropped')),
    priority text NOT NULL DEFAULT 'should' CHECK (priority IN ('must', 'should', 'could')),
    is_key boolean NOT NULL DEFAULT true,  -- 关键需求：未验证阻止验收
    created_by uuid NOT NULL REFERENCES users(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (team_id, id),
    UNIQUE (team_id, project_id, req_key),
    FOREIGN KEY (team_id, project_id) REFERENCES projects(team_id, id)
);

CREATE TABLE requirement_revisions (
    team_id uuid NOT NULL,
    id uuid NOT NULL,
    requirement_id uuid NOT NULL,
    seq integer NOT NULL,
    content jsonb NOT NULL CHECK (jsonb_typeof(content) = 'object'),
    content_digest text NOT NULL CHECK (content_digest ~ '^[0-9a-f]{64}$'),
    created_by uuid NOT NULL REFERENCES users(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (team_id, id),
    UNIQUE (team_id, requirement_id, seq)
);

CREATE TABLE requirement_baselines (
    team_id uuid NOT NULL,
    id uuid NOT NULL,
    project_id uuid NOT NULL,
    name text NOT NULL,
    created_by uuid NOT NULL REFERENCES users(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (team_id, id),
    FOREIGN KEY (team_id, project_id) REFERENCES projects(team_id, id)
);

CREATE TABLE requirement_baseline_items (
    team_id uuid NOT NULL,
    baseline_id uuid NOT NULL,
    requirement_id uuid NOT NULL,
    revision_id uuid NOT NULL,
    PRIMARY KEY (team_id, baseline_id, requirement_id),
    FOREIGN KEY (team_id, baseline_id) REFERENCES requirement_baselines(team_id, id),
    FOREIGN KEY (team_id, revision_id) REFERENCES requirement_revisions(team_id, id)
);

CREATE TABLE work_items (
    team_id uuid NOT NULL,
    id uuid NOT NULL,
    project_id uuid NOT NULL,
    title text NOT NULL,
    assignee_id uuid REFERENCES users(id),
    status text NOT NULL DEFAULT 'todo'
      CHECK (status IN ('todo', 'ready', 'in_progress', 'in_review', 'blocked', 'done', 'cancelled')),
    priority integer NOT NULL DEFAULT 2,
    blocked_reason text NOT NULL DEFAULT '',
    completion_evidence text NOT NULL DEFAULT '',   -- 完成所需证据说明
    created_by uuid NOT NULL REFERENCES users(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (team_id, id),
    FOREIGN KEY (team_id, project_id) REFERENCES projects(team_id, id)
);

-- 任务↔需求（范围说明）与 任务↔任务 依赖
CREATE TABLE work_item_req_links (
    team_id uuid NOT NULL,
    work_item_id uuid NOT NULL,
    requirement_id uuid NOT NULL,
    requirement_revision_id uuid NOT NULL,
    coverage text NOT NULL DEFAULT 'partial' CHECK (coverage IN ('full', 'partial')),
    PRIMARY KEY (team_id, work_item_id, requirement_id),
    FOREIGN KEY (team_id, work_item_id) REFERENCES work_items(team_id, id),
    FOREIGN KEY (team_id, requirement_revision_id) REFERENCES requirement_revisions(team_id, id)
);

CREATE TABLE work_item_deps (
    team_id uuid NOT NULL,
    work_item_id uuid NOT NULL,
    depends_on_id uuid NOT NULL,
    PRIMARY KEY (team_id, work_item_id, depends_on_id),
    CHECK (work_item_id <> depends_on_id),
    FOREIGN KEY (team_id, work_item_id) REFERENCES work_items(team_id, id),
    FOREIGN KEY (team_id, depends_on_id) REFERENCES work_items(team_id, id)
);

CREATE TABLE test_runs (
    team_id uuid NOT NULL,
    id uuid NOT NULL,
    project_id uuid NOT NULL,
    test_asset_id uuid NOT NULL,
    test_revision_id uuid NOT NULL,       -- 测试定义版本
    target_asset_id uuid NOT NULL,
    target_revision_id uuid NOT NULL,     -- 被测对象精确修订
    target_content_digest text NOT NULL,  -- 冗余存储被测摘要：证据只对它有效
    config jsonb NOT NULL DEFAULT '{}'::jsonb,
    environment text NOT NULL DEFAULT '',
    result text NOT NULL CHECK (result IN ('pass', 'fail', 'error', 'skipped')),
    summary text NOT NULL DEFAULT '',
    log_excerpt text NOT NULL DEFAULT '',
    executed_by uuid NOT NULL REFERENCES users(id),
    executed_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (team_id, id),
    FOREIGN KEY (team_id, target_asset_id, target_revision_id) REFERENCES asset_revisions(team_id, asset_id, id)
);

CREATE TABLE acceptance_records (
    team_id uuid NOT NULL,
    id uuid NOT NULL,
    project_id uuid NOT NULL,
    requirement_id uuid NOT NULL,
    requirement_revision_id uuid NOT NULL,
    verdict text NOT NULL CHECK (verdict IN ('pass', 'blocked', 'waived')),
    evidence_run_id uuid,
    reason text NOT NULL DEFAULT '',
    waiver_approver_id uuid,
    waiver_expires_at timestamptz,
    decided_by uuid NOT NULL REFERENCES users(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (team_id, id),
    FOREIGN KEY (team_id, requirement_revision_id) REFERENCES requirement_revisions(team_id, id)
);

CREATE TABLE gate_reviews (
    team_id uuid NOT NULL,
    id uuid NOT NULL,
    project_id uuid NOT NULL,
    gate text NOT NULL CHECK (gate IN ('requirements_intake', 'requirements_baseline', 'design',
                                        'dev_integration', 'test_verify', 'accept_release', 'closure')),
    verdict text NOT NULL CHECK (verdict IN ('pass', 'blocked')),
    blockers jsonb NOT NULL DEFAULT '[]'::jsonb,
    scope jsonb NOT NULL DEFAULT '{}'::jsonb,
    decided_by uuid NOT NULL REFERENCES users(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (team_id, id),
    FOREIGN KEY (team_id, project_id) REFERENCES projects(team_id, id)
);

-- RLS
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'requirements','requirement_revisions','requirement_baselines',
    'requirement_baseline_items','work_items','work_item_req_links',
    'work_item_deps','test_runs','acceptance_records','gate_reviews'
  ]
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

GRANT SELECT, INSERT, UPDATE, DELETE ON requirements, work_items, work_item_req_links, work_item_deps TO taw_app;
GRANT SELECT, INSERT ON requirement_revisions TO taw_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON requirement_baselines, requirement_baseline_items TO taw_app;
GRANT SELECT, INSERT ON test_runs TO taw_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON acceptance_records TO taw_app;
GRANT SELECT, INSERT ON gate_reviews TO taw_app;
