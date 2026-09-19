# PLAN — 实施计划

更新时间：2026-09-20（M0 建立时）
基线：team_asset_design.html（29 章设计）+ team_asset_goal.md（目标正文）。
规则：每轮开始先读本文件与 ACCEPTANCE.md、HANDOFF.md，选一个最重要未阻塞任务；完成标准以真实证据为准（见 EVIDENCE.md）。

## 里程碑

| 里程碑 | 内容 | 出口条件（摘要） | 状态 |
| --- | --- | --- | --- |
| M0 仓库与契约盘点 | 环境盘点、ADR、台账、最薄真实链（docker PG + 迁移 + typecheck + 测试框架） | 可运行基线、锁定依赖、许可证记录 | 进行中 |
| M1 资产目录骨架 | 身份/团队/项目/Session、两区工作台、文件接收、七类资产、类型属性、关系 | 两个真实用户登记/读取，重启数据保留 | 未开始 |
| M2 变更与发布 | 分支、不可变修订、差异、Issue、PR、审核摘要、管理员发布、回退、精确引用 | 成员提案→管理员发布→第三项目复用；并发/越权测试通过 | 未开始 |
| M3 项目全过程 | 需求基线、设计、任务、测试定义/运行、追踪矩阵、阶段门、结题包 | 一条真实需求走到结题；未通过需求阻止结题 | 未开始 |
| M4 真实 Agent | Pi 适配（@earendil-works/pi-*）、受控工具、持久事件、预算、取消、恢复 | 真实 LLM 完成入库提案与 Issue 整理，不能越权发布 | 未开始 |
| M5 语义与硬化 | Semantica 适配、检索授权、降级、备份恢复、安全/性能、文档 | 真实样本候选可审查；禁用增强仍可工作 | 未开始 |

## 当前下一步

1. M1：迁移 0002（身份/团队/项目/Session 表 + 受限应用角色 + RLS 初步）
2. M1：登录会话 API（注册/登录/登出/当前用户，HttpOnly Cookie + CSRF）
3. M1：BlobStore 内容寻址接收（上传/最终化/摘要校验）

## 关键决定（详见 ADR/）

- ADR-0001：技术栈 Node24/TS/Fastify/React/Vite/PostgreSQL16(pgvector 镜像)/Python 3.11 worker
- ADR-0002：迁移采用自研极简 SQL runner（少依赖、可审查）；应用角色与 DDL 角色分离
- ADR-0003：Agent 适配器先实现 OpenAI 兼容 Provider（DeepSeek 真实调用），Pi 通过 @earendil-works/pi-ai 统一 LLM 层接入；接口与本系统 AgentAdapter 契约一致
- ADR-0004：mock 仅用于单元测试且文件头标注 MOCK；一切集成/验收测试用真实 PostgreSQL/真实文件/真实 LLM

## 依赖与锁定

- Node v24.11.1、npm 11.6.2（lockfile 固定全部传递依赖）
- Docker 29.2.1（Linux 容器）；镜像 pgvector/pgvector:pg16（本地已有，无需拉取）
- Python 3.11.5（miniconda）；semantic-worker 依赖在 services/semantic-worker/requirements.txt 固定
- Pi 官方包 @earendil-works/{pi-ai,pi-agent-core,pi-coding-agent}@0.85.1（npm 已核实存在；接入时锁定并写契约测试）
- Semantica PyPI 0.6.8 已核实存在（接入时锁定版本并写契约测试）
- DeepSeek API：官方 https://api.deepseek.com（OpenAI 兼容），key 仅测试用，不入库
