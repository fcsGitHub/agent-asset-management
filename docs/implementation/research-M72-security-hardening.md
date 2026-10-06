# M72 调研笔记：安全与缺陷收口轮（用户点名：继续优化迭代，修复漏洞）

本轮不新增产品功能，专注**漏洞修复与缺陷收口**。入口：对 apps/api/src 全量做一轮
四类模式审计（变更路由 CSRF/权限、事务内 send、SQL 拼接、逻辑缺陷），逐个现场
确认后修复。审计结论：CSRF 与 SQL 参数化面干净（60 个变更路由全带 checkCsrf；
模板内插均为白名单或参数化），真实问题集中在**导出注入面、授权短路、守卫失效、
并发竞态**四类。

## 一、外部锚点

### 1. OWASP CSV Injection（本轮实读：owasp.org www-community/attacks/CSV_Injection）
- 电子表格把以 `=` `+` `-` `@` 开头的单元格按公式执行（可窃取内容/执行命令）；
  Tab(0x09)/CR(0x0D)/LF(0x0A) 与全角 ＝＋－＠ 同样危险。
- 缓解：单元格边界消毒；**引号 + 危险单元格前缀单引号 `'`**（Excel 视为文本标记）。
- 本项目坐实：M69 目录导出的 csvEscape 只做引号 doubling——资产名（用户完全可控）
  为 `=WEBSERVICE(...)` 时导出即公式注入。修复：危险开头前缀 `'`（全角一并处理）。

