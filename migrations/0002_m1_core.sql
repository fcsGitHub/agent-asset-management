-- 0002: M1 核心 schema — 身份/团队/项目/Session、实体与资产、类型本体、
-- 内容库元数据、上传、不可变修订、关系断言。
-- 设计基线：team_asset_design.html 第 7/8/9/10 章。

-- ============ 受限应用角色 ============
-- 应用永远以 taw_app 连接；无 DDL、非 owner、受 RLS。迁移以管理角色执行。
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'taw_app') THEN
    CREATE ROLE taw_app LOGIN PASSWORD 'taw_app_dev' NOSUPERUSER NOCREATEDB NOCREATEROLE;
  END IF;
END$$;

REVOKE ALL ON SCHEMA public FROM taw_app;
GRANT USAGE ON SCHEMA public TO taw_app;

-- ============ 身份 ============
CREATE TABLE users (
    id uuid PRIMARY KEY,
    email text NOT NULL UNIQUE,
    display_name text NOT NULL,
    password_hash text NOT NULL,
    is_active boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE teams (
    id uuid PRIMARY KEY,
    name text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE team_members (
    team_id uuid NOT NULL REFERENCES teams(id),
    user_id uuid NOT NULL REFERENCES users(id),
    role text NOT NULL CHECK (role IN ('member', 'admin')),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (team_id, user_id)
);

CREATE TABLE auth_sessions (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    revoked_at timestamptz
);
CREATE INDEX idx_auth_sessions_user ON auth_sessions(user_id);

-- ============ 项目与 Session ============
CREATE TABLE projects (
    team_id uuid NOT NULL REFERENCES teams(id),
    id uuid NOT NULL,
    name text NOT NULL,
    code text NOT NULL,
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'archived')),
    created_by uuid NOT NULL REFERENCES users(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (team_id, id),
    UNIQUE (team_id, code)
);

CREATE TABLE project_members (
    team_id uuid NOT NULL,
    project_id uuid NOT NULL,
    user_id uuid NOT NULL REFERENCES users(id),
    role text NOT NULL CHECK (role IN ('lead', 'member')),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (team_id, project_id, user_id),
    FOREIGN KEY (team_id, project_id) REFERENCES projects(team_id, id)
);
CREATE INDEX idx_project_members_user ON project_members(team_id, user_id);

-- 注意：产品"Session"指项目对话会话；登录会话为 auth_sessions。
CREATE TABLE sessions (
    team_id uuid NOT NULL REFERENCES teams(id),
    id uuid NOT NULL,
    project_id uuid NOT NULL,
    title text NOT NULL,
    visibility text NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'project')),
    created_by uuid NOT NULL REFERENCES users(id),
    archived boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (team_id, id),
    FOREIGN KEY (team_id, project_id) REFERENCES projects(team_id, id)
);
CREATE INDEX idx_sessions_project ON sessions(team_id, project_id);

CREATE TABLE messages (
    team_id uuid NOT NULL,
    id uuid NOT NULL,
    session_id uuid NOT NULL,
    role text NOT NULL CHECK (role IN ('user', 'assistant', 'system', 'tool')),
    content text NOT NULL,
    seq bigint NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (team_id, id),
    FOREIGN KEY (team_id, session_id) REFERENCES sessions(team_id, id),
    UNIQUE (team_id, session_id, seq)
);

-- ============ 稳定实体身份 ============
CREATE TABLE entities (
    team_id uuid NOT NULL REFERENCES teams(id),
    id uuid NOT NULL,
    kind text NOT NULL CHECK (kind IN ('asset', 'project', 'requirement', 'test_run', 'evidence', 'issue', 'work_item')),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (team_id, id)
);

-- ============ 类型本体（定义发布后不可变，版本并存） ============
CREATE TABLE asset_type_versions (
    team_id uuid NOT NULL REFERENCES teams(id),
    id uuid NOT NULL,
    type_key text NOT NULL,                -- 如 simulation.model
    version text NOT NULL,                 -- 如 1.0.0
    title text NOT NULL,
    json_schema jsonb NOT NULL CHECK (jsonb_typeof(json_schema) = 'object'),
    unit_vocabularies jsonb NOT NULL DEFAULT '{}'::jsonb,
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'deprecated')),
    created_by uuid NOT NULL REFERENCES users(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (team_id, id),
    UNIQUE (team_id, type_key, version)
);

