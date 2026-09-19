-- 0008: 序列授权补全（audit_events/outbox 的 bigserial 由应用角色写入需要 USAGE）。
-- 0002 中的 ALL SEQUENCES 授权在后续新表序列上不生效，统一补齐。
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO taw_app;
