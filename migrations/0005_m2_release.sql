-- 0005: M2 核心 — 分支、变更请求、审核快照、发布集、通道、Issue/评论、
-- 项目精确绑定、outbox、审计。
-- 设计基线：team_asset_design.html 第 12/13/21 章。

-- 复合外键所需的修订唯一约束（team, asset, revision）
ALTER TABLE asset_revisions ADD CONSTRAINT uq_revisions_team_asset_rev UNIQUE (team_id, asset_id, id);

-- ============ 分支（属于项目；main 为正式发布视图，受保护） ============
CREATE TABLE branches (
    team_id uuid NOT NULL,
    id uuid NOT NULL,
    project_id uuid NOT NULL,
    name text NOT NULL,
    status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'merged', 'abandoned')),
    created_by uuid NOT NULL REFERENCES users(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (team_id, id),
    FOREIGN KEY (team_id, project_id) REFERENCES projects(team_id, id),
    UNIQUE (team_id, project_id, name)
);

-- 仅记录被修改资产的 基线修订 → 分支头修订；未修改内容经基线解析（设计 12 章）。
CREATE TABLE branch_entries (
    team_id uuid NOT NULL,
    branch_id uuid NOT NULL,
    asset_id uuid NOT NULL,
    base_revision_id uuid NOT NULL,
    head_revision_id uuid NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (team_id, branch_id, asset_id),
    FOREIGN KEY (team_id, branch_id) REFERENCES branches(team_id, id),
    FOREIGN KEY (team_id, base_revision_id) REFERENCES asset_revisions(team_id, id),
    FOREIGN KEY (team_id, head_revision_id) REFERENCES asset_revisions(team_id, id)
);

-- ============ Issue 与评论 ============
CREATE TABLE issues (
    team_id uuid NOT NULL,
    id uuid NOT NULL,
    project_id uuid NOT NULL,
    asset_id uuid,
    reported_revision_id uuid,       -- Issue 锁定报告所针对的版本
    title text NOT NULL,
    body text NOT NULL DEFAULT '',
    status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'resolved', 'closed')),
    created_by uuid NOT NULL REFERENCES users(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (team_id, id),
    FOREIGN KEY (team_id, project_id) REFERENCES projects(team_id, id)
);

CREATE TABLE comments (
    team_id uuid NOT NULL,
    id uuid NOT NULL,
    target_kind text NOT NULL CHECK (target_kind IN ('issue', 'change_request')),
    target_id uuid NOT NULL,
    author_id uuid NOT NULL REFERENCES users(id),
    content text NOT NULL,
    edited_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (team_id, id)
);

