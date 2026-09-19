-- 0010: 工作项交付物（任务产出的精确资产修订）——追踪矩阵的 任务→交付 链。

CREATE TABLE work_item_deliverables (
    team_id uuid NOT NULL,
    work_item_id uuid NOT NULL,
    asset_id uuid NOT NULL,
    revision_id uuid NOT NULL,
    PRIMARY KEY (team_id, work_item_id, asset_id),
    FOREIGN KEY (team_id, work_item_id) REFERENCES work_items(team_id, id),
    FOREIGN KEY (team_id, asset_id, revision_id) REFERENCES asset_revisions(team_id, asset_id, id)
);

ALTER TABLE work_item_deliverables ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON work_item_deliverables
  USING (team_id = NULLIF(current_setting('app.team_id', true), '')::uuid)
  WITH CHECK (team_id = NULLIF(current_setting('app.team_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON work_item_deliverables TO taw_app;
