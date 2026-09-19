-- 0001: 基线骨架。真实业务表由后续迁移添加（0002 起）。
-- 本迁移仅建立验证迁移链所需的最小对象。

CREATE TABLE baseline_health (
    id bigserial PRIMARY KEY,
    checked_at timestamptz NOT NULL DEFAULT now(),
    note text NOT NULL
);
