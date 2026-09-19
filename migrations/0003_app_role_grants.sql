-- 0003: 应用角色注册流程所需的全局表写权限补全。
-- users / teams 在注册时写入（auth_sessions、team_members 已有授权）。

GRANT INSERT ON users, teams TO taw_app;
