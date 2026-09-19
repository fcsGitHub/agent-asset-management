-- 0014: 资产可变元数据（展示名/标签/分类）的乐观锁版本（C07 ETag）。
-- 注意：技术属性仍在不可变修订内；此处仅为可变业务状态（设计 10 章）。

ALTER TABLE assets ADD COLUMN meta_version integer NOT NULL DEFAULT 1;
GRANT UPDATE (meta_version) ON assets TO taw_app;
