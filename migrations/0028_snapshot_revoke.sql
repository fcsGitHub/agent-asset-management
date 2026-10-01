-- 0028 (M68①) 集合分享快照吊销（泄漏治理出口）
-- M67 的不可变设计没留吊销通道——链接一旦泄漏永远有效。补列级治理出口：
--   只授权 UPDATE (revoked_at, revoked_by) 两列——payload/token/创建信息在 DB 层
--   仍然不可改（列级授权下 UPDATE 其他列直接 permission denied），吊销是唯一
--   被授权的更新路径。公开端点对已吊销 token 返回 410 SHARE_REVOKED。

ALTER TABLE asset_collection_snapshots
    ADD COLUMN revoked_at timestamptz NULL,
    ADD COLUMN revoked_by uuid NULL;

GRANT UPDATE (revoked_at, revoked_by) ON asset_collection_snapshots TO taw_app;
