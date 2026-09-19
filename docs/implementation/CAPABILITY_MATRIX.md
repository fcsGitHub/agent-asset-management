# CAPABILITY MATRIX — 能力矩阵

要求 → 现有实现 → 缺口 → 代码位置。随开发持续更新；"无"表示尚未开始。

## 基础设施

| 要求 | 现有实现 | 缺口 | 位置 |
| --- | --- | --- | --- |
| 真实 PostgreSQL | docker-compose + pgvector:pg16，迁移链可用 | RLS/受限应用角色未建 | docker-compose.yml, migrations/, scripts/migrate.ts |
| 内容寻址 BlobStore | 无 | 全部 | packages/storage/ |
| 持久作业 + outbox | 无 | 全部 | apps/worker/, migrations/ |
| 类型检查/测试框架 | TS strict + vitest 已配置 | 尚无业务测试 | tsconfig.base.json, package.json |

## 领域能力（设计章节 → 状态）

| 能力 | 状态 | 位置 |
| --- | --- | --- |
| 身份/团队/项目/Session（M1） | 无 | apps/api/src/routes/ |
| 登录会话/CSRF（16 章） | 无 | 同上 |
| 文件接收/隔离扫描（14 章） | 无 | packages/storage/, apps/api |
| 七类资产 + 类型定义（7/8 章） | 无 | packages/domain/ |
| 不可变修订/分支（12 章） | 无 | packages/domain/ |
| 关系/候选分离（9 章） | 无 | packages/domain/ |
| Issue/PR/审核发布（13 章） | 无 | packages/domain/, apps/api |
| 项目闭环/阶段门/结题（15 章） | 无 | packages/domain/ |
| Agent 适配/工具网关（17/18 章） | 无 | packages/agent-adapter/ |
| SSE 事件/预算/取消/恢复（18 章） | 无 | apps/api/, apps/worker/ |
| Semantica 语义 worker（19 章） | 无 | services/semantic-worker/ |
| 审计/备份/运维（22/23 章） | 无 | scripts/, infra/ |

## 界面（4 章）

| 要求 | 状态 | 位置 |
| --- | --- | --- |
| 两区工作台（Agent 区+工作区，38/62 可拖动） | 无 | apps/web/ |
| 导航抽屉（项目 → Session，可收起） | 无 | apps/web/ |
| 空态/加载/失败/无权/断线恢复/窄屏 | 无 | apps/web/ |
| 不依赖 LLM 的直接操作 | 无 | 全链路设计约束 |
