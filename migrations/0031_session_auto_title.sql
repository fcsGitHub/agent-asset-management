-- 0031: 会话自动标题（M73）。
-- 新建会话不再强制弹窗命名：服务端生成占位标题「会话 MM-DD HH:mm」并标 title_is_auto=true，
-- 首条 Agent 运行创建时改写为 prompt 摘要；用户显式命名/改名置 false 后永不自动改写。
-- 存量会话默认 false——历史上标题全部来自用户显式输入，不应被自动改写。
ALTER TABLE sessions ADD COLUMN title_is_auto boolean NOT NULL DEFAULT false;