-- ============ 变更请求（PR） ============
CREATE TABLE change_requests (
    team_id uuid NOT NULL,
    id uuid NOT NULL,
    project_id uuid NOT NULL,
    branch_id uuid NOT NULL,
    title text NOT NULL,
    motivation text NOT NULL,
    related_refs text NOT NULL DEFAULT '',      -- 关联 Issue/任务
    change_summary text NOT NULL DEFAULT '',
    compatibility text NOT NULL DEFAULT '',
    test_plan text NOT NULL DEFAULT '',
    migration_notes text NOT NULL DEFAULT '',
    rollback_notes text NOT NULL DEFAULT '',
    status text NOT NULL DEFAULT 'draft'
      CHECK (status IN ('draft', 'open', 'awaiting_review', 'changes_requested', 'merged', 'withdrawn')),
    created_by uuid NOT NULL REFERENCES users(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (team_id, id),
    FOREIGN KEY (team_id, project_id) REFERENCES projects(team_id, id),
    FOREIGN KEY (team_id, branch_id) REFERENCES branches(team_id, id)
);

CREATE TABLE change_request_items (
    team_id uuid NOT NULL,
    change_request_id uuid NOT NULL,
    asset_id uuid NOT NULL,
    base_revision_id uuid NOT NULL,
    candidate_revision_id uuid NOT NULL,
    PRIMARY KEY (team_id, change_request_id, asset_id),
    FOREIGN KEY (team_id, change_request_id) REFERENCES change_requests(team_id, id),
    FOREIGN KEY (team_id, candidate_revision_id) REFERENCES asset_revisions(team_id, id)
);

-- 审核快照：提交后不可变；candidate/review 摘要绑定内容与条件（设计 13 章）
CREATE TABLE review_snapshots (
    team_id uuid NOT NULL,
    id uuid NOT NULL,
    change_request_id uuid NOT NULL,
    candidate_digest text NOT NULL CHECK (candidate_digest ~ '^[0-9a-f]{64}$'),
    review_digest text NOT NULL CHECK (review_digest ~ '^[0-9a-f]{64}$'),
    payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
    policy_version text NOT NULL,
    channel text NOT NULL DEFAULT 'stable' CHECK (channel IN ('stable', 'preview')),
    superseded boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (team_id, id),
    FOREIGN KEY (team_id, change_request_id) REFERENCES change_requests(team_id, id)
);

CREATE TABLE approvals (
    team_id uuid NOT NULL,
    id uuid NOT NULL,
    review_snapshot_id uuid NOT NULL,
    approver_id uuid NOT NULL REFERENCES users(id),
    release_set_id uuid,
    note text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (team_id, id),
    FOREIGN KEY (team_id, review_snapshot_id) REFERENCES review_snapshots(team_id, id)
);

-- ============ 发布集与通道 ============
CREATE TABLE release_sets (
    team_id uuid NOT NULL,
    id uuid NOT NULL,
    change_request_id uuid NOT NULL,
    review_snapshot_id uuid NOT NULL,
    version_label text NOT NULL,
    notes jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_by uuid NOT NULL REFERENCES users(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (team_id, id),
    UNIQUE (team_id, change_request_id)
);

CREATE TABLE release_items (
    team_id uuid NOT NULL,
    release_set_id uuid NOT NULL,
    asset_id uuid NOT NULL,
    revision_id uuid NOT NULL,
    superseded_revision_id uuid,
    PRIMARY KEY (team_id, release_set_id, asset_id),
    FOREIGN KEY (team_id, release_set_id) REFERENCES release_sets(team_id, id),
    FOREIGN KEY (team_id, asset_id, revision_id) REFERENCES asset_revisions(team_id, asset_id, id)
);

CREATE TABLE asset_channels (
    team_id uuid NOT NULL,
    id uuid NOT NULL,
    project_id uuid NOT NULL,
    name text NOT NULL DEFAULT 'stable' CHECK (name IN ('stable', 'preview')),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (team_id, id),
    UNIQUE (team_id, project_id, name),
    FOREIGN KEY (team_id, project_id) REFERENCES projects(team_id, id)
);

-- 通道头：按资产的当前指针；历史由 release_sets 保留
CREATE TABLE channel_heads (
    team_id uuid NOT NULL,
    channel_id uuid NOT NULL,
    asset_id uuid NOT NULL,
    revision_id uuid NOT NULL,
    release_set_id uuid NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (team_id, channel_id, asset_id),
    FOREIGN KEY (team_id, channel_id) REFERENCES asset_channels(team_id, id),
    FOREIGN KEY (team_id, asset_id, revision_id) REFERENCES asset_revisions(team_id, asset_id, id),
    FOREIGN KEY (team_id, release_set_id) REFERENCES release_sets(team_id, id)
);

-- 发布事件链（含回退；回退是新的受审查事件）
CREATE TABLE release_events (
    team_id uuid NOT NULL,
    id uuid NOT NULL,
    kind text NOT NULL CHECK (kind IN ('publish', 'rollback', 'withdraw')),
    release_set_id uuid,
    channel_id uuid,
    actor_id uuid NOT NULL REFERENCES users(id),
    detail jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (team_id, id)
);

-- ============ 项目精确引用（B09） ============
CREATE TABLE project_asset_bindings (
    team_id uuid NOT NULL,
    id uuid NOT NULL,
    project_id uuid NOT NULL,
    asset_id uuid NOT NULL,
    revision_id uuid NOT NULL,
    usage_key text NOT NULL,
    purpose text NOT NULL DEFAULT '',
    created_by uuid NOT NULL REFERENCES users(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (team_id, id),
    UNIQUE (team_id, project_id, usage_key),
    FOREIGN KEY (team_id, project_id) REFERENCES projects(team_id, id),
    -- 复合外键：阻止"资产 A 的引用误填资产 B 的修订"
    FOREIGN KEY (team_id, asset_id, revision_id) REFERENCES asset_revisions(team_id, asset_id, id)
);

-- ============ outbox 与审计 ============
CREATE TABLE outbox (
    id bigserial PRIMARY KEY,
    team_id uuid NOT NULL,
    event_id uuid NOT NULL,
    event_type text NOT NULL,
    aggregate text NOT NULL,
    payload jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    delivered_at timestamptz,
    attempts integer NOT NULL DEFAULT 0,
    UNIQUE (team_id, event_id)
);

CREATE TABLE audit_events (
    id bigserial PRIMARY KEY,
    team_id uuid NOT NULL,
    actor_id uuid,
    action text NOT NULL,
    object_kind text NOT NULL,
    object_id uuid,
    result text NOT NULL DEFAULT 'ok',
    request_id text NOT NULL DEFAULT '',
    detail jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_audit_team_time ON audit_events(team_id, created_at);

-- ============ 团队治理设置（单人管理例外等，默认关闭） ============
CREATE TABLE team_settings (
    team_id uuid PRIMARY KEY REFERENCES teams(id),
    allow_single_admin_self_approval boolean NOT NULL DEFAULT false,
    single_admin_exception_note text NOT NULL DEFAULT '',
    updated_at timestamptz NOT NULL DEFAULT now()
);

-- ============ RLS ============
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'branches','branch_entries','issues','comments','change_requests',
    'change_request_items','review_snapshots','approvals','release_sets',
    'release_items','asset_channels','channel_heads','release_events',
    'project_asset_bindings','outbox','audit_events'
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

-- team_settings 无 team_id RLS 列语义（team_id 即主键）：仍启用，策略同构
ALTER TABLE team_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON team_settings
  USING (team_id = NULLIF(current_setting('app.team_id', true), '')::uuid)
  WITH CHECK (team_id = NULLIF(current_setting('app.team_id', true), '')::uuid);

-- ============ 应用角色授权 ============
GRANT SELECT, INSERT, UPDATE, DELETE ON branches, branch_entries TO taw_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON issues, comments TO taw_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON change_requests, change_request_items TO taw_app;
GRANT SELECT, INSERT ON review_snapshots TO taw_app;               -- 快照不可变
GRANT SELECT, INSERT, UPDATE, DELETE ON approvals TO taw_app;
GRANT SELECT, INSERT ON release_sets, release_items TO taw_app;    -- 发布集不可变
GRANT SELECT, INSERT, UPDATE, DELETE ON asset_channels, channel_heads TO taw_app;
GRANT SELECT, INSERT ON release_events TO taw_app;                 -- 事件链只追加
GRANT SELECT, INSERT, UPDATE, DELETE ON project_asset_bindings TO taw_app;
GRANT SELECT, INSERT, UPDATE ON outbox TO taw_app;
GRANT SELECT, INSERT ON audit_events TO taw_app;                   -- 审计只追加
GRANT SELECT, INSERT, UPDATE ON team_settings TO taw_app;