CREATE TABLE relation_type_versions (
    team_id uuid NOT NULL REFERENCES teams(id),
    id uuid NOT NULL,
    type_key text NOT NULL,                -- 如 dependsOn
    version text NOT NULL,
    title text NOT NULL,
    source_kinds text[] NOT NULL,
    target_kinds text[] NOT NULL,
    cyclic boolean NOT NULL DEFAULT true,      -- 是否允许环
    is_symmetric boolean NOT NULL DEFAULT false,
    requires_revision boolean NOT NULL DEFAULT true, -- 是否绑定修订级
    created_by uuid NOT NULL REFERENCES users(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (team_id, id),
    UNIQUE (team_id, type_key, version)
);

-- ============ 资产目录 ============
CREATE TABLE assets (
    team_id uuid NOT NULL,
    id uuid NOT NULL,
    name text NOT NULL,
    lifecycle text NOT NULL DEFAULT 'active' CHECK (lifecycle IN ('active', 'deprecated', 'archived')),
    current_type_version_id uuid NOT NULL,
    created_by uuid NOT NULL REFERENCES users(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (team_id, id),
    FOREIGN KEY (team_id, id) REFERENCES entities(team_id, id),
    FOREIGN KEY (team_id, current_type_version_id) REFERENCES asset_type_versions(team_id, id)
);
CREATE INDEX idx_assets_name ON assets(team_id, name);

CREATE TABLE asset_categories (
    team_id uuid NOT NULL,
    asset_id uuid NOT NULL,
    category_path text NOT NULL,          -- 如 simulation/model/orbit（主分类一个 + 辅助分类）
    is_primary boolean NOT NULL DEFAULT false,
    PRIMARY KEY (team_id, asset_id, category_path),
    FOREIGN KEY (team_id, asset_id) REFERENCES assets(team_id, id)
);

CREATE TABLE asset_labels (
    team_id uuid NOT NULL,
    asset_id uuid NOT NULL,
    label text NOT NULL,
    PRIMARY KEY (team_id, asset_id, label),
    FOREIGN KEY (team_id, asset_id) REFERENCES assets(team_id, id)
);
CREATE INDEX idx_asset_labels_label ON asset_labels(team_id, label);

-- ============ 内容库元数据（blob 实体由 BlobStore 管理，按 team+digest 去重） ============
CREATE TABLE blobs (
    team_id uuid NOT NULL REFERENCES teams(id),
    digest text NOT NULL CHECK (digest ~ '^[0-9a-f]{64}$'),
    size bigint NOT NULL CHECK (size >= 0),
    media_type text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (team_id, digest)
);

CREATE TABLE uploads (
    team_id uuid NOT NULL REFERENCES teams(id),
    id uuid NOT NULL,
    uploader_id uuid NOT NULL REFERENCES users(id),
    original_name text NOT NULL,
    digest text NOT NULL,
    size bigint NOT NULL,
    media_type text NOT NULL,
    state text NOT NULL DEFAULT 'ready' CHECK (state IN ('quarantined', 'ready', 'rejected')),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (team_id, id)
);

-- ============ 不可变修订 ============
CREATE TABLE asset_revisions (
    team_id uuid NOT NULL,
    id uuid NOT NULL,
    asset_id uuid NOT NULL,
    type_version_id uuid NOT NULL,
    properties jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(properties) = 'object'),
    content_digest text NOT NULL CHECK (content_digest ~ '^[0-9a-f]{64}$'),
    seq integer NOT NULL,
    created_by uuid NOT NULL REFERENCES users(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (team_id, id),
    UNIQUE (team_id, asset_id, seq),
    FOREIGN KEY (team_id, asset_id) REFERENCES assets(team_id, id),
    FOREIGN KEY (team_id, type_version_id) REFERENCES asset_type_versions(team_id, id)
);
CREATE INDEX idx_revisions_asset ON asset_revisions(team_id, asset_id);

CREATE TABLE revision_artifacts (
    team_id uuid NOT NULL,
    revision_id uuid NOT NULL,
    blob_digest text NOT NULL,
    artifact_role text NOT NULL DEFAULT 'implementation',
    original_name text NOT NULL,
    media_type text NOT NULL,
    size bigint NOT NULL,
    PRIMARY KEY (team_id, revision_id, artifact_role, blob_digest),
    FOREIGN KEY (team_id, revision_id) REFERENCES asset_revisions(team_id, id),
    FOREIGN KEY (team_id, blob_digest) REFERENCES blobs(team_id, digest)
);

-- ============ 关系断言（受控关系；候选单独存 relation_proposals，M2 引入） ============
CREATE TABLE relation_assertions (
    team_id uuid NOT NULL,
    id uuid NOT NULL,
    relation_type_version_id uuid NOT NULL,
    source_asset_id uuid NOT NULL,
    source_revision_id uuid,
    target_asset_id uuid NOT NULL,
    target_revision_id uuid,
    conditions jsonb NOT NULL DEFAULT '{}'::jsonb,
    evidence_note text,
    status text NOT NULL DEFAULT 'confirmed' CHECK (status IN ('proposed', 'confirmed', 'withdrawn')),
    proposed_by uuid NOT NULL REFERENCES users(id),
    confirmed_by uuid REFERENCES users(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    withdrawn_reason text,
    PRIMARY KEY (team_id, id),
    FOREIGN KEY (team_id, relation_type_version_id) REFERENCES relation_type_versions(team_id, id),
    FOREIGN KEY (team_id, source_asset_id) REFERENCES assets(team_id, id),
    FOREIGN KEY (team_id, target_asset_id) REFERENCES assets(team_id, id)
);
CREATE INDEX idx_rel_source ON relation_assertions(team_id, source_asset_id, status);
CREATE INDEX idx_rel_target ON relation_assertions(team_id, target_asset_id, status);

-- ============ RLS：租户隔离 ============
-- 应用在每事务内 SET LOCAL app.team_id；未设置时策略拒绝一切行。
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE entities ENABLE ROW LEVEL SECURITY;
ALTER TABLE assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE asset_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE asset_labels ENABLE ROW LEVEL SECURITY;
ALTER TABLE asset_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE revision_artifacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE relation_assertions ENABLE ROW LEVEL SECURITY;
ALTER TABLE blobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE uploads ENABLE ROW LEVEL SECURITY;
ALTER TABLE asset_type_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE relation_type_versions ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON projects USING (team_id = current_setting('app.team_id', true)::uuid) WITH CHECK (team_id = current_setting('app.team_id', true)::uuid);
CREATE POLICY tenant_isolation ON project_members USING (team_id = current_setting('app.team_id', true)::uuid) WITH CHECK (team_id = current_setting('app.team_id', true)::uuid);
CREATE POLICY tenant_isolation ON sessions USING (team_id = current_setting('app.team_id', true)::uuid) WITH CHECK (team_id = current_setting('app.team_id', true)::uuid);
CREATE POLICY tenant_isolation ON messages USING (team_id = current_setting('app.team_id', true)::uuid) WITH CHECK (team_id = current_setting('app.team_id', true)::uuid);
CREATE POLICY tenant_isolation ON entities USING (team_id = current_setting('app.team_id', true)::uuid) WITH CHECK (team_id = current_setting('app.team_id', true)::uuid);
CREATE POLICY tenant_isolation ON assets USING (team_id = current_setting('app.team_id', true)::uuid) WITH CHECK (team_id = current_setting('app.team_id', true)::uuid);
CREATE POLICY tenant_isolation ON asset_categories USING (team_id = current_setting('app.team_id', true)::uuid) WITH CHECK (team_id = current_setting('app.team_id', true)::uuid);
CREATE POLICY tenant_isolation ON asset_labels USING (team_id = current_setting('app.team_id', true)::uuid) WITH CHECK (team_id = current_setting('app.team_id', true)::uuid);
CREATE POLICY tenant_isolation ON asset_revisions USING (team_id = current_setting('app.team_id', true)::uuid) WITH CHECK (team_id = current_setting('app.team_id', true)::uuid);
CREATE POLICY tenant_isolation ON revision_artifacts USING (team_id = current_setting('app.team_id', true)::uuid) WITH CHECK (team_id = current_setting('app.team_id', true)::uuid);
CREATE POLICY tenant_isolation ON relation_assertions USING (team_id = current_setting('app.team_id', true)::uuid) WITH CHECK (team_id = current_setting('app.team_id', true)::uuid);
CREATE POLICY tenant_isolation ON blobs USING (team_id = current_setting('app.team_id', true)::uuid) WITH CHECK (team_id = current_setting('app.team_id', true)::uuid);
CREATE POLICY tenant_isolation ON uploads USING (team_id = current_setting('app.team_id', true)::uuid) WITH CHECK (team_id = current_setting('app.team_id', true)::uuid);
CREATE POLICY tenant_isolation ON asset_type_versions USING (team_id = current_setting('app.team_id', true)::uuid) WITH CHECK (team_id = current_setting('app.team_id', true)::uuid);
CREATE POLICY tenant_isolation ON relation_type_versions USING (team_id = current_setting('app.team_id', true)::uuid) WITH CHECK (team_id = current_setting('app.team_id', true)::uuid);

-- ============ 应用角色授权 ============
-- 全局表（无租户列）读授权
GRANT SELECT ON teams, users TO taw_app;
GRANT SELECT, INSERT, UPDATE ON auth_sessions TO taw_app;
GRANT SELECT, INSERT ON team_members TO taw_app;

-- 租户表 CRUD（UPDATE/DELETE 不可变表被排除）
GRANT SELECT, INSERT, UPDATE, DELETE ON projects, project_members, sessions, messages TO taw_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON entities, assets, asset_categories, asset_labels TO taw_app;
GRANT SELECT, INSERT ON asset_type_versions, relation_type_versions TO taw_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON blobs, uploads TO taw_app;
GRANT SELECT, INSERT ON asset_revisions TO taw_app;   -- 不可变：禁 UPDATE/DELETE
GRANT SELECT, INSERT, UPDATE, DELETE ON revision_artifacts, relation_assertions TO taw_app;

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO taw_app;
GRANT SELECT ON schema_migrations TO taw_app;
