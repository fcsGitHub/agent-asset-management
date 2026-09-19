-- 0004: 修复 RLS 策略对"已回滚的 SET LOCAL"的处理。
-- 连接复用时，事务结束后 app.team_id 会回退为空字符串（而非 NULL），
-- current_setting(..., true)::uuid 会抛 22P02。统一改为 NULLIF 包裹。

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'projects','project_members','sessions','messages','entities','assets',
    'asset_categories','asset_labels','asset_revisions','revision_artifacts',
    'relation_assertions','blobs','uploads','asset_type_versions','relation_type_versions'
  ]
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      $f$
        CREATE POLICY tenant_isolation ON %I
          USING (team_id = NULLIF(current_setting('app.team_id', true), '')::uuid)
          WITH CHECK (team_id = NULLIF(current_setting('app.team_id', true), '')::uuid)
      $f$, t);
  END LOOP;
END$$;
