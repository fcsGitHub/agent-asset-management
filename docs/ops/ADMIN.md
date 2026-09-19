# 管理员手册

面向团队管理员（`team_members.role = 'admin'`）。日常使用见工作台界面；本文只列
需要理解规则与直接操作数据库/API 的部分。

## 角色与权限

- 首个注册用户创建团队并成为管理员；其他成员由管理员
  `POST /api/v1/teams/:teamId/members` 添加（member/admin）。
- 普通成员：读团队正式资产、登记资产、提 Issue、建分支提交 CR——不能发布。
- 管理员：审核发布、阶段门审查、豁免记录、语义候选确认后的关系固化。
- 发布与审批的硬规则（服务端强制，见 tests/m2-release）：
  - 成员调用 `review-and-publish` 一律 403；
  - 作者不能审批自己的 CR；确需单人团队例外，必须先在 `team_settings` 中配置
    `allow_single_admin_self_approval = true` 且填写 `single_admin_exception_note`
    （无说明仍拒绝）。该配置无 API，直接对数据库操作并留痕，Agent 无权改动。

## 审核并发布

1. 成员提交 CR 后调用 `prepare-review` 生成**不可变审核快照**
   （candidate_digest / review_digest，绑定内容、制品摘要、目标头、策略版本、通道与受众）。
2. 管理员在工作区查看差异（属性逐字段、制品摘要、关系对照）。
3. 发布请求必须携带 `expectedReviewDigest` == 当前快照摘要。
   内容、分支头、目标通道头、制品任一变化 → 409 `REVIEW_DIGEST_CHANGED`，需重新 prepare。
4. 发布成功 = 同一事务写入 approval + release_set/items + 通道头 + main 视图 + 审计 + outbox。
5. 回退是**新的受审查事件**：`POST /channels/:id/rollback`，需说明原因与不可自动逆转的
   外部副作用；历史发布集全部保留。

## Agent 边界

- Agent（DeepSeek）可用的工具只有：`asset.search`、`asset.getRevision`、`relation.query`、
  `issue.create`、`proposal.create`、`external.notify`。
- 发布、权限、本体批准、敏感导出不在工具清单中；即使模型点名调用也被网关记录为 denied
  （tests/m4-agent D02）。提案（agent_proposals）必须由人审查，不会自动成为正式资产。
- 预算（工具次数/token）超限 → 运行 blocked，等待用户处置；取消传播到模型请求。
- 崩溃恢复：`POST /runs/:id/recover` 把失联运行标记为 `unknown_reconcile` 并展示最后事件，
  不盲目重跑。

## 语义增强

- `services/semantic-worker`（semantica 0.6.8）提供中文实体定位、关系候选与冲突检测。
- 候选关系只能以 `status='proposed'` 进入 `relation_assertions`；不参与发布、依赖解析与结题判断。
- worker 停机时 `/api/v1/semantic/*` 返回 503 `DEPENDENCY_UNAVAILABLE`；其余功能不受影响。

## 升级与迁移

1. 备份（见 BACKUP.md）。
2. 拉取新代码后 `npm install`（lockfile 固定）。
3. `npx tsx scripts/migrate.ts --role=admin`——迁移幂等，只应用未执行过的文件。
4. 重启 API/前端/worker 进程。

## 审计

- `audit_events` 对应用角色只追加（无 UPDATE/DELETE 权限），记录发布、回退、快照生成等动作。
- 数据库角色 `taw_app` 非 owner、无 BYPASSRLS；RLS 以事务内 `app.team_id` 隔离租户。