### 2. OWASP 注入预防（LIKE 通配符）——既有知识
- 用户输入直接拼入 LIKE 模式时 `%` `_` 是通配符：`%` 恒真匹配、`_` 单字符任意——
  搜索语义失真（输入 `100%` 返回全量）。缓解：转义 `\` `%` `_` 并显式 ESCAPE。
- 本项目坐实：8 处 `ILIKE '%' || $q || '%'`（catalog 3、agent tools 4、graph 1）。
  修复：共享 likeContains() 构造字面量模式 + ESCAPE '\'。

### 3. OWASP Authentication Cheat Sheet（防爆破）——既有知识
- 登录端点必须有失败节流（lockout/throttle/delay 三选一），否则可无限试密码。
- 本项目坐实：/auth/login 无任何失败限速。修复：进程内滑动窗（键 = ip+邮箱小写，
  15 分钟 10 次失败 → 429 RATE_LIMITED，新错误码）；**诚实边界：单实例内存态，
  多实例部署需共享存储（Redis）——与 activityHub 实时通道同口径**，不做分布式声称。
- 顺带（login-CSRF）：login 免 CSRF 是设计内豁免（无会话可被携带有意义动作），
  审计记录不修。

### 4. PostgreSQL advisory locks——既有知识（pg_advisory_xact_lock 文档口径）
- 事务级咨询锁：会话结束/事务回滚自动释放，不阻塞普通读，专治 check-then-insert。
- 本项目坐实三处 `MAX(seq)+1` / 首草稿 check-then-insert 无锁：messages（会话消息
  seq）、requirement_revisions（需求修订 seq）、branches（首草稿 branch_entries 不存在
  时 FOR UPDATE 无行可锁）。并发下重复 seq（唯一约束 500）或 PK 冲突 500。
  修复：写前 `pg_advisory_xact_lock(hashtextextended(键串, 0))` 序列化同键并发。

## 二、审计发现与处置（13 处，四组）

**A 入口面**：①CSV 公式注入（上）；②LIKE 通配符 8 处（上）；③登录无限速（上）。

**B 授权面**：
- ④`POST /work-items/:id/status`（lifecycle.ts:242）无前置 teamRole——被移出团队的
  旧 assignee/creator 仍可改状态（assignee 检查本意是放宽给成员中的负责人，
  不是豁免成员资格）。修复：入口先 teamRole。
- ⑤`POST /proposals/:id/review`（projects.ts:831）只查团队成员、不查项目成员——
  与批量端点（assertProjectAccess）口径不一致，任意团队成员可审任意项目提案。
  修复：事务内查 project_members（RLS 表须租户上下文）。
- ⑥`review-and-publish`（releases.ts:477）幂等回放在权限校验之前——持有他人
  Idempotency-Key 的非成员可探到发布回执。修复：admin 校验提到 idempotentReply 之前
  （403 不消耗幂等键，语义也更正确）。

**C 守卫失效与错误契约**：
- ⑦弃用自继守卫可绕过（catalog.ts:2227，M70 回归）：`successor === assetId` 拿
  UUID 比对名称/别名 ref 恒假——传资产自己的名称即可「自己继任自己」。
  修复：resolveSuccessorRef 解析出 id 后比对（守卫移到解析后）。
- ⑧重复加团队成员 500（auth.ts:127）：裸 INSERT 无 23505 映射。修复：409
  MEMBER_EXISTS（与 collections/catalog 同场景口径对齐）。
- ⑨lead 基线通道死代码（lifecycle.ts:119）：project_members 受 RLS，全局连接查询
  恒 0 行——「项目创建者（lead，非团队 admin）可建基线」的设计承诺自上线起不可达。
  修复：检查移入 withTeam 租户上下文。

**D 并发与教训收口**：
- ⑩M67 教训（事务内 send 竞态）两处漏网：semantic import/preview（:338）、
  ontology/export?format=turtle（:1186）。两处均只读（无 read-your-writes 伤害），
  按口径统一移到事务外，注释如实说明。
- ⑪三处 seq/首草稿竞态 advisory lock（上）。
- ⑫runs cancel 冗余 teamRole 双查（纯清理）。

**明确不修（如实记录）**：
- 资产详情 relation 计数 `status='confirmed'`（catalog.ts:2023）——M65 完整度口径
  「confirmed in+out」是有意设计，非缺陷。
- login 免 CSRF——设计内豁免。
- 登记端点全角公式字符的输入侧消毒——出口（CSV）侧防护已足够且不误伤合法名。

## 三、验证记录（实施后回填）

- **测试**：tests/m72-security-hardening.test.ts 十一项——纯函数一（likeContains 转义）
  + 端到端十（CSV 危险名前缀/普通名不变；LIKE 字面量匹配 `_` 不再通配；work-items
  外团队旧 assignee 被拦（404 成员门槛，修复前 200）；proposals 非项目成员 403、项目
  成员 200；releases 已缓存幂等键非 admin 403（修复前回放 200）；弃用自继按名称/别名
  409 且不落库；重复加成员 409 MEMBER_EXISTS；lead 基线 201+纯成员 403；messages 10
  并发全 201 seq 互异；登录连败 10 次 429 且他号不受影响）。全量 72 套件 370 项全绿。
- **回归修复过程中的发现**：M70 测试「继任者=自身（UUID）409」当初断言的正是坏守卫
  的行为——移除后 UUID 走名称/别名解析 422。修法是让 resolveSuccessorRef 补 UUID 直
  解析（与全工程 resolveAssetRef/resolveCollectionRef 的 id-or-name 口径一致），自继
  守卫在解析出 id 后统一比对——m70/m72 同时全绿。m17「成员审核」按旧宽松口径（团队
  成员即可审任意项目提案）写的，已对齐新语义：审核员先经 POST /projects/:id/members
  成为项目成员再审核。
- **浏览器实测**（M71 演示团队，真实登录会话）：页内登记 `=1+1|WEBSERVICE(m72演示)`
  资产（201）→ 页内 fetch /assets/export?format=csv 200 → 断言该行单元格为
  `"'=1+1|WEBSERVICE(m72演示)"`（OWASP 前缀防护生效）、content-type text/csv。
  注记：IAB 截图表面（webview）在本轮中途崩溃（guest not attached 持续），目录行
  截图未能补拍——CSV 防护证据以页内真实 fetch 断言为准（输出原文记于 HANDOFF）。
