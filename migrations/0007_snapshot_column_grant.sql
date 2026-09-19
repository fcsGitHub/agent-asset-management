-- 0007: 审核快照列级授权 — 仅允许翻转 superseded 标记；
-- 摘要与载荷列对应用角色保持不可变。

GRANT UPDATE (superseded) ON review_snapshots TO taw_app;
