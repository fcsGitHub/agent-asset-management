# ADR 记录

## ADR-0001 ｜ 技术栈 ｜ 2026-09-20 ｜ 已接受

- 决定：模块化单体。Node 24 + TypeScript（strict）+ Fastify（API）+ React/Vite（Web）+ PostgreSQL 16（pgvector 镜像，为 M5 向量检索预留）+ Python 3.11 独立语义 worker。包结构按设计 25 章：apps/{api,web,worker}、packages/{domain,contracts,agent-adapter,storage}、services/semantic-worker、migrations、docs/implementation。
- 理由：设计 6 章推荐基线；仓库为空，无既有栈需保持。
- 代价：Node/TS 全栈需自行维持领域边界（ADR-0001 风险）；测试覆盖必须补偿。
- 重估条件：出现实测的独立扩容需求或团队交付边界。

## ADR-0002 ｜ 自研极简迁移 runner ｜ 2026-09-20 ｜ 已接受

- 决定：migrations/*.sql 按序在单事务内执行，schema_migrations 登记；--role=admin 使用 DDL 管理角色，日常应用角色后续建为受限角色（无 DDL、非 owner、受 RLS 约束）。
- 理由：迁移必须可审查（目标正文 §3）；node-pg-migrate 等引入额外抽象，收益低。
- 代价：无 down 迁移（回退以显式新迁移实现，与"回退是新事件"一致）。
- 重估条件：迁移数量导致审查负担（每迁移一文件仍可控）。

## ADR-0003 ｜ Agent 适配路径：DeepSeek（OpenAI 兼容）真实调用 + Pi 官方包统一接入 ｜ 2026-09-20 ｜ 已接受

- 决定：packages/agent-adapter 定义本系统 AgentAdapter 契约（start/cancel/resume，见设计 18 章）。Provider 实现顺序：
  1. OpenAI 兼容 Provider 直连 DeepSeek 官方 API（真实工具调用、取消、错误处理），用户已提供测试 key；
  2. Pi 接入采用 @earendil-works/pi-ai（统一多供应商 LLM 层）与 @earendil-works/pi-agent-core（agent loop/工具调用），版本锁定 0.85.1.x 并写契约测试；生产 ResourceLoader 使用允许名单（设计 18 章），不加载上传内容中的 .pi/extensions。
- 理由：目标正文要求真实模型连接可配置、可测工具调用/取消/错误处理；用户明确要求用 DeepSeek 真实 key。Pi 为适配器后的可替换层，契约测试保护替换自由（ADR-07 of design）。
- 代价：两套路径需契约测试覆盖；Pi 上游 API 随版本变化需按锁定版本核实。
- 重估条件：Pi SDK 契约测试失败或上游重大变更。

## ADR-0004 ｜ mock 使用边界 ｜ 2026-09-20 ｜ 已接受

- 决定：mock/fake 仅允许出现在单元测试与前端开发期，文件头/用例名必须含 "mock" 标识；所有集成、E2E、验收证据使用真实 PostgreSQL、真实文件库、真实 LLM。伪成功答复禁止（D01 无真实模型时记阻塞，不拿 mock 充数）。
- 理由：目标正文 §8。

## ADR-0005 ｜ 开发环境为 Windows + Docker Linux 容器 ｜ 2026-09-20 ｜ 已接受

- 决定：本机 Windows 宿主直接运行 Node/Python；PostgreSQL 等 Stateful 组件容器化（Linux）。部署文档按 Linux 服务端撰写；离线/ARM64 声称在无对应硬件时不做，台账明确标记"未验证"。
- 理由：目标正文 §1 允许记录隔离能力限制；不伪造联网/平台验证。
- 代价：E06 部分项只能标记未验证。
