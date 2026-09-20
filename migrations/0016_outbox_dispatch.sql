-- 0016: outbox 派发支持（租约/退避）+ 热路径索引。
-- 1) outbox 增加租约列：worker 以至少一次语义投递（SKIP LOCKED 抢占 + 租约超时回收）。
ALTER TABLE outbox ADD COLUMN IF NOT EXISTS leased_at timestamptz;
ALTER TABLE outbox ADD COLUMN IF NOT EXISTS lease_until timestamptz;
ALTER TABLE outbox ADD COLUMN IF NOT EXISTS last_error text NOT NULL DEFAULT '';

-- 2) 未投递事件的部分索引：派发轮询只扫未投递行。
CREATE INDEX IF NOT EXISTS idx_outbox_undelivered ON outbox (id) WHERE delivered_at IS NULL;

-- 3) 修订头查找热路径：LATERAL ORDER BY seq DESC LIMIT 1 从"取全部分支再排序"降为索引 top-1。
CREATE INDEX IF NOT EXISTS idx_revisions_head ON asset_revisions (team_id, asset_id, seq DESC);

-- 4) 专用 worker 角色：仅对 outbox 具备跨租户读写（表级策略），不绕过 RLS 整体。
--    应用角色继续受租户 RLS 约束；worker 需要更新租约与投递标记。
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'taw_worker') THEN
    CREATE ROLE taw_worker LOGIN PASSWORD 'taw_worker_dev' NOSUPERUSER NOCREATEDB NOCREATEROLE;
  END IF;
END$$;
GRANT USAGE ON SCHEMA public TO taw_worker;
GRANT SELECT, UPDATE ON outbox TO taw_worker;
DROP POLICY IF EXISTS outbox_worker_all ON outbox;
CREATE POLICY outbox_worker_all ON outbox
  FOR ALL TO taw_worker
  USING (true)
  WITH CHECK (true);
